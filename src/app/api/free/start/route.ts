import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { freeStopsOf, grabFreeVehicle } from "@/lib/free-ride";

export const preferredRegion = "sin1";

/**
 * POST /api/free/start { route, dir, boardStation }
 * 创建自由记站会话 = 上车（board）打点一步完成：
 *   写 free_rides 行（含方向/上车站/开始时刻）+ board 事件 + 抓实际车牌（巴士；轻轨无）。
 * v0.23.0：测试模式已移除 → is_test 恒 false（不再读 cookie）
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      route?: string;
      dir?: string;
      boardStation?: string;
    };
    const route = body.route?.trim();
    const dir = body.dir?.trim() || "0";
    const boardStation = body.boardStation?.trim() || null;
    if (!route || !boardStation) {
      return NextResponse.json({ ok: false, error: "缺少 route / boardStation" }, { status: 400 });
    }
    const pool = getPool();
    const now = new Date();
    const ins = await pool.query(
      `INSERT INTO free_rides (route_code, dsat_dir, board_station, started_at, is_test)
       VALUES ($1, $2, $3, $4, false) RETURNING id`,
      [route, dir, boardStation, now.toISOString()],
    );
    const id = (ins.rows[0] as { id: number }).id;
    // v0.22.0：回传 board 的 event_id —— riding 页「本程已记」从上车那条就开始列，
    // 撤销按钮也随之立即可用（此前首次打点前看不到任何已记条目）
    const bEvt = await pool.query(
      `INSERT INTO free_ride_events (free_ride_id, seq, event_type, station_code, recorded_at)
       VALUES ($1, 1, 'board', $2, $3) RETURNING id`,
      [id, boardStation, now.toISOString()],
    );

    // 抓实际车牌（异步静默，失败留空；轻轨直接跳过）
    const veh = await grabFreeVehicle(route, dir, boardStation);
    if (veh?.plate || veh?.code) {
      await pool.query(
        `UPDATE free_rides SET vehicle_plate = $2, vehicle_code = $3 WHERE id = $1`,
        [id, veh.plate, veh.code],
      );
    }

    // 上车站是否在该方向站序中（客户端已保证；复核供调试）
    const stops = await freeStopsOf(route, dir);
    const boardIdx = stops.findIndex((s) => s.code === boardStation);
    return NextResponse.json({
      ok: true,
      id,
      vehiclePlate: veh?.plate ?? null,
      vehicleCode: veh?.code ?? null,
      boardIdx,
      stopCount: stops.length,
      boardEventId: Number(bEvt.rows[0].id),
      startedAt: now.toISOString(),
    });
  } catch (err) {
    console.error("[free/start] 失败：", (err as Error).message);
    return NextResponse.json({ ok: false, error: "启动失败" }, { status: 500 });
  }
}
