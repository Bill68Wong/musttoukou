import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getBusPositions } from "@/lib/dsat/client";
import { RISK } from "@/config/risk";

/** 就近部署：Supabase 新加坡池化器 → sin1 */
export const preferredRegion = "sin1";

/**
 * POST /api/dsat/grab { sessionId, station? }
 * 打点（board：上车）成功后由前端触发：抓"用户实际乘坐的那辆车"存入 session.vehicle_*
 *
 * v0.4.0 语义修正：不再用 wait_start 时"任意第一辆"。
 * 上车那一刻 → 查线路实时车辆，优先选停靠在上车站（station 命中、status='1'）的车；
 * 找不到再退而求其次（status='0' 正驶向该站 → 该车即刚上/即将上的车），
 * 仍找不到才回退旧逻辑（线路任意第一辆），保证尽量不丢数据。
 * 命中后同时落一条 stage='board' 的 bus_snapshots（车牌级追踪闭环）。
 * 经风控守卫；任何失败都静默留空，绝不影响计时主流程。
 */

/** 站码三段式匹配（含上车站可能带 / 子码） */
function sameStation(code: string | undefined, target: string | undefined): boolean {
  if (!code || !target) return false;
  if (code === target) return true;
  if (code.startsWith(target + "/") || target.startsWith(code + "/")) return true;
  return false;
}

export async function POST(req: NextRequest) {
  try {
    if (!RISK.timerGrab.enabled) {
      return NextResponse.json({ ok: true, skipped: "disabled" });
    }

    const { sessionId, station } = (await req.json()) as {
      sessionId?: number;
      station?: string;
    };
    if (!sessionId) return NextResponse.json({ error: "缺少 sessionId" }, { status: 400 });

    const pool = getPool();
    const sessRes = await pool.query(
      `SELECT id, route_code, dsat_dir, plan_id FROM timer_sessions
       WHERE id = $1 AND vehicle_plate IS NULL AND ended_at IS NULL`,
      [sessionId],
    );
    const session = sessRes.rows[0] as
      | { id: number; route_code: string | null; dsat_dir: string | null; plan_id: number | null }
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

    // 候选：停在上车站的车（status='1' 已到 / '0' 正驶入）；都无 → 全线路第一辆兜底
    let pick: { plate: string | null; code: string | null; atStation: string; status: string | null; speed: string | number | null } | null = null;
    let fallbackFirst: { plate: string | null; code: string | null; atStation: string; status: string | null; speed: string | number | null } | null = null;
    const atUserStop: { plate: string | null; code: string | null; atStation: string; status: string | null; speed: string | number | null }[] = [];
    for (const st of result.data.routeInfo) {
      if (!st.busInfo?.length) continue;
      const isUserStop = station ? sameStation(st.staCode, station) : false;
      for (const b of st.busInfo) {
        const item = {
          plate: b.busPlate ?? null,
          code: b.busCode ?? null,
          atStation: st.staCode,
          status: b.status ?? null,
          speed: b.speed ?? null,
        };
        if (!fallbackFirst) fallbackFirst = item;
        if (isUserStop) atUserStop.push(item);
      }
    }
    pick =
      atUserStop.find((b) => b.status === "1") ??
      atUserStop.find((b) => b.status === "0") ??
      atUserStop[0] ??
      fallbackFirst;

    if (pick?.plate || pick?.code) {
      await pool.query(
        `UPDATE timer_sessions SET vehicle_plate = $1, vehicle_code = $2 WHERE id = $3`,
        [pick.plate, pick.code, session.id],
      );
      // 车牌级追踪闭环：记 board 时点的实际乘坐车辆快照
      try {
        const speed = Number(pick.speed);
        await pool.query(
          `INSERT INTO bus_snapshots
             (route_code, dsat_dir, station_code, bus_plate, bus_code,
              speed_kmh, status, session_id, stage, ref_station, stops_away)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'board',$9,0)`,
          [
            session.route_code,
            session.dsat_dir,
            pick.atStation,
            pick.plate,
            pick.code,
            Number.isFinite(speed) ? Math.round(speed) : null,
            pick.status,
            session.id,
            station ?? pick.atStation,
          ],
        );
      } catch {
        /* 快照失败不影响主流程 */
      }
    }
    return NextResponse.json({ ok: true, plate: pick?.plate ?? null, code: pick?.code ?? null });
  } catch (err) {
    // 抓取失败永不报错给前端（不影响计时）
    console.warn("[grab] 车辆抓取异常：", (err as Error).message);
    return NextResponse.json({ ok: true, skipped: "error" });
  }
}
