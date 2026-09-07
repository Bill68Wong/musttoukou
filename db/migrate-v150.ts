/**
 * v0.15.0 增量迁移（db/migrate-v150.ts）
 * 用法：npm run db:migrate-v150 -- [local|cloud]
 *
 * 轻轨时刻表报站（motransportinfo 全量入库）数据层：
 *   1. 建 lrt_api_stations（api_id ↔ DB 站码 映射种子）
 *   2. 建 lrt_timetables（每 站×线路×方向×班别 整表 minutes JSONB）
 *   3. 建/对齐 lrt_holidays + 种子（2026–2027 澳门公众假期，班别判定用）
 *   4. 丢弃废弃占位表 lrt_schedules（已在 schema.sql 移除；云库为空表可安全删）
 *
 * ⚠️ 幂等：全部 IF NOT EXISTS + ON CONFLICT upsert，可重复执行；绝不触碰计时数据。
 */
import { Pool } from "pg";
import { LRT_API_STATIONS } from "./data/lrt-api-stations";
import { LRT_HOLIDAYS } from "./data/lrt-holidays";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const target = process.argv[2] as "local" | "cloud" | undefined;
const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? process.env.DATABASE_URL_LOCAL
      : (process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL);

if (!connStr) {
  console.error("❌ 未找到连接串：请先在 .env 配置（参照 .env.example）");
  process.exit(1);
}
const masked = connStr.replace(/:[^:@/]+@/, ":****@");
console.log(`目标库：${masked}`);

async function main() {
  const pool = new Pool({ connectionString: connStr });
  try {
    // 0) 废弃占位表（schema 2.12 旧版；云库已核实空表，本地影子库本就不存在）
    await pool.query(`DROP TABLE IF EXISTS lrt_schedules`);
    console.log("✅ lrt_schedules（废弃占位）已移除");

    // 1) 轻轨 API 站点映射
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lrt_api_stations (
        api_id      TEXT PRIMARY KEY,
        db_code     TEXT NOT NULL UNIQUE REFERENCES stations(code),
        name_tc     TEXT NOT NULL,
        lat         DOUBLE PRECISION,
        lng         DOUBLE PRECISION,
        note        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    let nMap = 0;
    for (const s of LRT_API_STATIONS) {
      const r = await pool.query(
        `INSERT INTO lrt_api_stations (api_id, db_code, name_tc, note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (api_id) DO UPDATE
           SET db_code = EXCLUDED.db_code, name_tc = EXCLUDED.name_tc, note = EXCLUDED.note`,
        [s.api_id, s.db_code, s.name_tc, s.lines ?? null],
      );
      nMap += (r.rowCount ?? 0) > 0 ? 1 : 0;
    }
    console.log(`✅ lrt_api_stations upsert: ${nMap}/${LRT_API_STATIONS.length}`);

    // 2) 时刻表整表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lrt_timetables (
        id          SERIAL PRIMARY KEY,
        api_station TEXT NOT NULL REFERENCES lrt_api_stations(api_id),
        route_no    TEXT NOT NULL,
        direction   TEXT NOT NULL,
        day_type    TEXT NOT NULL CHECK (day_type IN ('mon_thurs', 'fri', 'sat_sun_holiday')),
        first_min   SMALLINT NOT NULL,
        last_min    SMALLINT NOT NULL,
        minutes     JSONB NOT NULL,
        fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (api_station, route_no, direction, day_type)
      )`);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_lrt_timetables_lookup
        ON lrt_timetables (api_station, route_no, direction, day_type)`);
    console.log("✅ lrt_timetables 就绪");

    // 3) 公众假期表（对齐既有列名，幂等补列 + 唯一索引 + upsert 种子）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lrt_holidays (
        id            SERIAL PRIMARY KEY,
        holiday_date  DATE NOT NULL,
        holiday_code  TEXT NOT NULL,
        name_tc       TEXT NOT NULL,
        name_pt       TEXT,
        source        TEXT NOT NULL DEFAULT 'macau_gov'
      )`);
    await pool.query(
      `ALTER TABLE lrt_holidays ADD COLUMN IF NOT EXISTS holiday_code TEXT NOT NULL DEFAULT ''`,
    );
    await pool.query(`ALTER TABLE lrt_holidays ADD COLUMN IF NOT EXISTS name_tc TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE lrt_holidays ADD COLUMN IF NOT EXISTS name_pt TEXT`);
    await pool.query(`ALTER TABLE lrt_holidays ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'macau_gov'`);
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_lrt_holidays_date ON lrt_holidays (holiday_date)`,
    );
    let nHol = 0;
    for (const h of LRT_HOLIDAYS) {
      const r = await pool.query(
        `INSERT INTO lrt_holidays (holiday_date, holiday_code, name_tc, name_pt, source)
         VALUES ($1, $2, $3, $4, 'macau_gov')
         ON CONFLICT (holiday_date) DO UPDATE
           SET holiday_code = EXCLUDED.holiday_code,
               name_tc = EXCLUDED.name_tc,
               name_pt = EXCLUDED.name_pt`,
        [h.date, h.code, h.name_tc, h.name_pt ?? null],
      );
      nHol += (r.rowCount ?? 0) > 0 ? 1 : 0;
    }
    console.log(`✅ lrt_holidays upsert: ${nHol}/${LRT_HOLIDAYS.length}`);
    console.log("🎉 v0.15.0 数据层迁移完成");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ 迁移失败：", (err as Error).message);
  process.exit(1);
});
