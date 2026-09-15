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
  // ★ v1.0.0 自动选线：一次页面加载会并发 8~16 次 DSAT 调用（计时路径一次最多 1 次），
  //   因此**单独设更短超时**（不等 5s，避免单条线路拖垮整页 2s 预算），
  //   且**不参与熔断判定**（见 src/lib/risk.ts#guardDsatCall 的 purpose 过滤）——
  //   否则一次推荐就能撞开熔断，连累计时器的自动车距快照一起哑 30 分钟。
  recommend: {
    enabled: true,
    timeoutMs: 1500,
  },
  // 通用保险（所有 DSAT 调用共用）
  circuitBreaker: {
    failThreshold: 3, // 连续失败 3 次 → 熔断
    cooldownMin: 30, // 熔断后静默 30 分钟
  },
  // v0.17.1：dailyLimit 已彻底取消（单人 PWA 无刷量风险；dsat_call_logs 保留记账仅作统计）
  // M3 预留（本期不启用）
  poll: { enabled: false, intervalSec: 60 },
} as const;

export type RiskConfig = typeof RISK;
