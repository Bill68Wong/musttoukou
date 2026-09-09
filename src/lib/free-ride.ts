/**
 * 自由记站服务端逻辑（src/lib/free-ride.ts，v0.19.0）
 * ⚠️ 本文件含 db/DSAT import——仅允许 server 侧（API route）import；
 *     client 组件请 import src/lib/free-shared.ts（纯常量/函数）。
 */
import { getPool } from "@/lib/db";
import { getBusPositions } from "@/lib/dsat/client";
import { sameStation, stripCode } from "@/lib/free-shared";

/** 站序行 */
export interface FreeStop {
  seq: number;
  code: string;
  name: string;
}

/** 某线路某方向的站序（bus 站名带码前缀，轻轨纯名） */
export async function freeStopsOf(route: string, dir: string): Promise<FreeStop[]> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT rs.seq, rs.station_code AS code,
            (CASE WHEN st.kind = 'bus' THEN rs.station_code || ' ' || st.name_tc ELSE st.name_tc END) AS name
     FROM route_stations rs
     JOIN routes r ON rs.route_id = r.id
     JOIN stations st ON rs.station_code = st.code
     WHERE r.code = $1 AND rs.dsat_dir = $2
     ORDER BY rs.seq`,
    [route, dir],
  );
  return res.rows as FreeStop[];
}

/** 该线路可选方向（含「往 X」标签，X=方向末站纯名） */
export async function freeDirsOf(route: string, kind: string): Promise<{ dir: string; label: string }[]> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT DISTINCT rs.dsat_dir FROM route_stations rs
     JOIN routes r ON rs.route_id = r.id
     WHERE r.code = $1 AND r.kind = $2
     ORDER BY rs.dsat_dir`,
    [route, kind],
  );
  const dirs = res.rows as { dsat_dir: string }[];
  const out: { dir: string; label: string }[] = [];
  for (const d of dirs) {
    const stops = await freeStopsOf(route, d.dsat_dir);
    const last = stops[stops.length - 1];
    out.push({ dir: d.dsat_dir, label: last ? `往 ${stripCode(last.name)}` : `方向 ${d.dsat_dir}` });
  }
  return out;
}

/**
 * 上车时抓实际乘坐车辆（自由记站版）：
 * 在 boardStation 停靠（status 0/1）的车优先，全部无 → 全线路第一辆兜底。
 * 轻轨（无车辆数据）或失败 → null。绝不抛错。
 */
export async function grabFreeVehicle(
  route: string,
  dir: string,
  boardStation: string | null,
): Promise<{ plate: string | null; code: string | null } | null> {
  try {
    if (route.startsWith("LRT-")) return null; // 轻轨无车辆数据
    const res = await getBusPositions(route, dir, "timer_grab");
    if (!res.ok || !res.data?.routeInfo) return null;
    let fallback: { plate: string | null; code: string | null } | null = null;
    const atPick: { plate: string | null; code: string | null; status: string | null }[] = [];
    for (const st of res.data.routeInfo) {
      if (!st.busInfo?.length) continue;
      const isTarget = boardStation ? sameStation(st.staCode, boardStation) : false;
      for (const b of st.busInfo) {
        const item = { plate: b.busPlate ?? null, code: b.busCode ?? null, status: b.status ?? null };
        if (!fallback) fallback = item;
        if (isTarget) atPick.push(item);
      }
    }
    const pick =
      atPick.find((b) => b.status === "1") ??
      atPick.find((b) => b.status === "0") ??
      atPick[0] ??
      fallback;
    if (!pick) return null;
    return { plate: pick.plate, code: pick.code };
  } catch {
    return null;
  }
}
