import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { timeBucketOf, type EventType } from "@/lib/timer-flow";

/** 就近部署：Supabase 新加坡池化器 → sin1 */
export const preferredRegion = "sin1";

const VALID_EVENTS: EventType[] = [
  "depart",
  "wait_start",
  "missed",
  "board",
  "station_arrive",
  "station_pass",
  "alight",
  "border_start",
  "border_end",
  "arrive",
];

/** 学校分区：B/C 座、N/O 座、R 座（步行分组上下文，需求 10） */
const ZONES = ["B/C", "N/O", "R"];

/**
 * POST /api/timer/[id]/events
 * body: { type: EventType, station_code?: string, from_zone?, to_zone? }
 *       { type: "wait_snapshot", value: number, value_kind: "stops"|"minutes" }  → 写 wait_snapshots
 *
 * arrive 事件触发收尾：ended_at / total_minutes / time_bucket（GMT+8）
 * from_zone/to_zone（B/C|N/O|R）：随 depart/arrive 打点附带，落到会话做步行分组
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sessionId = Number(id);
    const body = (await req.json()) as {
      type?: string;
      station_code?: string | null;
      value?: number;
      value_kind?: "stops" | "minutes";
      from_zone?: string | null;
      to_zone?: string | null;
    };
    const pool = getPool();

    // 会话存在且未结束
    const sessRes = await pool.query(
      `SELECT id, ended_at FROM timer_sessions WHERE id = $1 AND deleted_at IS NULL`,
      [sessionId],
    );
    const session = sessRes.rows[0] as { id: number; ended_at: string | null } | undefined;
    if (!session) {
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    }
    if (session.ended_at) {
      return NextResponse.json({ error: "会话已结束" }, { status: 409 });
    }

    // 等车快照：单独表
    // - minutes（轻轨手动）：同一会话同一站只保留一条（单次乘坐只记一次）；改选分钟 = 覆盖原值（UPDATE）
    // - stops（巴士自动）：走 /auto-snapshot（本路由不落 stops 手动）
    if (body.type === "wait_snapshot") {
      if (typeof body.value !== "number" || !body.value_kind) {
        return NextResponse.json({ error: "快照参数错误" }, { status: 400 });
      }
      if (body.value_kind === "stops") {
        return NextResponse.json({ error: "巴士段车距由系统自动记录" }, { status: 400 });
      }
      // 轻轨分钟（v0.9）：必须带上车站——无站行无法去重、无法归属分段，历史已清并建索引防再犯
      if (body.value_kind === "minutes" && !body.station_code) {
        return NextResponse.json({ error: "轻轨分钟快照必须带上车站 station_code" }, { status: 400 });
      }
      // 轻轨分钟：带上车站（多段轻轨各站独立）；部分唯一索引 (session_id, station_code)
      // WHERE source='manual' AND value_kind='minutes' AND station_code IS NOT NULL
      await pool.query(
        `INSERT INTO wait_snapshots (session_id, value_kind, value, source, station_code)
         VALUES ($1, 'minutes', $2, 'manual', $3)
         ON CONFLICT (session_id, station_code)
           WHERE source = 'manual' AND value_kind = 'minutes' AND station_code IS NOT NULL
         DO UPDATE SET value = EXCLUDED.value, recorded_at = now()`,
        [sessionId, body.value, body.station_code ?? null],
      );
      return NextResponse.json({ ok: true });
    }

    if (!body.type || !VALID_EVENTS.includes(body.type as EventType)) {
      return NextResponse.json({ error: `无效事件类型：${body.type}` }, { status: 400 });
    }
    const type = body.type as EventType;

    // 事件序号 = 当前最大 seq + 1
    const seqRes = await pool.query(
      `SELECT coalesce(max(seq), 0) + 1 AS next FROM timer_events WHERE session_id = $1`,
      [sessionId],
    );
    const seq = (seqRes.rows[0] as { next: number }).next;

    await pool.query(
      `INSERT INTO timer_events (session_id, seq, event_type, station_code) VALUES ($1, $2, $3, $4)`,
      [sessionId, seq, type, body.station_code ?? null],
    );

    // 学校分区随打点落到会话（B/C | N/O | R），仅合法值写入
    if (body.from_zone && ZONES.includes(body.from_zone)) {
      await pool.query(`UPDATE timer_sessions SET from_zone = $1 WHERE id = $2`, [
        body.from_zone,
        sessionId,
      ]);
    }
    if (body.to_zone && ZONES.includes(body.to_zone)) {
      await pool.query(`UPDATE timer_sessions SET to_zone = $1 WHERE id = $2`, [
        body.to_zone,
        sessionId,
      ]);
    }

    if (type === "missed") {
      await pool.query(
        `UPDATE timer_sessions SET missed_count = missed_count + 1 WHERE id = $1`,
        [sessionId],
      );
    }

    if (type === "arrive") {
      // 收尾：总时长 + 时段分桶（GMT+8）
      const now = new Date();
      const macau = new Date(now.getTime() + 8 * 3600 * 1000);
      const bucket = timeBucketOf(macau.getUTCHours());
      await pool.query(
        `UPDATE timer_sessions
         SET ended_at = now(),
             time_bucket = $2,
             total_minutes = round((extract(epoch from (now() - started_at)) / 60)::numeric, 1)
         WHERE id = $1`,
        [sessionId, bucket],
      );
      return NextResponse.json({ ok: true, finished: true });
    }

    return NextResponse.json({ ok: true, finished: false });
  } catch (err) {
    console.error("[events] 写入失败：", (err as Error).message);
    return NextResponse.json({ error: "事件写入失败" }, { status: 500 });
  }
}
