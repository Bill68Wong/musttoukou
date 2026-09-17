/**
 * v0.16.1 迁移（db/migrate-v161.ts）
 * 用法：npm run db:migrate-v161 -- [local|cloud]
 *
 * 背景（2026-09-07 用户实测反馈，修复数据）：
 *   1. 去横琴口岸莲花路停车场换乘：T355/1↔T355/2 同场相邻站台，跨台不计步行
 *      → home-hengqin-1 transfer 段显式 minutes=0（权威源 data/commute-network.json 同步）
 *   2. 到横琴/关闸「通关完即结束行程并结算」（无多余收尾步）
 *      → 代码层 border_end 自动结算（v0.16.1 events route）；
 *        历史真实会话尾部 arrive 对齐 border_end 时刻并重算 total
 *      （用户确认修复范围：sid=128 去拱北 + sid=155 去横琴，均 is_test=false）
 *
 * ⚠️ 本脚本动计时表属用户明确授权的历史数据修复（仅限指定真实会话、幂等可重复执行）；
 * 其余部分只按 JSON 权威源对齐静态方案数据。
 */
import { readFileSync } from "fs";
import { join } from "path";
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
const q = async (sql: string, args?: unknown[]) => (await pool.query(sql, args)).rows as Record<string, unknown>[];

/** 时段分桶（GMT+8），与 src/lib/timer-flow.timeBucketOf 一致 */
function timeBucketOfUtc(utcMs: number): string {
  const h = new Date(utcMs + 8 * 3600 * 1000).getUTCHours();
  if (h >= 7 && h < 10) return "am_peak";
  if (h >= 10 && h < 17) return "day";
  if (h >= 17 && h < 20) return "pm_peak";
  return "night";
}

const FIX_SIDS = [128, 155];

async function main() {
  // ========== 1. home-hengqin-1 transfer minutes=0（JSON 权威同步） ==========
  const json = JSON.parse(readFileSync(join(__dirname, "..", "data", "commute-network.json"), "utf8")) as {
    plans: { id: string; legs: { seq: number; kind: string; minutes?: number | null }[] }[];
  };
  const plan = json.plans.find((p) => p.id === "home-hengqin-1");
  const transferLeg = plan?.legs.find((l) => l.kind === "transfer");
  if (transferLeg) {
    const r = await q(
      `UPDATE plan_legs l
       SET minutes = $1
       FROM commute_plans p
       WHERE p.plan_key = 'home-hengqin-1' AND l.plan_id = p.id AND l.leg_kind = 'transfer'
       RETURNING l.seq, l.minutes`,
      [transferLeg.minutes ?? null],
    );
    console.log(`1) home-hengqin-1 transfer minutes → ${r[0]?.minutes ?? null}（JSON: ${transferLeg.minutes ?? null}）`);
  }

  // ========== 2. 历史真实会话修复（用户授权：128 去拱北 / 155 去横琴） ==========
  const sids = FIX_SIDS;
  const before = await q(
    `SELECT s.id, s.total_minutes, s.border_minutes, s.ended_at,
            (SELECT recorded_at FROM timer_events e WHERE e.session_id = s.id AND e.event_type = 'arrive') AS arrive_at,
            (SELECT recorded_at FROM timer_events e WHERE e.session_id = s.id AND e.event_type = 'border_end') AS border_end_at
     FROM timer_sessions s
     WHERE s.id = ANY($1) AND s.is_test = false AND s.deleted_at IS NULL`, [sids],
  );
  for (const b of before) {
    console.log(`2) sid=${b.id} 修复前 total=${b.total_minutes} border=${b.border_minutes} arrive=${String(b.arrive_at).slice(11, 19)} border_end=${String(b.border_end_at).slice(11, 19)}`);
  }

  // 2a. arrive 时间戳对齐 border_end（幂等：仅当 arrive 晚于其 border_end 时执行）
  const aligned = await q(
    `UPDATE timer_events e
     SET recorded_at = be.recorded_at
     FROM (
       SELECT session_id, max(recorded_at) AS recorded_at
       FROM timer_events WHERE event_type = 'border_end' AND session_id = ANY($1)
       GROUP BY session_id
     ) be
     WHERE e.session_id = ANY($1) AND e.event_type = 'arrive'
       AND e.session_id = be.session_id AND e.recorded_at > be.recorded_at
     RETURNING e.session_id, e.recorded_at`, [sids],
  );
  console.log(`2a) arrive 对齐 border_end：${aligned.length ? aligned.map((r) => `sid=${r.session_id}@${String(r.recorded_at).slice(11, 19)}`).join(", ") : "无需对齐（已一致）"}`);

  // 2b. 以 arrive（=通关完成）时刻收尾重算：ended_at/total_minutes/border_minutes/time_bucket
  const arr = await q(
    `SELECT session_id, recorded_at FROM timer_events WHERE event_type = 'arrive' AND session_id = ANY($1)`, [sids],
  );
  for (const a of arr) {
    const sid = a.session_id as number;
    const recMs = new Date(a.recorded_at as string).getTime();
    // 与 events route settle 同口径：总时长 - 暂停闭合 - 通关闭合
    const r = await q(
      `SELECT
         extract(epoch from ($1::timestamptz - coalesce(
           (SELECT min(recorded_at) FROM timer_events WHERE session_id = $2 AND event_type = 'depart'),
           (SELECT started_at FROM timer_sessions WHERE id = $2)))) AS raw_sec,
         COALESCE((
           SELECT sum(extract(epoch from (resume_at - pause_at)))
           FROM (
             SELECT recorded_at AS pause_at, lead(recorded_at) OVER w AS resume_at,
                    lead(event_type) OVER w AS resume_type
             FROM timer_events WHERE session_id = $2 AND event_type IN ('pause', 'resume')
             WINDOW w AS (ORDER BY seq, id)
           ) pr WHERE pr.resume_type = 'resume'), 0) AS pause_sec,
         COALESCE((
           SELECT sum(extract(epoch from (border_end_at - border_start_at)))
           FROM (
             SELECT recorded_at AS border_start_at, lead(recorded_at) OVER w AS border_end_at,
                    lead(event_type) OVER w AS border_end_type
             FROM timer_events WHERE session_id = $2 AND event_type IN ('border_start', 'border_end')
             WINDOW w AS (ORDER BY seq, id)
           ) bb WHERE bb.border_end_type = 'border_end'), 0) AS border_sec`,
      [a.recorded_at, sid],
    );
    const raw = Number(r[0].raw_sec);
    const pause = Number(r[0].pause_sec);
    const border = Number(r[0].border_sec);
    const total = Math.round(Math.max(0, (raw - pause - border) / 60) * 10) / 10;
    const borderMin = Math.round(Math.max(0, border / 60) * 10) / 10;
    const bucket = timeBucketOfUtc(recMs);
    const upd = await q(
      `UPDATE timer_sessions
       SET ended_at = $1, total_minutes = $2, border_minutes = $3, time_bucket = $4
       WHERE id = $5 AND deleted_at IS NULL AND is_test = false
       RETURNING id`, [a.recorded_at, total, borderMin, bucket, sid],
    );
    if (upd.length) console.log(`2b) sid=${sid} 重算完成 → total=${total}min border=${borderMin}min bucket=${bucket}（收尾时刻=${new Date(recMs).toISOString().slice(11, 19)}Z）`);
  }

  // 2c. 校验输出
  const after = await q(
    `SELECT s.id, s.total_minutes, s.border_minutes,
            (SELECT count(*) FROM timer_events e WHERE e.session_id = s.id AND e.event_type = 'arrive' AND e.recorded_at <= coalesce((SELECT max(recorded_at) FROM timer_events e2 WHERE e2.session_id = s.id AND e2.event_type = 'border_end'), '1970-01-01')) AS arrive_le_border
     FROM timer_sessions s WHERE s.id = ANY($1)`, [sids],
  );
  for (const b of after) console.log(`2c) sid=${b.id} 修复后 total=${b.total_minutes} border=${b.border_minutes} arrive≤border_end=${b.arrive_le_border}`);
  console.log(`\n✅ v0.16.1 迁移完成（${target}）`);
  await pool.end();
}

main().catch((e) => {
  console.error("迁移失败：", e);
  process.exit(1);
});
