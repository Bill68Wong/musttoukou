/**
 * v0.16.3 迁移（db/migrate-v163.ts）
 * 用法：npm run db:migrate-v163 -- [local|cloud]
 *
 * 背景（2026-09-08 实测反馈）：去横琴莲花路停车场换乘 —— 第一程下车即到
 * 第二程等车站台（transfer minutes=0，同场相邻），下车后不应再单独点一次
 * 「到站，开始等车」；第一程 alight 与第二程 wait_start 语义上合并
 * （等车自下车时刻起算）。代码层已做同场换乘自动接续（events route 在
 * alight 后自动补 wait_start），本迁移修复既有真实会话的历史记录：
 * 「wait_start 紧邻其前一条 alight 且间隔 <15s」且方案含 transfer minutes=0
 * 的会话 → wait_start.recorded_at 对齐 alight 时刻（幂等：已对齐则不动）。
 * 仅处理 is_test=false 且未软删的真实样本。
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
  const before = await q(
    `SELECT ws.id, ws.session_id, al.recorded_at AS alight_at, ws.recorded_at AS ws_at,
            (ws.recorded_at - al.recorded_at) AS gap
     FROM timer_events ws
     JOIN timer_events al ON al.session_id = ws.session_id AND al.seq = ws.seq - 1
     JOIN timer_sessions s ON s.id = ws.session_id
     JOIN commute_plans p ON p.id = s.plan_id
     WHERE ws.event_type = 'wait_start' AND al.event_type = 'alight'
       AND ws.recorded_at > al.recorded_at
       AND ws.recorded_at - al.recorded_at < interval '15 seconds'
       AND s.is_test = false AND s.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM plan_legs tr WHERE tr.plan_id = p.id AND tr.leg_kind = 'transfer' AND tr.minutes = 0)
     ORDER BY ws.session_id`,
  );
  console.log(`待对齐的同场换乘 wait_start ${before.length} 条:`);
  for (const b of before) {
    console.log(`  sid=${b.session_id} ws#${b.id} gap=${String(b.gap).replace("00:00:0", "").replace("00:00:", "")}s`);
  }

  const upd = await q(
    `UPDATE timer_events ws
     SET recorded_at = al.recorded_at
     FROM timer_events al, timer_sessions s, commute_plans p
     WHERE ws.session_id = s.id AND al.session_id = ws.session_id
       AND ws.event_type = 'wait_start' AND al.event_type = 'alight'
       AND al.seq = ws.seq - 1
       AND ws.recorded_at > al.recorded_at
       AND ws.recorded_at - al.recorded_at < interval '15 seconds'
       AND s.plan_id = p.id AND s.is_test = false AND s.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM plan_legs tr WHERE tr.plan_id = p.id AND tr.leg_kind = 'transfer' AND tr.minutes = 0)
     RETURNING ws.session_id, ws.id, ws.recorded_at`,
  );
  console.log(`已对齐 ${upd.length} 条：${upd.map((r) => `sid=${r.session_id}`).join(", ") || "(无)"}`);
  console.log(`\n✅ v0.16.3 迁移完成（${target}）`);
  await pool.end();
}

main().catch((e) => {
  console.error("迁移失败：", e);
  process.exit(1);
});
