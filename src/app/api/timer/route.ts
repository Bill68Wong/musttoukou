import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";

/**
 * POST /api/timer：创建计时会话 {planId}
 * 自动填充：日期/星期/时段（GMT+8）、主线路、DSAT 方向（由 route_stations 推导，未同步则为 null）
 */
export async function POST(req: NextRequest) {
  try {
    const { planId } = (await req.json()) as { planId?: number };
    if (!planId) {
      return NextResponse.json({ error: "缺少 planId" }, { status: 400 });
    }
    const pool = getPool();

    // 查方案与首个巴士/轻轨分段
    const legRes = await pool.query(
      `SELECT l.leg_kind, l.route_options, l.from_station, l.to_station
       FROM plan_legs l WHERE l.plan_id = $1 ORDER BY l.seq`,
      [planId],
    );
    const legs = legRes.rows as {
      leg_kind: string;
      route_options: string | null;
      from_station: string | null;
      to_station: string | null;
    }[];
    if (legs.length === 0) {
      return NextResponse.json({ error: "方案不存在" }, { status: 404 });
    }

    const vehicleLeg = legs.find((l) => l.leg_kind === "bus" || l.leg_kind === "lrt");
    let routeCode: string | null = null;
    let dsatDir: string | null = null;
    if (vehicleLeg) {
      const options = vehicleLeg.route_options
        ? (JSON.parse(vehicleLeg.route_options) as string[])
        : [];
      routeCode = options[0] ?? null;
      // 由 route_stations 推导方向：from 站在 to 站之前的方向
      if (routeCode && vehicleLeg.from_station && vehicleLeg.to_station) {
        // 站区匹配：同一站区不同站台用后缀区分（C690 vs C690/1、C690/2），
        // 方案里存站区主码，推导时兼容所有站台变体
        const dirRes = await pool.query(
          `SELECT dsat_dir,
                  max(seq) FILTER (WHERE station_code = $2 OR station_code LIKE $2 || '/%') AS from_seq,
                  max(seq) FILTER (WHERE station_code = $3 OR station_code LIKE $3 || '/%') AS to_seq
           FROM route_stations rs
           JOIN routes r ON rs.route_id = r.id
           WHERE r.code = $1 AND r.kind = 'bus'
           GROUP BY dsat_dir`,
          [routeCode, vehicleLeg.from_station, vehicleLeg.to_station],
        );
        let singleDir: string | null = null;
        let dirCount = 0;
        for (const row of dirRes.rows as {
          dsat_dir: string;
          from_seq: number | null;
          to_seq: number | null;
        }[]) {
          if (row.from_seq !== null && row.to_seq !== null) {
            dirCount++;
            singleDir = row.dsat_dir;
          }
          if (row.from_seq !== null && row.to_seq !== null && row.from_seq < row.to_seq) {
            dsatDir = row.dsat_dir;
            break;
          }
        }
        // 兜底：循环线只有一套站序（回程 from_seq > to_seq 匹配不上），
        // 两站都在该方向的站序里时直接用这唯一方向。
        if (!dsatDir && dirCount === 1 && singleDir) {
          dsatDir = singleDir;
        }
      }
    }

    // 澳门时间（GMT+8）
    const now = new Date();
    const macau = new Date(now.getTime() + 8 * 3600 * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    const travelDate = `${macau.getUTCFullYear()}-${p(macau.getUTCMonth() + 1)}-${p(macau.getUTCDate())}`;
    const weekday = macau.getUTCDay();

    const ins = await pool.query(
      `INSERT INTO timer_sessions
         (plan_id, route_code, dsat_dir, travel_date, weekday, started_at)
       VALUES ($1, $2, $3, $4, $5, now())
       RETURNING id`,
      [planId, routeCode, dsatDir, travelDate, weekday],
    );
    const sessionId = (ins.rows[0] as { id: number }).id;
    return NextResponse.json({ sessionId });
  } catch (err) {
    console.error("[timer] 创建失败：", (err as Error).message);
    return NextResponse.json({ error: "创建计时会话失败" }, { status: 500 });
  }
}
