/**
 * 两来源合并 + 质量闸门（src/lib/nav/merge-sources.ts，v1.3.0 提案 · T03）
 *
 * ── 定位（设计 §B.5）───────────────────────────────────────────────────
 *   高德是**主源**（有背书），本地图枚举是**第二来源**（找高德漏掉的更优组合）。
 *   本模块负责：**质量把关**（本地候选无高德背书）+ **数量控制**（最多 2 张）+ 中性来源标注。
 *
 * ── ★ 本地补漏方案的 5 道质量闸门（必须全部通过，§B.5）────────────────
 *   1. **线路合法性**：线路全部来自我们 DSAT 官方库（无穿梭巴士/在建轻轨）——由
 *      `graph-search` **只遍历我们库线路**结构性保证（无需运行时复核）。
 *   2. **站序可解**：每段 `hops` 非空（否则丢弃）。
 *   3. **覆盖度**：门到门总时长里**我们实测（L1~L4）比例 ≥ 50%**（避免整卡靠估算）。
 *   4. **对照高德最优**：`T_ours` 必须**严格快于**高德最优（否则无价值 → 丢弃）；
 *      且**不与高德方案重复**（key 去重）。
 *   5. **差异告警（§C.7）**：`suspect` 的本地候选一律丢弃（无背书 + 存疑 = 不出）。
 *
 * ── 数量控制（§B.5-④）────────────────────────────────────────────────
 *   本地补漏**最多占 2 张**（5 张里）；**若高德方案 < 3 张** → 放宽到 **3 张**（保证卡片数）。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §B.5 / §C.7
 */
import type { RankedItem } from "./rank";

export interface GateDrop {
  key: string;
  reason: string;
}

export interface GateResult {
  kept: RankedItem[];
  dropped: GateDrop[];
}

export interface GateOpts {
  /** 高德最优 `T_ours`（分钟）；null = 本轮高德无方案（降级态） */
  amapBestTotalMin: number | null;
  /** 高德方案已占用的 key（去重） */
  existingKeys: Set<string>;
  /** 最小覆盖度（默认 0.5） */
  minCoverage?: number;
}

/** 对本地候选逐条过闸门 */
export function applyLocalGates(local: RankedItem[], opts: GateOpts): GateResult {
  const minCov = opts.minCoverage ?? 0.5;
  const kept: RankedItem[] = [];
  const dropped: GateDrop[] = [];

  for (const it of local) {
    // 闸门 1（线路合法性）：本地候选**只由我们库线路构成**（graph-search 只遍历 routeIdx），
    //   天然满足 ⇒ 无需运行时复核（穿梭巴士/在建轻轨本就不在我们库里）。
    const segs = it.card.rides;
    // 闸门 2：站序可解（本地候选必须有 levels 或轻轨）
    const solvable = segs.length > 0 && segs.every((r) => r.kind === "lrt" || r.levels.length > 0);
    if (!solvable) {
      dropped.push({ key: it.key, reason: "unsolvable_stops" });
      continue;
    }
    // 闸门 4a：与高德重复 → 丢
    if (opts.existingKeys.has(it.key)) {
      dropped.push({ key: it.key, reason: "duplicate_of_amap" });
      continue;
    }
    // 闸门 4b：必须严格快于高德最优
    if (opts.amapBestTotalMin !== null && !(it.card.totalMin < opts.amapBestTotalMin)) {
      dropped.push({ key: it.key, reason: "not_faster_than_amap_best" });
      continue;
    }
    // 闸门 5：差异存疑 → 丢
    if (it.provenance?.suspect) {
      dropped.push({ key: it.key, reason: "suspect" });
      continue;
    }
    // 闸门 3：覆盖度
    if ((it.coverage ?? 0) < minCov) {
      dropped.push({ key: it.key, reason: `low_coverage(${(it.coverage ?? 0).toFixed(2)})` });
      continue;
    }
    kept.push(it);
  }
  return { kept, dropped };
}

export interface MergeOpts {
  /** 本地补漏上限（默认 2） */
  maxLocal?: number;
  /** 高德方案少于该数时放宽本地上限（默认 3 张） */
  relaxLocal?: number;
  /** 触发放宽的高德方案数阈值（默认 <3） */
  relaxWhenAmapBelow?: number;
}

export interface MergeResult {
  /** 合并后的候选（**未排序**；排序请调 `rank.rankItems`） */
  items: RankedItem[];
  dropped: GateDrop[];
  /** 本次允许的本地上限（诊断） */
  localCap: number;
}

/**
 * 合并两来源（施加质量闸门 + 数量控制）。
 * ⚠️ 传入的 `local` 应为**已排序**（快的在前）—— 超上限时保留最快的若干。
 */
export function mergeSources(amap: RankedItem[], local: RankedItem[], opts: MergeOpts = {}): MergeResult {
  const maxLocal = opts.maxLocal ?? 2;
  const relaxLocal = opts.relaxLocal ?? 3;
  const relaxBelow = opts.relaxWhenAmapBelow ?? 3;
  const localCap = amap.length < relaxBelow ? relaxLocal : maxLocal;

  const existingKeys = new Set(amap.map((a) => a.key));
  const amapBest = amap.length ? Math.min(...amap.map((a) => a.card.totalMin)) : null;

  const gated = applyLocalGates(local, { amapBestTotalMin: amapBest, existingKeys });
  const kept = gated.kept.slice(0, localCap);
  const overCap: GateDrop[] = gated.kept.slice(localCap).map((k) => ({ key: k.key, reason: "over_local_cap" }));

  return {
    items: [...amap, ...kept],
    dropped: [...gated.dropped, ...overCap],
    localCap,
  };
}
