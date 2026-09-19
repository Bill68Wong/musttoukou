/**
 * 二次计算（src/lib/nav/recompute.ts，v1.3.0 提案 · T03）
 *
 * ── 职责（设计 §C.1 / §C.4 / §C.5 / §C.7）─────────────────────────────
 *   高德只给「方案骨架」；**时间由我们算**。本模块提供三件接缝工具，
 *   使**不修改 `modelOption` 签名**即可让旧引擎吃「高德骨架」：
 *
 *   ① `makeWalkResolver(seed)` —— 首末步行走**高德几何（短距修正后）÷84**，
 *      通过 `ModelContext.walkResolver` 注入（§C.8）；
 *   ② `overlayTransferIndex(seed, base)` —— 换乘步行口径（§C.5）：
 *      轻轨相关 → **高德换乘时间**；巴士-巴士 → 高德距离 ÷ 84（缺 → 回落 `transfer_walks`）；
 *   ③ `patchAmapFallback(card, seed)` —— **映射失败段回落高德时长**（§C.4）+ 产出 `provenance`
 *      （含 §C.7 差异告警：单段 ratio∉[0.4,3.0] 且绝对差≥3min → 存疑；整方案 >50% → 存疑）。
 *
 * ── 为什么用「补丁」而不是重写总时长公式 ──────────────────────────────
 *   `modelOption` 的时间轴（walk+wait+ride+transfer）与赶车档/实时文案**深度耦合**，
 *   重写会漂移。映射成功的段其 `minutes` 已由 `modelOption(rideOfHops/lookupHop)` 算好；
 *   **只有映射失败的段**需要替换成高德时长 —— 该替换是**纯加法**（时间轴自 now 串行累加）
 *   ⇒ `totalMin += Δ` / `arriveAt += Δ·60000` **精确无误差** ✓
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §C.1 / §C.4 / §C.5 / §C.7 / §C.8
 */
import { lookupHop, mainCodeOf, type SegmentIndex } from "@/lib/recommend/segment-lookup";
import type { OptionSeed, RecommendCard } from "@/lib/recommend/types";
import { WALK_FALLBACK_MIN } from "@/lib/recommend/types";
import type { TransferIndex, TransferInfo } from "@/lib/recommend/model";
import { haversineM, wgs84ToGcj02, type LatLng } from "@/lib/amap/coord";
import { fixWalkDistance, walkCacheKey, walkMinutes } from "@/lib/amap/walk-fix";
import type { AmapPlanSeed, RecomputeProvenance, SegmentLevel, WalkInfo, WalkResolver } from "./types";

const round1 = (v: number): number => Math.round(v * 10) / 10;

// ─────────────────────────── ① 步行解析器 ───────────────────────────

/** 由骨架构造首末步行信息（首末 = 高德几何 ÷ 84，§C.1） */
export function walkInfosOf(
  seed: AmapPlanSeed,
  nameOf: Map<string, string>,
): { out: WalkInfo; in: WalkInfo } {
  const first = seed.legs[0];
  const last = seed.legs[seed.legs.length - 1];
  const boardMain = first?.mappedBoard ?? null;
  const alightMain = last?.mappedAlight ?? null;
  const boardLabel = boardMain ? (nameOf.get(boardMain) ?? boardMain) : "上車站";
  const alightLabel = alightMain ? (nameOf.get(alightMain) ?? alightMain) : "目的地";

  const out: WalkInfo = {
    minutes: round1(walkMinutes(seed.walkOut.correctedM)),
    distanceM: seed.walkOut.correctedM,
    toLabel: boardLabel,
    source: seed.walkOut.distanceM > 0 ? "amap" : "straight-estimate",
    estimated: !(seed.walkOut.distanceM > 0),
    samples: 0,
  };
  const inInfo: WalkInfo = {
    minutes: round1(walkMinutes(seed.walkIn.correctedM)),
    distanceM: seed.walkIn.correctedM,
    toLabel: alightLabel,
    source: seed.walkIn.distanceM > 0 ? "amap" : "straight-estimate",
    estimated: !(seed.walkIn.distanceM > 0),
    samples: 0,
  };
  return { out, in: inInfo };
}

/**
 * 构造 `WalkResolver`（注入 `ModelContext.walkResolver`）。
 * ⚠️ 首末步行由**本方案的骨架**决定 ⇒ resolver 必须**按方案**构造（不能全局共用一个）。
 */
export function makeWalkResolver(seed: AmapPlanSeed, nameOf: Map<string, string>): WalkResolver {
  const infos = walkInfosOf(seed, nameOf);
  return { out: () => infos.out, in: () => infos.in };
}

// ─────────────────────────── ①b 本地/降级步行解析器（★ P1-4） ───────────────────────────

/** `walk_cache` 内存索引：cacheKey → 距离/修正后距离（米） */
export interface WalkCacheEntry {
  distanceM: number | null;
  correctedM: number | null;
}
export type WalkCacheMap = Map<string, WalkCacheEntry>;

/**
 * ★ P1-4 修复：**本地 / 降级路径**的首末步行解析器 —— 设计 §B.6：
 *   「首末步行走 `walk_cache`（**未命中 → 直线 × 1.5**）」。
 *
 * 背景：本地图枚举出的候选**没有高德步行几何**（不同于主路径的 `AmapPlanSeed`），
 *   旧实现直接落 `walkIdx`（`walk_times`）——对**任意 POI 起点**（GPS）会命中
 *   「全局均值 / 常数 3 分」这类无意义值（level 3~4）✗。现改为：
 *     ① `walk_cache` 命中（键 = geohash-7 对）→ 用其 `corrected_m`；
 *     ② 未命中 → `直线（WGS 球面）× 1.5`（短距修正无高德几何时同口径）。
 *
 * @param geoOf 主码 → 站点坐标（**WGS84**，与我们库一致）
 */
export function makeCacheWalkResolver(
  seed: OptionSeed,
  fromWgs: LatLng,
  toWgs: LatLng,
  geoOf: Map<string, LatLng>,
  cache: WalkCacheMap,
  nameOf: Map<string, string>,
): WalkResolver {
  const boardMain = seed.segments[0] ? mainCodeOf(seed.segments[0].board) : null;
  const alightMain = seed.segments.length ? mainCodeOf(seed.segments[seed.segments.length - 1].alight) : null;

  const mk = (from: LatLng | null, to: LatLng | null): WalkInfo => {
    if (!from || !to) {
      return { minutes: WALK_FALLBACK_MIN, toLabel: "", source: "fallback", estimated: true, samples: 0 };
    }
    const straight = haversineM(from, to);
    const key = walkCacheKey(wgs84ToGcj02(from), wgs84ToGcj02(to));
    const hit = cache.get(key);
    const correctedM = hit?.correctedM ?? fixWalkDistance(straight, hit?.distanceM ?? null).correctedM;
    return {
      minutes: round1(walkMinutes(correctedM)),
      distanceM: correctedM,
      toLabel: "",
      source: hit ? "amap-cache" : "straight-estimate",
      estimated: !hit,
      samples: 0,
    };
  };

  const geoOfMain = (main: string | null): LatLng | null => (main ? geoOf.get(main) ?? null : null);
  const out = mk(fromWgs, geoOfMain(boardMain));
  const inInfo = mk(geoOfMain(alightMain), toWgs);

  // 补 toLabel（模型层会用 info.toLabel 覆盖显示；为空时模型回退 nameOf(station)）
  if (boardMain) out.toLabel = nameOf.get(boardMain) ?? boardMain;
  if (alightMain) inInfo.toLabel = nameOf.get(alightMain) ?? alightMain;

  return { out: () => out, in: () => inInfo };
}

// ─────────────────────────── ② 换乘步行口径 ───────────────────────────

/**
 * 构造**方案级**换乘索引（叠加在静态 `transfer_walks` 之上）。
 *
 * §C.5：轻轨相关 → 高德换乘 `duration`；巴士-巴士 → **高德距离 ÷ 84**（缺则回落 `transfer_walks`）。
 * 键 = `mainCode(前段下车站)|mainCode(后段上车站)`（与 `model.ts#transferMinutes` 同口径）。
 */
export function overlayTransferIndex(seed: AmapPlanSeed, base: TransferIndex): TransferIndex {
  const out: TransferIndex = new Map(base);
  for (let i = 0; i + 1 < seed.legs.length; i++) {
    const prev = seed.legs[i];
    const next = seed.legs[i + 1];
    const at = prev.mappedAlight;
    const to = next.mappedBoard;
    if (!at || !to) continue;
    const key = `${mainCodeOf(at)}|${mainCodeOf(to)}`;
    const tr = seed.transfers[i];
    const lrtRelated = prev.kind === "lrt" || next.kind === "lrt";
    if (lrtRelated) {
      // 轻轨相关 → 高德换乘时间
      const minutes = round1((tr?.amapDurationSec ?? 0) / 60);
      const info: TransferInfo = { minutes, samples: 0, source: "amap-transfer", estimate: minutes <= 0 };
      out.set(key, info);
    } else if (tr && tr.distanceM !== null && tr.distanceM > 0) {
      // 巴士-巴士 → 高德距离 ÷ 84（★ 产品已定：不是常数 3）
      const info: TransferInfo = { minutes: round1(walkMinutes(tr.distanceM)), samples: 0, source: "amap-distance", estimate: false };
      out.set(key, info);
    }
    // 巴士-巴士且高德无距离 → 不覆盖（沿用 transfer_walks 实测 / 兜底）
  }
  return out;
}

// ─────────────────────────── ③ 映射失败回落 + provenance ───────────────────────────

/**
 * 把「映射失败段」的高德时长补进卡片，并产出 `provenance`。
 *
 * @param card    由 `modelOption` 产出的卡片（`rides` 与 `seed.legs` **一一对应**）
 * @param seed    已桥接的方案骨架
 * @param segIdx  段统计索引（供逐跳层级/provenance）
 * @param weekday 今天星期（0=周日…6=周六）
 */
export function patchAmapFallback(
  card: RecommendCard,
  seed: AmapPlanSeed,
  segIdx: SegmentIndex,
  weekday: number,
): RecomputeProvenance {
  const hopLevels: SegmentLevel[][] = [];
  let usedOur = 0;
  let usedFallback = 0;
  let addMin = 0;
  let perLegSuspect = 0;

  const amapTotalMin = seed.amapTotalSec > 0 ? seed.amapTotalSec / 60 : 0;

  for (let i = 0; i < seed.legs.length; i++) {
    const leg = seed.legs[i];
    const ride = card.rides[i];
    const mapped = !!(leg.mappedRoute && leg.mappedHops && leg.mappedHops.length);

    if (mapped) {
      usedOur++;
      const levels: SegmentLevel[] = [];
      for (const [a, b] of leg.mappedHops!) levels.push(lookupHop(segIdx, leg.mappedRoute!, a, b, weekday).level);
      hopLevels.push(levels);

      // §C.7 单段差异告警
      const ourMin = ride ? ride.minutes : 0;
      const amapMin = leg.amapDurationSec / 60;
      if (amapMin > 0) {
        const ratio = ourMin / amapMin;
        if ((ratio < 0.4 || ratio > 3.0) && Math.abs(ourMin - amapMin) >= 3) perLegSuspect++;
      }
    } else {
      // ★ 映射失败 → 回落高德时长（纯加法补正）
      usedFallback++;
      hopLevels.push([]);
      const m = round1(leg.amapDurationSec / 60);
      if (ride) {
        ride.minutes = m;
        ride.levels = [];
      }
      addMin += m;
    }
  }

  if (addMin !== 0) {
    card.totalMin = round1(card.totalMin + addMin);
    card.arriveAt = card.arriveAt + Math.round(addMin * 60_000);
  }

  const deviationRatio = amapTotalMin > 0 ? Math.abs(card.totalMin - amapTotalMin) / amapTotalMin : 0;

  return {
    usedOurDataLegs: usedOur,
    usedAmapFallbackLegs: usedFallback,
    hopLevels,
    deviationRatio,
    // 整方案存疑：差异 >50% 或多段存疑（§C.7）
    suspect: deviationRatio > 0.5 || perLegSuspect >= 2,
  };
}

// ─────────────────────────── 覆盖度（质量闸门 §B.5-③） ───────────────────────────

/**
 * 「用我们实测（L1~L4）的分钟数」占**门到门总时长**的比例。
 * 口径：轻轨段（表定）计为我们的数据；巴士段仅当**全部跳层级 ≤4** 才计入；
 *       换乘仅当 `estimated=false` 才计入。**保守近似**（宁低不高）✓
 */
export function ourDataCoverage(card: RecommendCard): number {
  let ours = 0;
  for (const r of card.rides) {
    if (r.kind === "lrt") {
      ours += r.minutes;
    } else if (r.levels.length && r.levels.every((l) => l <= 4)) {
      ours += r.minutes;
    }
  }
  for (const t of card.transfers) if (!t.estimated) ours += t.minutes;
  return card.totalMin > 0 ? ours / card.totalMin : 0;
}
