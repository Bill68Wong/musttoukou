/**
 * 坐标工具（src/lib/amap/coord.ts，v1.2.0）
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────
 *   我们的站点坐标来自 DSAT 官方接口，是 **WGS84 (EPSG:4326)**（见 `data/tracking/*-stations.json`
 *   的 `coordSystem` 字段）。而高德地图/API 在中国大陆使用 **GCJ-02**（国测局加密坐标）。
 *   两者直接混用会出现系统性偏移（大陆几百米量级）。
 *
 * ── 🚨 澳门到底偏不偏？—— **未知，必须实测** ──────────────────────────
 *   公开资料**自相矛盾**：有说「高德 SDK 在大陆、港澳都用 GCJ-02」，
 *   也有说「香港和澳门并不适用 GCJ-02，可直接用 WGS-84」。
 *   ⇒ 本项目已备好验证探针（`.verify/amap-probe.mjs`），用「吸附距离自证法」定案：
 *      把高德返回的路径首点与传入点做球面距离，偏了就会被吸附到几百米外。
 *
 * ── 本文件的设计原则：**不猜、不自动** ────────────────────────────────
 *   转换**只在调用方明确要求时**发生（`toAmapCoords()` 由 `AMAP_COORD_MODE` 驱动）。
 *   绝不像某些库那样「只要在中国框内就自动加偏」—— 澳门恰好在那个框里，
 *   自动加偏会在「澳门不加密」的情况下**制造**出偏移 ✗
 *
 * ⚠️ GCJ-02 的加偏是**非线性、不可逆**的（官方算法未公开）。
 *    本文件的 `gcj02ToWgs84` 是**迭代逼近**，精度 ~1 米级；够本项目的步行距离用，
 *    但不要拿去做测绘级用途。
 */

/** 克拉索夫斯基椭球长半轴（WGS84/GCJ 加偏算法用） */
const A = 6378245.0;
/** 椭球偏心率平方 */
const EE = 0.00669342162296594323;
/** 地球平均半径（米，球面距离用） */
const R_EARTH_M = 6371008.8;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * 中国大陆范围的粗判框（GCJ-02 加偏算法里惯例使用）
 * ⚠️ **澳门落在这个框内** —— 所以绝不能拿它当「是否需要加偏」的判据 ✗
 *    保留它只是为了与标准算法实现保持一致。
 */
export function inChinaBox(lat: number, lng: number): boolean {
  return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

/** WGS84 → GCJ-02（标准近似算法；大陆境内偏移可观，境外理论上是恒等变换） */
export function wgs84ToGcj02(p: LatLng): LatLng {
  if (!inChinaBox(p.lat, p.lng)) return { ...p };
  let dLat = transformLat(p.lng - 105.0, p.lat - 35.0);
  let dLng = transformLng(p.lng - 105.0, p.lat - 35.0);
  const rLat = rad(p.lat);
  let magic = Math.sin(rLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(rLat) * Math.PI);
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}

/** GCJ-02 → WGS84（迭代逼近，精度 ~1 米；官方算法不可逆，这是工程近似） */
export function gcj02ToWgs84(p: LatLng): LatLng {
  if (!inChinaBox(p.lat, p.lng)) return { ...p };
  // 以「正向加偏」为参考做 3 次牛顿式修正，收敛很快
  let guess: LatLng = { ...p };
  for (let i = 0; i < 3; i++) {
    const fwd = wgs84ToGcj02(guess);
    guess = { lat: guess.lat + (p.lat - fwd.lat), lng: guess.lng + (p.lng - fwd.lng) };
  }
  return guess;
}

/** 两点球面距离（米）—— 用 haversine，够本项目精度 */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * ★ 坐标模式：决定「调高德前要不要把我们的 WGS84 转成 GCJ-02」
 *
 *   `"gcj02"` —— 先加偏再调（**实测结论：澳门适用 GCJ-02**）
 *   `"wgs84"` —— 直接调（仅当实测证明某地不加密时）
 *
 * ── ✅ 2026-09-17 实测定案：**澳门适用 GCJ-02** ──────────────────────
 *   方法：把 DSAT 给的 WGS84 坐标交给高德官方 `coordinate/convert`（coordsys=gps），
 *        看转换后的偏移量；再对比「转换前后调步行路径规划」的结果。
 *   ```text
 *   C650 石排灣馬路/擎天匯   偏移 615.4 m
 *   T363 連貫公路/威尼斯人   偏移 615.6 m
 *   T367 望德聖母灣馬路      偏移 615.8 m
 *   ⇒ 三点偏移高度一致（差 <0.5m）= 标准 GCJ-02 加偏，非随机误差
 *
 *   同一段路（C650 → T363，直线 2014 m）：
 *     不转换：步行 4741 m · 吸附 24m · 绕路系数 2.35  ✗ 错一倍
 *     转换后：步行 2370 m · 吸附  2m · 绕路系数 1.18  ✓
 *   ```
 *   ⚠️ 不用转换会让步行距离**系统性偏大一倍** ⇒ 整个步行模型会建在错的数字上。
 *
 *   另：本文件的 `wgs84ToGcj02()` 已与高德官方转换**逐点比对**，
 *   最大差值 **0.32 米** ⇒ 直接用离线算法即可，**不必调转换接口**（省配额）✓
 *
 * 可用环境变量 `AMAP_COORD_MODE` 覆盖（切回 `wgs84` 即等价于不做转换）。
 */
export type AmapCoordMode = "wgs84" | "gcj02";

export function amapCoordMode(): AmapCoordMode {
  const v = (process.env.AMAP_COORD_MODE ?? "gcj02").trim().toLowerCase();
  return v === "wgs84" ? "wgs84" : "gcj02";
}

/**
 * 把「我们库里的坐标」转成「高德期望的坐标」
 * @param p 我们库里的坐标（**WGS84**，因为 DSAT 给的就是 WGS84）
 */
export function toAmapCoords(p: LatLng): LatLng {
  return amapCoordMode() === "gcj02" ? wgs84ToGcj02(p) : { ...p };
}

/** 高德 `locations` 参数格式：`lng,lat`（★ 经度在前，别写反） */
export function fmtAmapLngLat(p: LatLng, digits = 6): string {
  return `${p.lng.toFixed(digits)},${p.lat.toFixed(digits)}`;
}
