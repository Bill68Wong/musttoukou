/**
 * 开发者模式（src/lib/dev-mode.ts，v1.0.0）
 *
 * 纯前端状态，存在浏览器 `localStorage`，不上传、不入库、无 cookie。
 *
 * 作用：自动选线的大卡片默认**只展示**（点开是文字指引）；
 *   开启开发者模式后，点卡 = 直接进入计时打点流程（采实测样本）——
 *   把「采集数据」的能力藏在一个开关后面，普通用户不会误触。
 *   同时 `/routes`（旧的路线列表）也对非开发者关闭，避免双入口混淆。
 *
 * ⚠️ SSR 首帧恒为 `false`（服务端读不到 localStorage）→ 组件须在 `useEffect` 里读，
 *    否则会 hydration mismatch。见 `useDevMode()`。
 */
import { useEffect, useState } from "react";

const KEY = "must.dev-mode";
const EVT = "must:dev-mode";

/** 读当前状态（服务端 / 隐私模式禁用 storage 时一律 false） */
export function readDevMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** 写入并广播（同页自定义事件 + 跨标签 storage 事件） */
export function writeDevMode(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* 隐私模式：忽略，仅本次会话内生效 */
  }
  window.dispatchEvent(new CustomEvent<boolean>(EVT, { detail: on }));
}

/** 订阅变化；返回取消订阅函数 */
export function subscribeDevMode(cb: (on: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (e: Event) => cb(!!(e as CustomEvent<boolean>).detail);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb(readDevMode());
  };
  window.addEventListener(EVT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

/** 组件内使用：挂载后取值（首帧 false，避免 hydration mismatch），并跟随变化 */
export function useDevMode(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(readDevMode());
    return subscribeDevMode(setOn);
  }, []);
  return on;
}
