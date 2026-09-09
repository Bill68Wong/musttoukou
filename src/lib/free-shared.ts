/**
 * 自由记站共享常量/纯函数（src/lib/free-shared.ts，v0.19.0）
 * ⚠️ 纯展示层，禁止 import 任何含 pg/db 的模块（client 组件会直接 import 本文件）。
 */
export type FreeEventType = "board" | "stop_arrive" | "stop_pass" | "stop_skip" | "alight";

export const FREE_EVENT_LABELS: Record<FreeEventType, string> = {
  board: "上车",
  stop_arrive: "到站",
  stop_pass: "甩站",
  stop_skip: "忘记",
  alight: "下车",
};

/** 轻轨展示名（同 LrtEta lineLabel，无「輕軌·」前缀） */
export const freeLineLabel = (code: string) =>
  code
    .replace(/^LRT-/, "")
    .replace(/湾/g, "灣")
    .replace(/横/g, "橫")
    .replace(/线/g, "線");

/** 剥「站码+空格」前缀（bus 站名 = 'C692 樂居大馬路/樂群樓'），轻轨纯名不动 */
export function stripCode(name: string | null | undefined): string {
  if (!name) return "";
  return name.replace(/^[A-Za-z]+\d+(?:\/\d+)?\s+/, "");
}

/** 站码三段式匹配（C688 ↔ C688/2） */
export function sameStation(code: string | null | undefined, target: string | null | undefined): boolean {
  if (!code || !target) return false;
  if (code === target) return true;
  if (code.startsWith(target + "/") || target.startsWith(code + "/")) return true;
  return false;
}
