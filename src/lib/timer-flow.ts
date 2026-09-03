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
            routeOptions: nextVehicle?.leg_kind === "bus" ? nextVehicle.route_options : null,
            destStationCode: nextVehicle?.to_station ?? null,
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
          routeOptions: leg.leg_kind === "bus" ? leg.route_options : null,
          destStationCode: leg.to_station ?? null,
        });
        steps.push({
          eventType: "board",
          label: "上车",
          stationCode: leg.from_station,
          quickKind: leg.leg_kind === "bus" ? "stops" : "minutes",
          routeOptions: leg.leg_kind === "bus" ? leg.route_options : null,
          destStationCode: leg.to_station ?? null,
        });
        steps.push({
          eventType: "alight",
          label: "下车",
          sub: `目标站：${leg.to_station ?? ""}`,
          stationCode: leg.to_station,
          quickKind: leg.leg_kind === "bus" ? "stops" : "minutes",
          routeOptions: leg.route_options,
          fromStationCode: leg.from_station,
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

/** 时段分桶（GMT+8 小时）：早高峰/日间/晚高峰/夜间 */
export function timeBucketOf(hourMacau: number): string {
  if (hourMacau >= 7 && hourMacau < 10) return "am_peak";
  if (hourMacau >= 10 && hourMacau < 17) return "day";
  if (hourMacau >= 17 && hourMacau < 20) return "pm_peak";
  return "night";
}
