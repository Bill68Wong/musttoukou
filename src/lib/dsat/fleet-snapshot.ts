import { getPool } from "@/lib/db";
import { getBusPositions } from "@/lib/dsat/client";
import { findStopIdx, type StopLike } from "@/lib/station-match";

/**
 * 反事实车队快照采集（src/lib/dsat/fleet-snapshot.ts）
 * v0.4.0 需求 9 / v0.11.0 B1（OD 派生升级）：在 depart / wait_start / alight 三个时点，
 * 对「同一起终点（from_place/to_place）的全部 active 方案首个巴士段主线路」做全量在途车辆快照，
 * 每行以该候选方案自己的上车站为参照（ref_station / stops_away），落 bus_snapshots。
 *
 * 口径（2026-09-04 拍板 D4/D5）：为分析阶段的「跨站门到门总时长对比」预采数据——
 * 坐 50 时，也把走去别站坐 26A/51/51A/51B 等方案的车队相对各站位置抓下来；
 * 数据事后无法回溯，必须在实测当下抓。候选集 = OD 自动推导，取代历史 compare_routes 列（B2 删除）。
 * 采集层不筛选——每一辆在线车都记（车牌/当前站/方向/status），跨时点可按车牌追踪。
 *
 * 方向选择：取该线路中含"该候选上车站"的 dsat_dir（站台码在澳门是方向特定的，
 * 通常唯一命中；多命中且给得出目标站时按 from<to 优先）。不猜、不过滤。
 */
export type SnapshotStage = "depart" | "wait_start" | "alight";

export interface FleetSnapshotParams {
  sessionId: number;
  stage: SnapshotStage;
}

export interface FleetSnapshotResult {
  ok: boolean;
  skipped?: string;
  candidates?: { route: string; refStation: string }[];
  rows?: number;
  error?: string;
}

interface Candidate {
  planId: number | null;
  route: string;
  refStation: string;
  destHint: string | null;
}

/** 解析会话：plan_id + 实际线路 + 方向 + 方案 OD（from_place/to_place） */
async function loadSession(sessionId: number) {
  const pool = getPool();
  const sess = await pool.query(
    `SELECT s.id, s.plan_id, s.route_code, s.dsat_dir, s.ended_at,
            cp.from_place, cp.to_place
     FROM timer_sessions s
     LEFT JOIN commute_plans cp ON cp.id = s.plan_id
     WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [sessionId],
  );
  const row = sess.rows[0] as
    | {
        id: number;
        plan_id: number | null;
        route_code: string | null;
        dsat_dir: string | null;
        ended_at: string | null;
        from_place: number | null;
        to_place: number | null;
      }
    | undefined;
  if (!row) return null;
  return row;
}

/** 取一张方案的首个巴士段（主线路 / 上车站 / 目标站） */
async function loadFirstBusLeg(planId: number | null): Promise<{
  route: string | null;
  fromStation: string | null;
  toStation: string | null;
} | null> {
  if (!planId) return null;
  const pool = getPool();
  const res = await pool.query(
    `SELECT route_options, from_station, to_station
     FROM plan_legs WHERE plan_id = $1 AND leg_kind = 'bus' ORDER BY seq LIMIT 1`,
    [planId],
  );
  const leg = res.rows[0] as
    | { route_options: string | null; from_station: string | null; to_station: string | null }
    | undefined;
  if (!leg?.from_station) return null;
  let opts: string[] = [];
  try {
    opts = leg.route_options ? (JSON.parse(leg.route_options) as string[]) : [];
  } catch {
    opts = [];
  }
  return { route: opts[0] ?? null, fromStation: leg.from_station, toStation: leg.to_station };
}

/**
 * 候选集（v0.11.0 OD 派生）：
 * 同 from_place/to_place 且 is_active 的方案 → 每张卡首个巴士段主线路 + 各自上车站。
 * 会话自己的方案必在集内；按 (route, 上车站) 去重；上限 6（防单次抓拍过多 DSAT 调用）。
 * OD 信息缺失（异常数据）时降级 = 会话方案自己的首个巴士段。
 */
async function loadCandidates(session: NonNullable<Awaited<ReturnType<typeof loadSession>>>): Promise<Candidate[]> {
  const pool = getPool();
  const out: Candidate[] = [];
  const seen = new Set<string>();

  const pushCandidate = async (planId: number | null) => {
    const leg = await loadFirstBusLeg(planId);
    if (!leg?.route || !leg.fromStation) return;
    const key = `${leg.route}|${leg.fromStation}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      planId,
      route: leg.route,
      refStation: leg.fromStation,
      destHint: leg.toStation ?? null,
    });
  };

  if (session.plan_id != null && session.from_place != null && session.to_place != null) {
    // 同 OD active 方案集
    const res = await pool.query(
      `SELECT id FROM commute_plans
       WHERE is_active AND from_place = $1 AND to_place = $2
       ORDER BY id`,
      [session.from_place, session.to_place],
    );
    const ids = (res.rows as { id: number }[]).map((r) => r.id);
    for (const id of ids) await pushCandidate(id);
  } else {
    // 降级：本会话方案
    await pushCandidate(session.plan_id);
  }

  // 兜底：候选仍为空时（理论不可达）用实际乘坐线，无参照站则放弃
  if (out.length === 0) {
    const own = await loadFirstBusLeg(session.plan_id);
    if (own?.route && own.fromStation) {
      seen.add(`${own.route}|${own.fromStation}`);
      out.push({ planId: session.plan_id, route: own.route, refStation: own.fromStation, destHint: own.toStation ?? null });
    }
  }
  return out.slice(0, 6);
}

/**
 * 采集：主入口。
 * 逐候选（线路 × 自己的上车站）→ 方向 → DSAT 实时车辆 → 全量落 bus_snapshots。
 * 任何单条失败都静默跳过，绝不抛给调用方（不影响计时主流程）。
 */
export async function captureFleetSnapshot(p: FleetSnapshotParams): Promise<FleetSnapshotResult> {
  try {
    const session = await loadSession(p.sessionId);
    if (!session) return { ok: true, skipped: "no_session" };
    if (session.ended_at) return { ok: true, skipped: "ended" };

    const candidates = await loadCandidates(session);
    if (candidates.length === 0) return { ok: true, skipped: "no_candidates" };

    const pool = getPool();
    const candidateRoutes = [...new Set(candidates.map((c) => c.route))];

    // 站序预载（候选线路全集一次取回；行含 dsat_dir）
    const rows = (
      await pool.query(
        `SELECT r.code AS route, rs.dsat_dir, rs.seq, rs.station_code AS code
         FROM route_stations rs
         JOIN routes r ON rs.route_id = r.id
         WHERE r.code = ANY($1::text[]) AND r.kind = 'bus'
         ORDER BY r.code, rs.dsat_dir, rs.seq`,
        [candidateRoutes],
      )
    ).rows as { route: string; dsat_dir: string; seq: number; code: string }[];
    const stopsByRoute = new Map<string, StopLike[]>();
    for (const row of rows) {
      const list = stopsByRoute.get(row.route) ?? [];
      list.push(row);
      stopsByRoute.set(row.route, list);
    }

    // 逐候选：含其参照站的方向（多命中且能按该卡目标站判别时优先）
    const capturePlan: { candidate: Candidate; dirs: string[] }[] = [];
    for (const cand of candidates) {
      const list = stopsByRoute.get(cand.route) ?? [];
      const dirs = [...new Set(list.map((s) => s.dsat_dir as string))];
      const hasRef: string[] = [];
      for (const d of dirs) {
        const stops = list.filter((s) => s.dsat_dir === d);
        if (findStopIdx(stops, cand.refStation) >= 0) hasRef.push(d);
      }
      if (hasRef.length === 0) continue;
      if (hasRef.length > 1 && cand.destHint) {
        const better = hasRef.find((d) => {
          const stops = list.filter((s) => s.dsat_dir === d);
          const ri = findStopIdx(stops, cand.refStation);
          const di = findStopIdx(stops, cand.destHint!);
          return ri >= 0 && di > ri;
        });
        capturePlan.push({ candidate: cand, dirs: better ? [better] : hasRef });
      } else {
        capturePlan.push({ candidate: cand, dirs: hasRef });
      }
    }
    if (capturePlan.length === 0) return { ok: true, skipped: "ref_station_not_on_routes" };

    // DSAT 实时车辆 → 落库（每候选行参照 = 该候选自己的上车站）
    let rowsInserted = 0;
    const captured: { route: string; refStation: string }[] = [];
    for (const { candidate, dirs } of capturePlan) {
      for (const d of dirs) {
        try {
          const res = await getBusPositions(candidate.route, d, "poll");
          if (!res.ok || !res.data?.routeInfo) continue;
          const stops = (stopsByRoute.get(candidate.route) ?? []).filter((s) => s.dsat_dir === d);
          const refIdx = findStopIdx(stops, candidate.refStation);
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
                  candidate.route,
                  d,
                  st.staCode,
                  b.busPlate ?? null,
                  b.busCode ?? null,
                  speedKmh,
                  b.status ?? null,
                  Number.isFinite(flow) ? Math.round(flow) : null,
                  p.sessionId,
                  p.stage,
                  candidate.refStation,
                  // 车在该候选上车站后方（seq 小）为正站数；前方为负（已过站）；同站 0
                  refIdx >= 0 && busIdx >= 0 ? refIdx - busIdx : null,
                ],
              );
              rowsInserted++;
            }
          }
          if (!captured.some((c) => c.route === candidate.route && c.refStation === candidate.refStation)) {
            captured.push({ route: candidate.route, refStation: candidate.refStation });
          }
        } catch {
          /* 单条失败静默 */
        }
      }
    }

    return { ok: true, candidates: captured, rows: rowsInserted };
  } catch (err) {
    console.warn("[fleet-snapshot] 采集异常：", (err as Error).message);
    return { ok: true, skipped: "error", error: (err as Error).message };
  }
}
