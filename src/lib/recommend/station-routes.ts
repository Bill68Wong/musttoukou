/**
 * 站台可达线路查询（src/lib/recommend/station-routes.ts，v1.2.0）
 *
 * 用途：**预测卡片详情页**的折叠栏 —— 「该站台剩余所有能到达目的地的路线」。
 *
 * 用户口径（2026-09-16）：
 *   「折叠的是该站台的剩余所有能到达目的地路线的报站信息」
 *   → 不只是本卡方案表里那几条，而是**该上车站上所有能到目的地的线路**。
 *
 * 判据（全部基于既有静态数据，**不需要新采集**）：
 *   对每条线路的每个方向，找「上车站」在站序中的位置，再看它**之后**是否出现
 *   目的地的任一已知下车点 → 命中即可达，并记下这批下车点中**站序最靠前**的那个
 *   （最靠前 = 最快能下车，与 `enumerate.ts` 的「动态下车」口径一致）。
 *
 * 「目的地的已知下车点」由调用方给出 —— 取自各方案 `plan_legs` 的
 * `alight_candidates` / `route_meta[*].to` / `to_station`（见 `destCodesFor`）。
 * ⚠️ 不臆造下车点：只认项目里已经定义过的目的地站点，避免把「经过」误判成「能到」。
 */
import type { RecStatic } from "./query";
import { mainCodeOf } from "./segment-lookup";
import type { RouteIndex } from "./types";

export interface ReachableRoute {
  route: string;
  kind: "bus" | "lrt";
  /** 本方向内、本站之后可达目的地的全部下车点（站序升序；`alights[0]` = 最快下车） */
  alights: string[];
  /** 命中该站的方向（bus 用 dsat_dir；轻轨同） */
  dir: string;
}

/** 线路码 → 载具类型（`LRT-*` 前缀 = 轻轨；其余 = 巴士） */
export const kindOfRoute = (route: string): "bus" | "lrt" =>
  route.startsWith("LRT-") ? "lrt" : "bus";

/**
 * 某站码在站序里的全部下标（先精确匹配，再按主码兜底 —— 同站多台 = 同一站）。
 * 与 `segment-lookup.ts#mainCodeOf` 同口径。
 */
function idxsOf(stops: string[], code: string): number[] {
  const exact: number[] = [];
  for (let i = 0; i < stops.length; i++) if (stops[i] === code) exact.push(i);
  if (exact.length) return exact;
  const mc = mainCodeOf(code);
  const out: number[] = [];
  for (let i = 0; i < stops.length; i++) if (mainCodeOf(stops[i]) === mc) out.push(i);
  return out;
}

/**
 * 列出「上车站」上所有能到达目的地的线路。
 *
 * @param destCodes 目的地的已知下车点集合（站码，比较时按主码归一）
 * @returns 按「最快下车站序」升序排序（越早能下车的排前面）
 */
export function reachableFrom(
  routeIdx: RouteIndex,
  boardCode: string,
  destCodes: Set<string>,
): ReachableRoute[] {
  const destMain = new Set([...destCodes].map(mainCodeOf));
  const boardMain = mainCodeOf(boardCode);
  const out: ReachableRoute[] = [];

  for (const [route, dirs] of routeIdx.dirsOf) {
    for (const dir of dirs) {
      const stops = routeIdx.dirStops.get(`${route}|${dir}`);
      if (!stops?.length) continue;
      const boards = idxsOf(stops, boardCode);
      if (!boards.length) continue;

      // 本站之后（严格靠后）出现的、且属于目的地已知下车点的站
      const hit: { code: string; at: number }[] = [];
      for (const b of boards) {
        for (let i = b + 1; i < stops.length; i++) {
          if (destMain.has(mainCodeOf(stops[i]))) hit.push({ code: stops[i], at: i });
        }
      }
      if (!hit.length) continue;

      // 同一下车点可能在环线里出现多次 → 去重保序（取首次出现）
      const seen = new Set<string>();
      hit.sort((a, b) => a.at - b.at);
      const alights: string[] = [];
      for (const h of hit) {
        const key = h.code;
        if (seen.has(key)) continue;
        seen.add(key);
        alights.push(h.code);
      }

      out.push({ route, kind: kindOfRoute(route), alights, dir });
      break; // 一条线路只取最合适的一个方向（首个命中的方向）
    }
  }

  // 排序：先按「最快下车点的站序」……但站序跨线路不可比 → 退化为按线路码自然序，
  // 真正的排序由调用方按「实时总时长」重排（详情页展示用）。
  out.sort((a, b) => a.route.localeCompare(b.route, "en", { numeric: true }));
  return out;
}

/**
 * 从静态层汇总「某目的地的已知下车点」。
 *
 * 来源（三者取并集，与 `enumerate.ts#alightsOf` 同口径）：
 *   · 载具段的 `alight_candidates`
 *   · `route_meta[*].to`
 *   · 载具段的 `to_station`
 * ⚠️ 只扫**在用方案**（`loadStatics` 只取 `is_active`），与推荐链路一致。
 */
export function destCodesFor(st: RecStatic, toSlug: string): Set<string> {
  const out = new Set<string>();
  for (const { plan, legs } of st.planRows) {
    if (plan.to_slug !== toSlug) continue;
    for (const leg of legs) {
      if (leg.leg_kind !== "bus" && leg.leg_kind !== "lrt") continue;
      for (const c of leg.alight_candidates ?? []) if (c) out.add(c);
      if (leg.to_station) out.add(leg.to_station);
      const meta = leg.route_meta ?? {};
      for (const v of Object.values(meta)) {
        if (v && typeof v === "object" && "to" in v && v.to) out.add(v.to as string);
      }
    }
  }
  return out;
}
