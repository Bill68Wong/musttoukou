import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

/** GET /api/free/stations —— 全部站点（bus 名带码前缀；轻轨纯名），供「站点方式」搜索 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const pool = getPool();
    const res = await pool.query(
      `SELECT code,
              (CASE WHEN kind = 'bus' THEN code || ' ' || name_tc ELSE name_tc END) AS name,
              kind
         FROM stations
        WHERE dsat_synced
        ORDER BY kind = 'bus' DESC, name_tc`,
    );
    return NextResponse.json({ ok: true, stations: res.rows });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
