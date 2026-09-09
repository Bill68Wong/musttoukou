import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const preferredRegion = "sin1";

/** GET /api/free/[id] —— 会话详情 + 逐站事件（结束页汇总用） */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const rideId = Number(id);
    const pool = getPool();
    const ride = await pool.query(
      `SELECT id, route_code, dsat_dir, board_station, alight_station,
              vehicle_plate, vehicle_code, crowd_level, started_at, ended_at, total_ms, is_test
         FROM free_rides WHERE id = $1 AND deleted_at IS NULL`,
      [rideId],
    );
    if (!ride.rows.length) {
      return NextResponse.json({ ok: false, error: "不存在" }, { status: 404 });
    }
    const events = await pool.query(
      `SELECT id, seq, event_type, station_code, recorded_at
         FROM free_ride_events WHERE free_ride_id = $1 ORDER BY seq`,
      [rideId],
    );
    return NextResponse.json({ ok: true, ride: ride.rows[0], events: events.rows });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
