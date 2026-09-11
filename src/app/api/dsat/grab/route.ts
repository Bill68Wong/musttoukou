import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getBusPositions } from "@/lib/dsat/client";
import { deriveRouteDir } from "@/lib/dsat/eta";
import { RISK } from "@/config/risk";

/** 就近部署：Supabase 新加坡池化器 → sin1 */
export const preferredRegion = "sin1";

/**
 * POST /api/dsat/grab { sessionId, station?, route?, stage?, atStation? }
 * 打点（board：上车 / alight：下车）成功后由前端触发：抓"用户实际乘坐的那辆车"入库。
 *
 * v0.4.0：语义为上车那一刻；v0.14.1 起每段上/下车都抓（不再只首段一次）：
 *   - route：该段实乘线路（多线候选段用户所选的线，前端 chips 决定；单线段=唯一线）
 *   - station：该段上车站（服务端据此定位方案 bus 分段并推导实乘线方向）
 *   - stage：'board' | 'alight'
 *   - atStation：抓取候选站（board=上车站；alight=实际停靠台，如乘 50 落 T355/1）
 * 命中后写一条 stage 快照到 bus_snapshots（车牌级追踪闭环，每段独立一条）；
 * session.vehicle_plate / vehicle_code 仅在首次（首段）填入，语义仍为首段实乘车辆。
 * 经风控守卫；任何失败静默留空，绝不影响计时主流程。
 */

/** 站码三段式匹配（含上车站可能带 / 子码） */
function sameStation(code: string | undefined, target: string | undefined): boolean {
  if (!code || !target) return false;
  if (code === target) return true;
  if (code.startsWith(target + "/") || target.startsWith(code + "/")) return true;
  return false;
}

interface GrabBody {
  sessionId?: number;
  /** 该段上车站（定位方案分段用） */
  station?: string;
  /** 该段实乘线路（多线段选了哪路） */
  route?: string | null;
  /** 'board' | 'alight' */
  stage?: string;
  /** 抓取候选站（board=上车站；alight=实际停靠台） */
  atStation?: string;
}

export async function POST(req: NextRequest) {
  try {
    if (!RISK.timerGrab.enabled) {
      return NextResponse.json({ ok: true, skipped: "disabled" });
    }

    const { sessionId, station, route, stage, atStation } = (await req.json()) as GrabBody;
    if (!sessionId) return NextResponse.json({ error: "缺少 sessionId" }, { status: 400 });
    const grabStage = stage === "alight" ? "alight" : "board";

    const pool = getPool();
    const sessRes = await pool.query(
      `SELECT id, route_code, dsat_dir, plan_id FROM timer_sessions
       WHERE id = $1 AND ended_at IS NULL AND deleted_at IS NULL`,
      [sessionId],
    );
    const session = sessRes.rows[0] as
      | { id: number; route_code: string | null; dsat_dir: string | null; plan_id: number | null }
      | undefined;
    if (!session) {
      // 不存在 / 已结束 → 幂等跳过
      return NextResponse.json({ ok: true, skipped: "no_need" });
    }

    // —— 定位该段线路与方向：优先按「上车站匹配的 bus 分段 + 传入 route」——
    // 车站匹配不上（如选了非默认上车站的 51 系卡）→ 回退会话主线路（首段语义）
    let routeCode = route ?? session.route_code;
    let dsatDir: string | null = session.dsat_dir;
    let legMatched = false;
    if (session.plan_id) {
      const legsRes = await pool.query(
        `SELECT from_station, to_station, route_options FROM plan_legs
         WHERE plan_id = $1 AND leg_kind = 'bus' ORDER BY seq`,
        [session.plan_id],
      );
      const legs = legsRes.rows as {
        from_station: string | null;
        to_station: string | null;
        route_options: string | null;
      }[];
      const leg = legs.find((l) => station && sameStation(l.from_station ?? undefined, station));
      if (leg) {
        const opts = leg.route_options ? ((JSON.parse(leg.route_options) as string[]) ?? []) : [];
        // 传入 route 必须是该段候选项之一（多线段的实际所乘）；否则不猜，回退会话主线路
        if (route && opts.includes(route)) {
          routeCode = route;
          if (leg.from_station && leg.to_station) {
            const d = await deriveRouteDir(route, leg.from_station, leg.to_station, session.dsat_dir ?? "0");
            if (d) dsatDir = d;
          }
          legMatched = true;
        }
      }
    }
    if (!routeCode || !dsatDir) {
      // 方向未知（route_stations 未同步）→ 不猜，留空
      return NextResponse.json({ ok: true, skipped: "no_dir" });
    }

    const result = await getBusPositions(routeCode, dsatDir, "timer_grab");
    if (!result.ok || !result.data?.routeInfo) {
      return NextResponse.json({ ok: true, skipped: "dsat_fail", error: result.error });
    }

    // 候选：停在抓取站（atStation，board=上车站 / alight=实际下车站）的车
    // （status='1' 已到 / '0' 正驶入）；都无 → 全线路第一辆兜底
    const pickTarget = atStation ?? station;
    let pick: { plate: string | null; code: string | null; atStation: string; status: string | null; speed: string | number | null } | null = null;
    let fallbackFirst: { plate: string | null; code: string | null; atStation: string; status: string | null; speed: string | number | null } | null = null;
    const atPick: { plate: string | null; code: string | null; atStation: string; status: string | null; speed: string | number | null }[] = [];
    for (const st of result.data.routeInfo) {
      if (!st.busInfo?.length) continue;
      const isTarget = pickTarget ? sameStation(st.staCode, pickTarget) : false;
      for (const b of st.busInfo) {
        const item = {
          plate: b.busPlate ?? null,
          code: b.busCode ?? null,
          atStation: st.staCode,
          status: b.status ?? null,
          speed: b.speed ?? null,
        };
        if (!fallbackFirst) fallbackFirst = item;
        if (isTarget) atPick.push(item);
      }
    }
    pick =
      atPick.find((b) => b.status === "1") ??
      atPick.find((b) => b.status === "0") ??
      atPick[0] ??
      fallbackFirst;

    if (pick?.plate || pick?.code) {
      // 首段（尚未记录主车辆）才写 session.vehicle_*；后续分段只记 bus_snapshots
      await pool.query(
        `UPDATE timer_sessions
         SET vehicle_plate = COALESCE(vehicle_plate, $2),
             vehicle_code = COALESCE(vehicle_code, $3)
         WHERE id = $1`,
        [session.id, pick.plate, pick.code],
      );
      // 车牌级追踪闭环：每段 board/alight 时点的实际乘坐车辆快照
      try {
        const speed = Number(pick.speed);
        await pool.query(
          `INSERT INTO bus_snapshots
             (route_code, dsat_dir, station_code, bus_plate, bus_code,
              speed_kmh, status, session_id, stage, ref_station, stops_away)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0)`,
          [
            routeCode,
            dsatDir,
            pick.atStation,
            pick.plate,
            pick.code,
            Number.isFinite(speed) ? Math.round(speed) : null,
            pick.status,
            session.id,
            grabStage,
            pickTarget ?? pick.atStation,
          ],
        );
      } catch {
        /* 快照失败不影响主流程 */
      }
    }
    return NextResponse.json({ ok: true, plate: pick?.plate ?? null, code: pick?.code ?? null, legMatched });
  } catch (err) {
    // 抓取失败永不报错给前端（不影响计时）
    console.warn("[grab] 车辆抓取异常：", (err as Error).message);
    return NextResponse.json({ ok: true, skipped: "error" });
  }
}
