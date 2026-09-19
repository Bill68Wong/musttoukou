/**
 * 搜索配额记账 + 熔断（src/lib/nav/quota.ts，v1.3.0 · T02）
 *
 * ── 为什么单独做（R-07）────────────────────────────────────────────────
 *   高德**搜索类**（`place/text` / `inputtips`）月配额 **仅 5,000 次**，且**超限时静默
 *   返回空结果、不报错**【实测】✗ —— 一旦打满，用户看到的是「搜不到」，**没有任何错误**，
 *   极难发现。因此必须**主动记账 + 主动熔断**。
 *   方案 A（§2.A.6）把打字阶段做成 0 配额，只有「回车」才消耗 ⇒ 目标 ≈600/月，余量 8×。
 *
 * ── 记账 ──────────────────────────────────────────────────────────────
 *   每次真正发起高德搜索调用 → 往 `search_quota_log` 落 1 行
 *   （api / ok / infocode / latency_ms / day）。月度用量 = 本月行数（`day` 列）。
 *   ★ 该表同时是**命中率监控**的唯一数据源（未验证指标，见设计 §2.A）。
 *
 * ── 熔断 ──────────────────────────────────────────────────────────────
 *   触发条件（任一）：
 *     · 本月用量 ≥ `CIRCUIT_AT`（默认 4000，即配额 5000 的 80%）；
 *     · 当日用量 ≥ `DAY_SOFT_LIMIT`（默认 150，防单日突发打满）；
 *   熔断后**同时停掉 `inputtips` 与 `place/text`**（设计明确：不是只停兜底）——
 *   两条路径都先过 `circuitState()`，共用一个闸门。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §2.A / §2.A.6 / §8-P1-3；风险 R-07。
 */
import { getPool } from "@/lib/db";

/** 搜索类月配额（官方 5,000） */
export const SEARCH_MONTH_LIMIT = 5000;
/** 熔断阈值：本月用量达到即熔断（默认 4000 = 80%） */
export const SEARCH_CIRCUIT_AT = numEnv("AMAP_SEARCH_CIRCUIT_AT", 4000);
/** 单日软上限（防一天打满） */
export const SEARCH_DAY_SOFT_LIMIT = numEnv("AMAP_SEARCH_DAY_SOFT_LIMIT", 150);

function numEnv(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

export interface CircuitState {
  /** true = 已熔断（应停掉所有高德搜索调用） */
  open: boolean;
  /** 本月已用搜索次数 */
  monthUsage: number;
  /** 今日已用搜索次数 */
  dayUsage: number;
  /** 熔断原因（open=true 时有值） */
  reason?: "month_limit" | "day_limit";
  /** 阈值（便于日志） */
  circuitAt: number;
  daySoftLimit: number;
}

// 用量读的短缓存（5s）——回车路径每会话至多几次，缓存只为挡住短时突发读放大
let usageCache: { at: number; month: number; day: number } | null = null;
const USAGE_TTL_MS = 5_000;

async function readUsage(): Promise<{ month: number; day: number }> {
  if (usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) {
    return { month: usageCache.month, day: usageCache.day };
  }
  const pool = getPool();
  const { rows } = await pool.query<{ month: string; day: string }>(
    `SELECT
        count(*) FILTER (WHERE day >= date_trunc('month', now())::date) AS month,
        count(*) FILTER (WHERE day = current_date) AS day
       FROM search_quota_log`,
  );
  const month = Number(rows[0]?.month ?? 0);
  const day = Number(rows[0]?.day ?? 0);
  usageCache = { at: Date.now(), month, day };
  return { month, day };
}

/** 当前熔断状态（读 `search_quota_log`；失败时**保守放行**，但置 reason 供日志） */
export async function circuitState(): Promise<CircuitState> {
  let monthUsage = 0;
  let dayUsage = 0;
  try {
    const u = await readUsage();
    monthUsage = u.month;
    dayUsage = u.day;
  } catch {
    // 读不到用量（DB 抖）→ 不熔断（宁可偶尔多调，也不要「因读不到而全停」）
    return { open: false, monthUsage: 0, dayUsage: 0, circuitAt: SEARCH_CIRCUIT_AT, daySoftLimit: SEARCH_DAY_SOFT_LIMIT };
  }
  if (monthUsage >= SEARCH_CIRCUIT_AT) {
    return { open: true, monthUsage, dayUsage, reason: "month_limit", circuitAt: SEARCH_CIRCUIT_AT, daySoftLimit: SEARCH_DAY_SOFT_LIMIT };
  }
  if (dayUsage >= SEARCH_DAY_SOFT_LIMIT) {
    return { open: true, monthUsage, dayUsage, reason: "day_limit", circuitAt: SEARCH_CIRCUIT_AT, daySoftLimit: SEARCH_DAY_SOFT_LIMIT };
  }
  return { open: false, monthUsage, dayUsage, circuitAt: SEARCH_CIRCUIT_AT, daySoftLimit: SEARCH_DAY_SOFT_LIMIT };
}

/** 每次真正调高德搜索 ←→ 落一行（**fire-and-forget，绝不抛错中断搜索**） */
export async function recordSearchCall(
  api: "inputtips" | "place/text",
  ok: boolean,
  infocode: string | undefined,
  latencyMs: number,
): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO search_quota_log (api, ok, infocode, latency_ms) VALUES ($1, $2, $3, $4)`,
      [api, ok, infocode ?? null, Number.isFinite(latencyMs) ? Math.round(latencyMs) : null],
    );
    // 写后让缓存失效，下次读到最新
    usageCache = null;
  } catch {
    /* 记账失败不影响搜索本身 */
  }
}

/** 供诊断/测试：强制清缓存 */
export function _resetUsageCache(): void {
  usageCache = null;
}
