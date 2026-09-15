/**
 * 段时长回退链（src/lib/recommend/segment-lookup.ts，v1.0.0）
 *
 * 逐跳取「A 站开到 B 站要几分钟」，命中层级（★ 依批判性复核实测命中率而定）：
 *   ① `(route,f,t,今天,'all','stop')` n≥3 → p50       实测 9.9%
 *   ② `(route,f,t,-1,'all','stop')`   n≥3 → p50       实测 40.8%
 *   ③ `(route,f,t,-1,'all','all')`    n≥1 → p50/avg   实测  2.1%
 *   ④ **跨线邻接共享**：任一线路的 `(mainCode(f)→mainCode(t))` 邻接对样本 n≥1  实测 23.9%
 *      依据项目铁律「邻接区间可跨线路共享 → 覆盖按『邻接站对』评估，不按线路」
 *      （C653→C654 这段实体马路，26 路要开、50 路也要开，物理时长同源）
 *   ⑤ 该线「单站均值」× 1 跳                             实测 23.2%（与 ⑥ 合计）
 *   ⑥ 全局「单站均值」× 1 跳
 *
 * 补上 ④ 后逐跳命中率 52.8% → 76.8%。
 * ⚠️ 全程 **mainCode 归一**（C690/3 ≡ C690、M9/2 ≡ M9）：同站多台是同一物理位置。
 */
import type { RouteIndex, SegmentStatRow } from "./types";

/** 站码主码归一：剥掉站台号后缀（C690/3 → C690、M9/2 → M9、T376/1 → T376） */
export function mainCodeOf(code: string): string {
  return /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;
}

/** 命中层级：1~6 = 回退链第 n 级 */
export type SegmentLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface SegmentIndex {
  /** `route|mainF|mainT` → 该线路该邻接对的全部行 */
  byRoute: Map<string, SegmentStatRow[]>;
  /** `mainF|mainT` → 全部拥有该邻接对的线路的行（跨线共享，L4） */
  byAdj: Map<string, SegmentStatRow[]>;
  /** route → 该线单跳加权均值（L5） */
  routeHop: Map<string, number>;
  /** 全局单跳加权均值（L6） */
  globalHop: number;
}

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 由 segment_stats 全量行构建内存索引（**只读一次库**，之后纯内存查询） */
export function buildSegmentIndex(rows: SegmentStatRow[]): SegmentIndex {
  const byRoute = new Map<string, SegmentStatRow[]>();
  const byAdj = new Map<string, SegmentStatRow[]>();
  const hopAgg = new Map<string, { sum: number; n: number }>();
  let gSum = 0;
  let gN = 0;

  for (const r of rows) {
    const mf = mainCodeOf(r.from_station);
    const mt = mainCodeOf(r.to_station);
    const kr = `${r.route_code}|${mf}|${mt}`;
    if (!byRoute.has(kr)) byRoute.set(kr, []);
    byRoute.get(kr)!.push(r);

    const ka = `${mf}|${mt}`;
    if (!byAdj.has(ka)) byAdj.set(ka, []);
    byAdj.get(ka)!.push(r);

    // 单跳均值只取「兜底层」（weekday=-1 / bucket=all / kind=all），避免分层行重复计数
    if (r.weekday === -1 && r.time_bucket === "all" && r.arrive_kind === "all") {
      const avg = num(r.avg_minutes);
      if (avg !== null && r.samples > 0) {
        const a = hopAgg.get(r.route_code) ?? { sum: 0, n: 0 };
        a.sum += avg * r.samples;
        a.n += r.samples;
        hopAgg.set(r.route_code, a);
        gSum += avg * r.samples;
        gN += r.samples;
      }
    }
  }

  const routeHop = new Map<string, number>();
  for (const [k, v] of hopAgg) if (v.n > 0) routeHop.set(k, v.sum / v.n);

  return {
    byRoute,
    byAdj,
    routeHop,
    globalHop: gN > 0 ? gSum / gN : 1.5,
  };
}

export interface HopLookup {
  minutes: number;
  level: SegmentLevel;
}

/** 行 → 取值（优先 p50，缺则 avg） */
const valueOf = (r: SegmentStatRow): number | null => {
  const p = num(r.p50_minutes);
  if (p !== null && p > 0) return p;
  const a = num(r.avg_minutes);
  return a !== null && a > 0 ? a : null;
};

const pickBy = (
  rows: SegmentStatRow[] | undefined,
  pred: (r: SegmentStatRow) => boolean,
  minSamples: number,
): number | null => {
  if (!rows) return null;
  const hit = rows.filter((r) => pred(r) && r.samples >= minSamples);
  if (!hit.length) return null;
  // 多行同时命中（如 stop/all 并存）→ 取样本最多的一行
  hit.sort((a, b) => b.samples - a.samples);
  return valueOf(hit[0]);
};

// ── samples 门槛：**标定结论 = 1**（2026-09-15 探针 `.verify/rec-static-probe.ts` 实测）──
// 244 跳标定：n≥3 时 L1/L2 仅命中 24 跳（9.8%），大量真实实测样本被弃用 → 退化成「站均」拍脑袋值；
// n≥1 时 L1 19 跳、L2 覆盖 141 跳（57.8%），L4 覆盖 **82.0%**（200/244）。
// 判据：单条实测样本也远优于「单站均值」，故各层一律「有样本即用」，多层命中取样本最多者。

/**
 * 查一跳的时长（分钟）。
 * @param todayWeekday 今天星期（0=周日…6=周六）；v1 不分时段，故只用到 weekday 精确层
 */
export function lookupHop(
  idx: SegmentIndex,
  route: string,
  from: string,
  to: string,
  todayWeekday: number,
): HopLookup {
  const mf = mainCodeOf(from);
  const mt = mainCodeOf(to);
  const routeRows = idx.byRoute.get(`${route}|${mf}|${mt}`);

  // ① 本线 · 今天 · stop
  // ⚠️ 分层行的 time_bucket 是具体时段（am_peak/day/…），**不存在 bucket='all' 的分层行**
  //    （见 rebuild/segment-stats.ts 的三条 push）→ 本层只按 weekday 匹配，不再要求 bucket
  const l1 = pickBy(routeRows, (r) => r.weekday === todayWeekday && r.arrive_kind === "stop", 1);
  if (l1 !== null) return { minutes: l1, level: 1 };

  // ② 本线 · 全周 · stop
  const l2 = pickBy(routeRows, (r) => r.weekday === -1 && r.time_bucket === "all" && r.arrive_kind === "stop", 1);
  if (l2 !== null) return { minutes: l2, level: 2 };

  // ③ 本线 · 全周 · all
  const l3 = pickBy(routeRows, (r) => r.weekday === -1 && r.time_bucket === "all" && r.arrive_kind === "all", 1);
  if (l3 !== null) return { minutes: l3, level: 3 };

  // ④ 跨线邻接共享（同一条实体马路，任意线路的样本皆可用）
  const l4 = pickBy(idx.byAdj.get(`${mf}|${mt}`), () => true, 1);
  if (l4 !== null) return { minutes: l4, level: 4 };

  // ⑤ 该线单站均值 × 1 跳
  const per = idx.routeHop.get(route);
  if (per !== undefined && per > 0) return { minutes: Math.round(per * 10) / 10, level: 5 };

  // ⑥ 全局单站均值 × 1 跳
  return { minutes: Math.round(idx.globalHop * 10) / 10, level: 6 };
}

/** 一条载具段的行驶时长 = 逐跳累加（⚠️ 禁止「站数 × 常数」跳过逐跳，见项目铁律） */
export function rideOfHops(
  idx: SegmentIndex,
  route: string,
  hops: [string, string][],
  todayWeekday: number,
): { minutes: number; levels: SegmentLevel[] } {
  let sum = 0;
  const levels: SegmentLevel[] = [];
  for (const [a, b] of hops) {
    const r = lookupHop(idx, route, a, b, todayWeekday);
    sum += r.minutes;
    levels.push(r.level);
  }
  return { minutes: sum, levels };
}

/** 仅供 RouteIndex 类型引用（避免 TS「未使用」告警） */
export type { RouteIndex };
