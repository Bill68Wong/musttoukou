/**
 * 计时流程状态机（src/lib/timer-flow.ts）
 * 由方案分段 plan_legs 生成打点步骤序列；由已有事件回放定位当前步骤。
 * 客户端向导与服务端共用本模块（纯函数，无依赖）。
 */

export type EventType =
  | "depart"
  | "wait_start"
  | "missed"
  | "board"
  | "station_arrive"
  | "station_pass"
  | "alight"
  | "border_start"
  | "border_end"
  | "arrive";

export interface PlanLegLite {
  seq: number;
  leg_kind: "walk" | "bus" | "lrt" | "transfer" | "cross_border";
  route_options: string[] | null;
  from_station: string | null;
  to_station: string | null;
  /** v0.7.0：本段主线路主题色（bus=公司色 / lrt=线路官方色），由服务端按 route_options[0] 填好 */
  color?: string | null;
  /** bus 段可选上车站（去学校 51 系：首项=默认展示） */
  board_candidates?: string[] | null;
  /** bus 段可选下车点（回宿舍动态下车：末位=强制终点，与 to_station 一致） */
  alight_candidates?: string[] | null;
}

export interface Step {
  eventType: EventType;
  /** 大按钮文字 */
  label: string;
  /** 辅助说明（去向 / 站名） */
  sub?: string;
  stationCode?: string | null;
  /** 车距单位：'stops'=巴士（自动记录 DSAT 车距）| 'minutes'=轻轨（无实时源，保留手动） */
  quickKind?: "stops" | "minutes";
  /** 本步骤涉及的候选巴士线路（depart/wait_start/board = 等 ETA 显示用；alight = 乘车推算用） */
  routeOptions?: string[] | null;
  /** 载具段的目标站（ETA 按方向推导用） */
  destStationCode?: string | null;
  /** 下车步骤的上车站编码（推算乘车进度用） */
  fromStationCode?: string | null;
  /** 上车点候选（depart 步骤前让用户选；来自该程首个载具段的 board_candidates） */
  boardCandidates?: string[] | null;
  /** 下车点候选（乘车中动态下车：命中非末位时提示「下车/途经」；末位=强制终点） */
  alightCandidates?: string[] | null;
  /** v0.7.0：当前阶段载具主题色（出门=首段载具色；乘车=本段线路色；步行/到达无） */
  lineColor?: string | null;
}

/** 由方案分段生成打点步骤序列 */
export function buildSteps(legs: PlanLegLite[]): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    switch (leg.leg_kind) {
      case "walk":
        if (leg.seq === 1) {
          // 出门阶段：从下一程载具段推断快捷条单位（出门时记车距初估用）
          const nextVehicle = legs.find((l) => l.leg_kind === "bus" || l.leg_kind === "lrt");
          steps.push({
            eventType: "depart",
            label: "出发",
            sub: `步行前往 ${leg.to_station ?? "车站"}`,
            stationCode: leg.to_station,
            quickKind: nextVehicle
              ? nextVehicle.leg_kind === "bus"
                ? "stops"
                : "minutes"
              : undefined,
            routeOptions: nextVehicle?.route_options ?? null,
            destStationCode: nextVehicle?.to_station ?? null,
            lineColor: nextVehicle?.color ?? null,
            // 出门前可选上车站（去学校 51 系卡）：候选来自首载具段，选后覆盖 depart/wait/board 站
            boardCandidates:
              nextVehicle?.leg_kind === "bus" ? nextVehicle.board_candidates ?? null : null,
          });
        } else if (i === legs.length - 1) {
          // 末段步行 = 抵达目的地
          steps.push({ eventType: "arrive", label: "到达", sub: "步行到达目的地" });
        }
        break;
      case "bus":
      case "lrt":
        steps.push({
          eventType: "wait_start",
          label: "到站，开始等车",
          sub: `${leg.from_station ?? ""} 等候`,
          stationCode: leg.from_station,
          quickKind: leg.leg_kind === "bus" ? "stops" : "minutes",
          routeOptions: leg.route_options,
          destStationCode: leg.to_station ?? null,
          lineColor: leg.color ?? null,
        });
        steps.push({
          eventType: "board",
          label: "上车",
          stationCode: leg.from_station,
          quickKind: leg.leg_kind === "bus" ? "stops" : "minutes",
          routeOptions: leg.route_options,
          destStationCode: leg.to_station ?? null,
          lineColor: leg.color ?? null,
        });
        steps.push({
          eventType: "alight",
          label: "下车",
          sub: `目标站：${leg.to_station ?? ""}`,
          stationCode: leg.to_station,
          quickKind: leg.leg_kind === "bus" ? "stops" : "minutes",
          routeOptions: leg.route_options,
          fromStationCode: leg.from_station,
          alightCandidates:
            leg.leg_kind === "bus" && leg.alight_candidates?.length
              ? leg.alight_candidates
              : null,
          lineColor: leg.color ?? null,
        });
        break;
      case "cross_border":
        steps.push({ eventType: "border_start", label: "开始通关", sub: "横琴口岸" });
        steps.push({ eventType: "border_end", label: "通关完成" });
        break;
      case "transfer":
        // 换乘等待并入下一程的「到站，开始等车」，不单独成步
        break;
    }
  }
  // 方案末尾不是步行（如横琴方案以通关结尾）时补「到达」
  if (!steps.some((s) => s.eventType === "arrive")) {
    steps.push({ eventType: "arrive", label: "到达", sub: "到达目的地" });
  }
  return steps;
}

/** 回放事件定位当前步骤下标（missed / station_arrive / station_pass / 快照不推进） */
export function currentStepIndex(
  steps: Step[],
  events: { event_type: string }[],
): number {
  let i = 0;
  for (const e of events) {
    if (i >= steps.length) break;
    const t = e.event_type;
    if (
      t === "missed" ||
      t === "station_arrive" ||
      t === "station_pass" ||
      t === "wait_snapshot"
    )
      continue;
    if (steps[i].eventType === t) i++;
    // 乱序/多余事件忽略，不推进
  }
  return i;
}

/** 站区码三段式兼容：C688↔C688、C688↔C688/2、T560/4↔T560 */
export function stationCodesEq(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

/**
 * 去学校 51 系「上车点覆盖」：方案首个载具段若带多个 board_candidates，
 * 把默认上车站（defFrom）相关的 depart/wait_start/board/alight 步骤统一替换为所选站。
 * 选择优先级：用户本次选择 > 已打点事件中的上车站（刷新恢复）> 默认站（不改写）。
 */
export function applyBoardSteps(
  steps: Step[],
  legs: PlanLegLite[],
  events: { event_type: string; station_code: string | null }[],
  boardStation: string | null,
): Step[] {
  const firstVehicle = legs.find((l) => l.leg_kind === "bus" || l.leg_kind === "lrt");
  const boardCands =
    (firstVehicle?.board_candidates?.length ?? 0) > 1 ? firstVehicle!.board_candidates! : null;
  if (!boardCands) return steps;
  const defFrom = firstVehicle!.from_station;
  const lastEvt = [...events]
    .reverse()
    .find((e) => e.event_type === "depart" || e.event_type === "wait_start" || e.event_type === "board");
  const chosen =
    boardStation ??
    (lastEvt?.station_code && boardCands.includes(lastEvt.station_code)
      ? lastEvt.station_code
      : null);
  if (!chosen || !defFrom) return steps;
  return steps.map((s) => {
    let next: Step = s;
    if (s.stationCode === defFrom) next = { ...next, stationCode: chosen };
    if (s.fromStationCode === defFrom) next = { ...next, fromStationCode: chosen };
    if (next.sub && next.sub.includes(defFrom)) next = { ...next, sub: next.sub.split(defFrom).join(chosen) };
    return next === s ? s : next;
  });
}

/** 时段分桶（GMT+8 小时）：早高峰/日间/晚高峰/夜间 */
export function timeBucketOf(hourMacau: number): string {
  if (hourMacau >= 7 && hourMacau < 10) return "am_peak";
  if (hourMacau >= 10 && hourMacau < 17) return "day";
  if (hourMacau >= 17 && hourMacau < 20) return "pm_peak";
  return "night";
}
