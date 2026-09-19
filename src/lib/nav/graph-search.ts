/**
 * 本地图枚举 · 有界 BFS（src/lib/nav/graph-search.ts，v1.3.0 提案 · T03 / G4）
 *
 * ── 定位（设计 §B.5 / §B.6 / §G4）────────────────────────────────────
 *   本地 `route_stations` 图上搜「A→B」候选，换乘 ≤ `maxTransfers`（默认 2）。
 *   **两处复用**：① **补漏交付**（找高德没给的更优组合）；② **降级出卡**（高德不可用时）。
 *
 * ── 算法（有界 BFS / hub 组合）────────────────────────────────────────
 *   ① 近站点筛选（**降级路径的 R1 口径**）：起点/终点各取**最近 K=8 站、≤700m**（WGS 球面）；
 *   ② 沿线路（站序索引）算「起点站集合单程可达的 hub」与「能单程到达终点站的 hub」；
 *   ③ 组合：
 *      · 0 换乘：任一线 r，`a→b` 可顺向解出；
 *      · 1 换乘：hub h 同时「a 可达」与「可达 b」；
 *      · 2 换乘：hub h₁（a 可达）× hub h₂（可达 b），且存在中段线 rMid 连接 h₁→h₂
 *        （中段候选 = 两 hub 共有线路 → 交集很小，避免 O(hubs²·routes) 爆炸）；
 *   ④ 去重（键 = 线路@上→下 链）+ **硬上限** `maxCandidates`（防请求期超时）。
 *
 * ── ★ 已知局限（诚实，§B.6 已认可「本地可能漏」）──────────────────────
 *   · 换乘按**同一主码**（= 同物理站群，多站台已归一）处理 ⇒ 换乘步行计 0；
 *     真实的**跨街换乘**（不同主码、需走 100m）**不建模** ⇒ 本地候选取时偏乐观；
 *     ⇒ 故本地候选必须过**质量闸门**（`merge-sources.ts`，只有真更快才出）。
 *   · hub 组合是**有界**的（hub 限量、候选限量）⇒ **非穷举**（设计已接受）。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §B.5 / §B.6 / §G4；R1 §B.6「有界 BFS 换乘 ≤2」
 */
import { haversineM, type LatLng } from "@/lib/amap/coord";
import { segmentsOf } from "@/lib/recommend/enumerate";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { RouteIndex } from "@/lib/recommend/types";

/** 站点地理（**WGS84**，与我们库一致） */
export interface GeoStation {
  main: string;
  lat: number;
  lng: number;
}

export interface SearchOpts {
  /** 起/终点各取最近 K 站（默认 8） */
  k?: number;
  /** 近站半径（米，默认 700） */
  radiusM?: number;
  /** 最大换乘次数（默认 2） */
  maxTransfers?: number;
  /** 候选硬上限（默认 200） */
  maxCandidates?: number;
  /** 2 换乘时每侧 hub 限量（默认 25） */
  hubLimit?: number;
}

export interface RidePath {
  route: string;
  board: string;
  alight: string;
  hops: [string, string][];
}
export interface StationPath {
  rides: RidePath[];
  transfers: { at: string; to: string }[];
}

const DEFAULTS: Required<SearchOpts> = {
  k: 8,
  radiusM: 700,
  maxTransfers: 2,
  maxCandidates: 200,
  hubLimit: 25,
};

/** 取离 point 最近的主码（≤radius，最多 k 个；按距离升序） */
function nearestMains(geo: GeoStation[], point: LatLng, k: number, radiusM: number): string[] {
  const arr = geo
    .map((g) => ({ main: g.main, d: haversineM(point, { lat: g.lat, lng: g.lng }) }))
    .filter((x) => x.d <= radiusM)
    .sort((a, b) => a.d - b.d);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    if (seen.has(x.main)) continue;
    seen.add(x.main);
    out.push(x.main);
    if (out.length >= k) break;
  }
  return out;
}

/** 构建「主码 → 停靠线路集合」 */
function buildRoutesAt(routeIdx: RouteIndex): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const [key] of routeIdx.dirStops) {
    const [route] = key.split("|");
    const stops = routeIdx.dirStops.get(key)!;
    for (const code of stops) {
      const main = mainCodeOf(code);
      let s = m.get(main);
      if (!s) m.set(main, (s = new Set()));
      s.add(route);
    }
  }
  return m;
}

/** 该线该主码**顺向可达**的下游主码集合（任一方向）；缓存 */
function makeReachability(routeIdx: RouteIndex) {
  const cache = new Map<string, Set<string>>();
  return function reachableAfter(route: string, fromMain: string): Set<string> {
    const ck = `${route}|${fromMain}`;
    const hit = cache.get(ck);
    if (hit) return hit;
    const out = new Set<string>();
    for (const d of routeIdx.dirsOf.get(route) ?? []) {
      const stops = routeIdx.dirStops.get(`${route}|${d}`);
      if (!stops) continue;
      for (let i = 0; i < stops.length; i++) {
        if (mainCodeOf(stops[i]) !== fromMain) continue;
        for (let j = i + 1; j < stops.length; j++) out.add(mainCodeOf(stops[j]));
      }
    }
    cache.set(ck, out);
    return out;
  };
}

/** 该主码在该线上的**上游**主码集合（可达 from 的主码）；缓存 */
function makeReachabilityBack(routeIdx: RouteIndex) {
  const cache = new Map<string, Set<string>>();
  return function reachableBefore(route: string, toMain: string): Set<string> {
    const ck = `${route}|${toMain}`;
    const hit = cache.get(ck);
    if (hit) return hit;
    const out = new Set<string>();
    for (const d of routeIdx.dirsOf.get(route) ?? []) {
      const stops = routeIdx.dirStops.get(`${route}|${d}`);
      if (!stops) continue;
      for (let j = 0; j < stops.length; j++) {
        if (mainCodeOf(stops[j]) !== toMain) continue;
        for (let i = 0; i < j; i++) out.add(mainCodeOf(stops[i]));
      }
    }
    cache.set(ck, out);
    return out;
  };
}

const pathKey = (p: StationPath): string =>
  p.rides.map((r) => `${r.route}@${mainCodeOf(r.board)}>${mainCodeOf(r.alight)}`).join("|");

/**
 * 本地图枚举主入口。
 *
 * @param routeIdx 站序索引（`query.loadStatics().routeIdx`）
 * @param geo      站点地理（WGS84）
 * @param fromWgs  起点（**WGS84**；调用方须把 GCJ 的 GPS/POI 先 `gcj02ToWgs84`）
 * @param toWgs    终点（WGS84）
 */
export function searchStationPaths(
  routeIdx: RouteIndex,
  geo: GeoStation[],
  fromWgs: LatLng,
  toWgs: LatLng,
  opts: SearchOpts = {},
): StationPath[] {
  const o = { ...DEFAULTS, ...opts };
  const SRC = nearestMains(geo, fromWgs, o.k, o.radiusM);
  const DST = nearestMains(geo, toWgs, o.k, o.radiusM);
  if (!SRC.length || !DST.length) return [];

  const routesAt = buildRoutesAt(routeIdx);
  const reachAfter = makeReachability(routeIdx);
  const reachBefore = makeReachabilityBack(routeIdx);

  const results: StationPath[] = [];
  const seen = new Set<string>();
  const add = (rides: RidePath[], transfers: { at: string; to: string }[]): boolean => {
    const p: StationPath = { rides, transfers };
    const k = pathKey(p);
    if (seen.has(k)) return false;
    seen.add(k);
    results.push(p);
    return results.length < o.maxCandidates;
  };

  const ride = (route: string, a: string, b: string): RidePath | null => {
    if (mainCodeOf(a) === mainCodeOf(b)) return null;
    const seg = segmentsOf(routeIdx, route, a, b);
    if (!seg || !seg.segs.length) return null;
    return { route, board: a, alight: b, hops: seg.segs };
  };

  // ── 0 换乘 ──
  const allRoutes = [...routeIdx.dirsOf.keys()];
  for (const r of allRoutes) {
    for (const a of SRC) {
      for (const b of DST) {
        const rd = ride(r, a, b);
        if (rd) add([rd], []);
      }
    }
  }
  if (results.length >= o.maxCandidates) return results;

  // ── 1 换乘 ──
  const reachFrom = new Map<string, { route: string; from: string }[]>();
  for (const r of allRoutes) {
    for (const a of SRC) {
      for (const h of reachAfter(r, a)) {
        if (h === a) continue;
        let arr = reachFrom.get(h);
        if (!arr) reachFrom.set(h, (arr = []));
        arr.push({ route: r, from: a });
      }
    }
  }
  const reachTo = new Map<string, { route: string; to: string }[]>();
  for (const r of allRoutes) {
    for (const b of DST) {
      for (const h of reachBefore(r, b)) {
        if (h === b) continue;
        let arr = reachTo.get(h);
        if (!arr) reachTo.set(h, (arr = []));
        arr.push({ route: r, to: b });
      }
    }
  }

  for (const [hub, froms] of reachFrom) {
    const tos = reachTo.get(hub);
    if (!tos) continue;
    for (const f of froms) {
      for (const t of tos) {
        if (f.route === t.route) continue;
        const r1 = ride(f.route, f.from, hub);
        const r2 = ride(t.route, hub, t.to);
        if (!r1 || !r2) continue;
        if (!add([r1, r2], [{ at: hub, to: hub }])) return results;
      }
    }
  }
  if (o.maxTransfers < 2 || results.length >= o.maxCandidates) return results;

  // ── 2 换乘（hub 限量，中段线取两 hub 共有线路交集）──
  const hub1 = [...reachFrom.keys()].slice(0, o.hubLimit);
  const hub2 = [...reachTo.keys()].slice(0, o.hubLimit);
  outer: for (const h1 of hub1) {
    for (const h2 of hub2) {
      if (h1 === h2) continue;
      const s1 = routesAt.get(h1);
      const s2 = routesAt.get(h2);
      if (!s1 || !s2) continue;
      const mids: string[] = [];
      for (const r of s1) if (s2.has(r)) mids.push(r);
      if (!mids.length) continue;
      for (const rMid of mids) {
        const mid = ride(rMid, h1, h2);
        if (!mid) continue;
        for (const f of reachFrom.get(h1) ?? []) {
          if (f.route === rMid) continue;
          const r1 = ride(f.route, f.from, h1);
          if (!r1) continue;
          for (const t of reachTo.get(h2) ?? []) {
            if (t.route === rMid) continue;
            const r3 = ride(t.route, h2, t.to);
            if (!r3) continue;
            if (!add([r1, mid, r3], [{ at: h1, to: h1 }, { at: h2, to: h2 }])) break outer;
          }
        }
      }
    }
  }
  return results;
}
