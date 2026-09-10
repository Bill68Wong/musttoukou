import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { stripCode } from "@/lib/free-shared";
import { sortRouteOptions } from "@/lib/timer-flow";

/** GET /api/free/options —— 全部可乘线路（全澳巴士 + 轻轨，含颜色与方向）
 *  v0.21.0：全网络（~92 巴士 + 3 轻轨）；一次批量查询避免逐线 N+1 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const pool = getPool();
    const res = await pool.query(`
      WITH stops AS (
        SELECT rs.route_id, rs.dsat_dir, rs.seq, rs.station_code, st.name_tc, st.kind
          FROM route_stations rs
          JOIN stations st ON st.code = rs.station_code
      ),
      agg AS (
        SELECT route_id, dsat_dir,
               (array_agg(
                  CASE WHEN kind = 'bus' THEN station_code || ' ' || name_tc ELSE name_tc END
                  ORDER BY seq DESC))[1] AS last_name
          FROM stops
         GROUP BY route_id, dsat_dir
      )
      SELECT r.code, r.kind, r.color, a.dsat_dir, a.last_name
        FROM routes r
        JOIN agg a ON a.route_id = r.id
       WHERE r.is_active
    `);
    const map = new Map<
      string,
      { code: string; kind: string; color: string | null; dirs: { dir: string; label: string }[] }
    >();
    for (const row of res.rows as {
      code: string;
      kind: string;
      color: string | null;
      dsat_dir: string;
      last_name: string | null;
    }[]) {
      const m = map.get(row.code) ?? { code: row.code, kind: row.kind, color: row.color, dirs: [] };
      m.dirs.push({
        dir: row.dsat_dir,
        label: row.last_name ? `往 ${stripCode(row.last_name)}` : `方向 ${row.dsat_dir}`,
      });
      map.set(row.code, m);
    }
    const out = [...map.values()];
    // 展示顺序统一：轻轨在前 + 巴士自然排序（全网络通用）
    const order = sortRouteOptions(out.map((r) => r.code));
    out.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
    return NextResponse.json({ ok: true, routes: out });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
