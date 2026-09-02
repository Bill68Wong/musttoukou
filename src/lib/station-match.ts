/**
 * 站区码三段式匹配（src/lib/station-match.ts）
 * 同站区不同台用后缀区分（C688 vs C688/2、T560 vs T560/4）：
 *   ① 精确相等 ② 站带后缀（目标是主码）③ 目标带后缀（站是主码）
 * 前后端共用（TimerWizard 乘车推算 / ETA API 均使用）。
 */

export interface StopLike {
  seq?: number;
  code?: string;
  station_code?: string;
  [k: string]: unknown;
}

function codeOf(stop: StopLike): string {
  return (stop.code ?? stop.station_code ?? "") as string;
}

/** 在站序数组中找目标站的下标；找不到返回 -1 */
export function findStopIdx(stops: StopLike[], target: string | null | undefined): number {
  if (!target) return -1;
  let i = stops.findIndex((s) => codeOf(s) === target);
  if (i < 0) i = stops.findIndex((s) => codeOf(s).startsWith(target + "/"));
  if (i < 0) i = stops.findIndex((s) => target.startsWith(codeOf(s) + "/"));
  return i;
}
