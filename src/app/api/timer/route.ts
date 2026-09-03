import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { deriveBusDir } from "@/lib/dsat/eta";

/** 就近部署：Supabase 新加坡池化器 → sin1 */
export const preferredRegion = "sin1";

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
      // 由共享推导（src/lib/dsat/eta.ts）：from 站在 to 站之前的方向；
      // 循环线兜底（仅一套站序时用唯一方向）；轻轨无站序 → null（保持历史语义）
      if (
        routeCode &&
        vehicleLeg.leg_kind === "bus" &&
        vehicleLeg.from_station &&
        vehicleLeg.to_station
      ) {
        dsatDir = await deriveBusDir(
          routeCode,
          vehicleLeg.from_station,
          vehicleLeg.to_station,
          "0",
        );
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
