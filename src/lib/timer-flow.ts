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
  | "arrive"
  // v0.12.0：步行中途暂停/继续——暂停区间不计入步行计时与总时长。
  // 不入 steps（无独立步骤），currentStepIndex 天然忽略（不匹配任何步骤即不推进）。
  | "pause"
  | "resume";

export interface PlanLegLite {
  seq: number;
  leg_kind: "walk" | "bus" | "lrt" | "transfer" | "cross_border";
  route_options: string[] | null;
  from_station: string | null;
  to_station: string | null;
  /** v0.13.0 cross_border 段口岸显示名（'橫琴口岸' / '關閘（拱北口岸）'），通关按钮副标题用 */
  border_label?: string | null;
  /** v0.7.0：本段主线路主题色（bus=公司色 / lrt=线路官方色），由服务端按 route_options[0] 填好 */
  color?: string | null;
  /** bus 段可选上车站（去学校 51 系：首项=默认展示） */
  board_candidates?: string[] | null;
  /** bus 段可选下车点（回宿舍动态下车：末位=强制终点，与 to_station 一致） */
  alight_candidates?: string[] | null;
  /** v0.16.4：段参考时长/分钟（transfer 0 = 同场换乘步行 0 分钟） */
  minutes?: number | null;
  /** v0.17.0：合并卡「每线路差异化」——key=线路码，值=该线自己的 下车站/上车台/下车候选 */
  route_meta?: Record<string, RouteMeta> | null;
}

/** v0.17.0：单条线路在合并卡里的差异化配置（全部可选，缺省沿用段级值） */
export interface RouteMeta {
  /** 该线路的下车站（终点） */
  to?: string | null;
  /** 该线路可用上车台（首项 = 该线默认上车台） */
  board?: string[] | null;
  /** 该线路下车候选（末位 = 强制终点，语义同 alight_candidates） */
  alight?: string[] | null;
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
  /** v0.14.2：载具段序号（0-based，仅 bus/lrt 段 wait_start/board/alight 步有值）。
   *  多段方案区分「乘哪一路」的段槽位——chips 选择按段独立记忆，换乘后回默认 */
  vehIndex?: number;
}

/**
 * v0.18.0：线路显示顺序统一（主人定稿）
 *   ① 轻轨（LRT-*）统一排在巴士之上，轻轨之间保持方案原相对顺序；
 *   ② 巴士按「自然排序」：开头数字升序 → 同数字按字母后缀升序 → 纯字母开头（N6 等）排最后
 *     例：25 → 25AX → 25B → 25BS → 26 → 26A → 50 → 51 → 51A → 51B → 59 → 102 → 701X → N6
 * ⚠️ 只用于「展示排序」，不改变 plan_legs.route_options 数组本身——
 *    route_options[0] 语义 = 方案默认线路（历史样本口径），排序不得影响它。
 */
export function sortRouteOptions(codes: (string | null)[] | null | undefined): string[] {
  const list = (codes ?? []).filter((c): c is string => !!c);
  const lrt = list.filter((c) => c.startsWith("LRT-"));
  const bus = list.filter((c) => !c.startsWith("LRT-"));
  const keyOf = (c: string): [number, number, string] => {
    const m = c.match(/^(\d+)(.*)$/);
    return m ? [0, Number(m[1]), m[2] ?? ""] : [1, 0, c];
  };
  bus.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
  });
  return [...lrt, ...bus];
}

/** 载具段（bus/lrt）在 legs 中的下标与其 0-based 段序号（v0.17.0：合并卡/预览共用） */
export function vehicleLegEntries(legs: PlanLegLite[]): { leg: PlanLegLite; legIdx: number; vehIndex: number }[] {
  const out: { leg: PlanLegLite; legIdx: number; vehIndex: number }[] = [];
  let v = -1;
  legs.forEach((leg, legIdx) => {
    if (leg.leg_kind === "bus" || leg.leg_kind === "lrt") {
      v += 1;
      out.push({ leg, legIdx, vehIndex: v });
    }
  });
  return out;
}

/**
 * v0.17.0：合并卡「按所选线路改写段」——
 * 同一张卡合并多条同起点线路后，各线路的下车站/上车台/下车候选不同，
 * 由 route_meta（key=线路码）按「当前段生效线路」改写 legs，使
 * buildSteps / applyBoardSteps / buildProgress / rideInfo 全部自动跟随。
 *
 * @param choicesByVeh 段序号 → 生效线路码（由调用方按「用户 chips > 会话已修正实乘线」解析好；
 *                              null/未命中 → 保持段级默认值）
 */
export function applyRouteMeta(
  legs: PlanLegLite[],
  choicesByVeh: Record<string, string | null>,
): PlanLegLite[] {
  const entries = vehicleLegEntries(legs);
  if (!entries.some((e) => e.leg.route_meta)) return legs;

  const rewritten = new Map<number, PlanLegLite>();
  for (const e of entries) {
    const choice = choicesByVeh[String(e.vehIndex)] ?? null;
    const meta = choice ? (e.leg.route_meta?.[choice] ?? null) : null;
    if (!meta) continue;
    const next: PlanLegLite = { ...e.leg };
    if (meta.to) next.to_station = meta.to;
    if (meta.alight?.length) next.alight_candidates = meta.alight;
    if (meta.board?.length) {
      next.board_candidates = meta.board;
      // 上车台首项 = 该线默认台（用户二级选择由 applyBoardSteps 再覆盖）
      if (meta.board[0]) next.from_station = meta.board[0];
    }
    rewritten.set(e.legIdx, next);
  }
  if (!rewritten.size) return legs;

  return legs.map((leg, i) => {
    if (rewritten.has(i)) return rewritten.get(i)!;
    // 紧随载具段之后的步行段：起点同步为「实际下车站」（换线后下车点跟着变）
    const prev = legs[i - 1];
    if (leg.leg_kind === "walk" && prev && (prev.leg_kind === "bus" || prev.leg_kind === "lrt")) {
      const newPrev = rewritten.get(i - 1);
      if (newPrev?.to_station && leg.from_station !== newPrev.to_station) {
        return { ...leg, from_station: newPrev.to_station };
      }
    }
    return leg;
  });
}

/**
 * v0.17.0：轻轨换乘前预览——当前轻轨段的下一站就是换乘站（或只剩一站）时，
 * 找出「在换乘站上车的下一段轻轨」，供乘车页预显下一段的下一班车。
 * 只有当中间隔着 transfer（必要时允许 walk）且下段上车站 == 本段终点时才成立。
 */
export interface LrtOnward {
  /** 换乘站（下一段的上车站） */
  station: string;
  /** 下一段线路码 */
  route: string;
  /** 下一段终点（用于 /api/lrt/eta 推导方向） */
  dest: string | null;
}

export function findLrtOnward(
  legs: PlanLegLite[],
  vehIndex: number | null | undefined,
  destCode?: string | null,
): LrtOnward | null {
  if (vehIndex == null || !destCode) return null;
  const entries = vehicleLegEntries(legs);
  const cur = entries[vehIndex];
  const next = entries[vehIndex + 1];
  if (!cur || !next) return null;
  if (cur.leg.leg_kind !== "lrt" || next.leg.leg_kind !== "lrt") return null;
  // 中间只允许 transfer / walk（轻轨同场换乘），出现其它段则不是纯换乘衔接
  for (let k = cur.legIdx + 1; k < next.legIdx; k++) {
    const kind = legs[k]?.leg_kind;
    if (kind !== "transfer" && kind !== "walk") return null;
  }
  if (!next.leg.from_station || !stationCodesEq(next.leg.from_station, destCode)) return null;
  const route = next.leg.route_options?.[0];
  if (!route) return null;
  return { station: next.leg.from_station, route, dest: next.leg.to_station ?? null };
}

/** 由方案分段生成打点步骤序列 */
export function buildSteps(legs: PlanLegLite[]): Step[] {
  const steps: Step[] = [];
  // v0.14.2：载具段计数（仅 bus/lrt 递增）——routeChoice 按段独立记忆的槽位
  let vehIdx = -1;
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
            // 出门前可选上车站（去学校 51 系卡 / 轻轨合并卡）：候选来自首载具段，选后覆盖 depart/wait/board 站
            boardCandidates:
              nextVehicle && (nextVehicle.leg_kind === "bus" || nextVehicle.leg_kind === "lrt")
                ? nextVehicle.board_candidates ?? null
                : null,
          });
        } else if (i === legs.length - 1) {
          // 末段步行 = 抵达目的地
          steps.push({ eventType: "arrive", label: "到达", sub: "步行到达目的地" });
        }
        break;
      case "bus":
      case "lrt":
        vehIdx++;
        // v0.16.4：同场换乘（前一个 leg 是 transfer minutes=0，如莲花路停车场
        // T355/1↔T355/2 相邻台）→ 下车即已到站，第二程不再生成「到站，开始等车」步：
        // 等车自下车时刻自动开始，UI 下车后直接是「上车」（board 步自带等车 LiveEta）。
        // 判定仅限显式 0 分钟换乘（当前只有莲花路巴士卡；轻轨 UH/LOT 换乘未标注不受影响）
        const prevLeg = legs[i - 1];
        const sameFieldTransfer =
          prevLeg?.leg_kind === "transfer" &&
          prevLeg.minutes != null &&
          Number(prevLeg.minutes) === 0;
        if (!sameFieldTransfer) {
          steps.push({
            eventType: "wait_start",
            label: "到站，开始等车",
            sub: `${leg.from_station ?? ""} 等候`,
            stationCode: leg.from_station,
            quickKind: leg.leg_kind === "bus" ? "stops" : "minutes",
            routeOptions: leg.route_options,
            destStationCode: leg.to_station ?? null,
            lineColor: leg.color ?? null,
            vehIndex: vehIdx,
          });
        }
        steps.push({
          eventType: "board",
          label: "上车",
          stationCode: leg.from_station,
          quickKind: leg.leg_kind === "bus" ? "stops" : "minutes",
          routeOptions: leg.route_options,
          destStationCode: leg.to_station ?? null,
          lineColor: leg.color ?? null,
          vehIndex: vehIdx,
        });
        steps.push({
          eventType: "alight",
          label: "下车",
          sub: `目标站：${leg.to_station ?? ""}`,
          stationCode: leg.to_station,
          quickKind: leg.leg_kind === "bus" ? "stops" : "minutes",
          routeOptions: leg.route_options,
          fromStationCode: leg.from_station,
          /** 可选下车点（bus/lrt 段：v0.16.0 起轻轨合并卡也用；末位=强制终点） */
          alightCandidates:
            leg.leg_kind === "bus" || leg.leg_kind === "lrt"
              ? leg.alight_candidates?.length
                ? leg.alight_candidates
                : null
              : null,
          lineColor: leg.color ?? null,
          vehIndex: vehIdx,
        });
        break;
      case "cross_border":
        // v0.13.0：副标题按目的口岸（border_label）显示，不再写死「横琴口岸」
        steps.push({
          eventType: "border_start",
          label: "开始通关",
          sub: leg.border_label ?? "口岸",
        });
        steps.push({ eventType: "border_end", label: "通关完成", sub: leg.border_label ?? "口岸" });
        break;
      case "transfer":
        // 换乘等待并入下一程的「到站，开始等车」，不单独成步
        break;
    }
  }
  // 方案末尾不是步行时补「到达」——v0.16.1 例外：以 cross_border 结尾的去程口岸卡
  // （border_end 打点即自动结算收尾，通关完即结束行程，不再补多余的「到达」步）
  const lastLegKind = legs[legs.length - 1]?.leg_kind;
  if (!steps.some((s) => s.eventType === "arrive") && lastLegKind !== "cross_border") {
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
