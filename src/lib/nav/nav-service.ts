/**
 * 全澳导航编排（src/lib/nav/nav-service.ts，v1.3.0 提案 · T03）
 *
 * ── 一条完整链路（设计 §1.1 / §2.B / §2.C）────────────────────────────
 *   ① 静态装载 `loadStatics()`（复用旧推荐域：站序/段统计/步行/换乘/轻轨预载）；
 *   ② 站码映射表 `loadStationMap()`（人工确认优先）；
 *   ③ **高德 transit**（`fetchTransitPlans`，`AlternativeRoute=10`，带 `transit_cache`）；
 *   ④ 解析 → 过滤（穿梭巴士/在建）→ **桥接**（高德站→我们主码 + 逐跳站序）；
 *   ⑤ **本地图枚举**（补漏来源；**请求期现场跑**，失败即降级引擎）→ 候选；
 *   ⑥ `fetchLive`（DSAT 巴士 + 本库轻轨时刻表，**两来源共用一次**）；
 *   ⑦ 逐方案：`modelOption`（**注入 walkResolver + 方案级换乘索引**）→ `patchAmapFallback`（映射失败段回落高德 + provenance）；
 *   ⑧ `merge-sources`（补漏质量闸门；数量**默认不限**）→ `rank`（`T_ours` 升序）；
 *   ⑨ 返回前 `limit` 张（与旧版**完全一致**的卡片结构 → T04 直接复用渲染）。
 *
 * ── ★ 降级（§B.6）─────────────────────────────────────────────────────
 *   高德失败/超时/限流/0 方案 → `degraded=true`，**只用本地枚举 + `walk_times`（旧实测）**出卡。
 *
 * ── ★ 请求期现场枚举（2026-09-19 口径变更）──────────────────────────────
 *   产品拍板：本地枚举**每次请求现场执行**（`searchStationPaths`），**不再依赖离线表**
 *   `shadow_diff_report`。理由：离线表只覆盖历史 OD，新 OD 拿不到补漏；且枚举已被
 *   「链级限额 + 阶段预算」压到可控成本（研究报告 §4.6：修候选数控制后漏线率 20.5% → 8.6%）。
 *   ⇒ 删除原「只读离线表 `loadOfflineExtras`」路径，`localSource` 语义固定为 `"inline"`。
 *
 * ── ★ 多策略按需补查（2026-09-19 口径变更）──────────────────────────────
 *   默认只查高德 `strategy=0`；当**可用候选偏少**（`< MULTI_STRATEGY_WHEN_BELOW`）时
 *   **并行**补查 s=7/s=8 并按方案指纹合并去重（省配额 15 万/月；见 `fetchMultiStrategySeeds`）。
 *   补查**不得拖垮主流程**：整体失败静默降级为「只有 s=0 结果」。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §1.1 / §2.B / §2.C / §B.5 / §B.6
 */
import type { Pool } from "pg";
import { gcj02ToWgs84, haversineM } from "@/lib/amap/coord";
import { fixWalkDistance, walkMinutes } from "@/lib/amap/walk-fix";
import { fetchTransitPlans, type RawPlan, type TransitCacheIo, type AmapTransitRawResponse } from "@/lib/amap/transit";
import { fetchLive } from "@/lib/recommend/live";
import { amapPlanToSeed, modelOption, type ModeledOption } from "@/lib/recommend/model";
import { contextFor, loadStatics, type RecStatic } from "@/lib/recommend/query";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { RecommendCard, SchoolZone } from "@/lib/recommend/types";
import { candidatesToSeeds, pathsToCandidates, LOCAL_SUMMARY } from "./enumerate-nav";
import { searchStationPaths, type GeoStation, type StationPath } from "./graph-search";
import { loadStationMap, type BridgeContext, type StationMap } from "./map-stations";
import { mergeSources } from "./merge-sources";
import { parseAndBridge } from "./parse-amap-plan";
import { rankItems, type RankedItem } from "./rank";
import { makeCacheWalkResolver, makeWalkResolver, ourDataCoverage, overlayTransferIndex, patchAmapFallback, type WalkCacheMap } from "./recompute";
import type { AmapPlanSeed, NavEmptyReason, NavPoint, RecomputeProvenance, SegmentLevel } from "./types";

// ─────────────────────────── 接口 ───────────────────────────

export interface NavInput {
  origin: NavPoint;
  dest: NavPoint;
  /** 座区（仅当 origin/dest 是学校 place 时有意义） */
  zone?: SchoolZone | null;
  /** 取前几名（默认 5） */
  limit?: number;
  /** 时间基准（默认 `Date.now()`；测试可注入） */
  nowMs?: number;
  /** 绕过 `transit_cache`（强制真实调用） */
  noCache?: boolean;
  /**
   * @deprecated 自 2026-09-19 起**本地枚举每次请求现场执行**（见文件头「请求期现场枚举」），
   *   本字段不再生效，保留仅为**编译兼容**（现有调用方均未传，实际可删）。
   */
  allowInlineLocal?: boolean;
  /** 测试/回放：直接注入高德原始响应（跳过网络） */
  transitFixture?: AmapTransitRawResponse;
}

export interface NavStats {
  staticMs: number;
  transitMs: number;
  transitOk: boolean;
  transitFromCache: boolean;
  amapPlans: number;
  bridged: number;
  dropped: { index: number; reason: string }[];
  localCandidates: number;
  localKept: number;
  /** 本地枚举来源：`"inline"` = 请求期现场跑；`"none"` = 未产出（无近站等） */
  localSource: "inline" | "none";
  /** ★ 本次实际使用的高德策略（诊断用；如 `[0]` 或 `[0,7,8]`） */
  strategiesUsed: number[];
  liveMs: number;
  modelMs: number;
  ms: number;
}

export interface NavOutput {
  fromSlug: string;
  toSlug: string;
  /** 卡片（与旧版 `RecommendCard` **同构** → T04 直接复用） */
  cards: RecommendCard[];
  colors: Record<string, string>;
  /** true = 走高德降级路径（本地推算）→ UI 须提示「本地推算」 */
  degraded: boolean;
  emptyReason?: NavEmptyReason;
  /** ★ 当 `emptyReason='too_close'` 时给出的**纯步行建议**（分钟）——「走路比坐车快」（§11.4） */
  nearbyWalkMin?: number;
  /** 逐方案的二次计算凭据（键 = `optionSeed.key`） */
  provenance: Record<string, RecomputeProvenance>;
  /** 被剔除的线路（无在途车 / 已收车）与「首段赶不上」——沿用旧语义 */
  excluded: string[];
  missed: string[];
  stats: NavStats;
  generatedAt: number;
}

// ─────────────────────────── 缓存（映射表 / 站点地理） ───────────────────────────

const TTL_MS = 60_000;
const g = globalThis as unknown as {
  __navCaches?: { map?: { ts: number; data: StationMap }; geo?: { ts: number; data: GeoStation[] } };
};
if (!g.__navCaches) g.__navCaches = {};

async function loadStationMapCached(pool: Pool, force = false): Promise<StationMap> {
  const c = g.__navCaches!.map;
  if (!force && c && Date.now() - c.ts < TTL_MS) return c.data;
  const data = await loadStationMap(pool);
  g.__navCaches!.map = { ts: Date.now(), data };
  return data;
}

/** 站点地理（主码去重；**WGS84**，供本地图枚举的近站筛选） */
async function loadStationGeoCached(pool: Pool, force = false): Promise<GeoStation[]> {
  const c = g.__navCaches!.geo;
  if (!force && c && Date.now() - c.ts < TTL_MS) return c.data;
  const res = await pool.query(`SELECT code, lat, lng FROM stations WHERE lat IS NOT NULL AND lng IS NOT NULL`);
  const seen = new Set<string>();
  const data: GeoStation[] = [];
  for (const r of res.rows as Record<string, unknown>[]) {
    const main = mainCodeOf(String(r.code));
    if (seen.has(main)) continue;
    seen.add(main);
    data.push({ main, lat: Number(r.lat), lng: Number(r.lng) });
  }
  g.__navCaches!.geo = { ts: Date.now(), data };
  return data;
}

/** ★ P1-4：`walk_cache` 内存索引（供**本地/降级**路径的首末步行解析器；表小，整体载入） */
const gWalk = globalThis as unknown as { __navWalkCache?: { ts: number; data: WalkCacheMap } };
async function loadWalkCacheCached(pool: Pool, force = false): Promise<WalkCacheMap> {
  const c = gWalk.__navWalkCache;
  if (!force && c && Date.now() - c.ts < TTL_MS) return c.data;
  const m: WalkCacheMap = new Map();
  try {
    const res = await pool.query(`SELECT cache_key, distance_m, corrected_m FROM walk_cache LIMIT 20000`);
    for (const r of res.rows as Record<string, unknown>[]) {
      const d = Number(r.distance_m);
      const cm = Number(r.corrected_m);
      m.set(String(r.cache_key), {
        distanceM: Number.isFinite(d) ? d : null,
        correctedM: Number.isFinite(cm) ? cm : null,
      });
    }
  } catch {
    /* 表缺失 → 空缓存（解析器会回落「直线×1.5」） */
  }
  gWalk.__navWalkCache = { ts: Date.now(), data: m };
  return m;
}

// ─────────────────────────── 辅助 ───────────────────────────

/** 高德 OD 缓存读写（表不存在时静默降级为「不过缓存」） */
function makeTransitCacheIo(pool: Pool): TransitCacheIo {
  return {
    async get(odKey: string, ttlSec: number): Promise<RawPlan[] | null> {
      try {
        const r = await pool.query(
          `SELECT plans_json FROM transit_cache
            WHERE od_key = $1 AND fetched_at > now() - make_interval(secs => $2)`,
          [odKey, ttlSec],
        );
        const row = (r.rows as { plans_json?: unknown }[])[0];
        if (!row?.plans_json || !Array.isArray(row.plans_json)) return null;
        return row.plans_json as RawPlan[];
      } catch {
        return null;
      }
    },
    async put(odKey: string, plans: RawPlan[]): Promise<void> {
      try {
        await pool.query(
          `INSERT INTO transit_cache (od_key, plans_json, fetched_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (od_key) DO UPDATE SET plans_json = EXCLUDED.plans_json, fetched_at = now()`,
          [odKey, JSON.stringify(plans)],
        );
      } catch {
        /* 缓存写失败不影响本次结果 */
      }
    },
  };
}

/**
 * ★ 多策略按需补查阈值（产品口径 2026-09-19）：s=0 的**可用候选**（`seeds.length`）低于此值时，
 *   补查 s=7/s=8 以覆盖「路线太少」问题；否则只查 s=0（省配额）。
 */
const MULTI_STRATEGY_WHEN_BELOW = 3;

/** 补查使用的高德策略（产品指定：7/8） */
const MULTI_STRATEGIES: readonly number[] = [7, 8];

/**
 * ★ 方案指纹（跨策略去重用）：乘车段按 `${kind}:${线路名}:${上车站名}>${下车站名}` 拼接。
 *   用**高德原文**（`amapLineName`/`amapBoard.name`/`amapAlight.name`）而非桥接后主码——
 *   桥接可能部分失败，主码为空会把不同方案误判成同一条，原文更稳。
 */
function planFingerprint(seed: AmapPlanSeed): string {
  return seed.legs
    .map((l) => `${l.kind}:${l.amapLineName}:${l.amapBoard.name}>${l.amapAlight.name}`)
    .join("|");
}

/**
 * 按指纹把 `extra` 方案并入 `base`（**`base` 优先保留**：已存在指纹的 extra 丢弃）。
 * @returns 去重后的新数组（`base` 顺序不变，新增项追加在后）
 */
function mergeSeedsByFingerprint(base: AmapPlanSeed[], extra: AmapPlanSeed[]): AmapPlanSeed[] {
  const seen = new Set(base.map(planFingerprint));
  const out = [...base];
  for (const s of extra) {
    const fp = planFingerprint(s);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(s);
  }
  return out;
}

/**
 * ★ 多策略按需补查（产品口径 2026-09-19）：并行抓 s=7/s=8 → 解析桥接 → 各策略独立容错。
 *
 * · 每个策略**独立 try/catch**：单个失败**静默忽略**（视为空），不影响其它策略与主流程；
 * · 仍走原缓存（`transit_cache`，键含策略维度）与令牌桶（`rate-limit`）；
 * · 整体失败 ⇒ 返回空，调用方自然降级为「只有 s=0 结果」（**补查不得拖垮主流程**）。
 *
 * @returns 补查 seeds（**未与 s=0 去重**，由调用方合并）、带策略标签的 dropped、成功的策略号
 */
async function fetchMultiStrategySeeds(
  pool: Pool,
  origin: NavPoint,
  dest: NavPoint,
  bridgeCtx: BridgeContext,
  nowMs: number,
  noCache?: boolean,
): Promise<{ seeds: AmapPlanSeed[]; dropped: { index: number; reason: string }[]; strategiesUsed: number[] }> {
  const results = await Promise.all(
    MULTI_STRATEGIES.map(async (strategy) => {
      try {
        const r = await fetchTransitPlans(
          { lng: origin.lng, lat: origin.lat },
          { lng: dest.lng, lat: dest.lat },
          { cache: makeTransitCacheIo(pool), noCache, nowMs, strategy },
        );
        if (!r.ok) return { strategy, ok: false as const, seeds: [], dropped: [] };
        const raw: AmapTransitRawResponse = { status: "1", route: { transits: r.raw } };
        const parsed = parseAndBridge(raw, origin, dest, bridgeCtx);
        return {
          strategy,
          ok: true as const,
          seeds: parsed.seeds,
          // ★ 标注策略号，避免与 s=0 的 `index` 混淆（各策略 index 都从 1 起）
          dropped: parsed.dropped.map((d) => ({ index: d.index, reason: `s${strategy}:${d.reason}` })),
        };
      } catch {
        return { strategy, ok: false as const, seeds: [], dropped: [] };
      }
    }),
  );

  const seeds: AmapPlanSeed[] = [];
  const dropped: { index: number; reason: string }[] = [];
  const strategiesUsed: number[] = [];
  for (const r of results) {
    if (!r.ok) continue;
    strategiesUsed.push(r.strategy);
    seeds.push(...r.seeds);
    dropped.push(...r.dropped);
  }
  strategiesUsed.sort((a, b) => a - b); // Promise.all 已保序，此处再兜一层
  return { seeds, dropped, strategiesUsed };
}

/** NavPoint → 合成 slug（复用旧 `model.ts` 的 school 座区判据） */
function slugOf(p: NavPoint, placeSlugs: Set<string>): string {
  if (p.kind === "place" && p.code && placeSlugs.has(p.code)) return p.code;
  return p.kind;
}

// ─────────────────────────── 主流程 ───────────────────────────

export async function planNav(pool: Pool, input: NavInput): Promise<NavOutput> {
  const tAll = Date.now();
  const nowMs = input.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(20, input.limit ?? 5));
  const zone = input.zone ?? null;
  const origin = input.origin;
  const dest = input.dest;
  const fromWgs = gcj02ToWgs84({ lng: origin.lng, lat: origin.lat });
  const toWgs = gcj02ToWgs84({ lng: dest.lng, lat: dest.lat });

  // ① 静态
  const tStatic = Date.now();
  const st: RecStatic = await loadStatics(pool);
  const staticMs = Date.now() - tStatic;

  const map = await loadStationMapCached(pool);
  const geo = await loadStationGeoCached(pool);
  const validRoutes = new Set<string>(st.routeIdx.dirsOf.keys());
  const bridgeCtx: BridgeContext = { map, validRoutes, routeIdx: st.routeIdx };
  const placeSlugs = new Set(Object.keys(st.placeIds));
  const fromSlug = slugOf(origin, placeSlugs);
  const toSlug = slugOf(dest, placeSlugs);

  // ③ 高德（默认 strategy=0）
  const tTransit = Date.now();
  let transitOk = false;
  let fromCache = false;
  let rawPlans: AmapTransitRawResponse = { status: "1", route: { transits: [] } };
  let bridgedSeeds: AmapPlanSeed[] = [];
  let dropped: { index: number; reason: string }[] = [];
  let amapTotal = 0;
  /** ★ 本次实际用到的策略（诊断；s=0 恒在，命中补查时追加 7/8） */
  const strategiesUsed: number[] = [];

  if (input.transitFixture) {
    rawPlans = input.transitFixture;
    amapTotal = (input.transitFixture.route?.transits ?? []).length;
    // ★ §B.6 触发条件③：高德返回 **0 方案** = 异常 ⇒ 视为**不可用**（走降级）
    transitOk = amapTotal > 0;
    if (transitOk) strategiesUsed.push(0);
  } else {
    const r = await fetchTransitPlans({ lng: origin.lng, lat: origin.lat }, { lng: dest.lng, lat: dest.lat }, {
      cache: makeTransitCacheIo(pool),
      noCache: input.noCache,
      nowMs,
      strategy: 0,
    });
    if (r.ok) {
      transitOk = true;
      fromCache = r.fromCache;
      rawPlans = { status: "1", route: { transits: r.raw } };
      amapTotal = r.raw.length;
      strategiesUsed.push(0);
    }
  }
  const transitMs = Date.now() - tTransit;

  if (transitOk) {
    const parsed = parseAndBridge(rawPlans, origin, dest, bridgeCtx);
    bridgedSeeds = parsed.seeds;
    dropped = parsed.dropped;

    // ★ 多策略按需补查：s=0 可用候选偏少 ⇒ 并行补 s=7/s=8，按指纹合并去重（s=0 优先保留）。
    //   ⚠️ fixture 模式（测试/回放）不补查；补查整体失败静默降级为「只有 s=0 结果」。
    if (!input.transitFixture && bridgedSeeds.length < MULTI_STRATEGY_WHEN_BELOW) {
      const extra = await fetchMultiStrategySeeds(pool, origin, dest, bridgeCtx, nowMs, input.noCache);
      bridgedSeeds = mergeSeedsByFingerprint(bridgedSeeds, extra.seeds);
      dropped = [...dropped, ...extra.dropped];
      strategiesUsed.push(...extra.strategiesUsed);
    }
  }

  // ⑤ 本地候选（**请求期现场枚举**；补漏来源 + 降级引擎共用同一实现）。
  //    已删除原「只读离线表 `shadow_diff_report`」路径（口径变更 2026-09-19，见文件头）。
  let localSource: NavStats["localSource"] = "none";
  let localCandidates: StationPath[] = [];
  if (geo.length) {
    localCandidates = searchStationPaths(st.routeIdx, geo, fromWgs, toWgs, { maxCandidates: 240 });
    localSource = "inline";
  }

  // ── 组装 OptionSeed（两来源一次性喂 fetchLive）──
  const amapSeeds: { seed: AmapPlanSeed; opt: ReturnType<typeof amapPlanToSeed> }[] = [];
  for (let i = 0; i < bridgedSeeds.length; i++) {
    const s = bridgedSeeds[i];
    const summary = s.legs.map((l) => l.mappedRoute ?? l.amapLineName.split("(")[0]).join(" → ");
    const opt = amapPlanToSeed(s, { planId: i + 1, summary, fromSlug, toSlug, crossBorder: false });
    if (opt) amapSeeds.push({ seed: s, opt });
  }

  const localNavCands = pathsToCandidates(localCandidates, origin, dest);
  const localSeeds = candidatesToSeeds(localNavCands, { planIdBase: 900_000, fromSlug, toSlug });

  const allSeeds = [...amapSeeds.map((a) => a.opt!).filter(Boolean), ...localSeeds];

  // ⑥ 实时（两来源共用一次）
  const tLive = Date.now();
  const weekday = new Date(nowMs + 8 * 3_600_000).getUTCDay();
  const batch = await fetchLive(pool, allSeeds, st.routeIdx, st.segIdx, {
    todayWeekday: weekday,
    nowMs,
    lrtPre: st.lrtPre,
  });
  const liveMs = Date.now() - tLive;
  const baseCtx = contextFor(st, nowMs, zone, batch.live);

  // ⑦ 建模
  const tModel = Date.now();
  const provenance: Record<string, RecomputeProvenance> = {};
  /** ★ P2-a：保留 `modelOption` 的 `alts`（本班之外的后续班次），排序后按旧口径回填 `altBuses` */
  const modeled: ModeledOption[] = [];
  const amapItems: RankedItem[] = [];
  for (const { seed, opt } of amapSeeds) {
    if (!opt) continue;
    const ctx = {
      ...baseCtx,
      walkResolver: makeWalkResolver(seed, st.routeIdx.nameOf),
      transferIdx: overlayTransferIndex(seed, st.transferIdx),
    };
    const modeled1 = modelOption(opt, ctx);
    if (!modeled1) continue;
    const prov = patchAmapFallback(modeled1.card, seed, st.segIdx, weekday);
    provenance[opt.key] = prov;
    modeled.push(modeled1);
    amapItems.push({ card: modeled1.card, origin: "amap", key: opt.key, seed, provenance: prov });
  }

  // 本地（**P1-4**：首末步行走 `walk_cache`（未命中 → 直线×1.5），不再落 `walkIdx` 的全局均值）
  const geoOf = new Map<string, { lng: number; lat: number }>();
  for (const s of geo) geoOf.set(s.main, { lng: s.lng, lat: s.lat });
  const walkCache = await loadWalkCacheCached(pool);
  const localItems: RankedItem[] = [];
  for (const lseed of localSeeds) {
    const ctx = {
      ...baseCtx,
      walkResolver: makeCacheWalkResolver(lseed, fromWgs, toWgs, geoOf, walkCache, st.routeIdx.nameOf),
    };
    const modeled1 = modelOption(lseed, ctx);
    if (!modeled1) continue;
    const card = modeled1.card;
    const hopLevels = card.rides.map((r) => r.levels as SegmentLevel[]);
    const prov: RecomputeProvenance = {
      usedOurDataLegs: card.rides.length,
      usedAmapFallbackLegs: 0,
      hopLevels,
      deviationRatio: 0,
      suspect: false,
    };
    modeled.push(modeled1);
    localItems.push({
      card,
      origin: "local",
      key: lseed.key,
      provenance: prov,
      coverage: ourDataCoverage(card),
    });
  }

  // ⑧ 合并 + 排序
  const rankedLocal = rankItems(localItems);
  const merged = mergeSources(amapItems, rankedLocal, {});
  const ranked = rankItems(merged.items);
  const cards = ranked.slice(0, limit).map((r) => r.card);

  // ★ P2-a：回填「本班之外的后续班次」（**逐字复用旧 `service.ts` v1.1.5 口径**）
  backfillAltBuses(cards, modeled);
  const modelMs = Date.now() - tModel;

  // ── 空状态原因（§11.4）──
  let emptyReason: NavEmptyReason | undefined;
  let nearbyWalkMin: number | undefined;
  if (cards.length === 0) {
    const straightM = haversineM(fromWgs, toWgs);
    if (straightM < 400) {
      emptyReason = "too_close";
      // ★ 纯步行建议：直线 → 短距修正（无高德几何时）→ ÷84（常速基准分钟）
      const corrected = fixWalkDistance(straightM, null).correctedM;
      nearbyWalkMin = Math.max(1, Math.round(walkMinutes(corrected)));
    } else if (!transitOk) emptyReason = "amap_unavailable";
    else if (batch.live.size === 0) emptyReason = "no_live";
    else emptyReason = "no_candidate";
  }

  return {
    fromSlug,
    toSlug,
    cards,
    colors: st.routeColors,
    degraded: !transitOk,
    emptyReason,
    nearbyWalkMin,
    provenance,
    excluded: [...new Set(baseCtx.excluded)],
    missed: [...new Set(baseCtx.missed)],
    stats: {
      staticMs,
      transitMs,
      transitOk,
      transitFromCache: fromCache,
      amapPlans: amapTotal,
      bridged: bridgedSeeds.length,
      dropped,
      localCandidates: localCandidates.length,
      localKept: merged.items.filter((i) => i.origin === "local").length,
      localSource,
      strategiesUsed,
      liveMs,
      modelMs,
      ms: Date.now() - tAll,
    },
    generatedAt: nowMs,
  };
}

/** 供 UI 做「另一種走法」中性文案（产品口径，§B.5） */
export const NEUTRAL_LOCAL_LABEL = LOCAL_SUMMARY;

/**
 * ★ P2-a：把「本班之外的后续班次」按**旧口径**回填到卡片（逐字复用 `service.ts` v1.1.5）。
 *
 * 规则：阈值 = **最后一张卡**的总时长；只列 `totalMin ≤ 阈值` 的后续班次
 *   （用户口径：坐这一班的车，门到门总时长**不差于第 N 张卡**才值得列）。
 * ⚠️ `modelOption` 内部已按 `loSec` 去重并排除本班（v1.1.6）—— 此处**不重复**该逻辑。
 * 独立成函数便于**单测**（数据不足时真实链路可能一条 alts 都没有）。
 */
export function backfillAltBuses(cards: RecommendCard[], modeled: ModeledOption[]): void {
  if (!cards.length) return;
  const threshold = cards[cards.length - 1].totalMin;
  const topSet = new Set(cards);
  for (const m of modeled) {
    if (!topSet.has(m.card)) continue;
    const keep = m.alts.filter((a) => a.totalMin <= threshold + 1e-9);
    if (keep.length) m.card.altBuses = keep;
  }
}
