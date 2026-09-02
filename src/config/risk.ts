/**
 * 风控参数集中配置（★ 全项目唯一可调处，改参数不动代码）
 * 依据：docs/spec.md 第 3 节 / PRD v0.3 风险管理维度
 */
export const RISK = {
  // 第一版：计时器打点时单次查询 DSAT 抓车辆信息。无轮询。
  timerGrab: {
    enabled: true, // 应急开关：false = 完全不碰 DSAT
    timeoutMs: 5000, // 单次超时；超时=失败，字段留空，不影响计时
  },
  // 通用保险（所有 DSAT 调用共用）
  circuitBreaker: {
    failThreshold: 3, // 连续失败 3 次 → 熔断
    cooldownMin: 30, // 熔断后静默 30 分钟
  },
  dailyLimit: 500, // 每日请求总量硬上限（GMT+8 自然日，超限即停到次日）
  // M3 预留（本期不启用）
  poll: { enabled: false, intervalSec: 60 },
} as const;

export type RiskConfig = typeof RISK;
