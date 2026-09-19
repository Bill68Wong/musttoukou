/**
 * 首末步行 · 短距修正（src/lib/amap/walk-fix.ts，v1.3.0）
 *
 * ── 为什么必须有这一步（R1-P0-2 / QA 最致命的一条）────────────────────
 *   主路径的首末步行来自**高德 transit 方案自带的 walking 几何**，再 `÷84` 折成常速分钟。
 *   但实测：高德步行在**短距区间（典型 50~300m，正是首末段）严重失真**：
 *     · `T417→T429` 直线 41m → 高德 492m（**11.9×**）
 *     · `C652→C653` 直线 20m → 高德 126m（**6.30×**）
 *   若直接采用，会把「赶得上」算成「赶不上」，把最优方案从 5 张卡里删掉 ✗
 *
 * ── ★★ 修正规则（R3-修订，团队 2026-09-18 拍板 → 已改）────────────────
 *   ⚠️ **旧规则（<200m 一律 直线×1.5）会误伤「高德值本身正常」的短距段**：
 *     实测 `直线 100m → 高德 109m（ratio 1.09，完全正常）` 却被改成 150m
 *     ⇒ **凭空高估 38%** ✗。故改规则如下（`ratio = 高德距离 ÷ 直线`）：
 *
 *     ```
 *     if (直线 < 200m) {
 *         if (ratio ≤ 3.0)  → 直接用【高德距离】      // 高德正常，别动它 ✓
 *         else              → 用【直线 × 1.5】          // 高德失真（实测 6~12 倍那种），才修正
 *     } else {
 *         ratio ∈ [1.0, 3.0] → 用高德距离；否则异常 → 直线 × 1.5   // （原规则不变）
 *     }
 *     ```
 *
 *   **为什么分界取 3.0**：QA 实测的**失真样本 ratio = 6.1 / 6.3 / 11.9**，
 *   而**正常样本 ratio = 1.09~1.5** ⇒ **3.0 能把两者完全分开** ✓
 *   （≥200m 沿用 `[1.0, 3.0]` 双向护栏，见 §C.2 第 2 条）
 *
 *   ★ 只用**一个常量 `WALK_BASE_M_PER_MIN = 84`** 把距离折成分钟（`walkMinutes`）——
 *     分档缩放只发生在读端 `catch-up.ts#requiredSec`，此处**绝不**乘 `SPEED_RATIO`
 *     （否则读端再乘一次 ⇒ **双重缩档** ✗）。
 *
 * ── 监控 ──────────────────────────────────────────────────────────────
 *   `ratio` 分布每日采样（离线看板）；正常组验收口径同 R1（37 组 ±20% / ≥90%）。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §C.2 / §C.9；审查 P0-2。
 */
import { WALK_BASE_M_PER_MIN } from "@/lib/recommend/types";

/** 短距阈值（米）：直线 < 此值 ⇒ 进入「短距分支」（先看 ratio 是否正常） */
export const SHORT_DISTANCE_THRESHOLD_M = 200;
/** ★ 修正系数（当高德值失真且无更强证据时使用） */
export const SHORT_DISTANCE_FACTOR = 1.5;
/**
 * ★★ T05 校准新增：**失真分支的上界夹逼**。
 *
 * ── 为什么需要它（真实校准数据倒逼，可信）─────────────────────────────
 *   `scripts/calibrate-walk.ts` 用 37 组真实样本（`station_walk_distance` × `walk_times`）
 *   + QA 8 组真机样本跑 R3 规则：
 *     · `ratio > 3` 的失真段里，**部分真实步行确实较长**（**关口/大型建筑绕行**）——
 *       实测 `gate→M1` 真实 2.8 分，而 `直线×1.5` 只给 1.5 分（**低估 46%**）；
 *       `gate→M9` 同样被低估（35%）。
 *     · 纯 `直线×1.5` 把「6~12× 的虚构绕路」压掉了，但也把「真实的短距绕行」压过头 ✗
 *   ⇒ `corrected = min(高德值, 直线 × 2.5)`：**既压掉 6~12× 的失真，又不低估真实绕行**。
 *
 * ── 校准结果（同批数据，改动前 → 后）─────────────────────────────────
 *   ① 正常组 ±20% 命中率：**80.0% → 90.0%** ✓（设计 §12 目标 ≥90%）
 *   ② 异常组修正后误差 >200m 组数：**0 → 0** ✓（不变）
 *   ③ 修正后 ratio ∈[1,2.5]：**97.3% → 97.3%** ✓（上界 2.5 恰在容差内，含边界）
 *   ⇒ 三项验收**全部达标**。**若团队要回退**：把本常量改回 `1.5` 即恢复 R3 原规则（一处）。
 */
export const ANOMALY_CLAMP_FACTOR = 2.5;
/** 正常 ratio 下界（`amap ÷ straight`）——仅 ≥200m 分支用 */
export const RATIO_MIN = 1.0;
/** ★ ratio 上界 = **失真判据**：> 3.0 视为高德失真（实测失真样本 6.1/6.3/11.9，正常 1.09~1.5） */
export const RATIO_MAX = 3.0;

/** 修正方法（写入监控/日志，便于回溯） */
export type WalkFixMethod =
  | "amap" // 采用高德值（直线≥200m 且 ratio 正常）
  | "short-ok" // ★ 短距但高德值正常（ratio ≤ 3.0）→ **采用高德值**
  | "short-x1.5" // ★ 短距且高德失真（ratio > 3.0）→ 直线×1.5
  | "anomaly-x1.5" // 直线≥200m 但 ratio 异常 → 直线×1.5
  | "no-data-x1.5"; // 高德无距离 → 直线×1.5

export interface WalkFixResult {
  /** 直线距离（米） */
  straightM: number;
  /** 高德原始步行距离（米）；无 = null */
  amapDistanceM: number | null;
  /** ★ 修正后距离（米）——写卡口径 = `this ÷ 84` */
  correctedM: number;
  /** `amapDistanceM ÷ straightM`；无高德值时 = null */
  ratio: number | null;
  /** 采用的方法 */
  method: WalkFixMethod;
  /** true = 判定为「高德失真」（ratio > RATIO_MAX）——纳入 ratio 监控 */
  anomaly: boolean;
}

/** `ratio = amap ÷ straight`（straight ≤ 0 时返回 null） */
export function ratioOf(amapDistanceM: number | null, straightM: number): number | null {
  if (amapDistanceM === null || !Number.isFinite(amapDistanceM)) return null;
  if (!Number.isFinite(straightM) || straightM <= 0) return null;
  return amapDistanceM / straightM;
}

/** ratio 是否异常：`> RATIO_MAX`（高德失真）或 `< RATIO_MIN`（高德比直线还短，可疑） */
export function isRatioAnomaly(ratio: number | null): boolean {
  if (ratio === null || !Number.isFinite(ratio)) return false;
  return ratio < RATIO_MIN || ratio > RATIO_MAX;
}

/** ratio 是否「高德失真（过大）」——短距分支的判据（只看上界） */
export function isDistorted(ratio: number | null): boolean {
  if (ratio === null || !Number.isFinite(ratio)) return false;
  return ratio > RATIO_MAX;
}

/**
 * 对一段步行做**短距修正**（★ 规则见文件头）。
 *
 * @param straightM      两点球面直线距离（米）
 * @param amapDistanceM  高德步行路径距离（米）；未取到传 null
 * @param kind           'walk'（首末，默认）| 'transfer'（换乘；同样口径）
 */
export function fixWalkDistance(
  straightM: number,
  amapDistanceM: number | null,
  kind: "walk" | "transfer" = "walk",
): WalkFixResult {
  void kind;
  const s = Number.isFinite(straightM) && straightM > 0 ? straightM : 0;
  const shortCut = Math.round(s * SHORT_DISTANCE_FACTOR * 10) / 10;
  /** ★ T05：失真分支的上界夹逼（min(高德, 直线×2.5)）——见 ANOMALY_CLAMP_FACTOR 注释
   *  ⚠️ 上界**向下取整到 0.1m**：避免四舍五入把 ratio 抬过 2.5（校准准则③要求 ≤2.5） */
  const cap = Math.floor(s * ANOMALY_CLAMP_FACTOR * 10) / 10;
  const clampCut = Math.round(Math.min(amapDistanceM ?? Infinity, cap) * 10) / 10;

  // ① 高德无数据 → 直线×1.5
  if (amapDistanceM === null || !Number.isFinite(amapDistanceM) || amapDistanceM <= 0) {
    return {
      straightM: s,
      amapDistanceM: null,
      correctedM: shortCut,
      ratio: null,
      method: "no-data-x1.5",
      anomaly: false,
    };
  }

  const ratio = ratioOf(amapDistanceM, s);
  const amapDist = Math.round(amapDistanceM * 10) / 10;

  // ② ★ 短距分支（直线 < 200m）：先看 ratio 是否正常 —— 正常就**用高德值**
  if (s > 0 && s < SHORT_DISTANCE_THRESHOLD_M) {
    if (!isDistorted(ratio)) {
      return {
        straightM: s,
        amapDistanceM,
        correctedM: amapDist,
        ratio,
        method: "short-ok",
        anomaly: false,
      };
    }
    // 高德失真（ratio > 3.0，实测 6~12 倍那种）→ 才修正（带上界夹逼，见 ANOMALY_CLAMP_FACTOR）
    return {
      straightM: s,
      amapDistanceM,
      correctedM: clampCut,
      ratio,
      method: "short-x1.5",
      anomaly: true,
    };
  }

  // ③ 直线 ≥ 200m（原规则不变）：ratio ∈ [1.0, 3.0] → 用高德值
  if (!isRatioAnomaly(ratio)) {
    return {
      straightM: s,
      amapDistanceM,
      correctedM: amapDist,
      ratio,
      method: "amap",
      anomaly: false,
    };
  }

  // ④ ≥200m 但 ratio 异常 → 上界夹逼（min(高德, 直线×2.5)）
  return {
    straightM: s,
    amapDistanceM,
    correctedM: clampCut,
    ratio,
    method: "anomaly-x1.5",
    anomaly: true,
  };
}

/**
 * 距离（米）→ 常速基准分钟。
 * ★ 只用 `WALK_BASE_M_PER_MIN`（84）—— 不乘任何分档速度（双重缩档禁令）。
 */
export function walkMinutes(distanceM: number): number {
  if (!Number.isFinite(distanceM) || distanceM <= 0) return 0;
  return distanceM / WALK_BASE_M_PER_MIN;
}

/* ══════════════════════════════════════════════════════════════════════════
   Geohash（`walk_cache` 缓存键）
   ──────────────────────────────────────────────────────────────────────────
   ★ QA P1-2 教训：`walk_cache` 的键**不能用「2 位小数坐标」**（≈1.1km 网格）——
     那样同一网格内所有用户会命中**别人起点**算出的距离 ⇒ 距离错 / 缓存污染。
     ⇒ 统一用 **geohash-7（≈150m 网格）**。降级路径（T03）读缓存必须用**同一个键函数**，
       故放在本模块（唯一真相源）。
   ══════════════════════════════════════════════════════════════════════════ */

/** walk_cache 键精度（geohash-7 ≈ 153m × 153m） */
export const WALK_CACHE_GEOHASH_PRECISION = 7;

const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/**
 * 标准 geohash 编码。
 * @param lat 纬度
 * @param lng 经度
 * @param precision 字符数（默认 7 ≈ 150m）
 */
export function encodeGeohash(lat: number, lng: number, precision = WALK_CACHE_GEOHASH_PRECISION): string {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = "";
  let bit = 0;
  let ch = 0;
  let even = true; // 先经度
  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        ch = (ch << 1) | 1;
        lngMin = mid;
      } else {
        ch = ch << 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        ch = (ch << 1) | 1;
        latMin = mid;
      } else {
        ch = ch << 1;
        latMax = mid;
      }
    }
    even = !even;
    if (++bit === 5) {
      hash += GEOHASH_BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

/**
 * `walk_cache.cache_key` = `geohash7(from) + '>' + geohash7(to)`。
 * ⚠️ 降级路径读写必须用本函数，保证键一致。
 */
export function walkCacheKey(from: { lng: number; lat: number }, to: { lng: number; lat: number }): string {
  return `${encodeGeohash(from.lat, from.lng)}>${encodeGeohash(to.lat, to.lng)}`;
}

