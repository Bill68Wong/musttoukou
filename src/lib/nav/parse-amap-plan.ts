/**
 * 高德方案解析 + 桥接（src/lib/nav/parse-amap-plan.ts，v1.3.0 提案 · T03）
 *
 * ── 职责（设计 §B.2 / §B.3）────────────────────────────────────────────
 *   把高德 `transit/integrated` 的原始返回走完整条**候选处理链**：
 *     ① **结构解析**（复用 `transit.parseTransits`：步行/乘车/换乘段）；
 *     ② **方案级过滤**（穿梭巴士 / 在建轻轨 ES1–ES6 → 剔整方案，§B.3b·c）；
 *     ③ **站码桥接**（查 `station_amap_map` → `mappedRoute/mappedBoard/mappedAlight/mappedHops`）；
 *     ④ **全失败剔除**（整方案乘车段全映射失败 → 丢弃，§C.4）。
 *
 * ⚠️ 本模块是**纯函数**（除传入的桥接上下文），不碰 DB / 网络 —— 便于用 fixture 单测。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §B.2 / §B.3 / §C.4
 */
import { parseTransits, type AmapTransitRawResponse } from "@/lib/amap/transit";
import { bridgeLeg, planFilterReason, planFullyUnmapped, type BridgeContext } from "./map-stations";
import type { AmapPlanSeed } from "./types";

export interface ParseBridgeDrop {
  /** 高德返回序 */
  index: number;
  reason: string;
}

export interface ParseBridgeResult {
  /** 通过过滤 + 桥接的方案骨架（已填 mapped*） */
  seeds: AmapPlanSeed[];
  /** 被剔除的方案（诊断用） */
  dropped: ParseBridgeDrop[];
  /** 高德原始方案数 */
  total: number;
}

/**
 * 解析 → 过滤 → 桥接 → 剔除全失败。
 *
 * @param json       高德原始响应（`fetchTransitPlans().raw` 或 fixture）
 * @param originGcj  请求起点（GCJ-02）—— 算首段直线/短距修正
 * @param destGcj    请求终点（GCJ-02）
 * @param ctx        桥接上下文（station 映射 + 合法线路集合 + 站序索引）
 */
export function parseAndBridge(
  json: AmapTransitRawResponse,
  originGcj: { lng: number; lat: number },
  destGcj: { lng: number; lat: number },
  ctx: BridgeContext,
): ParseBridgeResult {
  const raw = parseTransits(json, originGcj, destGcj);
  const seeds: AmapPlanSeed[] = [];
  const dropped: ParseBridgeDrop[] = [];

  for (const seed of raw) {
    // ② 方案级过滤
    const reason = planFilterReason(seed.legs);
    if (reason) {
      dropped.push({ index: seed.index, reason });
      continue;
    }
    // ③ 桥接
    const bridged: AmapPlanSeed = { ...seed, legs: seed.legs.map((l) => bridgeLeg(ctx, l)) };
    // ④ 全失败剔除
    if (planFullyUnmapped(bridged.legs)) {
      dropped.push({ index: seed.index, reason: "all_legs_unmapped" });
      continue;
    }
    seeds.push(bridged);
  }

  return { seeds, dropped, total: raw.length };
}
