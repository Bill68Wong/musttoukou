/**
 * v0.18.0 迁移（db/migrate-v180.ts）
 * 用法：npm run db:migrate-v180 -- [local|cloud]
 *
 * 背景：拥挤度从「结束页一次性填、存 timer_sessions.crowd_level（会话级、0-3）」
 * 改为「上车后在行程内填、按每程记录（换乘每趟车都记）」，五档语义：
 *   0 空（随便坐）/ 1 正常（有座）/ 2 饱和（没座位但站稳）/ 3 挤（贴着站）/ 4 爆满（前胸贴后背）
 *
 * 本迁移做两件事（幂等）：
 *   ① CREATE TABLE IF NOT EXISTS ride_crowd（schema.sql 已同步）
 *   ② 历史真实样本迁移：timer_sessions.crowd_level 按语义映射写入 ride_crowd(veh_index=0, route_code)
 *      旧 0空→0、1正常→1、2「挤/贴着站」→新 3「挤」、3爆满→4
 *      （旧列保留不动，仅作历史参考，不再写入）
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
const q = async (sql: string, args?: unknown[]) =>
  (await pool.query(sql, args)).rows as Record<string, unknown>[];

async function main() {
  // ① 建表
  await q(`
    CREATE TABLE IF NOT EXISTS ride_crowd (
      id           BIGSERIAL PRIMARY KEY,
      session_id   INT NOT NULL REFERENCES timer_sessions(id) ON DELETE CASCADE,
      veh_index    INT NOT NULL DEFAULT 0,
      level        SMALLINT NOT NULL,
      route_code   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (session_id, veh_index)
    )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_ride_crowd_route ON ride_crowd (route_code)`);
  console.log("① ride_crowd 表就绪");

  // ② 历史会话级拥挤度 → 按程（veh_index=0）迁移，旧 2/3 按语义映射为 3/4
  const migrated = await q(
    `INSERT INTO ride_crowd (session_id, veh_index, level, route_code)
     SELECT s.id, 0,
            CASE s.crowd_level WHEN 2 THEN 3 WHEN 3 THEN 4 ELSE s.crowd_level END,
            s.route_code
       FROM timer_sessions s
      WHERE s.crowd_level IS NOT NULL
        AND s.deleted_at IS NULL
        AND NOT COALESCE(s.is_test, false)
        AND NOT EXISTS (
          SELECT 1 FROM ride_crowd rc WHERE rc.session_id = s.id AND rc.veh_index = 0
        )
      RETURNING session_id, level`,
  );
  console.log(
    `② 迁移历史拥挤度 ${migrated.length} 条：${
      migrated.map((r) => `sid=${r.session_id}→${r.level}`).join(", ") || "(无待迁移)"
    }`,
  );

  // 核对
  const rows = await q(
    `SELECT rc.session_id, rc.veh_index, rc.level, rc.route_code
       FROM ride_crowd rc JOIN timer_sessions s ON s.id = rc.session_id
      WHERE s.deleted_at IS NULL AND NOT COALESCE(s.is_test, false)
      ORDER BY rc.session_id, rc.veh_index`,
  );
  console.log(`\n当前 ride_crowd（真实样本）共 ${rows.length} 条：`);
  for (const r of rows)
    console.log(`  sid=${r.session_id} 第${Number(r.veh_index) + 1}程 level=${r.level} ${r.route_code ?? ""}`);

  console.log(`\n✅ v0.18.0 迁移完成（${target}）`);
  await pool.end();
}

main().catch((e) => {
  console.error("迁移失败：", e);
  process.exit(1);
});
