import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { type FreeEventType } from "@/lib/free-shared";

export const preferredRegion = "sin1";

/**
 * POST /api/free/[id]/events { type, station }
 * type: stop_arrive（到站）/ stop_pass（甩站·仅巴士）/ stop_skip（忘记·已过站） / alight（下车=结束）
 * alight 时结算：ended_at = now；total_ms = ended_at - started_at；alight_station = station。
 */
const VALID: FreeEventType[] = ["stop_arrive", "stop_pass", "stop_skip", "alight"];

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const rideId = Number(id);
    const body = (await req.json()) as { type?: string; station?: string };
    const type = body.type as FreeEventType;
    if (!VALID.includes(type)) {
      return NextResponse.json({ ok: false, error: "无效的事件类型" }, { status: 400 });
    }
    const station = body.station?.trim() || null;
    if (!station) return NextResponse.json({ ok: false, error: "缺少 station" }, { status: 400 });

    const pool = getPool();
    const ride = await pool.query(
      `SELECT id, started_at FROM free_rides
        WHERE id = $1 AND ended_at IS NULL AND deleted_at IS NULL`,
      [rideId],
    );
    if (!ride.rows.length) {
      return NextResponse.json({ ok: false, error: "会话不存在或已结束" }, { status: 404 });
    }
    const started = ride.rows[0].started_at as Date;
    const seqRes = await pool.query(
      `SELECT COALESCE(max(seq), 0)::int + 1 AS next FROM free_ride_events WHERE free_ride_id = $1`,
      [rideId],
    );
    const seq = (seqRes.rows[0] as { next: number }).next;
    const now = new Date();
    // v0.22.0：回传真实 event_id —— 前端「撤销最近一条」依赖它（同 timer 事件路由口径）
    const ins = await pool.query(
      `INSERT INTO free_ride_events (free_ride_id, seq, event_type, station_code, recorded_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [rideId, seq, type, station, now.toISOString()],
    );
    const eventId = Number(ins.rows[0].id);

    if (type === "alight") {
      const totalMs = Math.max(0, Math.round(now.getTime() - started.getTime()));
      await pool.query(
        `UPDATE free_rides
            SET ended_at = $2, alight_station = $3, total_ms = $4
          WHERE id = $1`,
        [rideId, now.toISOString(), station, totalMs],
      );
      return NextResponse.json({ ok: true, ended: true, totalMs, event_id: eventId, seq });
    }
    return NextResponse.json({
      ok: true,
      seq,
      event_id: eventId,
      station_code: station,
      recordedAt: now.toISOString(),
    });
  } catch (err) {
    console.error("[free/events] 失败：", (err as Error).message);
    return NextResponse.json({ ok: false, error: "打点失败" }, { status: 500 });
  }
}
