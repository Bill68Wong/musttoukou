/**
 * 赶车 5 档判定（src/lib/recommend/catch-up.ts，v1.0.0）
 *
 * 模型：`T_所需 = OVERHEAD + (步行基准秒 − OVERHEAD) × 速度比`
 *  - 固定开销让 **n 小时的各档绝对差自动收敛**（正是「n 小时差距不大」的物理解释）；
 *  - 基准 3 = 正常走 = 实测步行样本均值（`walk_times`）。
 *
 * 判据：**不留额外安全余量** —— 保守性改由「报时取区间下限」实现（见 busArrivalWindow）。
 *
 * ⚠️ `waitSec` 的语义**只有一种**：从「现在」起，车辆还有多少秒到站。
 *    · 巴士：直接传 `BusArrival.loSec`（区间下限，往短了算）✅
 *    · 轻轨首段：必须传 `(depMs − nowMs) / 1000`；
 *      ★ v1.0.6 修正：早期误传 `depMs − 你走到站台的时刻`（走完才剩的余量），
 *        参照系错位 → 判据偏保守 → 实测把「正常走能赶上」误报成「赶不上」。
 */
import { OVERHEAD_SEC, SPEED_RATIO, TIER_TEXT, type CatchTier } from "./types";

/** 以某档速度走完给定基准时长，所需秒数 */
export function requiredSec(baseMin: number, tier: CatchTier): number {
  const base = Math.max(0, baseMin * 60 - OVERHEAD_SEC);
  return OVERHEAD_SEC + base * SPEED_RATIO[tier];
}

/**
 * 判定档位：从 5 → 1 找**首个** `requiredSec ≤ waitSec` 的档（越慢的档要求越低）。
 * 都不满足（连冲刺都赶不上）→ null。
 *
 * @param baseMin 该段步行的「正常走」基准时长（分钟）
 * @param waitSec 车辆到站剩余（秒，**区间下限**）
 */
export function pickCatchTier(baseMin: number, waitSec: number): CatchTier | null {
  for (let k = 5; k >= 1; k--) {
    const t = k as CatchTier;
    if (requiredSec(baseMin, t) <= waitSec) return t;
  }
  return null;
}

/** 档位文案（★ v1.0.6：不再有 null 分支 —— 赶不上的路线已被整条剔除） */
export function tierTextOf(tier: CatchTier): string {
  return TIER_TEXT[tier];
}

/**
 * 分档剩余秒 → 「约 lo~hi 分」文案（往短了算，区间下限即缓冲）。
 *
 * ⚠️ 区间可能异常宽：`lo` 剔掉了「已过的那一跳」，而某跳的 segment_stats 样本本身可能偏大
 *    （跨站打点 / 路况），实测出现「约 4~21 分」这种 5 倍差 —— 呈现在卡片上等于没说。
 *    → 当 hi 超过 lo 的 2 倍且绝对差 ≥ 5 分时，**只报下限并标「起」**（计划 §5.4 允许只显下限）：
 *      「约 4 分起」诚实表达「至少还要这么久」，比一个宽到无用的区间更好决策。
 */
export function rangeText(loSec: number, hiSec: number): string {
  const lo = Math.max(0, Math.floor(loSec / 60));
  const hi = Math.max(lo, Math.ceil(hiSec / 60));
  if (lo === hi) return `约 ${lo} 分`;
  if (hi > lo * 2 && hi - lo >= 5) return `约 ${lo} 分起`;
  return `约 ${lo}~${hi} 分`;
}
