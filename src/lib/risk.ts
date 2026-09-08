/**
 * 风控守卫（src/lib/risk.ts）—— 无状态实现
 *
 * ① 熔断：查 dsat_call_logs 最近 N 条，若全部失败且最后一条失败在冷却期内 → 拒绝调用
 * ② 记账：每次调用成败写入 dsat_call_logs
 * （v0.17.1：日限已彻底取消——单人 PWA 无刷量风险，日志保留仅作统计）
 *
 * 设计说明：状态从日志表推导而非内存，保证 Vercel serverless 多实例下依然生效。
 * 数据库不可用时 fail-open（放行调用 + console 告警）——风控组件自身故障不拖垮计时器。
 */
import { RISK } from "../config/risk";
import { getPool } from "./db";

export interface GuardVerdict {
  allowed: boolean;
  reason?: "circuit_open";
  detail?: string;
}

/** ① 调用前检查：熔断 */
export async function guardDsatCall(now: Date = new Date()): Promise<GuardVerdict> {
  try {
    // ① 熔断：最近 failThreshold 条是否全失败
    const recent = await getPool().query(
      `SELECT ok, created_at FROM dsat_call_logs ORDER BY id DESC LIMIT $1`,
      [RISK.circuitBreaker.failThreshold],
    );
    const rows = recent.rows as { ok: boolean; created_at: string }[];
    if (
      rows.length === RISK.circuitBreaker.failThreshold &&
      rows.every((r) => !r.ok)
    ) {
      const lastFail = new Date(rows[0].created_at);
      const cooldownEnd = new Date(
        lastFail.getTime() + RISK.circuitBreaker.cooldownMin * 60 * 1000,
      );
      if (now < cooldownEnd) {
        return {
          allowed: false,
          reason: "circuit_open",
          detail: `连续失败熔断中，静默至 ${cooldownEnd.toISOString()}`,
        };
      }
    }

    return { allowed: true };
  } catch (err) {
    // 日志表不存在/数据库不可达 → fail-open
    console.warn("[risk] 风控日志不可用，放行调用：", (err as Error).message);
    return { allowed: true };
  }
}

/** ③ 调用后记账（尽力写入，失败不影响主流程） */
export async function logDsatCall(entry: {
  purpose: "timer_grab" | "poll" | "sync";
  route_code?: string | null;
  ok: boolean;
  http_status?: number | null;
  error?: string | null;
  latency_ms: number;
}): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO dsat_call_logs (purpose, route_code, ok, http_status, error, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.purpose,
        entry.route_code ?? null,
        entry.ok,
        entry.http_status ?? null,
        entry.error ? String(entry.error).slice(0, 500) : null,
        Math.min(32767, Math.round(entry.latency_ms)),
      ],
    );
  } catch (err) {
    console.warn("[risk] 调用日志写入失败：", (err as Error).message);
  }
}
