import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";

/** GET /api/free/station-routes?station= —— 该站能乘的线路（含方向、颜色） */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const station = req.nextUrl.searchParams.get("station")?.trim() ?? "";
    if (!station) return NextResponse.json({ ok: false, error: "缺少 station" }, { status: 400 });
    const pool = getPool();
    // 精确法：route_stations 里直接停靠该站（含 / 子码精确串）的线路
    const hit = await pool.query(
      `SELECT DISTINCT r.code, r.kind, r.color, rs.dsat_dir
         FROM route_stations rs
         JOIN routes r ON rs.route_id = r.id
        WHERE r.is_active AND rs.station_code = $1
        ORDER BY r.code, rs.dsat_dir`,
      [station],
    );
    const hits = hit.rows as { code: string; kind: string; color: string | null; dsat_dir: string }[];
    const map = new Map<string, { code: string; kind: string; color: string | null; dirs: string[] }>();
    for (const h of hits) {
      const m = map.get(h.code) ?? { code: h.code, kind: h.kind, color: h.color, dirs: [] };
      if (!m.dirs.includes(h.dsat_dir)) m.dirs.push(h.dsat_dir);
      map.set(h.code, m);
    }
    return NextResponse.json({ ok: true, routes: [...map.values()] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
