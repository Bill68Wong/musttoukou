/**
 * 迁移 v1.3.0：站间时长「原始样本」入库 —— `segment_samples`
 *
 * ── 起因 ──────────────────────────────────────────────────────────────
 *   追踪式采集链路（每 30 分钟一轮，追踪全澳 92 条巴士线的车辆轨迹推算站间行车时长）
 *   已跑 17 轮、产出 **60,313 段原始样本**，但**从未入过库** —— 线上唯一的段时长表
 *   `segment_stats` 是**聚合结果**（DELETE 后全量重灌），且只有手动打点的 696 段样本
 *   （覆盖率 3.9%）。
 *   本迁移新建**原始样本表** `segment_samples`，把采集/手动的**每一段原始观测**落库，
 *   再由重建脚本按同一口径合并重算 `segment_stats`。
 *
 * ── 为什么是「原始样本表」，而不是把聚合值塞进 segment_stats ─────────────
 *   ① 保留 方向(dir)/车牌(plate)/站台码(from_station/to_station)/站序(from_idx) 等细节
 *      —— 以后换口径（到达口径 / 按车牌 / 按方向）可**离线重算**，不必重采。
 *   ② `segment_stats` 是派生表（每日 Cron `DELETE` 全量重灌），原始观测若直接写进它
 *      会被覆盖丢失；分层后：`segment_samples` = 事实（append-only），`segment_stats` = 派生值。
 *   ③ 自动采集(track) 与 手动实测(timer) **同表**，靠 `source` 区分 —— 保证样本量、
 *      也让「两条链路是否一致」可随时复核。
 *
 * ── ★★ 列注释里必须写清的一条口径差异（防误用）────────────────────────
 *   `segment_samples.arrive_kind` ∈ {'depart','arrive'} = **计时口径**（离开 / 到达）；
 *   而 `segment_stats.arrive_kind` ∈ {'stop','pass','all'} = **起点站停站档位**。
 *   ★ 同名列、**不同语义** —— 直连看库的人极易混淆，故写进 COMMENT。
 *   本期只入**离开口径**（`arrive_kind='depart'`）：到达口径的原始样本在采集产物里是 0 条。
 *
 * ── 滚动窗口 ──────────────────────────────────────────────────────────
 *   库内只保留最近 **30 轮** `source='track'` 的原始样本（超出的删最老）；
 *   `source='timer'`（手动实测）**永不删除**（仅几百行，长期有效）。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs db/migrate-v1300.ts           # dry-run（只探测）
 *   node node_modules/tsx/dist/cli.mjs db/migrate-v1300.ts --apply    # 执行
 *   node node_modules/tsx/dist/cli.mjs db/migrate-v1300.ts --apply --drop  # 撤销（仅本表）
 *
 * **可重复执行**：CREATE TABLE/INDEX IF NOT EXISTS；唯一约束用 DO $$ ... EXCEPTION duplicate_object。
 */
import fs from "node:fs";
import { Pool } from "pg";

const APPLY = process.argv.includes("--apply");
const DROP = process.argv.includes("--drop");
process.loadEnvFile("D:/Projects/University/Studio/musttoukou/.env");
const u = new URL(process.env.DATABASE_URL!);
const pool = new Pool({
  host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1),
  user: u.username, password: decodeURIComponent(u.password || ""), ssl: { rejectUnauthorized: false },
});
const q = async (s: string, a?: unknown[]) => (await pool.query(s, a)).rows as Record<string, unknown>[];
const out: string[] = [];
const say = (s: string) => { out.push(s); console.log(s); };
const OUT = "D:/Projects/University/Studio/musttoukou/.verify/migrate-v1300.out.txt";

say(`模式：${DROP ? "★ DROP（撤销）" : APPLY ? "★ APPLY（写生产库）" : "DRY-RUN（只读）"}`);
say(`目标库：${u.hostname} / ${u.pathname.slice(1)}`);
say("");

const hasTable = async (t: string) =>
  (await q(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t])).length > 0;

async function main() {
  // ── ⓪ 前置：现状探测 ──
  say("⓪ 现状探测");
  const had = await hasTable("segment_samples");
  say(`   segment_samples：${had ? "已存在（将幂等跳过建表）" : "不存在（将新建）"}`);
  let before = 0;
  if (had) {
    before = Number((await q(`SELECT count(*)::int n FROM segment_samples`))[0].n);
    say(`   现有行数：${before}（若重复执行本迁移，**不触碰**这些数据）`);
  }
  const ss = Number((await q(`SELECT count(*)::int n FROM segment_stats`))[0].n);
  say(`   segment_stats 现有行数：${ss}（本迁移**不触碰**）`);
  say("");

  // ── DROP 路径 ──
  if (DROP) {
    say("① 撤销");
    if (!APPLY) { say("   （加 --apply 才真正执行）"); await pool.end(); fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8"); return; }
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`DROP TABLE IF EXISTS segment_samples`);
      await c.query("COMMIT");
      say("   ✅ 已撤销（segment_samples 表及其索引全部移除；segment_stats 未动）");
    } catch (e) {
      await c.query("ROLLBACK");
      say(`   🔴 出错已回滚：${(e as Error).message}`);
    } finally { c.release(); }
    await pool.end();
    fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    return;
  }

  // ── ① 表结构预览 ──
  say("① 建 segment_samples（原始样本表；可重复执行）");
  say(`   CREATE TABLE IF NOT EXISTS segment_samples (
       id            bigserial PRIMARY KEY,
       run_label     text NOT NULL,          -- 采集轮次标签（如 '20260918-213415'）；手动实测固定 'timer'
       route_code    text NOT NULL,          -- 线路（如 '25' / 'LRT-氹仔线'）
       dir           smallint,               -- 方向 0/1；手动实测可为 NULL
       plate         text,                   -- 车牌（如 'AB4969'）；手动实测为 NULL
       from_main     text NOT NULL,          -- 起点【主码】（如 'C653'）
       to_main       text NOT NULL,          -- 终点【主码】
       from_station  text NOT NULL,          -- 起点【站台码】（如 'C653/1'）—— 聚合键口径
       to_station    text NOT NULL,          -- 终点【站台码】
       from_idx      smallint,               -- 起点站序；手动实测可为 NULL
       minutes       numeric(6,3) NOT NULL,  -- 用时（分钟）
       arrive_kind   text NOT NULL,          -- ★ 计时口径：'depart'（离开）/ 'arrive'（到达）——与 segment_stats 同名不同义！
       source        text NOT NULL,          -- 'track'（自动采集）/ 'timer'（手动实测）
       observed_at   timestamptz NOT NULL,   -- 观测时刻
       weekday       smallint NOT NULL,      -- 0~6（0=周日）
       time_bucket   text NOT NULL,          -- 'am_peak'/'day'/'pm_peak'/'night'
       created_at    timestamptz NOT NULL DEFAULT now()
     )`);
  say("   唯一约束（防重复导入；★ NULLS NOT DISTINCT 让 timer 的 NULL dir/plate 也判等）：");
  say("     UNIQUE NULLS NOT DISTINCT (run_label, source, route_code, dir, plate, from_station, to_station, observed_at)");
  say("   查询索引：");
  say("     idx_seg_samples_key (route_code, from_main, to_main, weekday, time_bucket)");
  say("     idx_seg_samples_run (run_label, source)");

  if (!APPLY) {
    say("");
    say("（加 --apply 生效；加 --drop 撤销）");
    await pool.end();
    fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    return;
  }

  // ── ② 执行 ──
  say("");
  say("▶ 执行中…");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    await c.query(`
      CREATE TABLE IF NOT EXISTS segment_samples (
        id            bigserial PRIMARY KEY,
        run_label     text NOT NULL,
        route_code    text NOT NULL,
        dir           smallint,
        plate         text,
        from_main     text NOT NULL,
        to_main       text NOT NULL,
        from_station  text NOT NULL,
        to_station    text NOT NULL,
        from_idx      smallint,
        minutes       numeric(6,3) NOT NULL,
        arrive_kind   text NOT NULL,
        source        text NOT NULL,
        observed_at   timestamptz NOT NULL,
        weekday       smallint NOT NULL,
        time_bucket   text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now()
      )`);
    say("   ✅ segment_samples");

    // 唯一约束：幂等（已存在则 duplicate_object，忽略）
    // ★★ 必须是 `NULLS NOT DISTINCT`（PG15+）：手动实测(timer) 的 dir/plate 为 **NULL**，
    //    而标准 UNIQUE 视 NULL 互不相等 → 每跑一次导入都会**再插一份**（实测踩坑：timer 231→462）✗
    //    `NULLS NOT DISTINCT` 让 NULL 之间也判等 → 唯一约束才真正起「防重复导入」作用 ✓
    //    兼容已有旧约束：若已存在但没带 NULLS NOT DISTINCT，则重建。
    await c.query(`
      DO $$
      DECLARE def text;
      BEGIN
        SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
         WHERE conrelid = 'segment_samples'::regclass AND conname = 'segment_samples_uq';
        IF def IS NULL THEN
          ALTER TABLE segment_samples ADD CONSTRAINT segment_samples_uq
            UNIQUE NULLS NOT DISTINCT (run_label, source, route_code, dir, plate, from_station, to_station, observed_at);
        ELSIF def NOT ILIKE '%NULLS NOT DISTINCT%' THEN
          ALTER TABLE segment_samples DROP CONSTRAINT segment_samples_uq;
          ALTER TABLE segment_samples ADD CONSTRAINT segment_samples_uq
            UNIQUE NULLS NOT DISTINCT (run_label, source, route_code, dir, plate, from_station, to_station, observed_at);
        END IF;
      END $$;`);
    say("   ✅ 唯一约束 segment_samples_uq（UNIQUE NULLS NOT DISTINCT）");

    await c.query(`CREATE INDEX IF NOT EXISTS idx_seg_samples_key
      ON segment_samples (route_code, from_main, to_main, weekday, time_bucket)`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_seg_samples_run
      ON segment_samples (run_label, source)`);
    say("   ✅ 索引 idx_seg_samples_key / idx_seg_samples_run");

    // ★ 列注释：把「同名不同义」的口径差异写进库
    await c.query(`COMMENT ON TABLE segment_samples IS
      '站间时长**原始样本**（append-only 事实层）。自动采集(track) + 手动实测(timer) 同表，靠 source 区分；滚动窗口只保留最近 30 轮 track。派生聚合见 segment_stats。'`);
    await c.query(`COMMENT ON COLUMN segment_samples.arrive_kind IS
      '★ 计时口径：depart=离开口径（t离B−t离A，含终点停站）/ arrive=到达口径。⚠️ 与 segment_stats.arrive_kind（stop/pass/all=起点站停站档位）同名但**语义完全不同**，勿混用。本期只入 depart。'`);
    await c.query(`COMMENT ON COLUMN segment_samples.from_station IS
      '起点【站台码】（如 C653/1）。★ 与 segment_stats.from_station、timer_events.station_code 同口径（站台级），是聚合键的一部分。from_main 是主码（C653），仅作诊断/跨线共享用。'`);
    await c.query(`COMMENT ON COLUMN segment_samples.to_station IS
      '终点【站台码】（如 C653/1）。★ 同 from_station，站台级口径。'`);
    await c.query(`COMMENT ON COLUMN segment_samples.run_label IS
      '采集轮次标签（如 20260918-213415）；手动实测固定 timer。滚动窗口按此列保留最近 30 轮 track。'`);
    await c.query(`COMMENT ON COLUMN segment_samples.source IS
      'track=自动采集（滚动窗口会清理超 30 轮的旧轮次）；timer=手动实测（**永不删除**）。'`);
    await c.query(`COMMENT ON COLUMN segment_samples.dir IS
      '方向 0/1；手动实测（timer）为 NULL。'`);
    await c.query(`COMMENT ON COLUMN segment_samples.plate IS
      '车牌（如 AB4969）；手动实测（timer）为 NULL。'`);
    say("   ✅ 列注释（含同名不同义警示）");

    await c.query("COMMIT");
    say("   ✅ 已提交");
  } catch (e) {
    await c.query("ROLLBACK");
    say(`   🔴 出错已回滚：${(e as Error).message}`);
    c.release();
    await pool.end();
    fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    process.exit(1);
  }
  c.release();

  // ── ③ 复核：打印表结构 ──
  say("");
  say("③ 复核");
  const t1b = await hasTable("segment_samples");
  say(`   segment_samples：${t1b ? "✅ 存在" : "🔴 缺失"}`);
  const cols = await q(`SELECT column_name, data_type, is_nullable
     FROM information_schema.columns WHERE table_schema='public' AND table_name='segment_samples'
     ORDER BY ordinal_position`);
  say("   列结构：");
  for (const r of cols) say(`     ${String(r.column_name).padEnd(14)} ${String(r.data_type).padEnd(28)} ${r.is_nullable === "NO" ? "NOT NULL" : "NULL"}`);
  const cons = await q(`SELECT conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint WHERE conrelid = 'segment_samples'::regclass ORDER BY conname`);
  say("   约束：");
  for (const r of cons) say(`     ${r.conname}: ${r.def}`);
  const idx = await q(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='segment_samples' ORDER BY indexname`);
  say(`   索引：${idx.map((r) => r.indexname).join(", ")}`);
  const after = Number((await q(`SELECT count(*)::int n FROM segment_samples`))[0].n);
  say(`   行数：${after}${had ? `（迁移前 ${before}，应一致）${after === before ? " ✅ 未动数据" : " 🔴 有变化"}` : ""}`);
  const ss2 = Number((await q(`SELECT count(*)::int n FROM segment_stats`))[0].n);
  say(`   segment_stats 行数：${ss2}（应与迁移前一致 = ${ss}）${ss2 === ss ? " ✅ 未动" : " 🔴 有变化！"}`);

  await pool.end();
  fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
  say("");
  say(`（日志已写 ${OUT.split("/").pop()}）`);
}
main().catch((e) => { console.error("✗", e); process.exit(1); });
