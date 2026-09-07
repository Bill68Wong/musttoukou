"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  applyBoardSteps,
  buildSteps,
  currentStepIndex,
  stationCodesEq,
  type PlanLegLite,
} from "@/lib/timer-flow";
import LiveEta from "./LiveEta";
import LrtEta from "./LrtEta";
import JourneyProgress from "./JourneyProgress";
import { buildProgress, computeFilled } from "@/lib/trip-progress";
import { findStopIdx, resolveRideDestIdx } from "@/lib/station-match";

interface SessionData {
  session: {
    id: number;
    summary: string;
    ended_at: string | null;
    missed_count: number;
    crowd_level: number | null;
    total_minutes: number | null;
    dsat_dir: string | null;
    route_code: string | null;
    is_test: boolean;
    from_slug: string | null;
    to_slug: string | null;
    from_zone: string | null;
    to_zone: string | null;
  };
  legs: PlanLegLite[];
  events: { id: number; seq: number; event_type: string; station_code: string | null; recorded_at: string }[];
  snapshots: { id: number; value_kind: string; value: number; station_code: string | null; recorded_at: string }[];
  stationNames: Record<string, string>;
  routeStopsByRoute: Record<string, { seq: number; code: string; name: string }[]>;
}

/** 轻轨码判定（LRT-* 线路/站点；v0.15.0 轻轨报站卡分派用） */
const isLrtCode = (c?: string | null): boolean => !!c && c.startsWith("LRT-");

/** 学校分区（B/C、N/O、R 座）—— 步行分组上下文，需求 10 */
const SCHOOL_ZONES = [
  { value: "B/C", hint: "B/C 座" },
  { value: "N/O", hint: "N/O 座" },
  { value: "R", hint: "R 座" },
];

const EVENT_LABELS: Record<string, string> = {
  depart: "出发",
  wait_start: "到站等车",
  missed: "没挤上",
  board: "上车",
  station_arrive: "途经站",
  station_pass: "甩站未停",
  alight: "下车",
  border_start: "开始通关",
  border_end: "通关完成",
  arrive: "到达",
  // v0.12.0：步行暂停/继续（瞬态控制事件，不入步骤不推进）
  pause: "⏸ 暂停",
  resume: "继续计时",
};

/** v0.12.0：不可撤销的事件类型（瞬态控制事件；arrive 服务端支持复活撤销，见 undo 路由） */
const UNDO_EXCLUDED = new Set(["pause", "resume"]);

// 关键打点（出发/上车/下车/到达）触发 10ms 短振感；非每个点击都振。
const HAPTIC_EVENTS = new Set(["depart", "board", "alight", "arrive"]);
// v0.12.1：自动刷新（LiveEta refreshKey force 直查）仅在关键动作触发——
// 出发 depart / 人到站 wait_start / 上车 board / 下车 alight；
// 进入路线页由 LiveEta 挂载自动取一次；pause/继续/记站(missed/pass/arrive)等不再刷（省 DSAT 调用）
const AUTO_REFRESH_TYPES = new Set(["depart", "wait_start", "board", "alight"]);
function tryVibrate() {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try {
      navigator.vibrate(10);
    } catch {
      /* ignore */
    }
  }
}

/* ---------- v0.7.0 主题色工具：徽章文字对比色 / 轻轨线名美化 ---------- */
function textOn(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return "#fff";
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#101418" : "#fff";
}
// v0.15.1：轻轨标签去掉「輕軌·」前缀（🚈 图标/乘车语境已标识载具，无需重复）
//   LRT-石排湾线 → 石排灣線；LRT-横琴线 → 橫琴線；LRT-氹仔线 → 氹仔線
const lrtLabelOf = (code: string) =>
  code
    .replace(/^LRT-/, "")
    .replace(/湾/g, "灣")
    .replace(/横/g, "橫")
    .replace(/线/g, "線");

/** 乘车标题线路显示：轻轨 → 「石排灣線」；巴士 → 「51 路」 */
const rideRouteLabel = (code: string) =>
  code.startsWith("LRT-") ? lrtLabelOf(code) : `${code} 路`;

export default function TimerWizard({ sessionId }: { sessionId: number }) {
  const router = useRouter();
  const [data, setData] = useState<SessionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 防连点用 ref（不触发重渲染，打点全程零卡顿）
  const busy = useRef(false);
  // 学校分区选择（B/C | N/O | R；可跳过）
  const [fromZone, setFromZone] = useState<string | null>(null);
  const [toZone, setToZone] = useState<string | null>(null);
  // 去学校 51 系：上车点选择（board_candidates；首项=默认无需选）
  const [boardStation, setBoardStation] = useState<string | null>(null);
  // 动态下车「途经」后：抑制同一候选站的再次询问（cur 前进后自动失效）
  const [continueFrom, setContinueFrom] = useState<number | null>(null);
  // 打点成功后递增 → LiveEta 卡片事件驱动刷新（需求 7：无自动轮询）
  const [etaTick, setEtaTick] = useState(0);
  // v0.10.0 A11：多候选线路段「实际乘哪一路」（board 阶段选；乘车推进/车队参照按此线）
  // v0.14.2：按载具段（vehIndex）独立记忆——换乘到下一段回默认，不再跨段沿用上一程选择
  const [routeChoices, setRouteChoices] = useState<Record<string, string | null>>({});
  // v0.10.0 A8：tap_id 幂等——同一次打点（同 type+参数）复用同一 id；成功后清除，失败留作重试
  const tapIds = useRef(new Map<string, string>());
  // v0.15.0：LrtEta 上报的「下一班剩余毫秒」（轻轨 wait_start 自动写快照用；null=无下一班）
  const lrtRemainMs = useRef<number | null>(null);
  // v0.12.0：撤销确认弹窗目标（null=未弹）；弹窗真实，确认后才 POST undo
  const [undoTarget, setUndoTarget] = useState<{
    id: number;
    event_type: string;
    station_code: string | null;
  } | null>(null);
  const [undoing, setUndoing] = useState(false);

  // v0.12.0：暂停态由 events 推导（最后一条是 pause → 暂停中）；暂停时 1s 一跳刷新秒表
  const evtsForPause = data?.events ?? [];
  const pausedNow =
    evtsForPause.length > 0 && evtsForPause[evtsForPause.length - 1].event_type === "pause";
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!pausedNow) return;
    const t = setInterval(() => setClock((c) => c + 1), 1000);
    return () => clearInterval(t);
  }, [pausedNow]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/timer/${sessionId}`, { cache: "no-store" });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "加载失败");
      setData((await res.json()) as SessionData);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  // 已结束 → 跳结束页
  useEffect(() => {
    if (data?.session.ended_at) router.replace(`/finish/${sessionId}`);
  }, [data, router, sessionId]);

  /**
   * 打点（乐观更新）：点击后本地立即推进 UI（无 loading 闪烁），POST 后台同步；
   * 失败回滚并提示。arrive 由服务器收尾，成功后跳结束页。
   */
  async function postEvent(type: string, extra?: Record<string, unknown>) {
    if (!data || busy.current) return;
    busy.current = true;
    const prev = data; // 失败回滚用
    // v0.10.0 A8：幂等键 = 同一次逻辑打点（type + 参数）生成一次；服务器按 (session_id, tap_id) 去重
    const sigKey = `${type}|${JSON.stringify(extra ?? {})}`;
    let tapId = tapIds.current.get(sigKey);
    if (!tapId) {
      tapId = `${sessionId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      if (tapIds.current.size >= 12) {
        const oldest = tapIds.current.keys().next().value;
        if (oldest) tapIds.current.delete(oldest);
      }
      tapIds.current.set(sigKey, tapId);
    }
    // 当前被打点的步骤（自动记录车距用：depart / wait_start 的巴士段）
    // 注意用覆盖后的步骤，否则选了非默认上车站会以默认站为基准错位
    const curSteps = applyBoardSteps(buildSteps(data.legs), data.legs, data.events, boardStation);
    const curIdx = currentStepIndex(curSteps, data.events);
    const curStep = curSteps[curIdx];
    try {
      // —— 乐观更新本地 state ——
      const nowIso = new Date().toISOString();
      const maxSeq = data.events.reduce((m, e) => Math.max(m, e.seq), 0);
      // v0.12.0：本次乐观插入的本地负 id（成功收到真实 event_id 后替换，撤销标签需要真实 id）
      let pendingLocalId: number | null = null;
      if (type === "wait_snapshot") {
        // 等车快照：只追加/覆盖 snapshots（events 列表不显示快照）
        const snap = {
          id: -(Date.now() % 1e9) - 1,
          value_kind: (extra?.value_kind as string) ?? "stops",
          value: extra?.value as number,
          station_code: (extra?.station_code as string | null) ?? null,
          recorded_at: nowIso,
        };
        // 手动分钟：同站改选即覆盖（与库内部分唯一索引语义一致）
        const rep = data.snapshots.findIndex(
          (s) => s.value_kind === "minutes" && stationCodesEq(s.station_code, snap.station_code),
        );
        const snapshots =
          rep >= 0
            ? data.snapshots.map((s, i) => (i === rep ? snap : s))
            : [...data.snapshots, snap];
        setData({ ...data, snapshots });
      } else {
        const evt = {
          id: -(Date.now() % 1e9) - 1,
          seq: maxSeq + 1,
          event_type: type,
          station_code: (extra?.station_code as string | null) ?? null,
          recorded_at: nowIso,
        };
        // v0.12.0：记住乐观负 id，POST 成功后替换为服务器真实 event_id
        pendingLocalId = evt.id;
        setData({
          ...data,
          events: [...data.events, evt],
          session:
            type === "missed"
              ? { ...data.session, missed_count: data.session.missed_count + 1 }
              : data.session,
        });
      }

      // 关键打点：轻触觉反馈
      if (HAPTIC_EVENTS.has(type)) tryVibrate();

      // —— 后台同步服务器（带 tap_id，服务器幂等：同 id 已存在则不双写） ——
      const res = await fetch(`/api/timer/${sessionId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, tap_id: tapId, ...extra }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        finished?: boolean;
        /** v0.12.0：服务器真实事件 id（撤销依赖） */
        event_id?: number | null;
      };
      if (!res.ok) throw new Error(body.error ?? "打点失败");
      // 打点已入库（成功或幂等命中）→ 释放幂等键，供下一次打点使用
      tapIds.current.delete(sigKey);

      // v0.12.0：乐观负 id → 服务器真实 id（撤销标签需要 id>0 的真实事件才能撤）
      if (pendingLocalId !== null && body.event_id) {
        const realId = body.event_id;
        setData((prev) =>
          prev
            ? {
                ...prev,
                events: prev.events.map((e) =>
                  e.id === pendingLocalId ? { ...e, id: realId } : e,
                ),
              }
            : prev,
        );
      }

      // —— 后台数据采集（全部不阻塞打点；失败静默） ——
      // ① depart/wait_start 巴士段：自动记录当时车距（value 真实站数，force 直查）
      const busContext =
        curStep?.quickKind === "stops" && !!curStep.stationCode && !!curStep.routeOptions?.length;
      if (
        (type === "depart" || type === "wait_start") &&
        busContext
      ) {
        void fetch(`/api/timer/${sessionId}/auto-snapshot`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            moment: type,
            station: curStep.stationCode,
            routes: curStep.routeOptions,
            dir: data.session.dsat_dir ?? "0",
            dest: curStep.destStationCode,
          }),
        }).catch(() => {});
      }

      // ② 反事实车队快照（需求 9 / v0.11.0）：depart / wait_start / alight 三个时点全量候选车队。
      //    服务端按会话 OD 自动推导候选集（同 from/to 各方案主线路+各自上车站），无需前端传站/线
      if ((type === "depart" || type === "wait_start" || type === "alight") && busContext) {
        void fetch(`/api/timer/${sessionId}/fleet-snapshot`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage: type }),
        }).catch(() => {});
      }

      // ③ 抓实际乘坐车辆（v0.4.0 board 起；v0.14.1 每段上/下车都抓，多线候选段按所选
      //    实乘线 route 抓取，换乘点操作与单线一致、不打断流程）
      //    v0.14.2：按当前打点所属载具段的槽位取选择，跨段不沿用
      const segChoice = (() => {
        if (curStep?.vehIndex == null) return null;
        return routeChoices[String(curStep.vehIndex)] ?? null;
      })();
      const grabRoute = curStep?.routeOptions?.length
        ? segChoice && curStep.routeOptions.includes(segChoice)
          ? segChoice
          : curStep.routeOptions[0]
        : null;
      if ((type === "board" || type === "alight") && busContext && grabRoute) {
        // 抓取候选站：上车 = 上车站；下车 = 实际停靠台（rideInfo.destCode，乘 50 落 T355/1）
        const atStation =
          type === "board"
            ? (curStep.stationCode ?? null)
            : rideInfo?.destCode ?? curStep.stationCode ?? null;
        void fetch("/api/dsat/grab", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            route: grabRoute,
            stage: type, // 'board' | 'alight'
            station: curStep.stationCode ?? null, // 该段上车站（服务端定位方案分段、推方向）
            atStation,
          }),
        }).catch(() => {});
      }

      // ④ 自动刷新仅限关键打点（v0.12.1，见 AUTO_REFRESH_TYPES）→ LiveEta refreshKey 递增 force 直查
      if (AUTO_REFRESH_TYPES.has(type)) setEtaTick((t) => t + 1);

      // v0.15.0：轻轨 wait_start —— 按时刻表自动记「当时距下一班分钟」快照（手动 chips 已移除）。
      // 口径：value = floor(剩余毫秒/60000)，<60s 记 0（即将）；无下一班数据则跳过。
      // 落库走 events wait_snapshot + source=auto_wait_start（与巴士 auto 快照同表幂等）。
      if (type === "wait_start" && curStep?.quickKind === "minutes" && curStep.stationCode) {
        const remainMs = lrtRemainMs.current;
        if (remainMs != null && remainMs >= 0) {
          void fetch(`/api/timer/${sessionId}/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "wait_snapshot",
              value_kind: "minutes",
              value: Math.floor(remainMs / 60_000),
              station_code: curStep.stationCode,
              source: "auto_wait_start",
            }),
          }).catch(() => {});
        }
      }

      if (type === "arrive") {
        router.replace(`/finish/${sessionId}`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      // arrive 已在服务器收尾但响应丢失/重试撞「会话已结束」→ 直接进结束页（幂等兜底）
      if (type === "arrive" && /已结束|会话已结束/.test(msg)) {
        router.replace(`/finish/${sessionId}`);
        return;
      }
      setData(prev); // 回滚本地乐观更新（幂等键保留，重试复用同 tap_id）
      alert(msg);
    } finally {
      busy.current = false;
    }
  }

  if (error) {
    return (
      <main className="page">
        <p className="t-error t-body" style={{ marginBottom: 16 }}>
          加载失败：{error}
        </p>
        <button className="btn btn--primary btn--block" onClick={() => router.push("/")}>
          返回首页
        </button>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="page page--center">
        <p className="t-body t-muted t-center">加载中…</p>
      </main>
    );
  }

  const steps = buildSteps(data.legs);
  // —— 去学校 51 系：上车点动态覆盖（用户选择 > 已打点事件恢复 > 默认站）——
  const effSteps = applyBoardSteps(steps, data.legs, data.events, boardStation);
  const idx = currentStepIndex(effSteps, data.events);
  const step = effSteps[idx];
  const finished = idx >= steps.length || !!data.session.ended_at;
  // v0.7.0：当前阶段主题色（出门=将乘载具色；乘车=本段线路色；步行/到达无）
  const curLine = step?.lineColor ?? null;
  const curRoute = step?.routeOptions?.length ? step.routeOptions[0] : null;
  const curLabel = curRoute
    ? curRoute.startsWith("LRT-")
      ? lrtLabelOf(curRoute)
      : `${curRoute}路`
    : step?.quickKind === "minutes"
      ? "輕軌"
      : step?.quickKind === "stops"
        ? "巴士"
        : null;
  // 当前生效的上车站（chips 高亮用；null = 未选 = 默认站）
  const firstVehicle = data.legs.find((l) => l.leg_kind === "bus" || l.leg_kind === "lrt");
  const boardCands =
    (firstVehicle?.board_candidates?.length ?? 0) > 1 ? firstVehicle!.board_candidates! : null;
  const lastBoardEvt = [...data.events]
    .reverse()
    .find((e) => e.event_type === "depart" || e.event_type === "wait_start" || e.event_type === "board");
  const chosenBoard = boardCands
    ? boardStation ??
      (lastBoardEvt?.station_code && boardCands.includes(lastBoardEvt.station_code)
        ? lastBoardEvt.station_code
        : null)
    : null;
  // v0.12.2（需求 6）：行程进度条模型——按项目等分（上车步行 / 乘车各站 / 下车步行），
  // 由方案 legs + 站序表生成；events 回放实时推进（撤销/刷新恢复天然一致）
  const progressUnits = buildProgress(data.legs, data.routeStopsByRoute, {
    boardStation: chosenBoard,
    // v0.14.1：进度条按站等分同样按同场站名解析目标（26/50 分台各自正确）
    stationNames: data.stationNames,
  });
  const progressFilled = computeFilled(progressUnits, data.events);
  const stationName = (code?: string | null) =>
    code ? (data.stationNames[code] ?? code) : "";
  // sub 内嵌的站号替换为「站号 站名」（巴士）/「站名」（轻轨）
  const fullSub = (sub?: string, code?: string | null) => {
    if (!sub || !step?.stationCode) return sub;
    const full = stationName(code ?? step?.stationCode);
    const raw = code ?? step?.stationCode;
    if (!full || full === raw) return sub;
    return sub.split(raw).join(full);
  };

  // 等车阶段（已到站、待上车）
  const waiting = step?.eventType === "board";
  // 出门/走路阶段（出发前 或 已出门未到站）
  const departing =
    step?.eventType === "depart" || step?.eventType === "wait_start";
  // 巴士段出门/到站：打点后系统自动记录（提示文案，非操作项）
  const autoRecordStops = departing && step.quickKind === "stops";
  // 乘车阶段（已上车、待下车）
  const riding = step?.eventType === "alight";
  // 学校分区（需求 10）：离校 → 从哪个座走；抵校 → 到了哪个座
  const showFromZone = step?.eventType === "depart" && data.session.from_slug === "school";
  const showToZone = step?.eventType === "arrive" && data.session.to_slug === "school";

  // v0.15.0：轻轨段（站码与线路均为 LRT-*）→ 等车/出门显示时刻表报站卡（LrtEta）
  // 与巴士 LiveEta 同位置；换乘站多线只取本次将乘线路（决策 6），首项即本段主线路
  const isLrtStep =
    isLrtCode(step?.stationCode) &&
    !!step?.routeOptions?.length &&
    step.routeOptions!.some(isLrtCode);
  const effLrtRoute = step?.routeOptions?.find(isLrtCode) ?? null;

  // v0.10.0 A11：多候选线路段「乘哪一路」（chips 选中 > 会话已修正实乘线 > 首选项）
  // board 提交带实乘线 → 服务端把 route_code/dsat_dir 修正到实乘线（首个载具段）
  const isBoardRouteMulti =
    step?.eventType === "board" && (step.routeOptions?.length ?? 0) > 1 && step.quickKind === "stops";
  // v0.12.0：step?. 保护 —— arrive 打点后 idx 越界 step 为 undefined，而 routeChoices/
  // session.route_code 仍可能非空，此处无条件执行会读 step.routeOptions 崩溃
  // v0.14.2：只读当前载具段的槽位（无则 null → 走默认），换段后自动回默认
  const segChoice =
    step?.vehIndex != null ? (routeChoices[String(step.vehIndex)] ?? null) : null;
  const effRoute =
    segChoice && step?.routeOptions?.includes(segChoice)
      ? segChoice
      : data.session.route_code && step?.routeOptions?.includes(data.session.route_code)
        ? data.session.route_code
        : (step?.routeOptions?.[0] ?? null);

  /** 分区 chips（单选可取消；不选也不阻塞打点） */
  const renderZones = (question: string, value: string | null, onChange: (v: string | null) => void) => (
    <div className="card" style={{ padding: "12px 14px" }}>
      <p className="t-label" style={{ marginBottom: 8 }}>
        {question}
      </p>
      <div className="chip-row">
        {SCHOOL_ZONES.map((z) => (
          <button
            key={z.value}
            className={`chip${value === z.value ? " chip--on" : ""}`}
            onClick={() => onChange(value === z.value ? null : z.value)}
            aria-pressed={value === z.value}
          >
            {z.hint}
          </button>
        ))}
      </div>
      <p className="t-label t-muted" style={{ marginTop: 8 }}>
        用于按座区分的步行分组统计（可选）
      </p>
    </div>
  );

  // ===== 乘车进度推算（下一站 / 剩余站数）=====
  // 目标站解析（v0.14.1 起统一走 station-match.resolveRideDestIdx）：
  //   ① 循环线首尾同站码（25 路 M1/13 = seq1 起点 & seq50 终点）→ 沿行驶方向环距最近命中，
  //      避免「要下的终点关闸」被认成起点关闸（主人 2026-09-05 实测：接近终点显示还有 2 站）；
  //   ② 同场分台（26/50 分停莲花路停车场 T355/2 / T355/1，站名同为「蓮花路停車場」）→ 按站名
  //      聚合，取沿方向第一次到达该场站的那次停靠 —— 乘 50 时下车站自动落 T355/1、乘 26 落
  //      T355/2（主人 2026-09-06 确认按实际站台记录）。
  // 候选码的站名取自 timer 接口 stationNames（查不到时退回站码匹配）
  const destNameOf = (code: string) => data.stationNames[code] ?? null;

  type RideInfo = {
    routeCode: string;
    nextName: string;
    nextCode: string | null;
    remaining: number | null;
    upcoming: { name: string; isDest: boolean }[];
    /** 当前动态目标站（候选下车点推进：C688/2 → C690/x 收尾） */
    destName: string;
    destCode: string;
    /** 当前车逻辑位置（「途经」抑制决策卡用） */
    cur: number;
    /** 已停靠到非末位候选站 → 渲染「下车 / 途经」决策卡（途经=继续坐到末位总站） */
    decision: {
      code: string;
      name: string;
      continueCode: string;
      continueName: string;
    } | null;
    passedCount: number;
  };
  let rideInfo: RideInfo | null = null;
  if (riding && step.routeOptions) {
    // v0.10.0：乘车推进优先「实乘线」（A11 非首选线路也逐站正确）；无站序的选项跳过
    const fallbackRoute = step.routeOptions.find((r) => (data.routeStopsByRoute[r]?.length ?? 0) > 0);
    const routeCode =
      effRoute && (data.routeStopsByRoute[effRoute]?.length ?? 0) > 0
        ? effRoute
        : fallbackRoute;
    const stops = routeCode ? data.routeStopsByRoute[routeCode] : undefined;
    if (routeCode && stops && stops.length > 0) {
      const boardIdx = findStopIdx(stops, step.fromStationCode);
      // 本程已记的途经站数：最后一次 board 之后 station_arrive + station_pass 的总和
      const lastBoardSeq = [...data.events].reverse().find((e) => e.event_type === "board")?.seq ?? -1;
      const posEvts = data.events.filter(
        (e) =>
          (e.event_type === "station_arrive" || e.event_type === "station_pass") &&
          (e.seq ?? 0) > lastBoardSeq,
      );
      const passed = posEvts.length;
      // 动态下车目标序列：alight_candidates（末位=强制终点）；无则固定目标 = 本站(to_station)
      const cands = step.alightCandidates?.length
        ? step.alightCandidates
        : step.stationCode
          ? [step.stationCode]
          : [];
      // 候选下车点解析（v0.14.1）：resolveRideDestIdx 同时覆盖「循环线首尾同码折返」
      // 与「同场分台同名」（26/50 乘哪路下哪台）；anchor<0 时自动退回首命中语义
      // ⚠️ code 必须改写为「实际停靠台码」（stops[idx].code）：同场分台场景目标 T355/2
      //    经站名聚合命中 T355/1 停靠位时，若保留原始候选码 T355/2，会出现显示
      //    「T355/1 蓮花路停車場」而入库/决策却记 T355/2 的错位（2026-09-06 实测抓到）
      const candPos = cands
        .map((c) => ({ code: c, idx: resolveRideDestIdx(stops, c, boardIdx, destNameOf) }))
        .filter((c) => c.idx >= 0)
        .map((c) => ({ code: stops[c.idx]?.code ?? c.code, idx: c.idx }))
        .sort((a, b) => a.idx - b.idx);
      if (boardIdx >= 0 && candPos.length > 0) {
        const n = stops.length;
        const cur = (boardIdx + passed) % n; // 当前逻辑位置（循环线自动 wrap）
        const nextIdx = (cur + 1) % n;
        const k = candPos.findIndex((c) => c.idx === cur); // 是否正站在某候选站
        const candHere = k >= 0 ? candPos[k] : undefined;
        const isTerminal = k >= 0 && k === candPos.length - 1;
        // 到站决策：仅当「实际停靠」(station_arrive) 于非末位候选站时询问下车/途经；
        // 甩站(station_pass)经过候选 = 隐含途经，不打断；途经后同站不再重复问（continueFrom）
        const lastStopEvt = posEvts[posEvts.length - 1];
        const showDecision =
          !!candHere &&
          !isTerminal &&
          lastStopEvt?.event_type === "station_arrive" &&
          stationCodesEq(lastStopEvt.station_code, candHere.code) &&
          continueFrom !== cur;
        // 目标：决策态 = 已到的候选；否则 = 站序上第一个在 cur 之后的候选；无则末位收尾
        const lastCand = candPos[candPos.length - 1];
        const nextCand = candPos.find((c) => c.idx > cur);
        const dest = showDecision && candHere ? candHere : nextCand ?? lastCand;
        const destIdx = dest.idx;
        const remaining = showDecision ? 0 : (destIdx - cur + n) % n;
        const destName = stops[destIdx].name;
        // 接下来最多 4 站（含目标站高亮）
        const upcomingCount = Math.min(remaining > 0 ? remaining : 4, 4);
        const upcoming: { name: string; isDest: boolean }[] = [];
        for (let j = 1; j <= upcomingCount; j++) {
          const s = stops[(cur + j) % n];
          upcoming.push({ name: s.name, isDest: (cur + j) % n === destIdx });
        }
        rideInfo = {
          routeCode,
          nextName: stops[nextIdx].name,
          nextCode: stops[nextIdx].code,
          remaining,
          upcoming,
          destName,
          destCode: dest.code,
          cur,
          decision: showDecision && candHere
            ? {
                code: candHere.code,
                name: destName,
                continueCode: lastCand.code,
                continueName: stops[lastCand.idx].name,
              }
            : null,
          passedCount: passed,
        };
      }
    }
  }

  const recentEvents = [...data.events].reverse().slice(0, 4);
  // 动态下车决策中（已到非末位候选站）：主按钮替换为「下车 / 途经」决策卡
  const ridingDecision = riding && !!rideInfo?.decision;

  // ===== v0.12.0：步行暂停 / 最近事件撤销 =====
  // 暂停态由顶部 pausedNow 派生（events 最后一条是 pause）
  const lastEvent = data.events[data.events.length - 1];
  const paused = pausedNow;
  // 暂停入口：仅步行相关步骤（wait_start=走去车站途中 / arrive=下车走向目的地；含多段换乘步行的第二程 wait_start）
  // 且当前处于该步骤未打点（canPause 在整步替换暂停卡时不展示）
  const isWalkingStep =
    step?.eventType === "wait_start" || step?.eventType === "arrive";
  const canPause = !finished && !paused && isWalkingStep && !ridingDecision;
  // 暂停起始时刻（时长展示用；recorded_at 为 ISO）
  const pauseSince =
    paused && lastEvent ? new Date(lastEvent.recorded_at).getTime() : 0;
  // 可撤销：timeline 最新一条、真实入库(id>0)、非瞬态控制事件（pause/resume 服务端拒撤）
  const undoableLatest =
    recentEvents[0] &&
    Number(recentEvents[0].id) > 0 &&
    !UNDO_EXCLUDED.has(recentEvents[0].event_type)
      ? { ...recentEvents[0], id: Number(recentEvents[0].id) }
      : null;

  /** v0.12.0 撤销：真实弹窗确认后调 undo API；本地移除事件并按响应回滚会话级副作用 */
  async function doUndo(target: { id: number; event_type: string; station_code: string | null }) {
    if (undoing) return;
    setUndoing(true);
    try {
      const res = await fetch(`/api/timer/${sessionId}/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: target.id }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        missed_decremented?: boolean;
        resurrected?: boolean;
      };
      if (!res.ok) throw new Error(body.error ?? "撤销失败");
      setUndoTarget(null);
      setData((prev) => {
        if (!prev) return prev;
        const events = prev.events.filter((e) => Number(e.id) !== Number(target.id));
        let session = prev.session;
        if (body.missed_decremented)
          session = { ...session, missed_count: Math.max(0, session.missed_count - 1) };
        if (body.resurrected)
          session = { ...session, ended_at: null, total_minutes: null };
        return { ...prev, events, session };
      });
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setUndoing(false);
    }
  }

  return (
    <main className="page page--lock">
      <header style={{ marginBottom: 16 }}>
        {/* v0.12.2（需求 6）：主题色横条 → 行程进度条（按项目等分 + 载具主题色渐变） */}
        <JourneyProgress units={progressUnits} filled={progressFilled} />
        <p
          className="t-label t-muted"
          style={{
            marginBottom: 6,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>{data.session.summary}</span>
          {curLine && curLabel && (
            <span className="route-chip" style={{ background: curLine, color: textOn(curLine) }}>
              {curLabel}
            </span>
          )}
        </p>
        <p className="t-label t-muted">
          第 {Math.min(idx + 1, steps.length)} / {steps.length} 步
          {data.session.missed_count > 0 && (
            <span className="t-error"> · 没挤上 ×{data.session.missed_count}</span>
          )}
          {data.session.is_test && (
            <span
              className="t-label"
              style={{
                marginLeft: 6,
                padding: "1px 8px",
                borderRadius: 999,
                background: "var(--surface-dim, #eef1f4)",
              }}
            >
              🧪 测试中（不计统计）
            </span>
          )}
        </p>
      </header>

      {/* v0.12.2（需求 7）：行程区独立滚动容器——页面整体锁定防误点；
          内容适配时不滚动，超高时才允许在容器内主动滚动 */}
      <div className="tmr-scroll">
      {finished ? (
        <p className="t-body t-muted t-center" style={{ margin: "auto 0" }}>
          已完成，正在进入结束页…
        </p>
      ) : (
        <div
          key={idx}
          className="anim-fade-up"
          style={{
            marginTop: "auto",
            marginBottom: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {/* v0.12.0：暂停态整步覆盖为「已暂停」卡 + 继续（避免暂停中误触其它打点） */}
          {paused ? (
            <div className="card" style={{ padding: 22, textAlign: "center" }}>
              <p style={{ fontSize: 36, margin: 0 }}>⏸</p>
              <p className="h-title" style={{ margin: "8px 0 4px" }}>
                计时已暂停
              </p>
              <p className="t-label t-muted" style={{ marginBottom: 12, lineHeight: 1.6 }}>
                暂停时间不计入总时长
                {pauseSince > 0 && (
                  <>
                    <br />
                    已暂停{" "}
                    {(() => {
                      const s = Math.max(0, Math.floor((Date.now() - pauseSince) / 1000));
                      const m = Math.floor(s / 60);
                      return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
                    })()}
                  </>
                )}
              </p>
              <button
                className="btn btn--primary btn--lg btn--block"
                onClick={() => postEvent("resume")}
              >
                ▶ 继续
              </button>
            </div>
          ) : (
            <>
          {/* 报站卡（同一卡槽）：巴士 = LiveEta（DSAT 实时车距）；轻轨 = LrtEta（时刻表本地算，v0.15.0）。
              需求 7：无自动轮询，打点后经 refreshKey 刷新 */}
          {(departing || waiting) &&
            (isLrtStep
              ? step.stationCode &&
                effLrtRoute && (
                  <LrtEta
                    station={step.stationCode}
                    route={effLrtRoute}
                    dest={step.destStationCode}
                    refreshKey={etaTick}
                    onRemainChange={(ms) => {
                      lrtRemainMs.current = ms;
                    }}
                  />
                )
              : step.quickKind === "stops" &&
                (step.routeOptions?.length ?? 0) > 0 &&
                step.stationCode && (
                  <LiveEta
                    station={step.stationCode}
                    routes={step.routeOptions!}
                    dir={data.session.dsat_dir ?? "0"}
                    dest={step.destStationCode}
                    refreshKey={etaTick}
                  />
                ))}

          {/* 巴士段：打点后系统自动记录车距（无需手动选择） */}
          {autoRecordStops && (
            <p className="t-label t-muted t-center">⚡ 点下方按钮后将自动记录当时车距</p>
          )}

          {/* 学校分区：离校 → 从哪个座走 / 抵校 → 到了哪个座（需求 10） */}
          {showFromZone && renderZones("从哪个座出发？", fromZone, setFromZone)}
          {showToZone && renderZones("到了哪个座？", toZone, setToZone)}

          {/* 上车点选择（去学校 51 系：总站 或 C689/2 沿途站；出门/等车时可选） */}
          {boardCands && (departing || waiting) && (
            <div className="card" style={{ padding: "12px 14px" }}>
              <p className="t-label" style={{ marginBottom: 8 }}>
                在哪里上车？
              </p>
              <div className="chip-row">
                {boardCands.map((c) => (
                  <button
                    key={c}
                    className={`chip${chosenBoard === c ? " chip--on" : ""}`}
                    aria-pressed={chosenBoard === c}
                    onClick={() => setBoardStation(boardStation === c ? null : c)}
                  >
                    {stationName(c)}
                  </button>
                ))}
              </div>
              <p className="t-label t-muted" style={{ marginTop: 8 }}>
                {chosenBoard
                  ? `在「${stationName(chosenBoard)}」上车`
                  : `默认「${stationName(boardCands[0])}」上车，点其它站可改乘`}
              </p>
            </div>
          )}

          {/* v0.10.0 A11：多候选线路段——上车前确认「乘哪一路」（实乘线决定记录/乘车推进/车辆抓取） */}
          {isBoardRouteMulti && step.routeOptions && (
            <div className="card" style={{ padding: "12px 14px" }}>
              <p className="t-label" style={{ marginBottom: 8 }}>
                乘哪一路？
              </p>
              <div className="chip-row">
                {step.routeOptions.map((r) => (
                  <button
                    key={r}
                    className={`chip${effRoute === r ? " chip--on" : ""}`}
                    aria-pressed={effRoute === r}
                    onClick={() => {
                      if (step.vehIndex == null) return;
                      const k = String(step.vehIndex);
                      setRouteChoices((prev) => ({ ...prev, [k]: effRoute === r ? null : r }));
                    }}
                  >
                    {r.startsWith("LRT-") ? lrtLabelOf(r) : `${r} 路`}
                  </button>
                ))}
              </div>
              <p className="t-label t-muted" style={{ marginTop: 8 }}>
                {effRoute
                  ? `按「${effRoute.startsWith("LRT-") ? lrtLabelOf(effRoute) : `${effRoute} 路`}」记录本次乘车`
                  : `默认「${step.routeOptions[0]} 路」`}
              </p>
            </div>
          )}

          {/* 动态下车决策中：主「下车」替换为决策卡的两个按钮，避免误按到总站 */}
          {!ridingDecision && (
            <>
              {/* v0.14.1：乘车中已按实乘线算出动态目标台（乘 50 落 T355/1）时隐藏静态 sub，
                  避免步骤文案「目標站：T355/2…」（卡片默认台）与动态下车站并陈误导 */}
              {!(riding && rideInfo) && step.sub && (
                <p className="t-body" style={{ margin: 0 }}>{fullSub(step.sub)}</p>
              )}
              <button
                className="btn btn--primary btn--lg btn--block"
                onClick={() =>
                  postEvent(step.eventType, {
                    // v0.14.1：下车按实际停靠台（乘 50 落 T355/1、乘 26 落 T355/2）记录，
                    // 而非卡片默认台码；非乘车步骤仍用步骤站码
                    station_code:
                      (step.eventType === "alight" && rideInfo
                        ? rideInfo.destCode
                        : step.stationCode) ?? null,
                    ...(step.eventType === "depart" && fromZone ? { from_zone: fromZone } : {}),
                    ...(step.eventType === "arrive" && toZone ? { to_zone: toZone } : {}),
                    // v0.10.0 A11：多候选段 board 提交实乘线 → 服务端修正 route_code/dsat_dir
                    ...(step.eventType === "board" && isBoardRouteMulti && effRoute
                      ? { route: effRoute }
                      : {}),
                  })
                }
              >
                {step.label}
              </button>
            </>
          )}

          {/* v0.12.0：步行暂停入口（wait_start=走向车站途中 / arrive=下车走向目的地；不抢占主按钮） */}
          {canPause && (
            <button
              className="btn btn--outline"
              style={{ alignSelf: "center", maxWidth: 260 }}
              onClick={() => postEvent("pause")}
            >
              ⏸ 暂停（临时离开）
            </button>
          )}

          {/* 等车阶段：没挤上 */}
          {waiting && (
            <button
              className="btn btn--text t-error"
              style={{ alignSelf: "center" }}
              onClick={() => postEvent("missed")}
            >
              没挤上车（继续等下一趟）
            </button>
          )}

          {/* 乘车阶段：下一站提示 + 途经站打点；动态下车到候选站出「下车 / 途经」决策卡 */}
          {riding && rideInfo && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {rideInfo.decision ? (
                <>
                  <p className="t-label t-muted">
                    乘车中 · {rideRouteLabel(rideInfo.routeCode)} · 已到 {rideInfo.decision.name}
                  </p>
                  <div className="card" style={{ padding: 14 }}>
                    <p className="h-headline" style={{ margin: 0 }}>
                      🚏 到 {rideInfo.decision.name} 了
                    </p>
                    <p className="t-body t-muted" style={{ marginTop: 6 }}>
                      要在这里下车，还是继续坐到总站？
                    </p>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                        marginTop: 12,
                      }}
                    >
                      <button
                        className="btn btn--primary btn--lg btn--block"
                        onClick={() =>
                          postEvent("alight", { station_code: rideInfo!.decision!.code })
                        }
                      >
                        就在此下车
                      </button>
                      <button
                        className="btn btn--outline btn--block"
                        onClick={() => setContinueFrom(rideInfo!.cur)}
                      >
                        途经 · 坐到 {rideInfo.decision.continueName}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <p className="t-label t-muted">
                    乘车中 · {rideRouteLabel(rideInfo.routeCode)}
                    {rideInfo.remaining !== null &&
                      (rideInfo.remaining > 0
                        ? ` · 还剩 ${rideInfo.remaining} 站到「${rideInfo.destName}」`
                        : " · 已到站")}
                  </p>
                  {rideInfo.remaining !== null && rideInfo.remaining > 0 ? (
                    <>
                      <p className="h-headline" style={{ margin: 0 }}>
                        下一站：{rideInfo.nextName}
                      </p>
                      {rideInfo.upcoming.length > 1 && (
                        <p className="t-label t-muted" style={{ lineHeight: 1.7 }}>
                          之后：
                          {rideInfo.upcoming.slice(1).map((u, i) => (
                            <span key={i} className={u.isDest ? "t-accent t-strong" : undefined}>
                              {u.name}
                              {i < rideInfo.upcoming.length - 2 ? " → " : ""}
                            </span>
                          ))}
                        </p>
                      )}
                      {/* 两按钮：停靠到站 / 甩站未停（都入库并推进剩余站数） */}
                      <button
                        className="btn btn--tonal btn--block"
                        onClick={() =>
                          postEvent("station_arrive", {
                            station_code: rideInfo?.nextCode ?? step.stationCode ?? null,
                          })
                        }
                      >
                        ✓ 停靠 · 记一站
                      </button>
                      <button
                        className="btn btn--outline btn--block"
                        onClick={() =>
                          postEvent("station_pass", {
                            station_code: rideInfo?.nextCode ?? step.stationCode ?? null,
                          })
                        }
                      >
                        ↷ 甩站没停 · 也记一站
                      </button>
                    </>
                  ) : (
                    <p className="t-label t-muted" style={{ lineHeight: 1.7 }}>
                      已到站：{rideInfo.destName} —— 点「下车」结束乘车
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          {riding && !rideInfo && <p className="t-body t-muted">{fullSub(step.sub)}</p>}
            </>
          )}
        </div>
      )}

      {/* 最近事件，校验有没有按错（v0.12.0：最新一条可撤销，真实确认弹窗后删库回撤） */}
      <footer className="timeline">
        {recentEvents.map((e) => (
          <div key={e.id} className="timeline-item">
            <span className="timeline-dot" />
            <span>
              {new Date(e.recorded_at).toLocaleTimeString("zh-CN", { timeZone: "Asia/Macau" })}{" "}
              {EVENT_LABELS[e.event_type] ?? e.event_type}
              {e.station_code ? `（${stationName(e.station_code)}）` : ""}
            </span>
            {undoableLatest && Number(undoableLatest.id) === Number(e.id) && (
              <button
                className="btn--undo"
                onClick={() => setUndoTarget(undoableLatest)}
                disabled={undoing}
              >
                撤销
              </button>
            )}
          </div>
        ))}
      </footer>
      </div>

      {/* v0.12.0：撤销确认弹窗（真实确认，不点撤销直接撤） */}
      {undoTarget && (
        <div className="dialog-backdrop" onClick={() => !undoing && setUndoTarget(null)}>
          <div className="dialog-card" role="dialog" aria-modal="true">
            <p className="h-title" style={{ margin: 0 }}>
              撤销「{EVENT_LABELS[undoTarget.event_type] ?? undoTarget.event_type}
              {undoTarget.station_code ? ` · ${stationName(undoTarget.station_code)}` : ""}」？
            </p>
            <p className="t-body t-muted" style={{ margin: "10px 0 18px", lineHeight: 1.6 }}>
              将从记录中删除这一条（仅限最近一次，可连续撤销）。
              <br />
              误记了想重打？撤销后按原步骤重新点即可。
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                className="btn btn--tonal"
                style={{ flex: 1 }}
                onClick={() => setUndoTarget(null)}
                disabled={undoing}
              >
                取消
              </button>
              <button
                className="btn btn--danger-outline"
                style={{ flex: 1 }}
                onClick={() => doUndo(undoTarget)}
                disabled={undoing}
              >
                {undoing ? "撤销中…" : "确认撤销"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
