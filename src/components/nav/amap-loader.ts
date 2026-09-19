/**
 * 高德 JS API 2.0 加载器（src/components/nav/amap-loader.ts，v1.3.0 · T04）
 *
 * ⚠️ 本机沙箱拦截 npm install（`wsl.exe` 在黑名单）⇒ 手写加载器替代 `@amap/amap-jsapi-loader`。
 *    若将来环境放开：`npm i @amap/amap-jsapi-loader` 后可换回官方 loader（**接口一致**：
 *    `loadAMap(jsKey, plugins) → Promise<AMap>`），消费方零改动。
 *
 * ── ★ 为什么是手写加载器（而不是 `@amap/amap-jsapi-loader`）──────────────
 *   设计 §6.1 允许新增 `@amap/amap-jsapi-loader`。但本机 **`npm install` 被沙箱安全策略
 *   阻断**（`wsl.exe` 在黑名单，npm 触发即被拦）⇒ **无法安装该依赖**。
 *   为**零新增依赖**并达成同一目标，这里**手写等价加载器**：注入
 *   `https://webapi.amap.com/maps?v=2.0&key=…&plugin=…` 脚本并等待 `window.AMap`。
 *   功能与官方 loader 等价（含 `_AMapSecurityConfig` 安全代理设置）。
 *
 * ── 坐标铁律（§0-5）──────────────────────────────────────────────────
 *   `AMap.Geolocation` 用 `convert: true` 时，`result.position` **已是 GCJ-02**，
 *   **不要再转**（本模块与消费方都不做坐标转换）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    AMap?: any;
    _AMapSecurityConfig?: { serviceHost?: string; securityJsCode?: string };
  }
}

const SCRIPT_BASE = "https://webapi.amap.com/maps";
let inflight: Promise<any> | null = null;

/** 高德 JS API 是否已就绪 */
export function amapReady(): boolean {
  return typeof window !== "undefined" && !!window.AMap;
}

/**
 * 加载高德 JS API 2.0（幂等；并发调用共享同一个 Promise）。
 *
 * @param jsKey   **Web 端（JS API）Key**（`AMAP_JS_KEY`，由服务端以 prop 传入；JS Key 本身可公开）
 * @param plugins 需要的插件（如 `["AMap.Geolocation"]`）
 * @returns `window.AMap` 命名空间
 */
export function loadAMap(jsKey: string, plugins: string[] = []): Promise<any> {
  if (typeof window === "undefined") return Promise.reject(new Error("loadAMap 仅可在客户端调用"));
  if (window.AMap) return Promise.resolve(window.AMap);
  if (!jsKey) return Promise.reject(new Error("缺少 AMAP_JS_KEY"));
  if (inflight) return inflight;

  inflight = new Promise((resolve, reject) => {
    // ★ 安全密钥只在本服务端代理里拼接 ⇒ 浏览器侧**只设 host**
    window._AMapSecurityConfig = { serviceHost: `${window.location.origin}/_AMapService` };
    const script = document.createElement("script");
    const q = new URLSearchParams({ v: "2.0", key: jsKey });
    if (plugins.length) q.set("plugin", plugins.join(","));
    script.src = `${SCRIPT_BASE}?${q.toString()}`;
    script.async = true;
    script.onload = () => {
      if (window.AMap) resolve(window.AMap);
      else {
        inflight = null;
        reject(new Error("高德 JS 加载完成但未挂载 window.AMap"));
      }
    };
    script.onerror = () => {
      inflight = null;
      reject(new Error("高德 JS 脚本加载失败"));
    };
    document.head.appendChild(script);
  });
  return inflight;
}
