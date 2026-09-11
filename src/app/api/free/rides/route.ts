import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const preferredRegion = "sin1";

/**
 * GET /api/free/rides —— 自由记站历史行程列表（v0.22.0，/free/history 页用）
 * v0.23.0：测试模式已移除 → 一律排除 is_test=true（测试数据不再展示），不再读 cookie
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const pool = getPool();
    const res = await pool.query(
      `SELECT fr.id, fr.route_code, fr.dsat_dir, fr.board_station, fr.alight_station,
              fr.vehicle_plate, fr.crowd_level, fr.started_at, fr.ended_at, fr.total_ms,
              (SELECT color FROM routes r WHERE r.code = fr.route_code LIMIT 1) AS route_color,
              -- 站名：自由记站的站码带站台后缀（T373/2），stations 表存主码 → 三段式回退
              (SELECT name_tc FROM stations s
                WHERE s.code = fr.board_station OR fr.board_station LIKE s.code || '/%'
                LIMIT 1) AS board_name,
              (SELECT name_tc FROM stations s
                WHERE s.code = fr.alight_station OR fr.alight_station LIKE s.code || '/%'
                LIMIT 1) AS alight_name,
              (SELECT count(*)::int FROM free_ride_events e
                WHERE e.free_ride_id = fr.id) AS event_count,
              (SELECT count(*)::int FROM free_ride_events e
                WHERE e.free_ride_id = fr.id
                  AND e.event_type IN ('stop_arrive','stop_pass')) AS timed_count
         FROM free_rides fr
        WHERE fr.deleted_at IS NULL
          AND NOT COALESCE(fr.is_test, false)
        ORDER BY fr.started_at DESC
        LIMIT 200`,
    );
    return NextResponse.json({ ok: true, rides: res.rows });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
