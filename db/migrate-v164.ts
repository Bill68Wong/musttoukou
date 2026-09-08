/**
 * v0.16.4 迁移（db/migrate-v164.ts）
 * 用法：npm run db:migrate-v164 -- [local|cloud]
 *
 * 背景（2026-09-08 实测反馈）：莲花路同场换乘要「从根源上删除转车期间的
 * 到站等车」——步骤模型（buildSteps）已对该换乘不再生成 wait_start 步
 * （transfer minutes=0 的后段直接 board），本迁移清理历史真实会话中残留的
 * 转车 wait_start 事件（如 sid=155：alight(莲花路) 后紧跟的 wait_start），
 * 使事件链同样不存在「到站等车」记录（等车时长隐含 = board − alight）。
 *
 * 删除条件（幂等）：wait_start 紧邻其前一条 alight（seq 差 1）且会话方案
 * 含 transfer minutes=0（同场换乘）。仅处理 is_test=false 且未软删的真实样本。
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
  const before = await q(
    `SELECT ws.session_id, ws.id AS ws_id, ws.seq, al.seq AS alight_seq
     FROM timer_events ws
     JOIN timer_events al ON al.session_id = ws.session_id AND al.seq = ws.seq - 1
     JOIN timer_sessions s ON s.id = ws.session_id
     JOIN commute_plans p ON p.id = s.plan_id
     WHERE ws.event_type = 'wait_start' AND al.event_type = 'alight'
       AND s.is_test = false AND s.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM plan_legs tr WHERE tr.plan_id = p.id AND tr.leg_kind = 'transfer' AND tr.minutes = 0)
     ORDER BY ws.session_id`,
  );
  console.log(`待删除的同场换乘 wait_start ${before.length} 条:`);
  for (const b of before) console.log(`  sid=${b.session_id} wait_start#${b.ws_id}(seq ${b.seq}) ← alight(seq ${b.alight_seq})`);

  const del = await q(
    `DELETE FROM timer_events ws
     USING timer_events al, timer_sessions s, commute_plans p
     WHERE ws.event_type = 'wait_start'
       AND al.event_type = 'alight'
       AND al.session_id = ws.session_id
       AND al.seq = ws.seq - 1
       AND ws.session_id = s.id
       AND s.plan_id = p.id
       AND s.is_test = false AND s.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM plan_legs tr WHERE tr.plan_id = p.id AND tr.leg_kind = 'transfer' AND tr.minutes = 0)
     RETURNING ws.session_id, ws.id`,
  );
  console.log(`已删除 ${del.length} 条：${[...new Set(del.map((r) => `sid=${r.session_id}`))].join(", ") || "(无)"}`);
  console.log(`\n✅ v0.16.4 迁移完成（${target}）`);
  await pool.end();
}

main().catch((e) => {
  console.error("迁移失败：", e);
  process.exit(1);
});
