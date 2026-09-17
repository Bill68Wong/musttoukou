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

const target = (process.argv[2] ?? "cloud") as "local" | "cloud";
const dbUrl = target === "cloud" ? process.env.DATABASE_URL : (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);
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
  // v0.18.1：来源标记（'in_ride' 行程内记录 / 'migrated' 旧会话级迁移）
  await q(`ALTER TABLE ride_crowd ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'in_ride'`);
  console.log("① ride_crowd 表就绪");

  // ② 历史会话级拥挤度 → 按程（veh_index=0）迁移，旧 2/3 按语义映射为 3/4
  //    v0.18.1：created_at 直接回填为「该会话第一程的上车时刻」（旧模型未存时刻 → 迁移时刻无意义）
  const migrated = await q(
    `INSERT INTO ride_crowd (session_id, veh_index, level, route_code, created_at, source)
     SELECT s.id, 0,
            CASE s.crowd_level WHEN 2 THEN 3 WHEN 3 THEN 4 ELSE s.crowd_level END,
            s.route_code,
            COALESCE(
              (SELECT min(e.recorded_at) FROM timer_events e
                WHERE e.session_id = s.id AND e.event_type = 'board'),
              (SELECT min(e.recorded_at) FROM timer_events e
                WHERE e.session_id = s.id AND e.event_type = 'wait_start'),
              s.started_at,
              now()
            ),
            'migrated'
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

  // ③ v0.18.1：修正「首次迁移时 created_at 记为迁移时刻」的历史记录——
  //    回填为「该会话第一程上车时刻」并标记 source='migrated'（幂等：已标记则跳过）
  const fixed = await q(
    `UPDATE ride_crowd rc
        SET created_at = COALESCE(
              (SELECT min(e.recorded_at) FROM timer_events e
                WHERE e.session_id = rc.session_id AND e.event_type = 'board'),
              (SELECT min(e.recorded_at) FROM timer_events e
                WHERE e.session_id = rc.session_id AND e.event_type = 'wait_start'),
              (SELECT s.started_at FROM timer_sessions s WHERE s.id = rc.session_id),
              rc.created_at),
            source = 'migrated'
      WHERE rc.veh_index = 0
        AND rc.source <> 'migrated'
        AND EXISTS (SELECT 1 FROM timer_sessions s
                     WHERE s.id = rc.session_id AND s.crowd_level IS NOT NULL)
      RETURNING session_id`,
  );
  console.log(`③ 回填历史记录时刻 ${fixed.length} 条`);

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

  // 展开：每条拥挤度 + 该程上下车时刻 + 同程车牌（join 得到，不在本表冗余）
  const detail = await q(
    `SELECT rc.session_id, rc.veh_index, rc.level, rc.source,
            to_char(rc.created_at AT TIME ZONE 'Asia/Macau', 'MM-DD HH24:MI:SS') AS at,
            (SELECT to_char(min(e.recorded_at) AT TIME ZONE 'Asia/Macau','HH24:MI')
               FROM timer_events e WHERE e.session_id = rc.session_id AND e.event_type = 'board') AS board_t,
            -- 实际乘坐的那辆：上车/下车抓拍里「距参照站最近」的那条（stops_away 最小）
            (SELECT b.bus_plate FROM bus_snapshots b
              WHERE b.session_id = rc.session_id AND b.bus_plate IS NOT NULL
                AND b.stage IN ('board', 'alight')
              ORDER BY b.stops_away ASC NULLS LAST, b.polled_at DESC
              LIMIT 1) AS plate
       FROM ride_crowd rc
       JOIN timer_sessions s ON s.id = rc.session_id
      WHERE s.deleted_at IS NULL AND NOT COALESCE(s.is_test, false)
      ORDER BY rc.session_id, rc.veh_index`,
  );
  console.log("\n绑定上下文（join 行程得到，非本表冗余）：");
  for (const r of detail)
    console.log(
      `  sid=${r.session_id} 第${Number(r.veh_index) + 1}程 level=${r.level} [${r.source}] 记录于 ${r.at}`
      + ` 上车 ${r.board_t ?? "—"} 车牌 ${r.plate ?? "—（轻轨/无快照）"}`,
    );

  console.log(`\n✅ v0.18.0 迁移完成（${target}）`);
  await pool.end();
}

main().catch((e) => {
  console.error("迁移失败：", e);
  process.exit(1);
});
