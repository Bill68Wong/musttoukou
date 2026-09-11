/**
 * 行程进度条模型（src/lib/trip-progress.ts，v0.12.2 → v0.17.1）
 * 纯函数、无依赖（类型除外），由方案 legs + 站序表生成「项目等分」序列，
 * 再由已打点 events 回放实时算出已推进项目数。
 *
 * 口径（用户定稿，2026-09-05 → 2026-09-08 v0.17.1 改版）：
 *  - 项目 = 各载具段乘车中的每个停靠站，彼此等权等分；**只在交通工具上积累进度**：
 *    步行（出门/换乘/下车走）/ 等车 / 通关一律不占等分、不推进
 *  - 例：单程坐 12 站 → 12 等分；多载具方案 = 各段站数之和（每换一次车接续下一段各站）
 *  - 主题色按载具段取（bus/lrt 线路色，缺省回退 CSS 变量 --primary）：
 *    切换载具后新段用新主题色，旧段颜色不变（渲染层在组间做颜色渐变）
 *  - 事件推进映射：station_arrive/pass=过一站（乘车项目推进）；alight=本程结束
 *    （提前下车/漏记时自动补齐该程剩余站）；arrive=整趟结束（全部填满）；
 *    depart/wait_start/board/missed/border_start/border_end/pause/resume 不推进
 *    （v0.17.1：等车/换乘/通关全程不积累——去口岸卡下车后即满，通关停留 100%）
 */

import type { PlanLegLite } from "@/lib/timer-flow";
import { resolveRideDestIdx } from "@/lib/station-match";

export type ProgressUnitKind = "walk" | "ride";

export interface ProgressUnit {
  kind: ProgressUnitKind;
  /** 解析后的主题色（含 CSS var 兜底） */
  color: string;
  /** 所属载具组序号（-1 = 纯步行方案兜底单位）；同组单位等宽且同色 */
  group: number;
}

export interface ProgressOptions {
  /** 用户选择的上车站（覆盖首个载具段默认 from_station，与 applyBoardSteps 同口径） */
  boardStation?: string | null;
  /** v0.14.1：站码→站名表（timer 接口已返回）；供同场分台聚合（T355/1↔T355/2 同场） */
  stationNames?: Record<string, string>;
  /**
   * v0.17.1：各载具组的「生效线路」回调（合并卡按用户所选线路计算站数——终点随线而变，
   * 若仍按 route_options 首项会拿 50 的站序去匹配 26A 的终点 → 兜底 1 站）；
   * 未提供/返回线路无站序时回退「首个有站序的选项」
   */
  effRouteOf?: (group: number) => string | null;
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

  let group = -1;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.leg_kind !== "bus" && leg.leg_kind !== "lrt") continue;
    group++;

    // v0.17.1：不再生成「上车/换乘步行」格——步行不占进度（等车/步行不推进）
    const color = colorOf(leg);

    // 乘车中各站：k = 上车站到目标站需停靠的次数（含目标站到站）
    // v0.17.1：优先「生效线路」（合并卡按所选线路算站数），回退首个有站序选项
    const effRc = opts.effRouteOf ? opts.effRouteOf(group) : null;
    const routeCode =
      effRc && (stopsMap[effRc]?.length ?? 0) > 0
        ? effRc
        : ((leg.route_options ?? []).find((r) => (stopsMap[r]?.length ?? 0) > 0) ?? null);
    const stops = routeCode ? stopsMap[routeCode] : undefined;
    const boardIdx = stops ? findStopIdx(stops, effBoardOf(leg, opts.boardStation)) : -1;
    // v0.14.1：目标站按「同场站名」聚合沿方向最近命中（26/50 分台 T355/2、T355/1 都能算对）；
    //         无 stationNames（纯函数兜底）时按站区码沿方向最近命中（25 路 M1/13 折返段不误判）
    const destIdx = stops
      ? resolveRideDestIdx(
          stops,
          leg.to_station,
          boardIdx,
          opts.stationNames ? (c) => opts.stationNames![c] ?? null : undefined,
        )
      : -1;
    const rideN0 =
      stops && boardIdx >= 0 && destIdx >= 0
        ? (destIdx - boardIdx + stops.length) % stops.length || NaN
        : NaN;
    let rideN = rideN0;
    if (!Number.isFinite(rideN) || rideN < 1) rideN = 1; // 数据缺站序/异常 → 兜底 1 站
    for (let j = 0; j < rideN; j++) units.push({ kind: "ride", color, group });
  }

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
    // v0.17.1：wait_start / board（等车、步行）不推进进度——只在乘车时积累
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
    // depart / wait_start / board / missed / border_start / border_end / pause / resume 不推进
    // （v0.17.1：去口岸卡在最后 alight 后即满 100%，通关全程停留满格）
  }
  return Math.min(p, units.length);
}
