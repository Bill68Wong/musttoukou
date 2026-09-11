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

// ============ 共享类型（v0.23.0：FreeRideClient 与 FreeHistoryClient 共用）============

/** 站序里的一站（GET /api/free/stops） */
export interface FreeStop {
  seq: number;
  code: string;
  name: string;
}

/** 行程详情（GET /api/free/[id]） */
export interface RideDetail {
  route_code: string;
  dsat_dir: string;
  board_station: string | null;
  alight_station: string | null;
  vehicle_plate: string | null;
  vehicle_code: string | null;
  crowd_level: number | null;
  started_at: string;
  ended_at: string | null;
  total_ms: number | null;
}

/** 逐站事件（free_ride_events） */
export interface RideEventRow {
  id: number;
  seq: number;
  event_type: FreeEventType;
  station_code: string | null;
  recorded_at: string;
}

/** 历史记录行（GET /api/free/rides） */
export interface HistoryRow {
  id: number;
  route_code: string;
  dsat_dir: string;
  board_station: string | null;
  alight_station: string | null;
  vehicle_plate: string | null;
  crowd_level: number | null;
  started_at: string;
  ended_at: string | null;
  total_ms: number | null;
  route_color: string | null;
  board_name: string | null;
  alight_name: string | null;
  event_count: number;
  timed_count: number;
}

/** 固定模板 MM/DD HH:mm（澳门时间）—— toLocaleString 在 iOS/安卓会输出长格式把行挤爆 */
export function fmtFreeDateTime(iso: string): string {
  const m = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(m.getUTCMonth() + 1)}/${p(m.getUTCDate())} ${p(m.getUTCHours())}:${p(m.getUTCMinutes())}`;
}

/** HH:mm:ss（澳门时间）—— 固定模板，与 fmtFreeDateTime 同理避免 iOS/安卓长格式差异 */
export function fmtFreeClock(iso: string): string {
  const m = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(m.getUTCHours())}:${p(m.getUTCMinutes())}:${p(m.getUTCSeconds())}`;
}

/** 「N 分 SS 秒」 */
export function fmtFreeDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`;
}

/** 拥挤度档位（0-4， riding 页选择 + 历史页展示共用） */
export const FREE_CROWD = [
  { value: 0, label: "空", hint: "随便坐" },
  { value: 1, label: "正常", hint: "有座" },
  { value: 2, label: "饱和", hint: "没座位但站稳" },
  { value: 3, label: "挤", hint: "贴着站" },
  { value: 4, label: "爆满", hint: "前胸贴后背" },
];
