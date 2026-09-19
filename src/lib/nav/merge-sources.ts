/**
 * 两来源合并 + 质量闸门（src/lib/nav/merge-sources.ts，v1.3.0 提案 · T03）
 *
 * ── 定位（设计 §B.5；★ 口径变更见下）──────────────────────────────────
 *   高德是**候选主源**，本地图枚举是**第二来源**。本模块负责：**质量把关**（本地候选无
 *   高德背书）+ **中性来源标注**；两来源方案**进入同一套 `T_ours` 排优**（不再区分门第）。
 *
 * ── ★★ 口径变更（2026-09-19 产品拍板）─────────────────────────────────
 *   原文「把所有高德方案以及我们模型的方案放在一起，根据我们的算法算出的花费时间排优」。
 *   据此**废除**两条旧限制（研究报告 §2.2.4 亦指出其把第二来源约束成「更快的重复」）：
 *     · ❌ 旧闸门 4b「本地候选必须**严格快于**高德最优才保留」→ **默认关闭**
 *       （保留开关 `requireFasterThanAmapBest`，默认 false；仅在显式开启时应用）；
 *     · ❌ 旧「本地最多 2 张」（高德 <3 张时放宽到 3）→ **默认不限**
 *       （参数 `maxLocal`/`relaxLocal` 保留，`maxLocal` 缺省 = 不截断）。
 *   ⇒ 一个略慢但**步行更少 / 换乘更少**的方案不再被丢弃——我们允许第二来源「不一样」。
 *   （原「最多 2 张」的动机是限制无背书方案曝光面；现改为**全部进统一排优**，
 *    由 `T_ours` 决定去留，质量风险改由其余闸门 + 灰度观测承接。）
 *
 * ── ★ 本地补漏方案的质量闸门（§B.5；除 4b 外全部保留）────────────────
 *   1. **线路合法性**：线路全部来自我们 DSAT 官方库（无穿梭巴士/在建轻轨）——由
 *      `graph-search` **只遍历我们库线路**结构性保证（无需运行时复核）。
 *   2. **站序可解**：每段 `hops` 非空（否则丢弃）。
 *   3. **覆盖度**：门到门总时长里**我们实测（L1~L4）比例 ≥ 50%**（避免整卡靠估算）。
 *   4. **与高德去重（existingKeys）**；〔4b 对照高德最优：**默认关闭**，见上〕。
 *   5. **差异告警（§C.7）**：`suspect` 的本地候选一律丢弃（无背书 + 存疑 = 不出）。
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
  /**
   * ★ 是否启用闸门 4b（要求严格快于高德最优）。**默认 false**（2026-09-19 口径变更）。
   *   仅在显式开启且 `amapBestTotalMin` 非 null 时才生效。
   */
  requireFasterThanAmapBest?: boolean;
}

/** 对本地候选逐条过闸门 */
export function applyLocalGates(local: RankedItem[], opts: GateOpts): GateResult {
  const minCov = opts.minCoverage ?? 0.5;
  const requireFaster = opts.requireFasterThanAmapBest ?? false;
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
    // 闸门 4b：必须严格快于高德最优 —— ★ 默认**不启用**（口径变更 2026-09-19）
    if (requireFaster && opts.amapBestTotalMin !== null && !(it.card.totalMin < opts.amapBestTotalMin)) {
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
  /** 本地补漏上限（张）。**缺省 = 不截断（默认）**；显式给出时才生效 */
  maxLocal?: number;
  /** 高德方案少于 `relaxWhenAmapBelow` 时改用此上限（缺省则回落到 `maxLocal`） */
  relaxLocal?: number;
  /** 触发放宽的高德方案数阈值（默认 <3） */
  relaxWhenAmapBelow?: number;
  /** ★ 是否要求本地方案严格快于高德最优（默认 false = 不要求） */
  requireFasterThanAmapBest?: boolean;
}

export interface MergeResult {
  /** 合并后的候选（**未排序**；排序请调 `rank.rankItems`） */
  items: RankedItem[];
  dropped: GateDrop[];
  /** 本次生效的本地上限（诊断；`Infinity` = 不限） */
  localCap: number;
}

/**
 * 合并两来源（施加质量闸门；数量控制**默认不限**）。
 * ⚠️ 传入的 `local` 应为**已排序**（快的在前）—— 若显式设了上限，超限时保留最快的若干。
 */
export function mergeSources(amap: RankedItem[], local: RankedItem[], opts: MergeOpts = {}): MergeResult {
  // 数量控制：`maxLocal` 缺省 = 不限（口径变更 2026-09-19）；显式给出时才截断。
  const relaxBelow = opts.relaxWhenAmapBelow ?? 3;
  let localCap: number;
  if (opts.maxLocal === undefined) {
    localCap = Number.POSITIVE_INFINITY;
  } else {
    localCap = amap.length < relaxBelow ? (opts.relaxLocal ?? opts.maxLocal) : opts.maxLocal;
  }

  const requireFaster = opts.requireFasterThanAmapBest ?? false;
  const existingKeys = new Set(amap.map((a) => a.key));
  // 仅当启用 4b 时才计算高德最优（否则传 null，闸门 4b 自动跳过）
  const amapBest = requireFaster && amap.length ? Math.min(...amap.map((a) => a.card.totalMin)) : null;

  const gated = applyLocalGates(local, {
    amapBestTotalMin: amapBest,
    existingKeys,
    requireFasterThanAmapBest: requireFaster,
  });
  const kept = Number.isFinite(localCap) ? gated.kept.slice(0, localCap) : gated.kept;
  const overCap: GateDrop[] = Number.isFinite(localCap)
    ? gated.kept.slice(localCap).map((k) => ({ key: k.key, reason: "over_local_cap" }))
    : [];

  return {
    items: [...amap, ...kept],
    dropped: [...gated.dropped, ...overCap],
    localCap,
  };
}
