import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getBusPositions } from "@/lib/dsat/client";
import { RISK } from "@/config/risk";

/**
 * POST /api/dsat/grab {sessionId}
 * 打点（wait_start）后由前端触发：抓该线路当时在线车辆，存入 session.vehicle_*
 * 经风控守卫；任何失败都静默留空，绝不影响计时主流程。
 */
export async function POST(req: NextRequest) {
  try {
    if (!RISK.timerGrab.enabled) {
      return NextResponse.json({ ok: true, skipped: "disabled" });
    }

    const { sessionId } = (await req.json()) as { sessionId?: number };
    if (!sessionId) return NextResponse.json({ error: "缺少 sessionId" }, { status: 400 });

    const pool = getPool();
    const sessRes = await pool.query(
      `SELECT id, route_code, dsat_dir FROM timer_sessions
       WHERE id = $1 AND vehicle_plate IS NULL AND ended_at IS NULL`,
      [sessionId],
    );
    const session = sessRes.rows[0] as
      | { id: number; route_code: string | null; dsat_dir: string | null }
      | undefined;
    if (!session) {
      // 不存在 / 已抓到 / 已结束 → 幂等跳过
      return NextResponse.json({ ok: true, skipped: "no_need" });
    }
    if (!session.route_code || !session.dsat_dir) {
      // 方向未知（route_stations 未同步）→ 不猜，留空
      return NextResponse.json({ ok: true, skipped: "no_dir" });
    }

    const result = await getBusPositions(session.route_code, session.dsat_dir, "timer_grab");
    if (!result.ok || !result.data?.routeInfo) {
      return NextResponse.json({ ok: true, skipped: "dsat_fail", error: result.error });
    }

    // 取第一辆在线车（v1 策略：线路当前任意一辆；后续可按邻近站细化）
    let plate: string | null = null;
    let code: string | null = null;
    for (const st of result.data.routeInfo) {
      if (st.busInfo?.length) {
        plate = st.busInfo[0].busPlate ?? null;
        code = st.busInfo[0].busCode ?? null;
        break;
      }
    }

    if (plate || code) {
      await pool.query(
        `UPDATE timer_sessions SET vehicle_plate = $1, vehicle_code = $2 WHERE id = $3`,
        [plate, code, session.id],
      );
    }
    return NextResponse.json({ ok: true, plate, code });
  } catch (err) {
    // 抓取失败永不报错给前端（不影响计时）
    console.warn("[grab] 车辆抓取异常：", (err as Error).message);
    return NextResponse.json({ ok: true, skipped: "error" });
  }
}
