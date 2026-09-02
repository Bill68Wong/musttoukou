import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { timeBucketOf, type EventType } from "@/lib/timer-flow";

const VALID_EVENTS: EventType[] = [
  "depart",
  "wait_start",
  "missed",
  "board",
  "station_arrive",
  "alight",
  "border_start",
  "border_end",
  "arrive",
];

/**
 * POST /api/timer/[id]/events
 * body: { type: EventType, station_code?: string }
 *       { type: "wait_snapshot", value: number, value_kind: "stops"|"minutes" }  → 写 wait_snapshots
 *
 * arrive 事件触发收尾：ended_at / total_minutes / time_bucket（GMT+8）
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
    if (body.type === "wait_snapshot") {
      if (typeof body.value !== "number" || !body.value_kind) {
        return NextResponse.json({ error: "快照参数错误" }, { status: 400 });
      }
      await pool.query(
        `INSERT INTO wait_snapshots (session_id, value_kind, value) VALUES ($1, $2, $3)`,
        [sessionId, body.value_kind, body.value],
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
