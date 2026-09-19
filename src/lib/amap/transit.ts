/**
 * 高德 · 公交路径规划客户端（src/lib/amap/transit.ts，v1.3.0 提案）
 *
 * ── 定位 ──────────────────────────────────────────────────────────────
 *   全澳导航的**候选来源**（设计 §2.B.1）。一次「出发」= **1 次** `transit/integrated`
 *   往返，拿到高德**已枚举好的全部方案**（含上下车站 / 完整站序 / 步行段），我们只做
 *   后处理（站码桥接 + 逐跳重算 + 重排）。**不重造主路线引擎**。
 *
 * ── ★ 实测坑（改本文件前必读）────────────────────────────────────────
 *   ① `AlternativeRoute` **必须驼峰**（大写 A + 大写 R）——写成 `alternative_route`
 *      会被高德**静默忽略**、仍只返回 4~5 个方案，**且不报错** ✗（调研 §6 坑#1）
 *      ⇒ 本文件把参数名写成常量 `ALTERNATIVE_ROUTE_PARAM = "AlternativeRoute"` 并由
 *        `alternativeRouteQuery()` 统一拼装，禁止散落手写。
 *   ② `city1`/`city2` **必填**，只吃 `citycode`(1853) 或 `adcode`(820000)（调研 A1.2）。
 *   ③ `show_fields=cost,transits` —— **不要**加 `polyline`（响应显著增大，且实测方案数
 *      从 5 变 4，调研 §6 坑#2）。
 *   ④ 步行段 `steps[].polyline` 的形态**随 show_fields 变化**（对象/字符串），本文件
 *      **不解析 polyline**（只需要 distance），故天然规避。
 *
 * ── ★ 坐标系铁律（§0-5）───────────────────────────────────────────────
 *   传入的 `origin`/`dest` **必须是 GCJ-02**（用户 GPS 在边界处已转、POI 来自高德）。
 *   本文件**不做任何坐标转换**（高德返回坐标原样用）。
 *
 * ── ★ 限流与降级 ──────────────────────────────────────────────────────
 *   调用前必取**跨实例令牌桶**（`rate-limit.ts`，3 QPS 全实例共享）。取不到令牌 →
 *   返回 `{ ok:false, degraded:true }`，调用方走**正式降级路径**（本地图枚举 + `walk_cache`，§B.6）。
 *   超时预算 **1.5s**（§B.6 触发条件之一）。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §2.B.1~B.4 / §4；
 *       调研：docs/调研-全澳导航-高德API能力-20260918.md A1.1~A1.5、§6。
 */
import { haversineM, type LatLng } from "./coord";
import { acquireToken, RATE_BUCKET } from "./rate-limit";
import { fixWalkDistance } from "./walk-fix";
import type { AmapPlanLeg, AmapPlanSeed, AmapPlanTransfer, AmapStop } from "@/lib/nav/types";

// ─────────────────────────── 常量 ───────────────────────────

const BASE = "https://restapi.amap.com";
/** 公交路径规划端点（v5，字段最全，支持 AlternativeRoute） */
export const TRANSIT_ENDPOINT = `${BASE}/v5/direction/transit/integrated`;
/** ★ 驼峰参数名——写错会被静默忽略（调研 §6 坑#1） */
export const ALTERNATIVE_ROUTE_PARAM = "AlternativeRoute";
/** 方案条数（1~10；高德上限截断，不报错） */
export const ALTERNATIVE_ROUTE = 10;
/** 策略 0 = 推荐（同高德 App 默认） */
export const TRANSIT_STRATEGY = 0;
/** 澳门 citycode */
export const CITYCODE_MACAU = "1853";
/** 澳门 adcode（备用） */
export const ADCODE_MACAU = "820000";
/** 请求超时预算（毫秒）—— §B.6 降级触发条件之一 */
export const TRANSIT_TIMEOUT_MS = 1_500;

/** OD 缓存：坐标取整位数（3~4 位；§Q14 可工程决定，取 4） */
export const OD_ROUND_DIGITS = 4;
/** OD 缓存：时段桶（分钟） */
export const OD_BUCKET_MIN = 15;
/** OD 缓存：TTL（秒）—— 实时性优先 */
export const TRANSIT_CACHE_TTL_SEC = 60;

/** ★ 穿梭巴士线路名黑名单（赌场免费巴被高德当公交；只能靠名字过滤，§B.3b） */
export const SHUTTLE_BLACKLIST: readonly string[] = [
  "穿梭巴士",
  "发财车",
  "發財車",
  "新濠影汇",
  "新濠影匯",
  "新濠天地",
  "美高梅",
  "银河",
  "銀河",
  "金沙",
  "伦敦人",
  "倫敦人",
  "威尼斯人",
  "永利",
  "上葡京",
  "巴黎人",
  "四季",
  "皇冠假日",
  "康莱德",
  "瑞吉",
];

/** 高德线路 type → 我们的 kind（澳门轻轨被高德标为「地铁线路」，§B.3c） */
export function lineKindOf(amapLineType: string): "bus" | "lrt" {
  return amapLineType === "地铁线路" ? "lrt" : "bus";
}

/** UI 文案映射：高德「地铁线路」一律显示为「轻轨」（§B.3c、§11.6） */
export function uiLineLabel(amapLineType: string): string {
  return amapLineType === "地铁线路" ? "轻轨" : amapLineType;
}

/** 是否穿梭巴士（黑名单子串命中） */
export function isShuttleBus(lineName: string): boolean {
  return SHUTTLE_BLACKLIST.some((k) => lineName.includes(k));
}

/** 澳门轻轨**在建东线** ES1~ES6 —— 本库没有、只在高德侧 ⇒ 一律剔除（§B.3c） */
export function isUnderConstruction(name: string): boolean {
  return /\bES[1-6]\b/i.test(name) || /東線|东线/.test(name);
}

// ─────────────────────────── 原始响应类型（尽力最小化） ───────────────────────────

interface RawStop {
  name?: string;
  id?: string;
  location?: string;
}
interface RawBusline {
  name?: string;
  id?: string;
  type?: string;
  distance?: string;
  via_num?: string;
  cost?: { duration?: string; ticket_price?: string };
  departure_stop?: RawStop;
  arrival_stop?: RawStop;
  via_stops?: RawStop[];
}
interface RawWalking {
  distance?: string;
  cost?: { duration?: string };
}
interface RawSegment {
  walking?: RawWalking;
  bus?: { buslines?: RawBusline[] };
}
/** 高德原始方案（transits[i]）—— 供入库/重解析 */
export interface RawPlan {
  cost?: { duration?: string; transit_fee?: string };
  distance?: string;
  walking_distance?: string;
  nightflag?: string;
  segments?: RawSegment[];
}
export interface AmapTransitRawResponse {
  status?: string;
  info?: string;
  infocode?: string;
  route?: { transits?: RawPlan[] };
}

// ─────────────────────────── 解析 ───────────────────────────

/** `"lng,lat"` → `{lng, lat}`；无法解析返回 null */
export function parseLocation(loc: string | undefined): LatLng | null {
  if (!loc) return null;
  const parts = loc.split(",").map((s) => Number(s.trim()));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return { lng: parts[0], lat: parts[1] };
}

function stopOf(s: RawStop | undefined): AmapStop {
  const ll = parseLocation(s?.location);
  return { name: s?.name ?? "", lng: ll?.lng ?? NaN, lat: ll?.lat ?? NaN, id: s?.id };
}

function legOf(bl: RawBusline): AmapPlanLeg {
  const type = bl.type ?? "";
  return {
    kind: lineKindOf(type),
    amapLineName: bl.name ?? "",
    amapLineType: type,
    amapBoard: stopOf(bl.departure_stop),
    amapAlight: stopOf(bl.arrival_stop),
    amapViaStops: (bl.via_stops ?? []).map(stopOf),
    amapDurationSec: Number(bl.cost?.duration ?? 0) || 0,
    mappedRoute: null,
    mappedBoard: null,
    mappedAlight: null,
    mappedHops: null,
  };
}

/** 数字安全转换 */
const num = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 把一条高德原始方案解析成 `AmapPlanSeed`（骨架；**不含**站码桥接与逐跳重算）。
 *
 * @param raw       高德 `transits[i]`
 * @param index     方案序（对照用）
 * @param originGcj 请求起点（GCJ-02）—— 用于算首段直线距离
 * @param destGcj   请求终点（GCJ-02）—— 用于算末段直线距离
 */
export function parsePlan(
  raw: RawPlan,
  index: number,
  originGcj: LatLng,
  destGcj: LatLng,
): AmapPlanSeed {
  const segs = raw.segments ?? [];

  let walkOutDist = 0;
  let walkOutDur = 0;
  let walkInDist = 0;
  let walkInDur = 0;
  const legs: AmapPlanLeg[] = [];
  /** 相邻 leg 之间的步行（长度 = legs.length − 1） */
  const gapWalks: { dist: number; dur: number }[] = [];
  let pending = { dist: 0, dur: 0 };
  let seenBus = false;

  for (const seg of segs) {
    // ★ 先累加本段内的步行 —— 【实测】同一 segment 可同时含 `walking` 与 `bus`
    //   （如 seg0 = walking 1384m + bus 30X），且步行在**前**（走到上车站再乘车）。
    //   若先判 bus 再判 walking，会**漏掉首段步行**（walkOut 恒 0）✗
    if (seg.walking) {
      pending.dist += num(seg.walking.distance);
      pending.dur += num(seg.walking.cost?.duration);
    }
    const bls = seg.bus?.buslines;
    if (bls && bls.length > 0) {
      if (!seenBus) {
        walkOutDist = pending.dist;
        walkOutDur = pending.dur;
      } else {
        gapWalks.push(pending);
      }
      pending = { dist: 0, dur: 0 };
      seenBus = true;
      // 同段可能多条并行线 → 取首条作为骨架（§B.2）
      legs.push(legOf(bls[0]));
    }
  }
  if (!seenBus) {
    // 纯步行方案（无乘车段）
    walkOutDist = pending.dist;
    walkOutDur = pending.dur;
  } else {
    walkInDist = pending.dist;
    walkInDur = pending.dur;
  }
  void walkOutDur;
  void walkInDur;

  // ── 首末直线距离（球面）→ 短距修正 ──
  const board = legs[0]?.amapBoard;
  const alight = legs[legs.length - 1]?.amapAlight;
  const straightOut =
    board && Number.isFinite(board.lng) && Number.isFinite(board.lat)
      ? haversineM(originGcj, { lng: board.lng, lat: board.lat })
      : 0;
  const straightIn =
    alight && Number.isFinite(alight.lng) && Number.isFinite(alight.lat)
      ? haversineM({ lng: alight.lng, lat: alight.lat }, destGcj)
      : 0;

  const fixOut = fixWalkDistance(straightOut, walkOutDist > 0 ? walkOutDist : null, "walk");
  const fixIn = fixWalkDistance(straightIn, walkInDist > 0 ? walkInDist : null, "walk");

  // ── 换乘步行（相邻 leg 之间；缺失 → 0/ null）──
  const transfers: AmapPlanTransfer[] = [];
  for (let i = 0; i + 1 < legs.length; i++) {
    const g = gapWalks[i];
    transfers.push({
      amapDurationSec: g ? g.dur : 0,
      distanceM: g && g.dist > 0 ? g.dist : null,
    });
  }

  const feeRaw = raw.cost?.transit_fee;
  const fee = feeRaw !== undefined && feeRaw !== "" ? Number(feeRaw) : NaN;

  return {
    index,
    amapTotalSec: num(raw.cost?.duration),
    amapTransferFee: Number.isFinite(fee) ? fee : null,
    walkOut: {
      distanceM: walkOutDist,
      straightM: Math.round(straightOut * 10) / 10,
      correctedM: fixOut.correctedM,
    },
    walkIn: {
      distanceM: walkInDist,
      straightM: Math.round(straightIn * 10) / 10,
      correctedM: fixIn.correctedM,
    },
    legs,
    transfers,
  };
}

/** 把整份高德响应解析成方案骨架数组 */
export function parseTransits(
  json: AmapTransitRawResponse,
  originGcj: LatLng,
  destGcj: LatLng,
): AmapPlanSeed[] {
  const transits = json.route?.transits ?? [];
  return transits.map((t, i) => parsePlan(t, i, originGcj, destGcj));
}

// ─────────────────────────── OD 缓存键 ───────────────────────────

/** 取整坐标（固定 4 位小数）——避免浮点噪声让同一 OD 变成不同键 */
export function roundCoord(v: number): string {
  return v.toFixed(OD_ROUND_DIGITS);
}

/**
 * ★ 与时段桶**无关**的 OD 坐标键 = `取整坐标(4位),取整坐标(4位)`（不含时段桶）。
 *
 * 用途：**离线影子对照表**（`shadow_diff_report.od_key`）—— 补漏候选**不随时段变化**
 *   ⇒ 必须用**稳定键**，否则离线写入的桶与请求期计算的桶不同 ⇒ **永远读不到** ✗
 *   （`shadow-diff.ts` 写本键；`nav-service.loadOfflineExtras` 用本键查。）
 */
export function odCoordKey(originGcj: LatLng, destGcj: LatLng): string {
  return `${roundCoord(originGcj.lng)},${roundCoord(originGcj.lat)}|${roundCoord(destGcj.lng)},${roundCoord(destGcj.lat)}`;
}

/**
 * OD 缓存键 = `取整坐标(4位) | 时段桶(15min)`。
 * 例：`113.5707,22.1494|202609181430`（设计 §2.F 注释）。
 * ★ 时段桶用**固定 UTC+8（澳门时区）**计算，保证与服务器时区无关、全局一致。
 */
export function odKeyOf(originGcj: LatLng, destGcj: LatLng, atMs: number = Date.now()): string {
  const MACAU_OFFSET_MS = 8 * 3_600_000;
  const d = new Date(atMs + MACAU_OFFSET_MS);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const bucketMin = Math.floor(d.getUTCMinutes() / OD_BUCKET_MIN) * OD_BUCKET_MIN;
  const mi = String(bucketMin).padStart(2, "0");
  return `${odCoordKey(originGcj, destGcj)}|${yyyy}${mm}${dd}${hh}${mi}`;
}

// ─────────────────────────── 抓取（含限流 + 缓存） ───────────────────────────

export interface TransitFetchOk {
  ok: true;
  plans: AmapPlanSeed[];
  /** 高德原始 transits[]（供入库/重解析） */
  raw: RawPlan[];
  /** true = 命中 `transit_cache`（未触发配额） */
  fromCache: boolean;
  /** 服务端估算调用耗时（毫秒） */
  elapsedMs: number;
}

export interface TransitFetchErr {
  ok: false;
  /** 恒 true —— 调用方须走**降级路径**（§B.6） */
  degraded: true;
  error: string;
  /** 高德 infocode（如 10003/10005/10044…）；本地原因时为 undefined */
  infocode?: string;
}

export type TransitFetchResult = TransitFetchOk | TransitFetchErr;

/** 组装查询串（★ 唯一拼装 `AlternativeRoute` 的位置） */
export function alternativeRouteQuery(
  originGcj: LatLng,
  destGcj: LatLng,
  key: string,
  extra?: Record<string, string>,
): string {
  const params = new URLSearchParams({
    origin: `${originGcj.lng.toFixed(6)},${originGcj.lat.toFixed(6)}`,
    destination: `${destGcj.lng.toFixed(6)},${destGcj.lat.toFixed(6)}`,
    city1: CITYCODE_MACAU,
    city2: CITYCODE_MACAU,
    strategy: String(TRANSIT_STRATEGY),
    show_fields: "cost,transits",
    key,
  });
  // ★ 驼峰参数名（写错会被静默忽略）
  params.set(ALTERNATIVE_ROUTE_PARAM, String(ALTERNATIVE_ROUTE));
  if (extra) for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return params.toString();
}

function getKey(): string {
  const k = (process.env.AMAP_KEY ?? "").trim();
  if (!k) throw new Error("缺少 AMAP_KEY：请在 .env 配置高德 Web 服务 Key（参照 .env.example）。");
  return k;
}

export interface TransitFetchOptions {
  /** 跳过 `transit_cache`（默认 false = 先查缓存） */
  noCache?: boolean;
  /** 覆盖超时预算（毫秒） */
  timeoutMs?: number;
  /** 覆盖"现在"（毫秒，测试/回放用） */
  nowMs?: number;
  /** 缓存读写钩子（缺省时不落库；由调用方注入以解耦 DB 依赖） */
  cache?: TransitCacheIo;
}

/** 缓存读写钩子（把 DB 依赖从本模块剥离，便于纯逻辑测试） */
export interface TransitCacheIo {
  get(odKey: string, ttlSec: number): Promise<RawPlan[] | null>;
  put(odKey: string, plans: RawPlan[]): Promise<void>;
}

/**
 * 拉取高德公交方案（**限流 → 缓存 → 请求 → 缓存写回 → 解析**）。
 *
 * ⚠️ 本函数**不抛错**：任何失败都收敛为 `{ ok:false, degraded:true }`，由调用方降级。
 * @param originGcj 起点（GCJ-02）
 * @param destGcj   终点（GCJ-02）
 */
export async function fetchTransitPlans(
  originGcj: LatLng,
  destGcj: LatLng,
  opts: TransitFetchOptions = {},
): Promise<TransitFetchResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const odKey = odKeyOf(originGcj, destGcj, nowMs);

  // ① 缓存（命中零调用）
  if (!opts.noCache && opts.cache) {
    try {
      const cached = await opts.cache.get(odKey, TRANSIT_CACHE_TTL_SEC);
      if (cached && cached.length > 0) {
        return {
          ok: true,
          plans: parseTransits({ status: "1", route: { transits: cached } }, originGcj, destGcj),
          raw: cached,
          fromCache: true,
          elapsedMs: 0,
        };
      }
    } catch {
      /* 缓存读失败不阻塞主路径（当作未命中） */
    }
  }

  // ② 跨实例令牌桶（3 QPS 全实例共享）
  let token;
  try {
    token = await acquireToken(RATE_BUCKET.transit);
  } catch (e) {
    return { ok: false, degraded: true, error: `限流器不可用：${(e as Error).message}` };
  }
  if (!token.ok) {
    return { ok: false, degraded: true, error: "rate_limited" };
  }

  // ③ 请求（超时预算 1.5s）
  const started = Date.now();
  let json: AmapTransitRawResponse | null = null;
  try {
    const qs = alternativeRouteQuery(originGcj, destGcj, getKey());
    const res = await fetch(`${TRANSIT_ENDPOINT}?${qs}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? TRANSIT_TIMEOUT_MS),
    });
    json = (await res.json()) as AmapTransitRawResponse;
  } catch (e) {
    return {
      ok: false,
      degraded: true,
      error: `请求失败：${(e as Error).message}`,
    };
  }
  const elapsedMs = Date.now() - started;

  if (json.status !== "1") {
    return {
      ok: false,
      degraded: true,
      error: json.info ?? "amap_error",
      infocode: json.infocode,
    };
  }

  const raw = json.route?.transits ?? [];
  if (raw.length === 0) {
    // 触发条件③：高德返回 0 方案（异常）→ 降级（§B.6）
    return { ok: false, degraded: true, error: "no_plan", infocode: json.infocode };
  }

  // ④ 缓存写回（失败不影响本次结果）
  if (opts.cache) {
    try {
      await opts.cache.put(odKey, raw);
    } catch {
      /* 忽略缓存写失败 */
    }
  }

  return {
    ok: true,
    plans: parseTransits(json, originGcj, destGcj),
    raw,
    fromCache: false,
    elapsedMs,
  };
}

export type { RawPlan as AmapTransitRawPlan };
