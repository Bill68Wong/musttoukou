/**
 * 全澳导航编排（src/lib/nav/nav-service.ts，v1.3.0 提案 · T03）
 *
 * ── 一条完整链路（设计 §1.1 / §2.B / §2.C）────────────────────────────
 *   ① 静态装载 `loadStatics()`（复用旧推荐域：站序/段统计/步行/换乘/轻轨预载）；
 *   ② 站码映射表 `loadStationMap()`（人工确认优先）；
 *   ③ **高德 transit**（`fetchTransitPlans`，`AlternativeRoute=10`，带 `transit_cache`）；
 *   ④ 解析 → 过滤（穿梭巴士/在建）→ **桥接**（高德站→我们主码 + 逐跳站序）；
 *   ⑤ **本地图枚举**（补漏来源；失败即降级引擎）→ 候选；
 *   ⑥ `fetchLive`（DSAT 巴士 + 本库轻轨时刻表，**两来源共用一次**）；
 *   ⑦ 逐方案：`modelOption`（**注入 walkResolver + 方案级换乘索引**）→ `patchAmapFallback`（映射失败段回落高德 + provenance）；
 *   ⑧ `merge-sources`（补漏质量闸门 + 最多 2 张）→ `rank`（`T_ours` 升序）；
 *   ⑨ 返回前 `limit` 张（与旧版**完全一致**的卡片结构 → T04 直接复用渲染）。
 *
 * ── ★ 降级（§B.6）─────────────────────────────────────────────────────
 *   高德失败/超时/限流/0 方案 → `degraded=true`，**只用本地枚举 + `walk_times`（旧实测）**出卡。
 *
 * ── ⚠️ 请求期图搜索（临时）─────────────────────────────────────────────
 *   设计 §B.5 要求「本地方案**离线**先算、请求期只查 `shadow_diff_report`」。
 *   本轮先 **优先读离线结果**；离线结果**缺失时**才**内联**跑一次**有界**图搜索
 *   （`allowInlineLocal`，默认 true）—— 待 T05 的 `scripts/shadow-diff.ts` 上线后应改为 false。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §1.1 / §2.B / §2.C / §B.5 / §B.6
 */
import type { Pool } from "pg";
import { gcj02ToWgs84, haversineM } from "@/lib/amap/coord";
import { fixWalkDistance, walkMinutes } from "@/lib/amap/walk-fix";
import { fetchTransitPlans, odCoordKey, odKeyOf, type RawPlan, type TransitCacheIo, type AmapTransitRawResponse } from "@/lib/amap/transit";
import { fetchLive } from "@/lib/recommend/live";
import { amapPlanToSeed, modelOption } from "@/lib/recommend/model";
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
  /** 允许「离线补漏结果缺失时」内联跑一次有界图搜索。
   *  ★ **T05 起默认 `false`**（设计 §B.5：本地方案**离线先算**、请求期只查 `shadow_diff_report`）。
   *     `scripts/shadow-diff.ts` 已灌入离线数据 ⇒ 请求期不再跑图搜索（省时，且与设计一致）。
   *     如需临时内联（如离线数据未覆盖的新 OD），显式传 `allowInlineLocal: true`。 */
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
  localSource: "offline" | "inline" | "none";
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

/** 离线补漏结果（`shadow_diff_report.extra_paths`：`StationPath[]`） */
async function loadOfflineExtras(pool: Pool, odKey: string): Promise<StationPath[] | null> {
  try {
    const r = await pool.query(
      `SELECT extra_paths FROM shadow_diff_report
        WHERE od_key = $1 AND extra_paths IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [odKey],
    );
    const row = (r.rows as { extra_paths?: unknown }[])[0];
    if (!row?.extra_paths) return null;
    const arr = row.extra_paths as unknown;
    return Array.isArray(arr) ? (arr as StationPath[]) : null;
  } catch {
    return null;
  }
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

  const odKey = odKeyOf({ lng: origin.lng, lat: origin.lat }, { lng: dest.lng, lat: dest.lat }, nowMs);
  /** ★ 离线补漏表用**桶无关**的稳定键（`shadow-diff.ts` 同键写入）——否则永远读不到 */
  const odCoord = odCoordKey({ lng: origin.lng, lat: origin.lat }, { lng: dest.lng, lat: dest.lat });

  // ③ 高德
  const tTransit = Date.now();
  let transitOk = false;
  let fromCache = false;
  let rawPlans: AmapTransitRawResponse = { status: "1", route: { transits: [] } };
  let bridgedSeeds: AmapPlanSeed[] = [];
  let dropped: { index: number; reason: string }[] = [];
  let amapTotal = 0;

  if (input.transitFixture) {
    rawPlans = input.transitFixture;
    amapTotal = (input.transitFixture.route?.transits ?? []).length;
    // ★ §B.6 触发条件③：高德返回 **0 方案** = 异常 ⇒ 视为**不可用**（走降级）
    transitOk = amapTotal > 0;
  } else {
    const r = await fetchTransitPlans({ lng: origin.lng, lat: origin.lat }, { lng: dest.lng, lat: dest.lat }, {
      cache: makeTransitCacheIo(pool),
      noCache: input.noCache,
      nowMs,
    });
    if (r.ok) {
      transitOk = true;
      fromCache = r.fromCache;
      rawPlans = { status: "1", route: { transits: r.raw } };
      amapTotal = r.raw.length;
    }
  }
  const transitMs = Date.now() - tTransit;

  if (transitOk) {
    const parsed = parseAndBridge(rawPlans, origin, dest, bridgeCtx);
    bridgedSeeds = parsed.seeds;
    dropped = parsed.dropped;
  }

  // ⑤ 本地候选（两种来源，用途不同）：
  //    · **补漏**（主路径）：**只读离线表** `shadow_diff_report`（§B.5：请求期不跑图搜索）；
  //    · **降级引擎**（高德不可用时，§B.6）：**必须**现场跑本地图搜索（R1 设计原样）——
  //      这是「高德一挂不全哑」的唯一对冲，**不受 `allowInlineLocal` 约束**。
  const offline = await loadOfflineExtras(pool, odCoord);
  let localSource: NavStats["localSource"] = "none";
  let localCandidates: StationPath[] = [];
  if (offline && offline.length) {
    localCandidates = offline;
    localSource = "offline";
  } else if (!transitOk || (input.allowInlineLocal ?? false)) {
    localCandidates = searchStationPaths(st.routeIdx, geo, fromWgs, toWgs, { maxCandidates: 60 });
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
  const amapItems: RankedItem[] = [];
  for (const { seed, opt } of amapSeeds) {
    if (!opt) continue;
    const ctx = {
      ...baseCtx,
      walkResolver: makeWalkResolver(seed, st.routeIdx.nameOf),
      transferIdx: overlayTransferIndex(seed, st.transferIdx),
    };
    const modeled = modelOption(opt, ctx);
    if (!modeled) continue;
    const prov = patchAmapFallback(modeled.card, seed, st.segIdx, weekday);
    provenance[opt.key] = prov;
    amapItems.push({ card: modeled.card, origin: "amap", key: opt.key, seed, provenance: prov });
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
    const modeled = modelOption(lseed, ctx);
    if (!modeled) continue;
    const card = modeled.card;
    const hopLevels = card.rides.map((r) => r.levels as SegmentLevel[]);
    const prov: RecomputeProvenance = {
      usedOurDataLegs: card.rides.length,
      usedAmapFallbackLegs: 0,
      hopLevels,
      deviationRatio: 0,
      suspect: false,
    };
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
      liveMs,
      modelMs,
      ms: Date.now() - tAll,
    },
    generatedAt: nowMs,
  };
}

/** 供 UI 做「另一種走法」中性文案（产品口径，§B.5） */
export const NEUTRAL_LOCAL_LABEL = LOCAL_SUMMARY;
