/**
 * 重排序（src/lib/nav/rank.ts，v1.3.0 提案 · T03）
 *
 * ── 排序判据（设计 §C.6，产品要求「更快的排上面」）────────────────────
 *   主判据：**`T_ours`（我们算出的门到门总时长）升序**
 *   tie-break ①：换乘次数升序（同耗时优先少换乘）
 *   tie-break ②：总步行量升序（再同则少走路）
 *   tie-break ③：来源（高德优先，背书画强）
 *   tie-break ④：`planId` 升序（稳定）
 *
 * ★ **不用高德原始排序**（仅作对照基准）—— 产品口径：「我们有数据优势，算出更准确的结果」。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §C.6
 */
import type { RecommendCard } from "@/lib/recommend/types";
import type { AmapPlanSeed, RecomputeProvenance } from "./types";

export interface RankedItem {
  card: RecommendCard;
  /** 来源：'amap'（主路径）/ 'local'（本地补漏 / 降级） */
  origin: "amap" | "local";
  /** 展示键（去重用）：`route@上>下` 链 —— 与 `OptionSeed.key` 同口径 */
  key: string;
  /** 高德骨架（local 项为 undefined） */
  seed?: AmapPlanSeed;
  /** 二次计算凭据（local 项为 undefined） */
  provenance?: RecomputeProvenance;
  /** 本地候选的「我们实测覆盖度」（质量闸门 §B.5-③；amap 项可省） */
  coverage?: number;
}

/** 换乘次数（= 换乘段数） */
export function transfersOf(item: RankedItem): number {
  return item.card.transfers.length;
}

/** 总步行量（米）：首段 + 末段（换乘步行无距离口径，不计入） */
export function walkMetersOf(item: RankedItem): number {
  const o = item.card.walkOut.distanceM ?? 0;
  const i = item.card.walkIn.distanceM ?? 0;
  return o + i;
}

/** 按 §C.6 排序（返回新数组，稳定） */
export function rankItems(items: RankedItem[]): RankedItem[] {
  return [...items].sort((a, b) => {
    // ① T_ours 升序
    const dt = a.card.totalMin - b.card.totalMin;
    if (Math.abs(dt) > 1e-9) return dt;
    // ② 换乘次数升序
    const dtr = transfersOf(a) - transfersOf(b);
    if (dtr !== 0) return dtr;
    // ③ 总步行量升序
    const dw = walkMetersOf(a) - walkMetersOf(b);
    if (dw !== 0) return dw;
    // ④ 来源：高德优先
    if (a.origin !== b.origin) return a.origin === "amap" ? -1 : 1;
    // ⑤ planId 升序（稳定）
    return a.card.planId - b.card.planId;
  });
}
