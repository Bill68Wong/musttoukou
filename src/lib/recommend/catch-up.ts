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
import { OVERHEAD_SEC, SPEED_RATIO, TIER_TEXT, tier1EffRatio, type CatchTier } from "./types";

/**
 * 以某档速度走完给定基准时长，所需秒数。
 *
 * ★ v1.2.0：新增可选参数 `walkDistanceM` —— **档 1 用它做随距离衰减**。
 *
 *   背景：线性模型隐含「3.6 m/s 跑完全程」✗，但 PCr 只能撑 8~10 秒（≈30 米）。
 *   现在档 1 改用 `tier1EffRatio(distanceM)`（按能量系统的四段模型）。
 *   ⚠️ **不传距离时退回原来的线性行为**（向后兼容，且实测样本没有距离时也能算）。
 *
 *   ⚠️ 档 2~5 **不受距离影响** —— 2.0 m/s 是小跑（有氧强度，真的能跑 1 公里），
 *      模型没算错，不需要修正 ✓（详见 docs/步行速度五档-文献依据-20260918.md §7.7）
 *
 * @param baseMin       该段步行的「正常走」基准时长（分钟）
 * @param tier          档位
 * @param walkDistanceM 该段步行路径距离（米）；`null`/缺省 = 未知，档 1 退回线性
 */
export function requiredSec(baseMin: number, tier: CatchTier, walkDistanceM?: number | null): number {
  const base = Math.max(0, baseMin * 60 - OVERHEAD_SEC);
  const ratio = tier === 1 ? tier1EffRatio(walkDistanceM) : SPEED_RATIO[tier];
  return OVERHEAD_SEC + base * ratio;
}

/**
 * 判定档位：从 5 → 1 找**首个** `requiredSec ≤ waitSec` 的档（越慢的档要求越低）。
 * 都不满足（连冲刺都赶不上）→ null。
 *
 * @param baseMin       该段步行的「正常走」基准时长（分钟）
 * @param waitSec       车辆到站剩余（秒，**区间下限**）
 * @param walkDistanceM 该段步行距离（米）；用于档 1 的随距离衰减
 */
export function pickCatchTier(baseMin: number, waitSec: number, walkDistanceM?: number | null): CatchTier | null {
  for (let k = 5; k >= 1; k--) {
    const t = k as CatchTier;
    if (requiredSec(baseMin, t, walkDistanceM) <= waitSec) return t;
  }
  return null;
}

/** 档位文案（★ v1.0.6：不再有 null 分支 —— 赶不上的路线已被整条剔除） */
export function tierTextOf(tier: CatchTier): string {
  return TIER_TEXT[tier];
}

/**
 * ★ v1.1.2：档位差额提示 —— **只在比常速更快时（档 1~2）**给出。
 *
 * 为什么要这句话：卡片顶部大字用的是「**按该档速度走**」的到达时刻，而卡面那一行
 * 「步行 X 分」显示的是**常速实测均值**（`walk_times`），两者天生差一截
 * → 把卡面上看得见的每一项相加，会比顶部大字**多**（实测 5 张里 2 张差 1.4 分，
 *   理论上限约 4 分钟）。**大字本身没有算错**（它回答的是「现在出门、跑到站能赶上的话几点到」），
 * 缺的只是一句解释 → 由这里补出「需較常速快 X 分」。
 *
 * @param baseMin 该段步行的「正常走」基准时长（分钟）—— 必须与卡面显示的同一份
 * @param walkDistanceM 该段步行距离（米）；档 1 的差额会随距离变化（v1.2.0）
 * @returns 档 3~5（无需加速）或差额 < 30 秒 → `""`（不占版面）
 */
export function tierHintOf(baseMin: number, tier: CatchTier, walkDistanceM?: number | null): string {
  if (tier >= 3) return "";
  const saveSec = requiredSec(baseMin, 3) - requiredSec(baseMin, tier, walkDistanceM);
  if (saveSec < 30) return "";
  const m = Math.round((saveSec / 60) * 10) / 10;
  // ★ P1-2：界面文案**一律简体**（站名/线路名才用繁体）
  return `需较常速快 ${m} 分`;
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
