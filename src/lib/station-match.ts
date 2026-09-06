/**
 * 站区码三段式匹配（src/lib/station-match.ts）
 * 同站区不同台用后缀区分（C688 vs C688/2、T560 vs T560/4）：
 *   ① 精确相等 ② 站带后缀（目标是主码）③ 目标带后缀（站是主码）
 * 前后端共用（TimerWizard 乘车推算 / ETA API 均使用）。
 *
 * v0.14.1 乘车目标解析新增「同场站台（分台）」语义：
 *   DSAT 把同一场站的不同停靠位拆成多个站码，但站名相同——典型如
 *   T355/1 与 T355/2 都叫「蓮花路停車場」（26/50 两线分停两站台）、
 *   M1/13 關閘總站 在循环线首尾同点（seq1/seq50）。
 *   乘车推进要找的是「乘客要下的那个场站，沿行驶方向第一次到达的那次停靠」，
 *   而不是死磕目标站码——否则 50 路从 C653 去莲花路停车场（3 站到 T355/1）
 *   会因为目标码 T355/2 在站序后段而显示绕一整圈。
 */

export interface StopLike {
  seq?: number;
  code?: string;
  station_code?: string;
  name?: string;
  [k: string]: unknown;
}

function codeOf(stop: StopLike): string {
  return (stop.code ?? stop.station_code ?? "") as string;
}

function nameOfStop(stop: StopLike): string {
  const n = stop.name;
  return typeof n === "string" ? n : "";
}

/** 在站序数组中找目标站的下标；找不到返回 -1 */
export function findStopIdx(stops: StopLike[], target: string | null | undefined): number {
  if (!target) return -1;
  let i = stops.findIndex((s) => codeOf(s) === target);
  if (i < 0) i = stops.findIndex((s) => codeOf(s).startsWith(target + "/"));
  if (i < 0) i = stops.findIndex((s) => target.startsWith(codeOf(s) + "/"));
  return i;
}

/**
 * 乘车/进度目标站解析（v0.14.1，替换 v0.14.0 的 bestStopAhead）：
 * 返回 targetCode 沿行驶方向（自上车站 anchor 下标）环距最近的那次停靠下标。
 *   - nameOf(targetCode) 能查到站名时：以「站名」聚合同场分台（T355/1↔T355/2 同叫蓮花路停車場），
 *     取同名站中沿方向最近命中 —— 26 从 C653 3 站到 T355/2、50 从 C653 3 站到 T355/1 都能算对；
 *   - 查不到站名时退回首命中语义（沿用站区码三段式匹配，25 路 M1/13 首尾同码取沿方向最近）。
 * anchor < 0（无上车站信息）时按站序顺序取首个命中。
 */
export function resolveRideDestIdx(
  stops: StopLike[],
  targetCode: string | null | undefined,
  anchor: number,
  nameOf?: (code: string) => string | null | undefined,
): number {
  if (!targetCode || stops.length === 0) return -1;
  const n = stops.length;

  // 站名归一化：UI 全链路站名格式为「站码 + 空格 + 官方站名」（如 "T355/2 蓮花路停車場"），
  // 同场分台 T355/1 与 T355/2 前缀不同 → 比对前必须先剥掉码前缀，否则同名聚合永不命中
  // （2026-09-06 实测 50 路显示「还剩 34 站」的根因）。纯名（库 name_tc）传入时不受影响。
  const codeSet = new Set(stops.map((s) => codeOf(s)));
  const stripCode = (raw: string | null | undefined): string => {
    if (!raw) return "";
    for (const c of codeSet) {
      if (c && (raw === c || raw.startsWith(c + " "))) return raw.slice(c.length).trim();
    }
    return raw;
  };

  // ① 优先按同场站名聚合（分台都叫同一站名）
  const nm = stripCode(nameOf ? nameOf(targetCode) : null);
  let hits: number[] = [];
  if (nm) {
    stops.forEach((s, i) => {
      if (stripCode(nameOfStop(s)) === nm) hits.push(i);
    });
  }
  // ② 站名缺失/无同名命中 → 回退站区码三段式（25 路 M1/13 首尾同码也在其列）
  if (hits.length === 0) {
    hits = stops
      .map((s, i) => ({ i, c: codeOf(s) }))
      .filter(({ c }) => c === targetCode || c.startsWith(targetCode + "/") || targetCode.startsWith(c + "/"))
      .map(({ i }) => i);
  }
  if (hits.length === 0) return -1;
  if (anchor < 0) return hits[0];

  let best = hits[0];
  let bestD = (best - anchor + n) % n;
  for (const h of hits) {
    const d = (h - anchor + n) % n;
    if (d < bestD) {
      best = h;
      bestD = d;
    }
  }
  return best;
}
