import { getPool } from "@/lib/db";
import { getBusPositions } from "@/lib/dsat/client";
import { findStopIdx, type StopLike } from "@/lib/station-match";

/**
 * 反事实车队快照采集（src/lib/dsat/fleet-snapshot.ts）
 * v0.4.0 需求 9：在 depart / wait_start / alight 三个时点，对"同一上车点可到同一目的地"
 * 的候选线路组（commute_plans.compare_routes）做全量在途车辆快照，落 bus_snapshots。
 * 口径：采集层不筛选——每一辆在线车都记（车牌/当前站/方向/status），跨时点可按车牌追踪。
 *
 * 方向选择：取该线路中含"用户乘车段上车站"的 dsat_dir（站台码在澳门是方向特定的，
 * 通常唯一命中；多命中且给得出目标站时按 from<to 优先）。不猜、不过滤。
 */
export type SnapshotStage = "depart" | "wait_start" | "alight";

export interface FleetSnapshotParams {
  sessionId: number;
  stage: SnapshotStage;
  /** 候选线路（缺省 = 方案 compare_routes，再缺省 = 实际乘坐线路） */
  routes?: string[];
  /** 用户乘车段上车站（相对位置参照；缺省从方案分段解析） */
  refStation?: string;
}

export interface FleetSnapshotResult {
  ok: boolean;
  skipped?: string;
  routes?: string[];
  rows?: number;
  error?: string;
}

/** 解析会话：plan_id + 实际线路 + 方向 */
async function loadSession(sessionId: number) {
  const pool = getPool();
  const sess = await pool.query(
    `SELECT id, plan_id, route_code, dsat_dir, ended_at
     FROM timer_sessions WHERE id = $1 AND deleted_at IS NULL`,
    [sessionId],
  );
  const row = sess.rows[0] as
    | { id: number; plan_id: number | null; route_code: string | null; dsat_dir: string | null; ended_at: string | null }
    | undefined;
  if (!row) return null;
  return row;
}

/** 方案候选线路（compare_routes JSONB） */
async function loadCompareRoutes(planId: number | null): Promise<string[] | null> {
  if (!planId) return null;
  const pool = getPool();
  const res = await pool.query(
    `SELECT compare_routes FROM commute_plans WHERE id = $1`,
    [planId],
  );
  const v = (res.rows[0] as { compare_routes: unknown } | undefined)?.compare_routes;
  return Array.isArray(v) ? (v as string[]) : null;
}

/** 用户乘车段（巴士）的 from_station / to_station（供缺省 refStation 与方向 hint） */
async function loadBusLeg(planId: number | null, routeCode: string | null) {
  if (!planId) return null;
  const pool = getPool();
  const res = await pool.query(
    `SELECT leg_kind, route_options, from_station, to_station
     FROM plan_legs WHERE plan_id = $1 AND leg_kind = 'bus' ORDER BY seq`,
    [planId],
  );
  const legs = res.rows as {
    leg_kind: string;
    route_options: string | null;
    from_station: string | null;
    to_station: string | null;
  }[];
  if (legs.length === 0) return null;
  // 优先实际乘坐线路所在段
  const match = routeCode
    ? legs.find((l) => {
        try {
          const opts = l.route_options ? (JSON.parse(l.route_options) as string[]) : [];
          return opts.includes(routeCode);
        } catch {
          return false;
        }
      })
    : undefined;
  return match ?? legs[0];
}

/**
 * 采集：主入口。
 * 逐候选线路 → 方向 → DSAT 实时车辆 → 全量落 bus_snapshots。
 * 任何单条失败都静默跳过，绝不抛给调用方（不影响计时主流程）。
 */
export async function captureFleetSnapshot(p: FleetSnapshotParams): Promise<FleetSnapshotResult> {
  try {
    const session = await loadSession(p.sessionId);
    if (!session) return { ok: true, skipped: "no_session" };
    if (session.ended_at) return { ok: true, skipped: "ended" };
    if (!session.route_code && !(p.routes?.length)) {
      return { ok: true, skipped: "no_route" };
    }

    const compare = await loadCompareRoutes(session.plan_id);
    const leg = await loadBusLeg(session.plan_id, session.route_code);
    const routes =
      p.routes && p.routes.length > 0
        ? p.routes
        : compare && compare.length > 0
          ? compare
          : session.route_code
            ? [session.route_code]
            : [];
    if (routes.length === 0) return { ok: true, skipped: "no_routes" };
    if (routes.length > 6) routes.length = 6; // 保险：一次最多快照 6 条

    const refStation =
      p.refStation?.trim() || leg?.from_station || session.route_code || "";
    if (!refStation) return { ok: true, skipped: "no_ref_station" };
    const destHint = leg?.to_station ?? null;

    const pool = getPool();

    // 每条线路可捕获的方向：含 refStation 的 dir（多命中且能按 dest 判别时优先）
    const captureDirs = new Map<string, string[]>(); // route -> dir[]
    {
      const rows = (
        await pool.query(
          `SELECT r.code AS route, rs.dsat_dir, rs.seq, rs.station_code AS code
           FROM route_stations rs
           JOIN routes r ON rs.route_id = r.id
           WHERE r.code = ANY($1::text[]) AND r.kind = 'bus'
           ORDER BY r.code, rs.dsat_dir, rs.seq`,
          [routes],
        )
      ).rows as { route: string; dsat_dir: string; seq: number; code: string }[];
      const stopsByRoute = new Map<string, StopLike[]>();
      for (const row of rows) {
        const list = stopsByRoute.get(row.route) ?? [];
        list.push(row);
        stopsByRoute.set(row.route, list);
      }
      for (const route of routes) {
        const list = stopsByRoute.get(route) ?? [];
        // StopLike 有 index signature，读出为 unknown；实际行来自 rs.dsat_dir（string）
        const dirs = [...new Set(list.map((s) => s.dsat_dir as string))];
        const hasRef: string[] = [];
        for (const d of dirs) {
          const stops = list.filter((s) => s.dsat_dir === d);
          if (findStopIdx(stops, refStation) >= 0) hasRef.push(d);
        }
        if (hasRef.length === 0) continue;
        if (hasRef.length > 1 && destHint) {
          const better = hasRef.find((d) => {
            const stops = list.filter((s) => s.dsat_dir === d);
            const ri = findStopIdx(stops, refStation);
            const di = findStopIdx(stops, destHint);
            return ri >= 0 && di > ri;
          });
          if (better) captureDirs.set(route, [better]);
          else captureDirs.set(route, hasRef);
        } else {
          captureDirs.set(route, hasRef);
        }
      }
    }
    if (captureDirs.size === 0) return { ok: true, skipped: "ref_station_not_on_routes" };

    // DSAT 实时车辆 → 落库
    let rowsInserted = 0;
    const insertedRoutes: string[] = [];
    for (const [route, dirs] of captureDirs) {
      for (const d of dirs) {
        try {
          const res = await getBusPositions(route, d, "poll");
          if (!res.ok || !res.data?.routeInfo) continue;
          const list = await pool.query(
            `SELECT seq, station_code AS code FROM route_stations rs
             JOIN routes r ON rs.route_id = r.id
             WHERE r.code = $1 AND r.kind = 'bus' AND rs.dsat_dir = $2 ORDER BY rs.seq`,
            [route, d],
          );
          const stops = list.rows as StopLike[];
          const refIdx = findStopIdx(stops, refStation);
          for (const st of res.data.routeInfo) {
            if (!st.busInfo?.length) continue;
            const busIdx = findStopIdx(stops, st.staCode);
            if (busIdx < 0) continue;
            for (const b of st.busInfo) {
              const speed = Number(b.speed);
              const speedKmh = Number.isFinite(speed) ? Math.round(speed) : null;
              const flow = Number(b.passengerFlow);
              await pool.query(
                `INSERT INTO bus_snapshots
                   (route_code, dsat_dir, station_code, bus_plate, bus_code,
                    speed_kmh, status, passenger_flow,
                    session_id, stage, ref_station, stops_away)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [
                  route,
                  d,
                  st.staCode,
                  b.busPlate ?? null,
                  b.busCode ?? null,
                  speedKmh,
                  b.status ?? null,
                  Number.isFinite(flow) ? Math.round(flow) : null,
                  p.sessionId,
                  p.stage,
                  refStation,
                  // 车在用户站后方（seq 小）为正站数；前方为负（已过站）；同站 0
                  refIdx >= 0 && busIdx >= 0 ? refIdx - busIdx : null,
                ],
              );
              rowsInserted++;
            }
          }
          insertedRoutes.push(`${route}@${d}`);
        } catch {
          /* 单条失败静默 */
        }
      }
    }

    return { ok: true, routes: insertedRoutes, rows: rowsInserted };
  } catch (err) {
    console.warn("[fleet-snapshot] 采集异常：", (err as Error).message);
    return { ok: true, skipped: "error", error: (err as Error).message };
  }
}
