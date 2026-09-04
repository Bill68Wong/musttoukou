/**
 * 报站数平滑（src/lib/eta-smooth.ts）
 * 背景：v0.8.2 曾因 DSAT"离站后挂载站切换滞后"导致过渡帧 2→3→1 假倒退而引入本模块。
 * v0.8.4 已修正根因（eta.ts 口径：s0/s1 同值，数字天然单调递减），2→3 不再由公式产生；
 * 本模块保留为**纯防御层**：DSAT 数据自身偶发回跳（换车/换向/数据毛刺）时仍按
 * 「线路|车牌|等车站」只降不升兜底，且不干预正常递减。
 *
 * 规则：
 *  - 记忆上一帧显示值，同车同站新值回涨时沿用旧值（cap）；
 *  - 最近车切换（旧车消失/被超车）时新车无记忆，直接显示真实值；
 *  - 记忆超时（默认 120s）自动清除，防止回场/掉头/换向的车被永久压住。
 *
 * 记忆为模块级单例而非组件 useRef（v0.8.3 E2E 揪出）——TimerWizard 步骤容器
 * <div key={idx}> 在每次打点推进时卸载重建 LiveEta，useRef 记忆随之清零。
 * getSmoothMem() 提供 globalThis 单例：同页面跨 remount 存活；刷新/关页即重置。
 * key 含等车站：不同站等同一辆车不作比较。
 *
 * 纯函数、无副作用（除原地修正传入的 results），可被 .verify/ 脚本直接单测。
 */

export type SmoothableResult = {
  route: string;
  ok: boolean;
  nearest?: { plate: string | null; stopsAway: number } | null;
};

/** 同车记忆条目：上一帧平滑后的显示值 + 上次出现时间戳 */
export type SmoothMemEntry = { stopsAway: number; ts: number };

/** 记忆最大存活：超过则删除，允许该车按真实值重新显示 */
export const SMOOTH_MAX_AGE_MS = 120_000;

const g = globalThis as unknown as {
  __etaSmoothMem?: Map<string, SmoothMemEntry>;
};

/**
 * 模块级记忆单例（跨组件 remount 存活；浏览器刷新/关页后随 JS 运行时重置）。
 * 组件应把该实例传给 smoothStopsAway，而不是自己 new Map（useRef 会在步骤推进时清零）。
 */
export function getSmoothMem(): Map<string, SmoothMemEntry> {
  if (!g.__etaSmoothMem) g.__etaSmoothMem = new Map();
  return g.__etaSmoothMem;
}

/**
 * 对一帧结果做"同车只降不升"修正（原地改 nearest.stopsAway）。
 * @param mem  跨帧记忆 Map（用 getSmoothMem() 获取的模块级单例）
 * @param results 当前帧各线路结果（与 EtaResponse.results 同构，字段够用即可）
 * @param station 等车站（记忆键的一部分：不同站等同一辆车不作比较）
 * @param now  当前时间戳（测试可注入）
 */
export function smoothStopsAway(
  mem: Map<string, SmoothMemEntry>,
  results: SmoothableResult[],
  station: string,
  now: number = Date.now(),
): void {
  // ① 清理超时记忆
  for (const [k, v] of mem) {
    if (now - v.ts > SMOOTH_MAX_AGE_MS) mem.delete(k);
  }
  // ② 逐线路修正
  for (const r of results) {
    if (!r.ok || !r.nearest || !r.nearest.plate) continue; // 无最近车/无车牌不参与
    const key = `${r.route}|${r.nearest.plate}|${station}`;
    const prev = mem.get(key);
    if (prev && r.nearest.stopsAway > prev.stopsAway) {
      // 同车同站回跳：DSAT 过渡帧滞后所致，物理剩余不变 → 沿用上一帧显示值
      r.nearest.stopsAway = prev.stopsAway;
    }
    mem.set(key, { stopsAway: r.nearest.stopsAway, ts: now });
  }
}

