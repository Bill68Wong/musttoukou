/**
 * 高德 · POI 搜索客户端（src/lib/amap/poi.ts，v1.3.0 提案）
 *
 * ── 定位 ──────────────────────────────────────────────────────────────
 *   本地别名库 `poi_aliases` **未命中**时的高德兜底。提供两个端点：
 *     · `inputtips`（`/v3/assistant/inputtips`）—— 提示型，**错别字/繁简/拼音容错强**，
 *        但不支持分页、**无 `dist` 字段**、上限 10 条（调研 §6 坑#8/9）；
 *     · `place/text`（`/v3/place/text`）—— 正式搜索，容错同样强（实测「澳科打」也能命中），
 *        可分页、条数可控。
 *   ★ 搜索交互已定（§2.A.6 / R5）：**打字只查本地**（0 配额），**回车才调高德** ⇒
 *     请求期只在「回车」这一刻消耗搜索配额。本模块是那一次调用的**薄客户端**。
 *
 * ── 约束 ──────────────────────────────────────────────────────────────
 *   · 调用前取**跨实例令牌桶**（`search` 桶）——搜索与 transit/walking **共用 3 QPS**（§B.4）；
 *   · 结果按 **adcode 过滤（澳门 820000）** + **本地 haversine 排序**（不依赖 `location` 偏置，
 *     实测该偏置无效，调研 §6 坑#9）；
 *   · 只做 HTTP + 归一，**不落库**（配额记账由调用方通过 `onCall` 钩子写入 `search_quota_log`）。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §2.A / §2.A.6；
 *       调研：docs/调研-全澳导航-高德API能力-20260918.md §C、§6。
 */
import { haversineM } from "./coord";
import { acquireToken, RATE_BUCKET } from "./rate-limit";
import { normalizeName } from "@/lib/shared/normalize";
import type { PoiKind, PoiSearchResult } from "@/lib/nav/types";

const BASE = "https://restapi.amap.com";
/** 输入提示端点 */
export const AMAP_INPUTTIPS_ENDPOINT = `${BASE}/v3/assistant/inputtips`;
/** 关键字搜索端点 */
export const AMAP_TEXT_ENDPOINT = `${BASE}/v3/place/text`;
/** 澳门 adcode */
export const ADCODE_MACAU = "820000";
const TIMEOUT_MS = 3_000;
/** 搜索上限（place/text 每页最多 25，分页 ≤ 100） */
const MAX_OFFSET = 25;

/** 配额/可观测回调（调用方注入 DB 写入；本模块不碰 DB） */
export type PoiCallHook = (
  api: "inputtips" | "place/text",
  ok: boolean,
  infocode: string | undefined,
  latencyMs: number,
) => void;

export interface AmapTip {
  id?: string;
  name?: string;
  district?: string;
  adcode?: string;
  location?: string;
  address?: string;
  typecode?: string;
}

export interface AmapPoi {
  id?: string;
  name?: string;
  district?: string;
  adcode?: string;
  location?: string;
  address?: string;
  typecode?: string;
  cityname?: string;
  adname?: string;
  /** place/text 才返回（米）；inputtips 无 */
  distance?: string;
}

export interface PoiFetchResult<T> {
  ok: boolean;
  items: T[];
  infocode?: string;
  error?: string;
}

function getKey(): string {
  const k = (process.env.AMAP_KEY ?? "").trim();
  if (!k) throw new Error("缺少 AMAP_KEY：请在 .env 配置高德 Web 服务 Key。");
  return k;
}

/** `"lng,lat"` → `{lng,lat}`；无法解析返回 null */
function parseLoc(loc: string | undefined): { lng: number; lat: number } | null {
  if (!loc) return null;
  const p = loc.split(",").map((s) => Number(s.trim()));
  if (p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
  return { lng: p[0], lat: p[1] };
}

/** 高德 typecode → 我们的 kind */
export function kindOfTypeCode(typecode: string | undefined): PoiKind {
  const t = typecode ?? "";
  // 150700 = 公交车站；150500 = 地铁站（澳门轻轨被归为此类）
  if (t.startsWith("150700")) return "station";
  if (t.startsWith("150500")) return "lrt_station";
  return "poi";
}

/**
 * 是否澳门 adcode。★ **不能只判 `=== '820000'`**：澳门 8 个下辖区用 **820001~820008**
 * （如 820001 花地玛堂区），高德多数 POI 返回的是**区级码** ⇒ 只匹配 820000 会把
 * 绝大多数澳门本地结果**误杀**（实测：`新葡京`/`金沙城中心` 全被过滤成 0 条 ✗）。
 * 澳门 = 820000（省级）+ 820001~820008（区级），统一以 `8200` 前缀判定。
 * 【实测】高德返回邻市（珠海）为 440402，不会误入。
 */
export function isMacauAdcode(adcode: string | undefined | null): boolean {
  return /^8200\d{2}$/.test(String(adcode ?? ""));
}

// ─────────────────────────── inputtips ───────────────────────────

export interface InputTipsOptions {
  /** 城市限定（澳门 adcode 820000 或 citycode 1853） */
  city?: string;
  /** 仅返回该城市（默认 true） */
  citylimit?: boolean;
  /** 就近偏置点（GCJ-02）—— ⚠️ 实测效果不明显，仅传、不依赖 */
  location?: { lng: number; lat: number };
  /** 数据类型（默认 all） */
  datatype?: string;
  /** 配额记账钩子 */
  onCall?: PoiCallHook;
}

/** 调 `inputtips`（提示型搜索）。失败不抛错，收敛为 `{ok:false}`。 */
export async function inputtips(
  keywords: string,
  opts: InputTipsOptions = {},
): Promise<PoiFetchResult<AmapTip>> {
  const token = await acquireToken(RATE_BUCKET.search);
  if (!token.ok) return { ok: false, items: [], error: "rate_limited" };

  const params = new URLSearchParams({
    keywords,
    city: opts.city ?? ADCODE_MACAU,
    citylimit: String(opts.citylimit ?? true),
    datatype: opts.datatype ?? "all",
    key: getKey(),
  });
  if (opts.location) params.set("location", `${opts.location.lng.toFixed(6)},${opts.location.lat.toFixed(6)}`);

  const started = Date.now();
  try {
    const res = await fetch(`${AMAP_INPUTTIPS_ENDPOINT}?${params.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = (await res.json()) as {
      status?: string;
      info?: string;
      infocode?: string;
      tips?: AmapTip[];
    };
    const ok = j.status === "1";
    opts.onCall?.("inputtips", ok, j.infocode, Date.now() - started);
    if (!ok) return { ok: false, items: [], infocode: j.infocode, error: j.info };
    return { ok: true, items: j.tips ?? [], infocode: j.infocode };
  } catch (e) {
    opts.onCall?.("inputtips", false, undefined, Date.now() - started);
    return { ok: false, items: [], error: (e as Error).message };
  }
}

// ─────────────────────────── place/text ───────────────────────────

export interface PlaceTextOptions {
  city?: string;
  citylimit?: boolean;
  /** 每页条数（1~25，默认 20） */
  offset?: number;
  /** 页码（默认 1） */
  page?: number;
  onCall?: PoiCallHook;
}

/** 调 `place/text`（正式搜索）。失败不抛错。 */
export async function placeText(
  keywords: string,
  opts: PlaceTextOptions = {},
): Promise<PoiFetchResult<AmapPoi>> {
  const token = await acquireToken(RATE_BUCKET.search);
  if (!token.ok) return { ok: false, items: [], error: "rate_limited" };

  const offset = Math.min(MAX_OFFSET, Math.max(1, opts.offset ?? 20));
  const params = new URLSearchParams({
    keywords,
    city: opts.city ?? ADCODE_MACAU,
    citylimit: String(opts.citylimit ?? true),
    offset: String(offset),
    page: String(Math.max(1, opts.page ?? 1)),
    extensions: "all",
    key: getKey(),
  });

  const started = Date.now();
  try {
    const res = await fetch(`${AMAP_TEXT_ENDPOINT}?${params.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = (await res.json()) as {
      status?: string;
      info?: string;
      infocode?: string;
      pois?: AmapPoi[];
    };
    const ok = j.status === "1";
    opts.onCall?.("place/text", ok, j.infocode, Date.now() - started);
    if (!ok) return { ok: false, items: [], infocode: j.infocode, error: j.info };
    return { ok: true, items: j.pois ?? [], infocode: j.infocode };
  } catch (e) {
    opts.onCall?.("place/text", false, undefined, Date.now() - started);
    return { ok: false, items: [], error: (e as Error).message };
  }
}

// ─────────────────────────── 归一 → PoiSearchResult ───────────────────────────

export interface ToResultsOptions {
  /** 结果来源标签 */
  source: PoiSearchResult["source"];
  /** 用户当前位置（GCJ-02）；给了就算 distM 并按距离做次级排序 */
  userPos?: { lng: number; lat: number };
  /** 仅保留澳门（adcode 820000/8200xx）；默认 true */
  macauOnly?: boolean;
  /** 基础分（本地/高德不同权重由调用方给）——★ 仅在**未给 `query`** 时生效（旧口径） */
  baseScore?: number;
  /**
   * ★ v1.3.0：用户查询串。**给了就启用「相关性优先」排序**：
   *   主排序 = 文字相关性（完全匹配 > 前缀 > 包含 > 模糊），距离**仅作同档 tie-break**。
   *   不给（undefined）时退回「距离优先」旧口径（向后兼容）。
   */
  query?: string;
}

/** `AmapTip[]` → `PoiSearchResult[]`（过滤无坐标者 + adcode + 本地排序） */
export function tipsToResults(tips: AmapTip[], opts: ToResultsOptions): PoiSearchResult[] {
  return toResults(
    tips.map((t) => ({
      name: t.name,
      address: t.address,
      district: t.district,
      adcode: t.adcode,
      location: t.location,
      typecode: t.typecode,
    })),
    opts,
  );
}

/** `AmapPoi[]` → `PoiSearchResult[]` */
export function poisToResults(pois: AmapPoi[], opts: ToResultsOptions): PoiSearchResult[] {
  return toResults(
    pois.map((p) => ({
      name: p.name,
      address: p.address,
      district: p.district ?? p.adname,
      adcode: p.adcode,
      location: p.location,
      typecode: p.typecode,
    })),
    opts,
  );
}

/**
 * 文字相关性档位：**3=完全匹配 / 2=前缀 / 1=包含 / 0=模糊（其它）**。
 * 用 `normalizeName`（繁→简 + 去交通后缀 + 去括注）对齐比较，故「新葡京」能匹配
 * 「新葡京酒店(公交站)」（去括注后前缀命中），而「新普京桑拿水疗」为 0 档。
 */
function relevanceTier(queryNorm: string, name: string): number {
  if (!queryNorm) return 0;
  const nn = normalizeName(name);
  if (!nn) return 0;
  if (nn === queryNorm) return 3;
  if (nn.startsWith(queryNorm)) return 2;
  if (nn.includes(queryNorm)) return 1;
  return 0;
}

/** 相关性档 → 基础分（间距 ≥250，确保「档位」永远压过「距离」的 ≤100 加成） */
const REL_BASE: Record<number, number> = { 3: 900, 2: 650, 1: 400, 0: 150 };
/** 同档内的距离近者加成上限（0~100；只做 tie-break，不跨档） */
const REL_PROX_MAX = 100;

function toResults(
  rows: {
    name?: string;
    address?: string;
    district?: string;
    adcode?: string;
    location?: string;
    typecode?: string;
  }[],
  opts: ToResultsOptions,
): PoiSearchResult[] {
  const queryNorm = opts.query ? normalizeName(opts.query) : "";
  const scored: { r: PoiSearchResult; i: number }[] = [];
  let i = 0;
  for (const r of rows) {
    const idx = i++;
    if (!r.name) continue;
    const ll = parseLoc(r.location);
    if (!ll) continue; // 无坐标（行政区等）→ 无法作为 transit 端点
    if ((opts.macauOnly ?? true) && r.adcode && !isMacauAdcode(r.adcode)) continue;
    const distM = opts.userPos ? haversineM(opts.userPos, ll) : undefined;
    let score: number;
    if (opts.query) {
      // ★ 相关性优先：档位基础分 + 档内距离加成（≤100，不会跨档）
      const near = distM !== undefined ? Math.max(0, REL_PROX_MAX - distM / 50) : 0;
      score = REL_BASE[relevanceTier(queryNorm, r.name)] + near;
    } else {
      // 旧口径（距离优先）——向后兼容
      score = (opts.baseScore ?? 1) + (distM !== undefined ? Math.max(0, 1000 - distM / 10) : 0);
    }
    scored.push({
      i: idx,
      r: {
        source: opts.source,
        name: r.name,
        address: r.address,
        district: r.district,
        adcode: r.adcode,
        lng: ll.lng,
        lat: ll.lat,
        kind: kindOfTypeCode(r.typecode),
        distM: distM !== undefined ? Math.round(distM) : undefined,
        score,
      },
    });
  }
  // score 已含「档位 + 档内距离」；同分再按高德原序（稳定 tie-break）
  scored.sort((a, b) => b.r.score - a.r.score || a.i - b.i);
  return scored.map((x) => x.r);
}
