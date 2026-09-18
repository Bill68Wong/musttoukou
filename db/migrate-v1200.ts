/**
 * 迁移 v1.2.0：高德步行距离接入 —— 数据层基建
 *
 * ── 起因 ──────────────────────────────────────────────────────────────
 *   项目要把「步行时长」的来源从**手动计时实测**升级为
 *   **高德地图步行路径距离 × 常速基准**，为最终「澳门任意地点导航」铺路。
 *   现状：`walk_times` 只有 18 行 / 54 次实测样本，覆盖不了任意起终点。
 *
 * ── 本迁移做三件事（**只加表、只加列，不动任何现有列与数据**）──────────
 *   ① 新建 `place_coords`      —— 地点坐标（★ 带 zone 粒度）
 *   ② 新建 `station_walk_distance` —— 高德距离的独立缓存表
 *   ③ `walk_times` 加两列      —— `distance_m` / `amap_fetched_at`
 *
 * ── ★★ 为什么是这两张新表，而不是给现有表加列 ─────────────────────────
 *
 *   【place_coords 独立成表，而不是 places.lat/lng】
 *     聚合键是 `(place_id, station主码, zone)`，而 `zone`（澳科大 B/C、N/O、R）
 *     是**三栋不同建筑 = 三个不同目的地**。`places` 一行对应「整个澳科大」，
 *     单行坐标表达不了三座 → 三个 zone 会算出同一个距离、维度直接退化。
 *     独立表 + `UNIQUE(place_id, zone)` 才能真正约束住 zone 维度。
 *
 *   【station_walk_distance 独立成表，而不是把 distance_m 塞进 walk_times】
 *     `rebuildWalkTimes` 是 `DELETE FROM walk_times` 后**全量重灌**（每日 Cron）。
 *     距离若存在那张表里 → 每天被清掉再重抓 → **浪费配额 + 高德一挂就全丢**。
 *     分层后：距离是「外部事实」（慢变、可增量抓），`minutes` 是「派生值」。
 *     高德失败时上轮距离还在，`minutes` 照样算得出来。
 *
 * ── 🚨🚨 本迁移最重要的一条：禁令写进列注释 ──────────────────────────
 *   读端 `src/lib/recommend/catch-up.ts#requiredSec` **已经**对步行分钟做了分档缩放：
 *       requiredSec(min, tier) = OVERHEAD + (min*60 − OVERHEAD) × SPEED_RATIO[tier]
 *       SPEED_RATIO = 0.27 / 0.48 / 1.0 / 1.5 / 2.5   （基准档 3 = 1.5 m/s）
 *   ⇒ 落库时若按「分档速度」算 minutes，读端会**再乘一次** ⇒ **双重缩档** ✗
 *   ⇒ `walk_times.minutes` **只能存「常速基准分钟」**（= distance_m ÷ 90）。
 *   这条禁令同时写在 `COMMENT ON COLUMN` 里，让任何直接看库的人都能看到。
 *
 * 用法：
 *   node --experimental-strip-types db/migrate-v1200.ts           # dry-run
 *   node --experimental-strip-types db/migrate-v1200.ts --apply   # 执行
 *   node --experimental-strip-types db/migrate-v1200.ts --apply --drop   # 撤销（仅本次新建的）
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
const q = async (s: string, a?: unknown[]) => (await pool.query(s, a)).rows;
const out: string[] = [];
const say = (s: string) => { out.push(s); console.log(s); };
const OUT = "D:/Projects/University/Studio/musttoukou/.verify/migrate-v1200.out.txt";

say(`模式：${DROP ? "★ DROP（撤销）" : APPLY ? "★ APPLY（写生产库）" : "DRY-RUN（只读）"}`);
say(`目标库：${u.hostname} / ${u.pathname.slice(1)}`);
say("");

async function main() {
  // ── ⓪ 前置：现状探测（幂等的基础）──
  const hasTable = async (t: string) =>
    (await q(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t])).length > 0;
  const hasCol = async (t: string, c: string) =>
    (await q(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [t, c])).length > 0;

  say("⓪ 现状探测");
  const t1 = await hasTable("place_coords");
  const t2 = await hasTable("station_walk_distance");
  const c1 = await hasCol("walk_times", "distance_m");
  const c2 = await hasCol("walk_times", "amap_fetched_at");
  const wtRows = (await q(`SELECT count(*)::int n FROM walk_times`))[0] as { n: number };
  say(`   place_coords          ：${t1 ? "已存在" : "不存在（将新建）"}`);
  say(`   station_walk_distance ：${t2 ? "已存在" : "不存在（将新建）"}`);
  say(`   walk_times.distance_m      ：${c1 ? "已有" : "缺（将新增）"}`);
  say(`   walk_times.amap_fetched_at ：${c2 ? "已有" : "缺（将新增）"}`);
  say(`   walk_times 现有行数：${wtRows.n}（本迁移**不触碰**这些数据）`);
  const places = (await q(`SELECT count(*)::int n FROM places`))[0] as { n: number };
  say(`   places 现有行数：${places.n}（本迁移不动它）`);
  say("");

  // ── DROP 路径 ──
  if (DROP) {
    say("① 撤销");
    if (!APPLY) { say("   （加 --apply 才真正执行）"); await pool.end(); return; }
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      if (c1) await c.query(`ALTER TABLE walk_times DROP COLUMN IF EXISTS distance_m`);
      if (c2) await c.query(`ALTER TABLE walk_times DROP COLUMN IF EXISTS amap_fetched_at`);
      await c.query(`DROP TABLE IF EXISTS station_walk_distance`);
      await c.query(`DROP TABLE IF EXISTS place_coords`);
      await c.query("COMMIT");
      say("   ✅ 已撤销（两张新表 + 两个新列全部移除；walk_times 的原有数据未动）");
    } catch (e) {
      await c.query("ROLLBACK");
      say(`   🔴 出错已回滚：${(e as Error).message}`);
    } finally { c.release(); }
    await pool.end();
    fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    return;
  }

  // ── ① place_coords ──
  say("① 建 place_coords（地点坐标，★ 带 zone 粒度）");
  say(`   CREATE TABLE IF NOT EXISTS place_coords (
       id SERIAL PRIMARY KEY,
       place_id INT NOT NULL REFERENCES places(id),
       zone TEXT,                          -- 'B/C'|'N/O'|'R'；非澳科大 place 为 NULL
       lat DOUBLE PRECISION NOT NULL,
       lng DOUBLE PRECISION NOT NULL,
       source TEXT NOT NULL DEFAULT 'manual',
       note TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       UNIQUE (place_id, zone)             -- ★ zone 维度的真正约束点
     )`);

  // ── ② station_walk_distance ──
  say("");
  say("② 建 station_walk_distance（高德距离独立缓存；与 walk_times 分层）");
  say(`   CREATE TABLE IF NOT EXISTS station_walk_distance (
       id SERIAL PRIMARY KEY,
       place_id INT NOT NULL REFERENCES places(id),
       station_main TEXT NOT NULL,         -- 主码口径（C690、T363），与聚合键一致
       zone TEXT,
       distance_m NUMERIC(7,1) NOT NULL,
       snap_start_m NUMERIC(6,1),          -- ★ 健康指标：路径首点→输入点
       snap_end_m NUMERIC(6,1),
       fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       UNIQUE (place_id, station_main, zone)
     )`);

  // ── ③ walk_times 加列 ──
  say("");
  say("③ walk_times 加两列（幂等）");
  say(`   ADD COLUMN IF NOT EXISTS distance_m NUMERIC(7,1)`);
  say(`   ADD COLUMN IF NOT EXISTS amap_fetched_at TIMESTAMPTZ`);

  // ── ④ COMMENT（把禁令写进库）──
  say("");
  say("④ 列注释（★ 把「双重缩档」禁令写进库里，任何直连看库的人都能看到）");

  if (!APPLY) {
    say("");
    say("（加 --apply 生效；加 --drop 撤销）");
    await pool.end();
    fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    return;
  }

  say("");
  say("▶ 执行中…");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    await c.query(`
      CREATE TABLE IF NOT EXISTS place_coords (
        id         SERIAL PRIMARY KEY,
        place_id   INT NOT NULL REFERENCES places(id),
        zone       TEXT,
        lat        DOUBLE PRECISION NOT NULL,
        lng        DOUBLE PRECISION NOT NULL,
        source     TEXT NOT NULL DEFAULT 'manual',
        note       TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (place_id, zone)
      )`);
    say("   ✅ place_coords");

    await c.query(`
      CREATE TABLE IF NOT EXISTS station_walk_distance (
        id           SERIAL PRIMARY KEY,
        place_id     INT NOT NULL REFERENCES places(id),
        station_main TEXT NOT NULL,
        zone         TEXT,
        distance_m   NUMERIC(7,1) NOT NULL,
        snap_start_m NUMERIC(6,1),
        snap_end_m   NUMERIC(6,1),
        fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (place_id, station_main, zone)
      )`);
    say("   ✅ station_walk_distance");

    await c.query(`ALTER TABLE walk_times ADD COLUMN IF NOT EXISTS distance_m NUMERIC(7,1)`);
    await c.query(`ALTER TABLE walk_times ADD COLUMN IF NOT EXISTS amap_fetched_at TIMESTAMPTZ`);
    say("   ✅ walk_times +2 列");

    // ★ 禁令注释
    await c.query(`COMMENT ON COLUMN walk_times.minutes IS
      '常速基准分钟（tier 3 / 1.5 m/s 口径）。🚫 严禁在此列落任何「分档速度」值 —— 分档缩放只在 src/lib/recommend/catch-up.ts#requiredSec 做，此处再缩放即双重缩档。由高德距离推算时为 distance_m ÷ 90。'`);
    await c.query(`COMMENT ON COLUMN walk_times.distance_m IS
      '高德步行路径距离（米）；NULL = 未知。与 minutes 分层：距离是外部事实（可增量抓），minutes 是派生值。'`);
    await c.query(`COMMENT ON COLUMN walk_times.amap_fetched_at IS
      '上面 distance_m 的抓取时刻（判断新鲜度用；超过 30 天会在下次 Cron 增量重抓）。'`);
    await c.query(`COMMENT ON COLUMN walk_times.source IS
      '样本来源：timer = 手动计时实测（优先）；amap = 由高德路径距离推算；mixed = 两者混用。'`);
    await c.query(`COMMENT ON COLUMN place_coords.zone IS
      '澳科大校区座别 B/C | N/O | R —— ★ 三栋不同建筑 = 三个不同目的地，必须各给一个坐标，否则 zone 维度退化。非澳科大 place 为 NULL。'`);
    await c.query(`COMMENT ON COLUMN station_walk_distance.snap_start_m IS
      '★ 坐标系健康指标：高德返回的路径首点与我们传入点的球面距离（米）。正常 < 50m；若整体 > 150m 说明坐标系约定有误，应弃用 API 距离。'`);
    await c.query(`COMMENT ON COLUMN station_walk_distance.station_main IS
      '站码主码（剥掉站台号后缀：C690/3 → C690），与 walk_times 的聚合键口径一致。'`);
    say("   ✅ 列注释（含双重缩档禁令）");

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

  // ── ⑤ 复核 ──
  say("");
  say("⑤ 复核");
  const t1b = await hasTable("place_coords");
  const t2b = await hasTable("station_walk_distance");
  const c1b = await hasCol("walk_times", "distance_m");
  const c2b = await hasCol("walk_times", "amap_fetched_at");
  say(`   place_coords：${t1b ? "✅" : "🔴"} · station_walk_distance：${t2b ? "✅" : "🔴"}`);
  say(`   walk_times.distance_m：${c1b ? "✅" : "🔴"} · amap_fetched_at：${c2b ? "✅" : "🔴"}`);
  const wt2 = (await q(`SELECT count(*)::int n FROM walk_times`))[0] as { n: number };
  say(`   walk_times 行数：${wt2.n}（应与迁移前一致 = ${wtRows.n}）${wt2.n === wtRows.n ? " ✅ 数据未动" : " 🔴 有变化！"}`);
  const cols = (await q(`SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='walk_times' ORDER BY ordinal_position`)) as { column_name: string }[];
  say(`   walk_times 列：${cols.map((x) => x.column_name).join(", ")}`);

  await pool.end();
  fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
  say("");
  say(`（日志已写 ${OUT.split("/").pop()}）`);
}
main().catch((e) => { console.error("✗", e); process.exit(1); });
