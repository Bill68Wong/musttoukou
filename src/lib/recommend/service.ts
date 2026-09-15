/**
 * 推荐编排 + 结果缓存（src/lib/recommend/service.ts，v1.0.0）
 *
 * 一条完整的自动选线链路，SSR 页面与 JSON 接口**共用同一份实现**（口径不可能漂移）：
 *
 *   ① loadStatics（60s 进程内缓存）→ 站序 / 段统计 / 步行 / 换乘 / 方案腿
 *   ② optionsFor(from→to)          → 候选路线方案枚举（首段上车 × 动态下车）
 *   ③ fetchLive(seeds)             → 实时班次（DSAT 巴士 + 本库轻轨时刻表，分桶并发）
 *   ④ modelOption × N              → 逐条算门到门总耗时 / 到达时刻 / 赶车档
 *   ⑤ sortCards                    → 按总用时排序，取前 limit 条
 *
 * ⚠️ 本模块含 pg（server-only）。client 只接收 `RecommendCard[]`（`./types` 里的纯视图类型）。
 *
 * ────────────────────────── 缓存 ──────────────────────────
 * `globalThis.__recCache`：key = `from|to|zone|limit`，TTL **10s**。
 *   · 命中 → 直接返回上一次的卡（含 excluded/stats），零计算零网络 → 刷新体感即时。
 *   · 用户手动刷新带 `force` → 绕过缓存直算（并回写）。
 *   · ⚠️ key 必须含 zone：同一 from→to 在 B/C 与 N/O 座区的**步行分钟不同** → 卡也不同。
 *     这正是项目铁律「学校不同座 = 不同目的地」在缓存层的落实。
 */
import type { Pool } from "pg";
import { fetchLive, type LiveBatch } from "./live";
import { modelOption, sortCards } from "./model";
import { contextFor, loadStatics, optionsFor, type RecStatic } from "./query";
import type { RecommendCard, SchoolZone } from "./types";

const CACHE_TTL_MS = 10_000;

const g = globalThis as unknown as {
  __recCache?: Map<string, { ts: number; data: RecommendResult }>;
};
if (!g.__recCache) g.__recCache = new Map();

export interface RecommendStats {
  /** 枚举出的候选路线方案总数 */
  candidates: number;
  /** 静态装载耗时（ms） */
  staticMs: number;
  /** 实时层耗时（ms） */
  liveMs: number;
  /** 实时桶数 / DSAT 调用数 / 超时桶数 */
  buckets: number;
  dsatCalls: number;
  timedOut: number;
  /** 模型计算耗时（ms） */
  modelMs: number;
  /** 总耗时（ms） */
  ms: number;
  /** 实时层逐桶明细（诊断） */
  bucketsDetail: LiveBatch["stats"]["items"];
}

export interface RecommendResult {
  fromSlug: string;
  toSlug: string;
  zone: SchoolZone | null;
  cards: RecommendCard[];
  /** 线路码 → 主题色（静态层带出，省一次查询；刷新时可原样复用） */
  colors: Record<string, string>;
  /** 被排除的线路（无在途车 / 已收车 / 站序缺失）→ 静默剔除计数器 */
  excluded: string[];
  stats: RecommendStats;
  /** 结果生成时刻（ms） */
  generatedAt: number;
  /** 本次是否命中缓存 */
  cached: boolean;
}

export interface RecommendInput {
  fromSlug: string;
  toSlug: string;
  /** 座区（仅 school 侧有意义；非 school 侧忽略） */
  zone?: SchoolZone | null;
  /** 取前几名（默认 5） */
  limit?: number;
  /** 绕过 10s 缓存直算（用户手动刷新） */
  force?: boolean;
  /**
   * ★ 时间基准注入（默认 `Date.now()`）。用途：探针在**收班时段**用假时间验证白天链路
   * （轻轨时刻表按注入时刻算；⚠️ 巴士是 DSAT 实时数据，**无法伪造**——
   *  深夜跑探针时巴士仍按真实无车剔除，属预期）。
   */
  nowMs?: number;
}

/**
 * 算一批推荐卡。
 * @returns 可能 `cards` 为空（该时段线路全部收车/无在途车）——调用方须渲染空状态
 */
export async function recommend(
  pool: Pool,
  input: RecommendInput,
): Promise<RecommendResult> {
  const zone = input.zone ?? null;
  const limit = Math.max(1, Math.min(20, input.limit ?? 5));
  const key = `${input.fromSlug}|${input.toSlug}|${zone ?? ""}|${limit}`;
  const cached = g.__recCache!.get(key);
  if (!input.force && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { ...cached.data, cached: true };
  }

  const tAll = Date.now();
  const nowMs = input.nowMs ?? Date.now();

  // ① 静态
  const tStatic = Date.now();
  const st: RecStatic = await loadStatics(pool);
  const staticMs = Date.now() - tStatic;

  // ② 枚举候选
  const seeds = optionsFor(st, input.fromSlug, input.toSlug);

  // ③ 实时
  const tLive = Date.now();
  const batch = await fetchLive(pool, seeds, st.routeIdx, st.segIdx, {
    todayWeekday: new Date(nowMs + 8 * 3_600_000).getUTCDay(),
    nowMs: input.nowMs,
    lrtPre: st.lrtPre,
  });
  const liveMs = Date.now() - tLive;

  // ④ 逐条建模
  const tModel = Date.now();
  const ctx = contextFor(st, nowMs, zone, batch.live);
  const cards: RecommendCard[] = [];
  for (const seed of seeds) {
    const card = modelOption(seed, ctx);
    if (card) cards.push(card);
  }
  // ⑤ 排序取前 N
  const top = sortCards(cards).slice(0, limit);
  const modelMs = Date.now() - tModel;

  const result: RecommendResult = {
    fromSlug: input.fromSlug,
    toSlug: input.toSlug,
    zone,
    cards: top,
    colors: st.routeColors,
    excluded: [...new Set(ctx.excluded)],
    stats: {
      candidates: seeds.length,
      staticMs,
      liveMs,
      buckets: batch.stats.buckets,
      dsatCalls: batch.stats.dsatCalls,
      timedOut: batch.stats.timedOut,
      modelMs,
      ms: Date.now() - tAll,
      bucketsDetail: batch.stats.items,
    },
    generatedAt: nowMs,
    cached: false,
  };

  g.__recCache!.set(key, { ts: Date.now(), data: result });
  return result;
}

/** 清空推荐结果缓存（探针 / 调试用，慎在生产调用） */
export function clearRecommendCache(): void {
  g.__recCache?.clear();
}
