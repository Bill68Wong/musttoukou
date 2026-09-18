/**
 * 高德地图 Web 服务 API 客户端（src/lib/amap/client.ts，v1.2.0）
 *
 * ── 用途 ─────────────────────────────────────────────────────────────
 *   给「地点 ↔ 巴士站」算**步行路径距离**（米），用于把步行时长从
 *   「手动计时实测」逐步升级为「距离 × 常速基准」。
 *
 * ── 🚨🚨 三条硬规则（改动本文件前务必读完）────────────────────────────
 *
 *   ① **绝不在请求时调用** —— 本模块只允许被 `src/lib/rebuild/**` 与 Cron import。
 *      `src/lib/recommend/**` **禁止** import 本模块（推荐链路实时预算很紧，
 *      任何同步外部调用都会直接吃掉它）。调用全部走离线批算 + 落表。
 *
 *   ② **禁止 import `catch-up.ts` / `SPEED_RATIO`** —— 一旦这里能拿到分档速度，
 *      就会有人「顺手」用它把距离折成分档分钟，而读端 `requiredSec()` 会再乘一次
 *      ⇒ **双重缩档** ✗ 距离只产出「米」，折算成「常速基准分钟」是
 *      `src/lib/rebuild/walk-times.ts` 的职责，且只用一个常量 `WALK_BASE_M_PER_MIN`。
 *
 *   ③ **串行 + 限速** —— 个人认证开发者的并发上限很低（第三方资料称 3 QPS）。
 *      本模块内部用最小间隔把请求串起来，**绝不 Promise.all 全量并发**。
 *
 * ── 配额（个人认证开发者）─────────────────────────────────────────────
 *   步行路径规划 5000 次/日（以控制台「配额管理」为准）。本项目需求组只有几十个，
 *   且做增量抓取 ⇒ 稳态下每天调用 ≈ 0，远不会触顶。
 *
 * ── 错误码速查 ───────────────────────────────────────────────────────
 *   `10000` 成功 · `10003` 参数错 · `10005` Key 无效或过期 ·
 *   `10044` 日配额超限 · `20003` 该区域无路网数据
 */
import { fmtAmapLngLat, haversineM, toAmapCoords, type LatLng } from "./coord";

const BASE = "https://restapi.amap.com";
/** 单次请求超时（毫秒）—— 高德响应很快，8 秒足够；超了就当失败，不拖累批处理 */
const REQ_TIMEOUT_MS = 8_000;
/**
 * 两次请求之间的最小间隔（毫秒）。
 *
 * 🚨 依据控制台实测配额（2026-09-17）：
 *   「基础LBS服务」组（含步行/骑行/公交路径规划、地理编码、坐标转换…）
 *   —— 并发量上限 **3 次/秒** ✗
 * ⇒ 最小间隔必须 ≥ 334ms；这里取 **400ms（= 2.5 次/秒）**，留安全余量。
 *
 * ⚠️ 曾误设为 180ms（≈5.5 次/秒）—— **超出并发上限**，超出部分会被平台拒绝 ✗
 */
const MIN_GAP_MS = 400;

export interface AmapWalkOk {
  ok: true;
  /** 步行路径距离（米） */
  distanceM: number;
  /** 高德自估耗时（秒）—— 仅作参考，**不要**用它当 minutes（口径不同，见文件头 ②） */
  durationS: number;
  /**
   * ★ 坐标系健康指标：高德返回的路径**首点**与**我们传入的点**的球面距离（米）。
   *   正常应 < 50m（路径起点就是你给的点的最近道路）；
   *   若成百上千米 ⇒ 坐标系约定有误，距离开头就错了。
   */
  snapStartM: number;
  /** 同上，路径**末点**与终点输入点的距离（米） */
  snapEndM: number;
}

export interface AmapWalkErr {
  ok: false;
  error: string;
  infocode?: string;
}

export type AmapWalkResult = AmapWalkOk | AmapWalkErr;

/** 累计统计（供批处理报告用） */
export interface AmapStats {
  calls: number;
  ok: number;
  failed: number;
  infocodes: Record<string, number>;
}

let lastCallAt = 0;
const stats: AmapStats = { calls: 0, ok: 0, failed: 0, infocodes: {} };

export function amapStats(): AmapStats {
  return { ...stats, infocodes: { ...stats.infocodes } };
}
export function resetAmapStats(): void {
  stats.calls = 0; stats.ok = 0; stats.failed = 0; stats.infocodes = {};
}

function getKey(): string {
  const k = (process.env.AMAP_KEY ?? "").trim();
  if (!k) {
    throw new Error(
      "缺少 AMAP_KEY：请在本地 .env 里配置（参照 .env.example）。" +
        "高德开放平台 → 控制台 → 应用管理 → 创建应用 → 添加 Key（平台必须选「Web服务」）。",
    );
  }
  return k;
}

/** 把 request 串起来的最小间隔控制（模块级，单进程内有效） */
async function throttle(): Promise<void> {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/** 从 polyline 串（`lng,lat;lng,lat;...`）里取首末点 */
function endsOfPolyline(polyline: string | undefined): { first: LatLng; last: LatLng } | null {
  if (!polyline) return null;
  const pts = polyline.split(";").map((s) => s.split(",").map(Number)).filter((a) => a.length >= 2);
  if (!pts.length) return null;
  const toLL = ([lng, lat]: number[]): LatLng => ({ lat, lng });
  return { first: toLL(pts[0]), last: toLL(pts[pts.length - 1]) };
}

/**
 * 步行路径规划 —— 本模块的主力接口
 *
 * @param origin 起点（**我们库里的 WGS84 坐标**；内部按 `AMAP_COORD_MODE` 决定是否加偏）
 * @param dest   终点（同上）
 */
export async function walkRoute(origin: LatLng, dest: LatLng): Promise<AmapWalkResult> {
  const o = toAmapCoords(origin);
  const d = toAmapCoords(dest);

  const qs = new URLSearchParams({
    origin: fmtAmapLngLat(o),
    destination: fmtAmapLngLat(d),
    key: getKey(),
    show_fields: "cost,polyline",
  });

  await throttle();
  stats.calls++;

  let json: {
    status?: string; info?: string; infocode?: string;
    route?: { paths?: { distance?: string; cost?: { duration?: string }; steps?: { polyline?: string }[] }[] };
  } | null = null;

  try {
    const res = await fetch(`${BASE}/v5/direction/walking?${qs}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    json = await res.json();
  } catch (e) {
    stats.failed++;
    return { ok: false, error: `请求失败：${(e as Error).message}` };
  }

  const info = json?.info ?? "unknown";
  const code = json?.infocode ?? "?";
  stats.infocodes[code] = (stats.infocodes[code] ?? 0) + 1;

  const path = json?.route?.paths?.[0];
  const dist = Number(path?.distance ?? 0);
  if (json?.status !== "1" || !path || !Number.isFinite(dist) || dist <= 0) {
    stats.failed++;
    return { ok: false, error: info, infocode: code };
  }

  // ★ 吸附距离：把返回路径的首末点与「我们传给高德的点」比距离
  const polyline = path.steps?.map((s) => s.polyline ?? "").join(";");
  const ends = endsOfPolyline(polyline);
  const snapStartM = ends ? haversineM(ends.first, o) : -1;
  const snapEndM = ends ? haversineM(ends.last, d) : -1;

  stats.ok++;
  return {
    ok: true,
    distanceM: Math.round(dist),
    durationS: Number(path.cost?.duration ?? 0) || 0,
    snapStartM: Math.round(snapStartM),
    snapEndM: Math.round(snapEndM),
  };
}

/** 直线距离（对照用；**不是步行距离**，别拿它算时长） */
export async function straightDistance(a: LatLng, b: LatLng): Promise<number | null> {
  const ao = toAmapCoords(a);
  const bo = toAmapCoords(b);
  const qs = new URLSearchParams({
    origins: fmtAmapLngLat(ao),
    destination: fmtAmapLngLat(bo),
    type: "0",
    key: getKey(),
  });
  await throttle();
  stats.calls++;
  try {
    const res = await fetch(`${BASE}/v3/distance?${qs}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    const j = (await res.json()) as { status?: string; infocode?: string; results?: { distance?: string }[] };
    stats.infocodes[j.infocode ?? "?"] = (stats.infocodes[j.infocode ?? "?"] ?? 0) + 1;
    if (j.status !== "1") { stats.failed++; return null; }
    stats.ok++;
    return Number(j.results?.[0]?.distance ?? NaN) || null;
  } catch {
    stats.failed++;
    return null;
  }
}
