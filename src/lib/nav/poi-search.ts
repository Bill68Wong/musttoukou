/**
 * 两段式 POI 搜索（src/lib/nav/poi-search.ts，v1.3.0 · T02）
 *
 * ── 交互口径（设计 §2.A.6，产品 2026-09-18 拍板 = 方案 A）────────────────
 *   · **打字阶段 `suggestLocal()`** —— **只查本地别名库**（`alias-resolve`），
 *     **0 高德配额**、秒回；**绝不发任何高德请求** ✗。
 *   · **回车阶段 `searchAmap()`** —— 才调高德（`place/text` 正式搜索，必要时 `inputtips`
 *     兜底）——这是**唯一**消耗搜索配额（5,000/月，静默超限）的时机。
 *   ⇒ `suggest()` 按 `mode` 分派：`type` 纯本地 / `enter` 本地优先 + 高德兜底。
 *
 * ── 已知取舍（方案 A 的固有代价，**不是 bug**）─────────────────────────
 *   **打字时看不到「新地名」的提示** —— 逐字阶段不联网。用户输入本地库没有的新地名时，
 *   下拉区不会有候选，**直到按回车**才去高德搜。产品文案/引导需说明（§2.A.6）。
 *   本地未命中且输入 ≥2 字符时，下拉区给一行**灰字**提示（见 `HINT_*` 常量）。
 *
 * ── adcode 过滤 + 本地排序（★ 必做）──────────────────────────────────
 *   高德 `city` 参数只是「倾向」不是硬限定（实测输 `gongbei` 会返回珠海）⇒ 必须**本地按
 *   adcode（澳门=820000）过滤**；`inputtips` **无 `dist` 字段** ⇒ 排序由我们本地算
 *   haversine 距离（复用 `poi.ts` 的转换器，已内建过滤 + 近者优先）。
 *
 * ── 缓存 ──────────────────────────────────────────────────────────────
 *   回车命中**进程内 TTL 缓存**（10 分钟）→ 热门地名重复回车**零配额**。
 *   ⚠️ 这是**每实例**缓存（Serverless 跨实例不共享），是最轻量的闸门；若命中率不够，
 *   可升级为 `transit_cache` 式表缓存（工程可自决，见设计 §2.A 的「Data Cache」）。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §2.A / §2.A.6 / §6.2；调研 §6 坑#8/9。
 */
import {
  ADCODE_MACAU,
  inputtips,
  isMacauAdcode,
  placeText,
  poisToResults,
  tipsToResults,
  type PoiCallHook,
} from "@/lib/amap/poi";
import type { LatLng } from "@/lib/amap/coord";
import type { PoiPendingMatch, PoiSearchResult, PoiSuggestResponse, PoiSource } from "@/lib/nav/types";
import { normalizeQuery } from "@/lib/shared/normalize";
import { aliasToResult, resolveAliases } from "./alias-resolve";
import { circuitState, recordSearchCall } from "./quota";

/**
 * 本地未命中（且输入 ≥2 字符）时的灰字提示。
 * ★ 文案 = **简体**（产品总原则：界面文案一律简体 · 站名/线路名一律繁体）。
 *   ⚠️ 设计 §2.A.6 原文写成繁体「沒有本地結果 · 按回車搜尋網上新地點」——架构师笔误，
 *   经 team-lead 2026-09-18 更正为简体；若要回退只改这一个常量。
 */
export const HINT_NO_LOCAL_ENTER = "没有本地结果 · 按回车搜索网上的新地点";
/** 高德也无结果时的行内提示（简体；同产品总原则） */
export const HINT_AMAP_EMPTY = "找不到这个地点，试试换个说法";

export interface SuggestOptions {
  /** 用户当前位置（GCJ-02）——用于近者优先排序 */
  userPos?: LatLng;
  /** 最多返回条数 */
  limit?: number;
}

export interface LocalSuggest {
  /** 本地命中且**有坐标**（可直接作 destination） */
  results: PoiSearchResult[];
  /** 本地命中但**无坐标**（选中需走高德确认） */
  pending: PoiPendingMatch[];
}

// ─────────────────────────── 进程内 TTL 缓存 ───────────────────────────

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 300;
const amapCache = new Map<string, { at: number; results: PoiSearchResult[] }>();

function cacheGet(key: string): PoiSearchResult[] | null {
  const e = amapCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    amapCache.delete(key);
    return null;
  }
  return e.results;
}
function cacheSet(key: string, results: PoiSearchResult[]): void {
  if (amapCache.size >= CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of amapCache) if (v.at < oldestAt) ((oldestAt = v.at), (oldestKey = k));
    if (oldestKey) amapCache.delete(oldestKey);
  }
  amapCache.set(key, { at: Date.now(), results });
}

// ─────────────────────────── 第一段：本地（0 配额） ───────────────────────────

/** 站码主码归一（剥站台后缀：M1/2 → M1）——用于搜索结果去重 */
function mainCodeOf(code: string): string {
  return /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;
}

/** 打字阶段：只查本地别名库。**不发高德请求**。 */
export async function suggestLocal(query: string, opts: SuggestOptions = {}): Promise<LocalSuggest> {
  let matches: Awaited<ReturnType<typeof resolveAliases>> = [];
  try {
    matches = await resolveAliases(query, { userPos: opts.userPos, limit: opts.limit ?? 12 });
  } catch {
    return { results: [], pending: [] }; // 本地库不可用 → 退化为「未命中」（不抛错）
  }
  const results: PoiSearchResult[] = [];
  const pending: PoiPendingMatch[] = [];
  const seen = new Set<string>();
  // ★ 去重：同站多站台（M1/2·M1/3·M1/4…）在 UI 里应合成一行 ⇒ 按【主码】去重（保留得分最高者，
  //   因 matches 已按 score 降序，先到者即最优）；place/poi 按显示名去重。
  const dedupKey = (m: { targetKind: string; targetCode: string; nameTc: string }): string =>
    m.targetKind === "station" || m.targetKind === "lrt_station"
      ? `${m.targetKind}|${mainCodeOf(m.targetCode)}`
      : `${m.targetKind}|${m.nameTc}`;
  for (const m of matches) {
    const dk = dedupKey(m);
    if (seen.has(dk)) continue;
    const r = aliasToResult(m, { userPos: opts.userPos });
    if (r) {
      seen.add(dk);
      results.push(r);
    } else {
      seen.add(dk);
      pending.push({
        name: m.nameTc,
        targetKind: m.targetKind,
        targetCode: m.targetCode || undefined,
        source: "local",
        score: m.score,
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return { results, pending };
}

// ─────────────────────────── 第二段：高德（消耗配额） ───────────────────────────

/**
 * 严格的澳门过滤。★ **不能只判 adcode === '820000'**：澳门下辖 8 区用 **820001~820008**，
 * 高德 POI 多返回**区级码** ⇒ 只认 820000 会把澳门本地结果**误杀**（实测教训）。
 * 规则：有 adcode → 必须 `8200xx`（`isMacauAdcode`，邻市珠海=440402 会被剔）；无 adcode →
 * 用行政区名兜底（含「澳」）；连行政信息都没有 → 保留（避免误杀）。
 */
export function filterMacau(list: PoiSearchResult[]): PoiSearchResult[] {
  return list.filter((r) => {
    if (r.adcode) return isMacauAdcode(r.adcode);
    const d = r.district ?? "";
    if (d) return /澳|macau/i.test(d);
    return true; // 完全无信息 → 保留（避免误杀澳门本地结果）
  });
}

export interface AmapSuggest {
  results: PoiSearchResult[];
  /** true = 配额熔断中（未发请求） */
  circuitOpen: boolean;
  /** 本次实际发起的搜索调用数（0 = 命中缓存 / 熔断） */
  quotaConsumed: number;
}

/**
 * 回车阶段：高德兜底搜索。
 * 顺序：① `place/text`（正式、容错强）→ ② 若 0 结果再 `inputtips`（提示型兜底）。
 * 两条路径都先过 `circuitState()`（熔断**同时停**二者）与跨实例令牌桶（在 `poi.ts` 内）。
 * 失败/熔断**不抛错**，收敛为空结果。
 */
export async function searchAmap(query: string, opts: SuggestOptions = {}): Promise<AmapSuggest> {
  const key = normalizeQuery(query);
  const cached = cacheGet(key);
  if (cached) return { results: cached, circuitOpen: false, quotaConsumed: 0 };

  const st = await circuitState();
  if (st.open) return { results: [], circuitOpen: true, quotaConsumed: 0 };

  let quota = 0;
  const onCall: PoiCallHook = (api, ok, infocode, latencyMs) => {
    quota++;
    void recordSearchCall(api, ok, infocode, latencyMs);
  };

  // ① 正式搜索
  const text = await placeText(query, {
    city: ADCODE_MACAU,
    citylimit: true,
    offset: 20,
    onCall,
  });
  let results = text.ok
    ? poisToResults(text.items, { source: "amap-text", userPos: opts.userPos, macauOnly: true, query })
    : [];

  // ② 无结果时用 inputtips 补一次（设计：「必要时 inputtips」）
  if (!results.length) {
    const st2 = await circuitState();
    if (!st2.open) {
      const tips = await inputtips(query, {
        city: ADCODE_MACAU,
        citylimit: true,
        location: opts.userPos,
        onCall,
      });
      if (tips.ok) {
        results = tipsToResults(tips.items, { source: "amap-inputtips", userPos: opts.userPos, macauOnly: true, query });
      }
    }
  }

  results = filterMacau(results).sort((a, b) => b.score - a.score);
  if (results.length) cacheSet(key, results);
  return { results, circuitOpen: false, quotaConsumed: quota };
}

// ─────────────────────────── 编排（UI 只调这一个） ───────────────────────────

/**
 * 统一的搜索入口。
 *
 * @param query 用户输入
 * @param opts.mode `type` = 打字（纯本地，0 配额）/ `enter` = 回车（本地优先 + 高德兜底）
 */
export async function suggest(
  query: string,
  opts: { mode: "type" | "enter" } & SuggestOptions,
): Promise<PoiSuggestResponse> {
  const trimmed = (query ?? "").trim();
  const local = await suggestLocal(trimmed, opts);
  const resp: PoiSuggestResponse = {
    mode: opts.mode,
    results: local.results,
    pending: local.pending,
    quotaConsumed: 0,
  };

  if (opts.mode === "type") {
    // 本地完全无命中（有坐标/无坐标都没有）且输入 ≥2 字符 → 灰字提示「按回车搜」
    if (!local.results.length && !local.pending.length && trimmed.length >= 2) {
      resp.hint = "no_local_then_enter";
      resp.hintText = HINT_NO_LOCAL_ENTER;
    }
    return resp;
  }

  // ── 回车：本地已有「带坐标」命中 → 直接用，**不消耗配额** ──
  if (local.results.length) return resp;

  // ── 本地无带坐标命中 → 高德兜底（唯一消耗配额的时机）──
  const amap = await searchAmap(trimmed, opts);
  resp.amapCircuitOpen = amap.circuitOpen;
  resp.quotaConsumed = amap.quotaConsumed;
  if (amap.results.length) {
    resp.results = [...local.results, ...amap.results].sort((a, b) => b.score - a.score);
  } else {
    resp.hint = "amap_empty";
    resp.hintText = HINT_AMAP_EMPTY;
  }
  return resp;
}

/** 供诊断/测试：清空进程内缓存 */
export function _clearCache(): void {
  amapCache.clear();
}

/** 来源标签（UI 徽章用）：高德结果标「來自高德」 */
export function isAmapSource(source: PoiSource): boolean {
  return source === "amap-text" || source === "amap-inputtips";
}
