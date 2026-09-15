/**
 * 候选枚举（src/lib/recommend/enumerate.ts，v1.0.0）
 *
 * 把「方案 × 载具段 × 线路」展开成一条条**路线方案**单元：
 *   · 首段：**上车枚举** —— `route_options` 每条线各出一条；下车点按
 *     `route_meta[code].alight ?? alight_candidates ?? meta.to ?? to_station` 展开
 *     （「动态下车」→ 每个下车点算**一条独立路线**，如 26A 的 T363/1 / T367）
 *   · 续段：**不枚举**，只取默认线（`route_options[0]`）
 *
 * 站序解析（`segmentsOf` / `idxsOf`）从 `scripts/seg-coverage.ts` 移植为纯函数版 ——
 * 采集脚本与推荐引擎共用同一套「逐跳展开」口径，避免两处漂移。
 */
import type { PlanLegLite } from "@/lib/timer-flow";
import { mainCodeOf } from "./segment-lookup";
import type { OptionSeed, RideSegment, RouteIndex, TransferSegment } from "./types";

const stripCode = (s: string) => s.replace(/^[A-Za-z]+\d+(?:\/\d+)?\s+/, "");

/** 三段式站码匹配 → 返回所有命中的下标（循环线首尾同码会返回 2 个） */
export function idxsOf(stops: string[], target: string): number[] {
  const hit = (fn: (s: string) => boolean) => stops.map((s, i) => (fn(s) ? i : -1)).filter((i) => i >= 0);
  const exact = hit((s) => s === target);
  if (exact.length) return exact;
  const mid = hit((s) => s.startsWith(target + "/"));
  if (mid.length) return mid;
  const rev = hit((s) => target.startsWith(s + "/"));
  if (rev.length) return rev;
  const p = mainCodeOf(target);
  return hit((s) => mainCodeOf(s) === p);
}

/**
 * 对某条线路、某 from→to，取逐跳段列表
 * （选能顺向解出的方向 + 沿行驶方向环距最近的解 —— 循环线首尾同码取近的一圈）
 */
export function segmentsOf(
  idx: RouteIndex,
  route: string,
  from: string,
  to: string,
): { stops: string[]; segs: [string, string][] } | null {
  const dirs = idx.dirsOf.get(route) ?? [];
  let best: { stops: string[]; segs: [string, string][] } | null = null;
  for (const d of dirs) {
    const stops = idx.dirStops.get(`${route}|${d}`);
    if (!stops) continue;
    const fis = idxsOf(stops, from);
    const tis = idxsOf(stops, to);
    if (!fis.length || !tis.length) continue;
    let bestPair: { i: number; j: number } | null = null;
    for (const i of fis) {
      for (const j of tis) {
        if (j <= i) continue;
        if (!bestPair || j - i < bestPair.j - bestPair.i) bestPair = { i, j };
      }
    }
    if (!bestPair) continue;
    const segs: [string, string][] = [];
    for (let k = bestPair.i; k < bestPair.j; k++) segs.push([stops[k], stops[k + 1]]);
    if (!best || segs.length > best.segs.length) best = { stops, segs };
  }
  return best;
}

/**
 * 内存版方向推导（语义对齐 `src/lib/dsat/eta.ts#deriveRouteDir`）：
 * 找「from 在 to 之前」的那套方向；推导不出回退 fallback；
 * 循环线（只有一套站序且两站都在）用该唯一方向。站码取**末次出现**（与 SQL 的 max(seq) 一致）。
 */
export function deriveDirInMemory(
  idx: RouteIndex,
  route: string,
  from: string | null | undefined,
  to: string | null | undefined,
  fallback = "0",
): string {
  if (!from || !to) return fallback;
  const dirs = idx.dirsOf.get(route) ?? [];
  let candidate: string | null = null;
  let bothCount = 0;
  for (const d of dirs) {
    const stops = idx.dirStops.get(`${route}|${d}`);
    if (!stops) continue;
    let fi = -1;
    let ti = -1;
    for (let i = 0; i < stops.length; i++) {
      const c = stops[i] ?? "";
      if (c === from || c.startsWith(from + "/")) fi = i;
      if (c === to || c.startsWith(to + "/")) ti = i;
    }
    if (fi >= 0 && ti >= 0) {
      bothCount++;
      candidate = d;
      if (fi < ti) return d;
    }
  }
  if (bothCount === 1 && candidate) return candidate;
  return fallback;
}

/** 该线该方向的站序（方向按 from→to 推导，推不出退回首个方向） */
export function stopsFor(
  idx: RouteIndex,
  route: string,
  from: string,
  to: string,
): string[] | null {
  const d = deriveDirInMemory(idx, route, from, to, idx.dirsOf.get(route)?.[0] ?? "0");
  return idx.dirStops.get(`${route}|${d}`) ?? idx.dirStops.get(`${route}|${idx.dirsOf.get(route)?.[0] ?? "0"}`) ?? null;
}

/** 方案最小信息（server 查询侧给出） */
export interface PlanLite {
  id: number;
  summary: string;
  from_slug: string;
  to_slug: string;
}

/** 展平后的段（server 查询侧给出：plan_id + legs） */
export interface PlanLegsRow extends PlanLegLite {
  plan_id: number;
}

/** 一条载具段的候选（上车站 / 下车点） */
function boardsOf(leg: PlanLegLite, route: string): string[] {
  const meta = leg.route_meta?.[route];
  const out: string[] = [];
  if (meta?.board?.length) out.push(...meta.board);
  if (leg.board_candidates?.length) out.push(...leg.board_candidates);
  if (leg.from_station) out.push(leg.from_station);
  return [...new Set(out.filter(Boolean))];
}

/** 一条载具段的下车候选（首段才展开；末位=强制终点，语义与 alight_candidates 一致） */
function alightsOf(leg: PlanLegLite, route: string): string[] {
  const meta = leg.route_meta?.[route];
  const out: string[] = [];
  if (meta?.alight?.length) out.push(...meta.alight);
  else if (leg.alight_candidates?.length) out.push(...leg.alight_candidates);
  if (meta?.to) out.push(meta.to);
  if (leg.to_station) out.push(leg.to_station);
  // 去重但保序；末尾若与 meta.to 重复自动折叠
  return [...new Set(out.filter(Boolean))];
}

/**
 * 枚举一个方案的全部路线方案单元。
 * @returns 每条 = `(plan, 首段线路, 首段下车点)`；解不出站序的组合直接跳过
 */
export function enumerateOptions(
  plan: PlanLite,
  legs: PlanLegLite[],
  idx: RouteIndex,
): OptionSeed[] {
  const veh = legs.filter((l) => l.leg_kind === "bus" || l.leg_kind === "lrt");
  if (!veh.length) return [];
  const crossBorder = legs.some((l) => l.leg_kind === "cross_border");

  const first = veh[0];
  const firstRoutes = (first.route_options ?? []).filter(Boolean);
  if (!firstRoutes.length) return [];

  // ── 续段默认线（不枚举）──
  interface RestSpec {
    route: string;
    kind: "bus" | "lrt";
    board: string;
    alight: string;
    legIdx: number;
  }
  const rests: RestSpec[] = [];
  for (let i = 1; i < veh.length; i++) {
    const L = veh[i];
    const R = (L.route_options ?? [])[0];
    if (!R) return [];
    const m = L.route_meta?.[R];
    const board = m?.board?.[0] ?? L.board_candidates?.[0] ?? L.from_station;
    const alight = m?.to ?? L.to_station;
    if (!board || !alight) return [];
    rests.push({
      route: R,
      kind: L.leg_kind === "lrt" ? "lrt" : "bus",
      board,
      alight,
      legIdx: i,
    });
  }

  const out: OptionSeed[] = [];
  for (const R of firstRoutes) {
    const board = boardsOf(first, R)[0];
    if (!board) continue;
    const alights = alightsOf(first, R);
    for (const alight of alights) {
      if (mainCodeOf(board) === mainCodeOf(alight)) continue;
      const seg0 = segmentsOf(idx, R, board, alight);
      if (!seg0 || !seg0.segs.length) continue;

      const segments: RideSegment[] = [
        {
          route: R,
          kind: first.leg_kind === "lrt" ? "lrt" : "bus",
          board,
          alight,
          hops: seg0.segs,
        },
      ];
      let ok = true;
      for (const rest of rests) {
        const s = segmentsOf(idx, rest.route, rest.board, rest.alight);
        if (!s || !s.segs.length) {
          ok = false;
          break;
        }
        segments.push({
          route: rest.route,
          kind: rest.kind,
          board: rest.board,
          alight: rest.alight,
          hops: s.segs,
        });
      }
      if (!ok) continue;

      // ── 换乘（相邻载具段之间）──
      const transfers: TransferSegment[] = [];
      for (let i = 0; i + 1 < segments.length; i++) {
        const a = segments[i];
        const b = segments[i + 1];
        const sameField =
          a.alight === b.board && !a.alight.startsWith("LRT-") && !b.board.startsWith("LRT-");
        transfers.push({ at: a.alight, to: b.board, sameField });
      }

      out.push({
        planId: plan.id,
        summary: plan.summary,
        fromSlug: plan.from_slug,
        toSlug: plan.to_slug,
        crossBorder,
        segments,
        transfers,
        key: segments.map((s) => `${s.route}@${mainCodeOf(s.board)}>${mainCodeOf(s.alight)}`).join("|"),
      });
    }
  }

  // 同方案内去重（动态下车可能产出重复链）
  const seen = new Set<string>();
  return out.filter((o) => (seen.has(o.key) ? false : (seen.add(o.key), true)));
}

/** 站名展示（供 model 拼标签；stripCode 导出给 UI 复用） */
export { stripCode };
