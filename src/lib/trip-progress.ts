/**
 * 行程进度条模型（src/lib/trip-progress.ts，v0.12.2）
 * 纯函数、无依赖（类型除外），由方案 legs + 站序表生成「项目等分」序列，
 * 再由已打点 events 回放实时算出已推进项目数。
 *
 * 口径（主人定稿，2026-09-05）：
 *  - 项目 = 上车步行 / 乘车中各站（每站一个）/ 下车步行，彼此等权等分；
 *    例：坐 10 站 → 12 等分（1 上车步行 + 10 站 + 1 下车步行）
 *  - 单车程从「上车步行」开始；多载具每换一次车：上一段结束后，先一段
 *    「换乘/上车步行」再到下一程各站；整趟结束一段「下车步行」收尾
 *  - 主题色按载具段取（bus/lrt 线路色，缺省回退 CSS 变量 --primary）：
 *    切换载具后新段用新主题色，旧段颜色不变（渲染层在组间做颜色渐变）
 *  - 事件推进映射：wait_start=走完一段步行；station_arrive/pass=过一站
 *    （乘车项目）；alight=本程结束（提前下车/漏记时自动补齐该程剩余站）；
 *    arrive=整趟结束（全部填满）
 */

import type { PlanLegLite } from "@/lib/timer-flow";

export type ProgressUnitKind = "walk" | "ride";

export interface ProgressUnit {
  kind: ProgressUnitKind;
  /** 解析后的主题色（含 CSS var 兜底） */
  color: string;
  /** 所属载具组序号（-1 = 终点下车步行）；同组单位等宽且同色 */
  group: number;
}

export interface ProgressOptions {
  /** 用户选择的上车站（覆盖首个载具段默认 from_station，与 applyBoardSteps 同口径） */
  boardStation?: string | null;
}

/** 无载具/未知时的兜底色：主题蓝，随明暗主题自适应 */
const NEUTRAL = "var(--primary)";

type StopRow = { seq: number; code: string; name: string };
export type RouteStopsMap = Record<string, StopRow[]>;

/** 站区码三段式匹配（与 eta / timer 全链路同款） */
export function findStopIdx(stops: StopRow[], target?: string | null): number {
  if (!target || stops.length === 0) return -1;
  let i = stops.findIndex((s) => s.code === target);
  if (i < 0) i = stops.findIndex((s) => s.code.startsWith(target + "/"));
  if (i < 0) i = stops.findIndex((s) => target.startsWith(s.code + "/"));
  return i;
}

/**
 * 沿行驶方向取最近命中（v0.13.x）：候选站码在站序中多次出现时（循环线首尾同站码，
 * 如 25 路 M1/13 關閘總站 = seq1 起点 & seq50 终点），findStopIdx 恒取首个命中会把
 * 「要下的终点」误判成折返起点，导致进度条按站等分时 rideN 严重少算。
 * anchor = 上车站下标，返回「自 anchor 沿方向环距最近」的该站命中（乘客上车后第一次遇到）。
 */
function bestStopAhead(stops: StopRow[], target: string | null | undefined, anchor: number): number {
  if (!target || stops.length === 0 || anchor < 0) return findStopIdx(stops, target);
  const n = stops.length;
  const hits: number[] = [];
  stops.forEach((s, i) => {
    if (s.code === target) hits.push(i);
    else if (s.code.startsWith(target + "/")) hits.push(i);
    else if (target.startsWith(s.code + "/")) hits.push(i);
  });
  if (hits.length === 0) return -1;
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

/** 该载具段的实际上车站（选了上车站候选则覆盖默认 from_station） */
function effBoardOf(leg: PlanLegLite, boardStation?: string | null): string | null {
  if (
    boardStation &&
    (leg.board_candidates ?? []).length > 1 &&
    leg.board_candidates!.includes(boardStation)
  ) {
    return boardStation;
  }
  return leg.from_station ?? null;
}

/**
 * 生成项目等分序列（固定于进入路线页时：随 legs/所选上车站而定，不随打点变化）
 */
export function buildProgress(
  legs: PlanLegLite[],
  stopsMap: RouteStopsMap,
  opts: ProgressOptions = {},
): ProgressUnit[] {
  const units: ProgressUnit[] = [];
  const vehLegs = legs.filter((l) => l.leg_kind === "bus" || l.leg_kind === "lrt");
  const colorOf = (leg?: PlanLegLite | null) => leg?.color ?? NEUTRAL;

  // 纯步行方案（无载具）：单项目兜底
  if (vehLegs.length === 0) {
    return [{ kind: "walk", color: NEUTRAL, group: -1 }];
  }

  const lastVeh = vehLegs[vehLegs.length - 1];
  let group = -1;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.leg_kind !== "bus" && leg.leg_kind !== "lrt") continue;
    group++;

    // 上一段是步行 → 本程开头有一格「上车步行」（换乘走也计入下一载具的步行项目）
    const walkIn = i > 0 && legs[i - 1].leg_kind === "walk";
    const color = colorOf(leg);
    if (walkIn) units.push({ kind: "walk", color, group });

    // 乘车中各站：k = 上车站到目标站需停靠的次数（含目标站到站）
    const routeCode = (leg.route_options ?? []).find((r) => (stopsMap[r]?.length ?? 0) > 0);
    const stops = routeCode ? stopsMap[routeCode] : undefined;
    const boardIdx = stops ? findStopIdx(stops, effBoardOf(leg, opts.boardStation)) : -1;
    // v0.13.x：目标站沿行驶方向取最近命中（循环线首尾同站码不误判成折返起点）
    const destIdx = stops ? bestStopAhead(stops, leg.to_station, boardIdx) : -1;
    const rideN0 =
      stops && boardIdx >= 0 && destIdx >= 0
        ? (destIdx - boardIdx + stops.length) % stops.length || NaN
        : NaN;
    let rideN = rideN0;
    if (!Number.isFinite(rideN) || rideN < 1) rideN = 1; // 数据缺站序/异常 → 兜底 1 站
    for (let j = 0; j < rideN; j++) units.push({ kind: "ride", color, group });
  }

  // 终点「下车步行」收尾（颜色沿用最后一程载具，跨关/步行并入）
  units.push({ kind: "walk", color: colorOf(lastVeh), group: -1 });
  return units;
}

/**
 * 回放 events 计算已推进项目数（幂等：每次从 0 扫，撤销/漏记天然正确）
 * 单位顺序 = 事件自然顺序；详见文件头「事件推进映射」
 */
export function computeFilled(
  units: ProgressUnit[],
  events: { seq: number; event_type: string }[],
): number {
  if (units.length === 0 || events.length === 0) return 0;
  // 每载具组最后一个单位下标（alight 补齐该程剩余站用）
  const lastOfGroup = new Map<number, number>();
  units.forEach((u, i) => {
    if (u.group >= 0) lastOfGroup.set(u.group, i);
  });

  let p = 0;
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const e of sorted) {
    const t = e.event_type;
    if (t === "arrive") {
      p = units.length;
      break;
    }
    if (t === "wait_start") {
      // 已走到车站/换乘到站 → 关闭本程开头那一格「上车步行」（终点步行由 arrive 收尾）
      if (p < units.length && units[p].kind === "walk" && units[p].group >= 0) p++;
      continue;
    }
    if (t === "station_arrive" || t === "station_pass") {
      if (p < units.length && units[p].kind === "ride") p++;
      continue;
    }
    if (t === "alight") {
      // 本程下车 = 该载具组结束：提前下车/漏记途经站时把该组剩余站一并补齐
      if (p < units.length && units[p].group >= 0) {
        const end = lastOfGroup.get(units[p].group) ?? p;
        if (end + 1 > p) p = end + 1;
      }
      continue;
    }
    // depart / board / missed / border_* / pause / resume 不推进
  }
  return Math.min(p, units.length);
}
