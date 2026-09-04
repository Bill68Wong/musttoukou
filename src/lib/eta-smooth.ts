/**
 * 报站数平滑（src/lib/eta-smooth.ts）
 * v0.8.2 修复 C 抖动：同一辆车物理上只会越开越近，剩余站数应当只降不升。
 * 但 DSAT 的"车↔站"关联在站间行驶时更新滞后（车已离 U−2、记录还停在"驶向 U−2"），
 * 过渡帧会把停靠 U−2 时的 2 算成 3，界面出现 2→3→1 的假倒退。
 *
 * 修法：按「线路|车牌」记住上一帧显示值；同车新值回涨时沿用旧值（cap）。
 *  - 物理正确的场景（车真正变近）值递减，永不触发 cap；
 *  - 最近车切换（旧车消失/被超车）时新车无记忆，直接显示真实值；
 *  - 记忆超时（默认 120s）自动清除，防止回场/掉头/换向的车被永久压住。
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

/**
 * 对一帧结果做"同车只降不升"修正（原地改 nearest.stopsAway）。
 * @param mem  跨帧记忆 Map（组件用 useRef 持有）
 * @param results 当前帧各线路结果（与 EtaResponse.results 同构，字段够用即可）
 * @param now  当前时间戳（测试可注入）
 */
export function smoothStopsAway(
  mem: Map<string, SmoothMemEntry>,
  results: SmoothableResult[],
  now: number = Date.now(),
): void {
  // ① 清理超时记忆
  for (const [k, v] of mem) {
    if (now - v.ts > SMOOTH_MAX_AGE_MS) mem.delete(k);
  }
  // ② 逐线路修正
  for (const r of results) {
    if (!r.ok || !r.nearest || !r.nearest.plate) continue; // 无最近车/无车牌不参与
    const key = `${r.route}|${r.nearest.plate}`;
    const prev = mem.get(key);
    if (prev && r.nearest.stopsAway > prev.stopsAway) {
      // 同车回跳：DSAT 过渡帧滞后所致，物理剩余不变 → 沿用上一帧显示值
      r.nearest.stopsAway = prev.stopsAway;
    }
    mem.set(key, { stopsAway: r.nearest.stopsAway, ts: now });
  }
}
