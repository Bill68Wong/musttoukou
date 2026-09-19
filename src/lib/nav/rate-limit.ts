/**
 * 跨实例令牌桶 —— 兼容转发（src/lib/nav/rate-limit.ts）
 *
 * 设计 §3 的任务分解表把限流器列在 `src/lib/nav/rate-limit.ts`；而本步骤的任务说明
 * 明确要求放在 `src/lib/amap/rate-limit.ts`（它确实是对**高德调用**的限流，与 amap
 * 域耦合更紧）。为**同时满足**设计清单与任务说明，这里做**零逻辑转发**：
 * 唯一实现见 `src/lib/amap/rate-limit.ts`，本文件仅供按设计路径 import 的调用方使用。
 *
 * ⚠️ 不要在本文件新增任何逻辑 —— 改限流算法请改 `src/lib/amap/rate-limit.ts`。
 */
export * from "@/lib/amap/rate-limit";
