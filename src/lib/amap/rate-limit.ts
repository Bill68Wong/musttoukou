/**
 * 高德调用 · 跨实例令牌桶（src/lib/amap/rate-limit.ts，v1.3.0）
 *
 * ── 为什么必须「跨实例」────────────────────────────────────────────────
 *   高德个人认证开发者的**基础 LBS 服务并发上限 = 3 次/秒【官方+实测】**，且该上限是
 *   **按 Key 全局**的 —— 不是按进程。Vercel 上每个 Serverless 实例都是独立进程，
 *   **单进程变量（如 `client.ts` 里的 `lastCallAt`）在多实例下完全失效** ✗
 *   ⇒ 必须把令牌桶放到**共享存储**（Postgres），用 `pg_advisory_xact_lock`
 *   把所有实例的扣减**串行化**，才能保证「全实例合计 ≤ QPS」。
 *   （这是 QA 批判性审查 **P0-1** 的教训：本地限速看起来对、一上多实例就崩。）
 *
 * ── 算法（延迟最小化）─────────────────────────────────────────────────
 *   每桶一行 `amap_rate_bucket(bucket, tokens, updated_at)`：
 *     ① 事务内 `pg_advisory_xact_lock(hashtext('amap_rate:'||bucket))` 串行化；
 *     ② 原子补充：`tokens = LEAST(capacity, tokens + elapsed* qps)`（按经过时间线性回填）；
 *     ③ 条件扣减：`tokens >= 1` 才 `-1`（否则视为本次未取到）。
 *   —— 桶的行锁只在这一条事务内持有（毫秒级），不会成为热点瓶颈。
 *
 * ── 使用约定 ──────────────────────────────────────────────────────────
 *   · 主路径用 `acquireToken(bucket)`（**不等待**）：取不到 → 调用方退避/降级（§B.6）；
 *   · 离线预热用 `acquireWithWait(bucket, timeoutMs)`：可短等，避免抖失败。
 *   · 分桶：`transit`（公交路径）/ `walking`（步行路径）/ `search`（POI 搜索）。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §B.4 / §6.2；审查 P0-1。
 */
import { getPool } from "@/lib/db";

/** 默认 QPS（全 Key 共用）—— 官方 3/s，这里取 3 并留由 `capacity` 吸收突发 */
export const AMAP_QPS = 3;
/** 桶容量（允许的短突发量）。默认 6 = 2 秒的量，够抵消「请求批次」抖动 */
export const AMAP_BUCKET_CAPACITY = 6;

/** 分桶名（与设计 §6.2 「transit/walking/search 分桶」一致） */
export const RATE_BUCKET = {
  transit: "transit",
  walking: "walking",
  search: "search",
} as const;
export type RateBucketName = (typeof RATE_BUCKET)[keyof typeof RATE_BUCKET];

export interface RateDecision {
  /** true = 已扣到令牌，可以发起高德调用 */
  ok: boolean;
  /** 扣减后剩余令牌（近似，供日志/看板）；取不到时为当前余量 */
  tokensLeft: number | null;
}

/** 纯函数：按经过时间回填令牌（可单测；与 SQL 里的 LEAST 表达式同一口径） */
export function refillTokens(
  tokens: number,
  elapsedSec: number,
  qps: number = AMAP_QPS,
  capacity: number = AMAP_BUCKET_CAPACITY,
): number {
  const refilled = tokens + Math.max(0, elapsedSec) * qps;
  return Math.min(capacity, refilled);
}

/**
 * 尝试取一个令牌（**单次、不等待**）。
 *
 * @param bucket 分桶名（见 `RATE_BUCKET`）
 * @param qps    该桶速率（默认 3/s）
 * @param capacity 桶容量（默认 6）
 * @returns `{ ok:false }` 表示此刻应退避/降级（**不抛错**，调用方决定行为）
 */
export async function acquireToken(
  bucket: string,
  qps: number = AMAP_QPS,
  capacity: number = AMAP_BUCKET_CAPACITY,
): Promise<RateDecision> {
  const pool = getPool();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // 首次使用建行（幂等；tokens 初始 = capacity，等价于「启动即满桶」）
    await c.query(
      `INSERT INTO amap_rate_bucket (bucket, tokens, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (bucket) DO NOTHING`,
      [bucket, capacity],
    );
    // ★ 跨实例串行化：advisory 事务锁（键 = 'amap_rate:'||bucket 的 hash）
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`amap_rate:${bucket}`]);
    // ① 原子补充
    await c.query(
      `UPDATE amap_rate_bucket
          SET tokens = LEAST($2::numeric, tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * $3::numeric),
              updated_at = now()
        WHERE bucket = $1`,
      [bucket, capacity, qps],
    );
    // ② 条件扣减（tokens>=1 才扣）
    const r = await c.query(
      `UPDATE amap_rate_bucket
          SET tokens = tokens - 1
        WHERE bucket = $1 AND tokens >= 1
        RETURNING tokens`,
      [bucket],
    );
    const now = await c.query(`SELECT tokens FROM amap_rate_bucket WHERE bucket = $1`, [bucket]);
    await c.query("COMMIT");
    const left = now.rows[0]?.tokens !== undefined ? Number(now.rows[0].tokens) : null;
    return { ok: (r.rowCount ?? 0) > 0, tokensLeft: left };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * 取令牌，取不到则**短等重试**（离线/可等待场景用；主路径请用 `acquireToken`）。
 *
 * @param bucket    分桶名
 * @param timeoutMs 最长等待（毫秒）；超时返回 `{ ok:false }`
 */
export async function acquireWithWait(
  bucket: string,
  timeoutMs = 2_000,
  qps: number = AMAP_QPS,
  capacity: number = AMAP_BUCKET_CAPACITY,
): Promise<RateDecision> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  // 一个令牌最坏等 1/qps 秒；轮询间隔取略大于该值的 1/2，兼顾及时与礼让
  const stepMs = Math.max(50, Math.round(1000 / qps / 2));
  let last: RateDecision = { ok: false, tokensLeft: null };
  for (;;) {
    last = await acquireToken(bucket, qps, capacity);
    if (last.ok) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
