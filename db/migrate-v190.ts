/**
 * v0.19.0 迁移（db/migrate-v190.ts）——自由记站（独立数据采集渠道）
 * 用法：npm run db:migrate-v190 -- [local|cloud]
 *
 * 建两张互不依赖的表（幂等）：
 *   free_rides        采集会话（单线单程：路线/方向/上下车站/车牌/车号/拥挤度/时间）
 *   free_ride_events  逐站打点（board / stop_arrive / stop_pass / stop_skip / alight）
 * 与乘车计时表完全隔离（不入 stats/records），供未来「站间行车时长」建模。
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const target = (process.argv[2] ?? "local") as "local" | "cloud";
const dbUrl = target === "cloud" ? process.env.DATABASE_URL : process.env.DATABASE_URL_LOCAL;
if (!dbUrl) throw new Error(`未找到 ${target === "cloud" ? "DATABASE_URL" : "DATABASE_URL_LOCAL"}`);
const u = new URL(dbUrl);
const pool = new Pool({
  host: u.hostname,
  port: Number(u.port || 5432),
  database: u.pathname.slice(1),
  user: u.username,
  password: decodeURIComponent(u.password || ""),
  ...(target === "cloud" ? { ssl: { rejectUnauthorized: false } } : {}),
});
const q = async (sql: string) => (await pool.query(sql)).rows as Record<string, unknown>[];

async function main() {
  await q(`
    CREATE TABLE IF NOT EXISTS free_rides (
      id             BIGSERIAL PRIMARY KEY,
      route_code     TEXT NOT NULL,
      dsat_dir       TEXT NOT NULL DEFAULT '0',
      board_station  TEXT,
      alight_station TEXT,
      vehicle_plate  TEXT,
      vehicle_code   TEXT,
      crowd_level    SMALLINT,
      started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at       TIMESTAMPTZ,
      total_ms       INT,
      is_test        BOOLEAN NOT NULL DEFAULT FALSE,
      note           TEXT,
      deleted_at     TIMESTAMPTZ
    )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_free_rides_route ON free_rides (route_code, started_at)`);
  await q(`
    CREATE TABLE IF NOT EXISTS free_ride_events (
      id            BIGSERIAL PRIMARY KEY,
      free_ride_id  BIGINT NOT NULL REFERENCES free_rides(id) ON DELETE CASCADE,
      seq           INT NOT NULL,
      event_type    TEXT NOT NULL,
      station_code  TEXT,
      recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (free_ride_id, seq)
    )`);
  console.log("✅ free_rides / free_ride_events 就绪");
  const n = await q(`SELECT (SELECT count(*)::int FROM free_rides) AS rides`);
  console.log(`free_rides 现有 ${n[0].rides} 条`);
  console.log(`\n✅ v0.19.0 迁移完成（${target}）`);
  await pool.end();
}

main().catch((e) => {
  console.error("迁移失败：", e);
  process.exit(1);
});
