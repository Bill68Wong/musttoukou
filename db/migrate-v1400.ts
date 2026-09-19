/**
 * 迁移 v1.4.0：全澳导航「数据地基」 —— 高德接缝表 + 缓存 + 限流 + 别名库
 *
 * ── 起因 ──────────────────────────────────────────────────────────────
 *   全澳导航（v1.3.0 提案）要落地「候选来自高德 + 时间我们自己算」的方案，
 *   需要一组**新的数据地基**（设计 §2.F / §2.G）：
 *     · `station_amap_map`  高德站 ↔ 我们站码的**人工可维护映射表**（G1，阻塞二次计算）
 *     · `poi_aliases`       本地地名别名库（G3，搜索 0 配额的关键，阻塞需求 3）
 *     · `transit_cache`     高德公交方案缓存（OD 取整 + 15min 时段桶，TTL 60s）
 *     · `shadow_diff_report` 影子对照 / 本地补漏候选（离线产，请求期只读）
 *     · `amap_rate_bucket`  ★跨实例令牌桶（3 QPS 全实例共享；QA P0-1 教训）
 *     · `walk_cache`        步行缓存（**降级路径**用；键 = geohash-7 ≈150m，QA P1-2）
 *     · `walk_miss_queue`   步行缓存未命中的**异步补算队列**（离线预热消费）
 *     · `search_quota_log`  搜索配额记账（熔断/看板）
 *
 * ── ★ 编号说明 ────────────────────────────────────────────────────────
 *   设计文档里写的是 `db/migrate-v1300.ts`，但 **v1300 编号已被「采集数据入库」
 *   那次的迁移占用**（`segment_samples`）⇒ 本次改用 **v1400**（同 `package.json`
 *   的 `db:migrate-v1400`）。
 *
 * ── 幂等 ──────────────────────────────────────────────────────────────
 *   全部 `CREATE TABLE / INDEX IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS`；
 *   唯一约束用 `uq_*_...` 命名 + 部分唯一索引（`WHERE ... IS NOT NULL`）以支持可空键。
 *   **不触碰任何既有表的数据**（stations / segment_stats / timer_* 一律只读）。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs db/migrate-v1400.ts           # dry-run（只探测）
 *   node node_modules/tsx/dist/cli.mjs db/migrate-v1400.ts --apply    # 执行（写生产库）
 *   node node_modules/tsx/dist/cli.mjs db/migrate-v1400.ts --apply --drop  # 撤销（仅本迁移的 8 张表）
 */
import fs from "node:fs";
import { Pool } from "pg";

const APPLY = process.argv.includes("--apply");
const DROP = process.argv.includes("--drop");
process.loadEnvFile("D:/Projects/University/Studio/musttoukou/.env");
const u = new URL(process.env.DATABASE_URL!);
const pool = new Pool({
  host: u.hostname,
  port: Number(u.port || 5432),
  database: u.pathname.slice(1),
  user: u.username,
  password: decodeURIComponent(u.password || ""),
  ssl: { rejectUnauthorized: false },
});
const q = async (s: string, a?: unknown[]) =>
  (await pool.query(s, a)).rows as Record<string, unknown>[];
const out: string[] = [];
const say = (s: string) => {
  out.push(s);
  console.log(s);
};
const OUT = "D:/Projects/University/Studio/musttoukou/.verify/migrate-v1400.out.txt";

/** 本迁移要建的全部表（--drop 与复核都据此） */
const TABLES = [
  "station_amap_map",
  "poi_aliases",
  "transit_cache",
  "shadow_diff_report",
  "amap_rate_bucket",
  "walk_cache",
  "walk_miss_queue",
  "search_quota_log",
] as const;

const hasTable = async (t: string) =>
  (
    await q(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
      [t],
    )
  ).length > 0;

/** 所有表/索引/注释的 DDL（应用与文档预览共用同一份） */
const DDL: string[] = [
  // ── ① 站码映射（G1）───────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS station_amap_map (
     id                BIGSERIAL PRIMARY KEY,
     amap_station_id   TEXT,                         -- 高德站 id（有则优先按 id 匹配）
     amap_name         TEXT NOT NULL,                -- 高德站名（★简体）
     amap_lng          DOUBLE PRECISION NOT NULL,    -- 高德坐标（GCJ-02，原样存）
     amap_lat          DOUBLE PRECISION NOT NULL,
     dsat_station_main TEXT,                         -- 我们【主码】（C653 / LRT-MUST）；NULL = 未匹配
     name_tc           TEXT,                         -- 我们站名（★繁体官方原文）—— §R5 保留两列
     match_method      TEXT NOT NULL DEFAULT 'coord',-- 'coord'|'name'|'both'|'manual'|'unmatched'
     match_dist_m      NUMERIC(7,1),                 -- 坐标最近邻距离（米）
     name_match        BOOLEAN NOT NULL DEFAULT FALSE,
     confidence        TEXT NOT NULL DEFAULT 'low',  -- 'high'|'medium'|'low'
     verified_by_human BOOLEAN NOT NULL DEFAULT FALSE,
     verified_at       TIMESTAMPTZ,
     verified_note     TEXT,                         -- 人工备注（改名/新建…）
     created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_station_amap_map_amap_id
     ON station_amap_map (amap_station_id) WHERE amap_station_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_station_amap_map_amap_key
     ON station_amap_map (amap_name, amap_lng, amap_lat)`,
  `CREATE INDEX IF NOT EXISTS idx_station_amap_map_main ON station_amap_map (dsat_station_main)`,
  `CREATE INDEX IF NOT EXISTS idx_station_amap_map_verified ON station_amap_map (verified_by_human)`,

  // ── ② 本地地名别名库（G3）─────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS poi_aliases (
     id          BIGSERIAL PRIMARY KEY,
     alias_norm  TEXT NOT NULL,                      -- 归一化别名（简体/去空白/去后缀）—— 匹配键
     alias_raw   TEXT NOT NULL,                      -- 原始别名（展示 / 调试）
     target_kind TEXT NOT NULL,                      -- 'station'|'lrt_station'|'route'|'poi'|'place'
     target_code TEXT NOT NULL DEFAULT '',           -- 站码 / 线路码 / 点位码（无则 ''）
     name_tc     TEXT NOT NULL,                      -- 目标显示名（★繁体官方原文）
     lng         DOUBLE PRECISION,                   -- GCJ-02（确认后直接作 transit destination）
     lat         DOUBLE PRECISION,
     weight      NUMERIC(6,3) NOT NULL DEFAULT 1,    -- 命中排序权重
     source      TEXT NOT NULL DEFAULT 'seed',       -- 'station'|'route'|'campus'|'border'|'lrt'|'pt'|'manual'
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (alias_norm, target_kind, target_code)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_poi_aliases_norm ON poi_aliases (alias_norm)`,
  `CREATE INDEX IF NOT EXISTS idx_poi_aliases_kind ON poi_aliases (target_kind)`,

  // ── ③ 高德公交方案缓存（Q14）──────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS transit_cache (
     id          BIGSERIAL PRIMARY KEY,
     od_key      TEXT NOT NULL,                      -- 取整坐标(4位) + '|' + 时段桶(15min)
     plans_json  JSONB NOT NULL,                     -- 高德原始返回（transits[] 原样，供重解析）
     fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (od_key)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_transit_cache_time ON transit_cache (fetched_at DESC)`,

  // ── ④ 影子对照 / 本地补漏候选（离线产，请求期只读）────────────────
  `CREATE TABLE IF NOT EXISTS shadow_diff_report (
     id              BIGSERIAL PRIMARY KEY,
     od_key          TEXT NOT NULL,
     amap_plan_cnt   INT NOT NULL,
     local_plan_cnt  INT NOT NULL,
     missed_paths    JSONB,                          -- 高德有、我们没有的组合
     extra_paths     JSONB,                          -- ★我们有、高德没有的组合（经闸门后交付）
     extra_recompute JSONB,                          -- ★extra 方案的二次计算缓存（请求期复用）
     miss_rate       NUMERIC(5,3),
     created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_shadow_diff_created ON shadow_diff_report (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_shadow_diff_od ON shadow_diff_report (od_key)`,

  // ── ⑤ 跨实例令牌桶（QA P0-1 / R-09）───────────────────────────────
  `CREATE TABLE IF NOT EXISTS amap_rate_bucket (
     bucket     TEXT PRIMARY KEY,                    -- 'transit'|'walking'|'search'
     tokens     NUMERIC(10,4) NOT NULL DEFAULT 0,    -- 当前令牌数（原子补充后扣减）
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // ── ⑥ 步行缓存（★降级路径用；键 = geohash-7 ≈150m，QA P1-2）──────
  `CREATE TABLE IF NOT EXISTS walk_cache (
     id          BIGSERIAL PRIMARY KEY,
     cache_key   TEXT NOT NULL UNIQUE,               -- geohash7(from) + '>' + geohash7(to)
     kind        TEXT NOT NULL DEFAULT 'walk',       -- 'walk' | 'transfer'
     from_key    TEXT NOT NULL,                      -- geohash7（起点）
     to_key      TEXT NOT NULL,
     from_lng    DOUBLE PRECISION NOT NULL,          -- 原样缓存请求坐标（GCJ-02）
     from_lat    DOUBLE PRECISION NOT NULL,
     to_lng      DOUBLE PRECISION NOT NULL,
     to_lat      DOUBLE PRECISION NOT NULL,
     distance_m  NUMERIC(7,1),                       -- 高德步行路径距离（米）
     duration_s  NUMERIC(8,1),                       -- 高德自估耗时（秒，仅参考）
     straight_m  NUMERIC(7,1),                       -- 直线距离（短距修正用）
     ratio       NUMERIC(6,3),                       -- distance_m / straight_m（异常检测）
     corrected_m NUMERIC(7,1),                       -- 短距修正后距离（写卡口径）
     source      TEXT NOT NULL DEFAULT 'amap',
     fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_walk_cache_fetched ON walk_cache (fetched_at DESC)`,

  // ── ⑦ 步行缓存未命中补算队列（离线预热消费）──────────────────────
  `CREATE TABLE IF NOT EXISTS walk_miss_queue (
     id         BIGSERIAL PRIMARY KEY,
     cache_key  TEXT NOT NULL UNIQUE,
     kind       TEXT NOT NULL DEFAULT 'walk',
     from_lng   DOUBLE PRECISION NOT NULL,
     from_lat   DOUBLE PRECISION NOT NULL,
     to_lng     DOUBLE PRECISION NOT NULL,
     to_lat     DOUBLE PRECISION NOT NULL,
     straight_m NUMERIC(7,1),
     reason     TEXT,
     status     TEXT NOT NULL DEFAULT 'pending',     -- 'pending'|'done'|'failed'
     attempts   INT NOT NULL DEFAULT 0,
     last_error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_walk_miss_status ON walk_miss_queue (status, created_at)`,

  // ── ⑧ 搜索配额记账（R-07 熔断 / 看板）────────────────────────────
  `CREATE TABLE IF NOT EXISTS search_quota_log (
     id         BIGSERIAL PRIMARY KEY,
     api        TEXT NOT NULL,                       -- 'inputtips'|'place/text'
     ok         BOOLEAN NOT NULL,
     infocode   TEXT,
     latency_ms INT,
     day        DATE NOT NULL DEFAULT (now())::date,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_search_quota_day ON search_quota_log (day, api)`,
  `CREATE INDEX IF NOT EXISTS idx_search_quota_time ON search_quota_log (created_at DESC)`,
];

/** 幂等的 ALTER（当表更早由别处建出、缺人工确认列时补上；设计 §B.3a②） */
const ALTERS: string[] = [
  `ALTER TABLE station_amap_map ADD COLUMN IF NOT EXISTS verified_by_human BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE station_amap_map ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ`,
  `ALTER TABLE station_amap_map ADD COLUMN IF NOT EXISTS verified_note TEXT`,
  `ALTER TABLE station_amap_map ADD COLUMN IF NOT EXISTS amap_station_id TEXT`,
];

/** 关键列注释（把口径写进库，防误用） */
const COMMENTS: string[] = [
  `COMMENT ON TABLE station_amap_map IS '高德站 ↔ 我们站码 的映射表（自动生成 + 人工维护的长期资产）。amap_name=高德简体名 / name_tc=我们繁体名，两列并存（§R5）。'`,
  `COMMENT ON COLUMN station_amap_map.amap_name IS '★高德站名（简体）——不可与 name_tc 合并为单列'`,
  `COMMENT ON COLUMN station_amap_map.name_tc IS '★我们站名（繁体官方原文）——显示一律用它'`,
  `COMMENT ON COLUMN station_amap_map.dsat_station_main IS '我们【主码】（已剥站台后缀，如 C653）；NULL 表示暂未匹配（待人工复核）'`,
  `COMMENT ON COLUMN station_amap_map.confidence IS '置信度：high=坐标≤30m 且名称命中；medium=坐标≤60m 或 名称命中；low=其余（最可疑，排最前）'`,
  `COMMENT ON COLUMN station_amap_map.verified_by_human IS '人工复核通过标记；主路径优先命中 verified 的行'`,
  `COMMENT ON TABLE poi_aliases IS '本地地名别名库（0 配额搜索）。alias_norm 为归一化键（已做繁简互转→简体）；命中直接给出 GCJ-02 坐标供 transit 使用。'`,
  `COMMENT ON TABLE transit_cache IS '高德公交方案缓存；od_key=取整坐标(4位)+"|"+15min 时段桶；TTL 60s（实时性），过期即视为未命中。'`,
  `COMMENT ON COLUMN transit_cache.plans_json IS '高德 transits[] 原样（供重解析）；请求期只读、不写'`,
  `COMMENT ON TABLE shadow_diff_report IS '离线影子对照/本地补漏候选。extra_paths 经质量闸门后交付给用户；extra_recompute 供请求期复用（免重跑图搜索）。'`,
  `COMMENT ON TABLE amap_rate_bucket IS '高德调用【跨实例】令牌桶（3 QPS 全实例共享）。单进程变量在多实例下无效——必须以 pg_advisory_xact_lock 串行化。'`,
  `COMMENT ON TABLE walk_cache IS '步行缓存（★降级路径用）。键 = geohash-7(≈150m) 对，**不是 2 位小数**（≈1km 网格会污染）。'`,
  `COMMENT ON COLUMN walk_cache.corrected_m IS '短距修正后距离（★规则已于 R3 修订）：直线<200m 且 ratio≤3.0 → 用高德值；直线<200m 且 ratio>3.0 → 直线×1.5；直线≥200m 按 [1.0,3.0] 护栏。写卡口径 = corrected_m ÷ 84'`,
];

say(`模式：${DROP ? "★ DROP（撤销）" : APPLY ? "★ APPLY（写生产库）" : "DRY-RUN（只读）"}`);
say(`目标库：${u.hostname} / ${u.pathname.slice(1)}`);
say("");

async function main() {
  // ── ⓪ 前置：现状探测 ──
  say("⓪ 现状探测（本迁移只新增表，不触碰既有数据）");
  const existed: Record<string, boolean> = {};
  for (const t of TABLES) {
    existed[t] = await hasTable(t);
    say(`   ${t.padEnd(20)} ${existed[t] ? "已存在（幂等跳过）" : "不存在（将新建）"}`);
  }
  const baseTables = ["stations", "routes", "segment_stats", "route_stations"];
  for (const t of baseTables) {
    const n = (await q(`SELECT count(*)::int n FROM ${t}`))[0].n;
    say(`   依赖基线 ${t.padEnd(16)} 行数 ${n}（本迁移只读，不修改）`);
  }
  say("");

  // ── DROP 路径 ──
  if (DROP) {
    say("① 撤销（仅本迁移的 8 张表）");
    if (!APPLY) {
      say("   （加 --apply 才真正执行）");
      await pool.end();
      fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
      return;
    }
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (const t of TABLES) await c.query(`DROP TABLE IF EXISTS ${t}`);
      await c.query("COMMIT");
      say("   ✅ 已撤销（8 张表及其索引全部移除；既有表未动）");
    } catch (e) {
      await c.query("ROLLBACK");
      say(`   🔴 出错已回滚：${(e as Error).message}`);
    } finally {
      c.release();
    }
    await pool.end();
    fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    return;
  }

  // ── ① 结构预览 ──
  say("① 将执行的 DDL（可重复执行）");
  for (const d of DDL) {
    say("   " + d.replace(/\n\s+/g, "\n     "));
    say("");
  }

  if (!APPLY) {
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
    for (const d of DDL) await c.query(d);
    say(`   ✅ 建表/索引：${TABLES.join(", ")}`);
    for (const a of ALTERS) await c.query(a);
    say("   ✅ 人工确认列（幂等 ALTER）");
    for (const cm of COMMENTS) await c.query(cm);
    say("   ✅ 列注释");
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

  // ── ③ 复核 ──
  say("");
  say("③ 复核");
  for (const t of TABLES) {
    const ok = await hasTable(t);
    const cols = await q(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [t],
    );
    const idx = await q(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname`,
      [t],
    );
    say(`   ${ok ? "✅" : "🔴"} ${t}（${cols.length} 列 / ${idx.length} 索引）`);
    for (const r of cols)
      say(
        `        ${String(r.column_name).padEnd(20)} ${String(r.data_type).padEnd(26)} ${
          r.is_nullable === "NO" ? "NOT NULL" : "NULL"
        }`,
      );
    say(`        索引：${idx.map((r) => r.indexname).join(", ") || "（无）"}`);
  }

  await pool.end();
  fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
  say("");
  say(`（日志已写 ${OUT.split("/").pop()}）`);
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
