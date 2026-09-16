"use client";

/**
 * 自由记站（v0.19.0）：独立数据采集——平时坐车时逐站实测行车时长
 * 模式：setup（选线路/选站点 → 方向 → 上车站）→ riding（站序推进逐站打点）→ summary
 * 与乘车计时完全隔离（free_rides / free_ride_events 表，不入 stats/records）。
 */
import RouteStack from "./RouteStack";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FREE_CROWD as CROWD, freeLineLabel } from "@/lib/free-shared";
import type { FreeStop, RideDetail, RideEventRow } from "@/lib/free-shared";

interface RouteOpt {
  code: string;
  kind: string;
  color: string | null;
  dirs: { dir: string; label: string }[];
}
interface StationOpt {
  code: string;
  name: string;
  kind: string;
}
const EVENT_TC: Record<string, string> = {
  board: "上车",
  stop_arrive: "到站",
  stop_pass: "甩站",
  stop_skip: "忘记",
  alight: "下车",
};
const kindBadge = (kind: string) =>
  kind === "lrt" ? (
    <span className="chip chip--on" style={{ padding: "0 8px", minHeight: 20, fontSize: 12 }}>
      🚈
    </span>
  ) : (
    <span className="chip" style={{ padding: "0 8px", minHeight: 20, fontSize: 12 }}>
      🚌
    </span>
  );
const lrtName = (name: string) => name.replace(/站$/, "");

/** 站区码三段式定位：站点方式传主码（C688），站序里可能是带后缀的分台码（C688/2） */
function findStationIdx(list: FreeStop[], code: string): number {
  return list.findIndex(
    (s) => s.code === code || s.code.startsWith(code + "/") || code.startsWith(s.code + "/"),
  );
}

/** 站点搜索匹配（code 或 站名） */
function matchStation(s: StationOpt, kw: string): boolean {
  if (!kw) return true;
  const k = kw.trim().toLowerCase();
  return (
    s.code.toLowerCase().includes(k) ||
    s.name.toLowerCase().includes(k) ||
    lrtName(s.name).toLowerCase().includes(k)
  );
}

type Stage = "setup" | "riding" | "done";

export default function FreeRideClient({ restoreRideId }: { restoreRideId: number | null }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>(restoreRideId ? "riding" : "setup");
  const [error, setError] = useState<string | null>(null);

  // —— setup 状态 ——
  const [mode, setMode] = useState<"route" | "station">("route");
  const [routes, setRoutes] = useState<RouteOpt[] | null>(null);
  const [routeKw, setRouteKw] = useState("");
  const [stations, setStations] = useState<StationOpt[] | null>(null);
  // ★ v1.1.7：站点列表的加载/失败态（原先失败被静默吞掉 → 白屏）
  const [stationsLoading, setStationsLoading] = useState(false);
  const [stationsErr, setStationsErr] = useState<string | null>(null);
  const [selRoute, setSelRoute] = useState<RouteOpt | null>(null); // 已选线路
  const [selDir, setSelDir] = useState<string | null>(null);
  const [selDirLabel, setSelDirLabel] = useState<string>("");
  const [stops, setStops] = useState<FreeStop[]>([]); // 该方向站序
  const [stopKw, setStopKw] = useState("");
  const [boardCode, setBoardCode] = useState<string | null>(null);
  // 站点模式：已选站点 → 该站线路
  const [selStation, setSelStation] = useState<StationOpt | null>(null);
  const [stationRoutes, setStationRoutes] = useState<
    { code: string; kind: string; color: string | null; dirs: string[] }[] | null
  >(null);
  const [stationKw, setStationKw] = useState("");

  // —— riding 状态 ——
  const [rideId, setRideId] = useState<number | null>(restoreRideId);
  const [ride, setRide] = useState<{
    route_code: string;
    dsat_dir: string;
    board_station: string | null;
    vehicle_plate: string | null;
    vehicle_code: string | null;
    crowd_level: number | null;
    started_at: string;
  } | null>(null);
  const [rideStops, setRideStops] = useState<FreeStop[]>([]);
  const [rideDirLabel, setRideDirLabel] = useState("");
  const [xCode, setXCode] = useState<string | null>(null); // 当前提示站
  const [elapsedMs, setElapsedMs] = useState(0);
  const [busy, setBusy] = useState(false);
  // 拥挤度
  const [crowdDraft, setCrowdDraft] = useState<number | null>(null);
  const [crowdEdit, setCrowdEdit] = useState(false);
  const [crowdBusy, setCrowdBusy] = useState(false);
  const [rideColor, setRideColor] = useState<string | null>(null);
  // v0.22.0：本程已打的点（riding 页展示 + 撤销最近一条）
  const [rideEvents, setRideEvents] = useState<RideEventRow[]>([]);
  const [undoing, setUndoing] = useState(false);

  // —— 汇总 ——
  const [detail, setDetail] = useState<{
    ride: RideDetail;
    events: RideEventRow[];
    nameOf: (code: string | null) => string;
    relSecs: (number | null)[]; // events 中每个「到站」相对上一「到站」的秒
  } | null>(null);

  // ★ v1.1.7：站点列表加载抽成具名函数 —— 供「重試」按钮复用。
  //   原先这里是 `.catch(() => {})` —— 请求失败被**静默吞掉**，
  //   而选站列表既无加载态也无空态 → 用户看到一片空白，不知道是坏了还是没数据。
  const loadStations = useCallback(async () => {
    setStationsLoading(true);
    setStationsErr(null);
    try {
      const d = (await (await fetch("/api/free/stations", { cache: "no-store" })).json()) as {
        ok: boolean;
        stations?: StationOpt[];
        error?: string;
      };
      if (d.ok && d.stations) setStations(d.stations);
      else setStationsErr(d.error ?? "站点列表加载失败");
    } catch {
      setStationsErr("站点列表加载失败（网络异常）");
    } finally {
      setStationsLoading(false);
    }
  }, []);

  // —— 首次加载选择数据 ——
  useEffect(() => {
    if (!routes) {
      fetch("/api/free/options", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (d.ok) setRoutes(d.routes);
          else setError(d.error);
        })
        .catch(() => setError("选项加载失败"));
    }
    if (!stations) void loadStations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 恢复进行中的会话（refresh 后回到 riding）——
  useEffect(() => {
    if (!restoreRideId) return;
    (async () => {
      const d = (await (await fetch(`/api/free/${restoreRideId}`, { cache: "no-store" })).json()) as {
        ok: boolean;
        ride?: RideDetail;
        events?: RideEventRow[];
      };
      if (!d.ok || !d.ride) return;
      if (d.ride.ended_at) {
        await finishLoad(restoreRideId);
        return;
      }
      const r = d.ride;
      setRide({
        route_code: r.route_code,
        dsat_dir: r.dsat_dir,
        board_station: r.board_station,
        vehicle_plate: r.vehicle_plate,
        vehicle_code: r.vehicle_code,
        crowd_level: r.crowd_level,
        started_at: r.started_at,
      });
      setRideId(restoreRideId);
      const stops = (await (await fetch(`/api/free/stops?route=${encodeURIComponent(r.route_code)}&dir=${r.dsat_dir}`, { cache: "no-store" })).json()).stops as FreeStop[];
      setRideStops(stops);
      const opts = (await (await fetch("/api/free/options", { cache: "no-store" })).json()) as { ok: boolean; routes?: RouteOpt[] };
      const ro = opts.routes?.find((x) => x.code === r.route_code);
      setRideColor(ro?.color ?? null);
      setRideDirLabel(ro?.dirs.find((dd) => dd.dir === r.dsat_dir)?.label ?? "");
      // v0.22.0：已打点事件回填（riding 页「本程已记」+ 撤销）
      setRideEvents(d.events ?? []);
      // 计算当前推进
      const passed = (d.events ?? []).filter(
        (e) => e.event_type !== "board" && e.event_type !== "alight",
      ).length;
      const bi = stops.findIndex((s) => s.code === r.board_station);
      if (bi >= 0 && stops.length) {
        setXCode(stops[(bi + passed + 1) % stops.length].code);
      }
      setStage("riding");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreRideId]);

  async function finishLoad(id: number) {
    const d = (await (await fetch(`/api/free/${id}`, { cache: "no-store" })).json()) as {
      ok: boolean;
      ride?: RideDetail;
      events?: RideEventRow[];
    };
    if (!d.ok || !d.ride) return;
    const evs = d.events ?? [];
    const stops = rideStops.length
      ? rideStops
      : ((await (await fetch(`/api/free/stops?route=${encodeURIComponent(d.ride.route_code)}&dir=${d.ride.dsat_dir}`, { cache: "no-store" })).json()).stops as FreeStop[]);
    const nameOf = (code: string | null) => {
      const st = stops.find((s) => s.code === code);
      return st ? st.name : code ?? "—";
    };
    // 相邻「到站」间隔秒（board 到第一站到站也计入；甩站/忘记不算）
    const rel: (number | null)[] = [];
    let lastArriveAt: number | null = null;
    for (const e of evs) {
      const ms = new Date(e.recorded_at).getTime();
      if (e.event_type === "stop_arrive" || e.event_type === "board") {
        rel.push(lastArriveAt !== null ? Math.round((ms - lastArriveAt) / 1000) : null);
        lastArriveAt = ms;
      } else {
        rel.push(null);
      }
    }
    // v0.22.0：站序与事件回填到 riding 级 state——「撤销下车·继续记录」要从 done 退回 riding
    setRideStops(stops);
    setRideEvents(evs);
    setDetail({ ride: d.ride, events: evs, nameOf, relSecs: rel });
    setStage("done");
  }

  // ================= setup：选方向 → 选上车站 =================
  const pickDir = async (r: RouteOpt, dir: string) => {
    setSelRoute(r);
    setSelDir(dir);
    setSelDirLabel(r.dirs.find((d) => d.dir === dir)?.label ?? "");
    const d = (await (await fetch(`/api/free/stops?route=${encodeURIComponent(r.code)}&dir=${dir}`, { cache: "no-store" })).json()) as { ok: boolean; stops?: FreeStop[] };
    setStops(d.stops ?? []);
    setBoardCode(null);
  };
  const resetSetup = () => {
    setSelRoute(null);
    setSelDir(null);
    setStops([]);
    setBoardCode(null);
    setSelStation(null);
    setStationRoutes(null);
    setStopKw("");
    setStationKw("");
  };

  /**
   * v0.22.0：启动采集（「按线路选」与「按站点选」共用）。
   * 参数全部显式传入 —— setState 是异步的，站点方式「选完线路直接开始」
   * 若在闭包里读 state 会拿到旧值（这正是此前按站点选打不开的同类问题）。
   */
  const beginRide = async (p: {
    route: string;
    dir: string;
    board: string;
    dirLabel: string;
    color: string | null;
    stopList: FreeStop[];
  }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const d = (await (
        await fetch("/api/free/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ route: p.route, dir: p.dir, boardStation: p.board }),
        })
      ).json()) as {
        ok: boolean;
        id?: number;
        error?: string;
        vehiclePlate?: string | null;
        boardEventId?: number;
        startedAt?: string;
      };
      if (!d.ok || !d.id) {
        setError(d.error ?? "启动失败");
        return;
      }
      const startedAt = d.startedAt ?? new Date().toISOString();
      // 上车站按站区码三段式定位：站点方式传的是主码（C688），站序里可能是分台码（C688/2）
      const bi = findStationIdx(p.stopList, p.board);
      setRide({
        route_code: p.route,
        dsat_dir: p.dir,
        board_station: p.board,
        vehicle_plate: d.vehiclePlate ?? null,
        vehicle_code: null,
        crowd_level: null,
        started_at: startedAt,
      });
      setRideId(d.id);
      setRideStops(p.stopList);
      setRideDirLabel(p.dirLabel);
      setRideColor(p.color);
      // 「本程已记」从上车那条开始（撤销按钮也随之立即可用）
      setRideEvents(
        d.boardEventId
          ? [
              {
                id: d.boardEventId,
                seq: 1,
                event_type: "board",
                station_code: p.board,
                recorded_at: startedAt,
              },
            ]
          : [],
      );
      if (bi >= 0 && p.stopList.length) setXCode(p.stopList[(bi + 1) % p.stopList.length].code);
      history.replaceState(null, "", `/free?ride=${d.id}`);
      setCrowdDraft(null);
      setCrowdEdit(false);
      setStage("riding");
    } catch {
      setError("启动失败");
    } finally {
      setBusy(false);
    }
  };

  const startRide = async () => {
    if (!selRoute || !selDir || !boardCode || busy) return;
    await beginRide({
      route: selRoute.code,
      dir: selDir,
      board: boardCode,
      dirLabel: selDirLabel,
      color: selRoute.color ?? null,
      stopList: stops,
    });
  };

  /**
   * v0.22.0：「按站点选」选完线路 → 直接开始。
   * 站点已确定就是上车站，无需再选一遍；多方向时由调用方先给 dir。
   * ⚠️ 此前只 setSelRoute/setSelDir，而站点方式的渲染条件只认 selStation →
   *    界面原地不动，表现为「点了没反应 / 打不开」。
   */
  const pickFromStation = async (
    r: { code: string; kind: string; color: string | null },
    dir: string,
  ) => {
    if (!selStation || busy) return;
    const board = selStation.code;
    // 方向 label：station-routes 只回 dir 值，label 需从线路选项补全
    let optList = routes;
    if (!optList) {
      try {
        const o = (await (await fetch("/api/free/options", { cache: "no-store" })).json()) as {
          ok: boolean;
          routes?: RouteOpt[];
        };
        optList = o.routes ?? null;
        if (optList) setRoutes(optList);
      } catch {
        /* 拿不到 label 不影响开始 */
      }
    }
    const dirLabel = optList?.find((x) => x.code === r.code)?.dirs.find((d) => d.dir === dir)?.label ?? "";
    const sd = (await (
      await fetch(`/api/free/stops?route=${encodeURIComponent(r.code)}&dir=${dir}`, { cache: "no-store" })
    ).json()) as { ok: boolean; stops?: FreeStop[] };
    const stopList = sd.stops ?? [];
    if (!stopList.length) {
      setError(`${r.code} 路该方向没有可用的站序`);
      return;
    }
    if (findStationIdx(stopList, board) < 0) {
      setError(`${r.code} 路该方向不经停「${selStation.name}」`);
      return;
    }
    await beginRide({ route: r.code, dir, board, dirLabel, color: r.color, stopList });
  };

  // ================= riding：逐站打点 =================
  // 已用时间（挂载/每点刷新起点；每秒 tick）
  useEffect(() => {
    if (stage !== "riding" || !ride) return;
    setElapsedMs(0);
    const tick = setInterval(() => setElapsedMs(Date.now() - new Date(ride.started_at).getTime()), 1000);
    return () => clearInterval(tick);
  }, [stage, ride?.started_at, ride]);

  const postEvent = async (type: "stop_arrive" | "stop_pass" | "stop_skip" | "alight") => {
    if (!rideId || busy || !xCode) return;
    setBusy(true);
    try {
      const station = xCode;
      const d = (await (
        await fetch(`/api/free/${rideId}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, station }),
        })
      ).json()) as {
        ok: boolean;
        ended?: boolean;
        totalMs?: number;
        error?: string;
        event_id?: number;
        seq?: number;
        recordedAt?: string;
      };
      if (!d.ok) {
        setError(d.error ?? "打点失败");
        return;
      }
      // v0.22.0：记录本地事件（riding 页「本程已记」与撤销依赖；event_id 来自服务端）
      if (d.event_id) {
        const row: RideEventRow = {
          id: d.event_id,
          seq: d.seq ?? rideEvents.length + 1,
          event_type: type,
          station_code: station,
          recorded_at: d.recordedAt ?? new Date().toISOString(),
        };
        setRideEvents((prev) => [...prev, row]);
      }
      if (d.ended) {
        history.replaceState(null, "", "/free");
        await finishLoad(rideId);
        return;
      }
      // 推进：xCode 沿站序到下一站（循环线 wrap）
      if (rideStops.length) {
        const xi = rideStops.findIndex((s) => s.code === xCode);
        setXCode(rideStops[(xi + 1) % rideStops.length].code);
      }
    } catch {
      setError("网络异常");
    } finally {
      setBusy(false);
    }
  };

  /**
   * v0.22.0：撤销最近一条打点。
   * 与通勤计时 /api/timer/[id]/undo 同口径——只能撤最新一条（可连续撤），
   * 撤完把提示站退回被撤的那一站，避免站序推进错位。
   */
  const undoLatest = async () => {
    if (!rideId || undoing) return;
    const last = rideEvents[rideEvents.length - 1];
    if (!last) return;
    if (
      !window.confirm(
        `撤销「${EVENT_TC[last.event_type] ?? last.event_type}（${rideName(last.station_code)}）」？`,
      )
    )
      return;
    setUndoing(true);
    setError(null);
    try {
      const res = await fetch(`/api/free/${rideId}/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: last.id }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? "撤销失败");
        return;
      }
      setRideEvents((prev) => prev.filter((e) => e.id !== last.id));
      if (last.station_code) setXCode(last.station_code);
    } catch {
      setError("网络异常");
    } finally {
      setUndoing(false);
    }
  };

  /**
   * v0.22.0：撤销「下车」—— 行程复活回 riding 继续打点（误触「在此下车」的补救）。
   * 服务端会把 ended_at / alight_station / total_ms 清空。
   */
  const undoAlight = async () => {
    if (!rideId || undoing || !detail) return;
    const last = detail.events[detail.events.length - 1];
    if (!last || last.event_type !== "alight") return;
    if (!window.confirm("撤销「下车」并继续记录？本趟将恢复为进行中。")) return;
    setUndoing(true);
    setError(null);
    try {
      const res = await fetch(`/api/free/${rideId}/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: last.id }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? "撤销失败");
        return;
      }
      // 从 ?ride= 直接进来的「已结束」行程，ride state 可能为空 → 用详情补上
      if (!ride) {
        setRide({
          route_code: detail.ride.route_code,
          dsat_dir: detail.ride.dsat_dir,
          board_station: detail.ride.board_station,
          vehicle_plate: detail.ride.vehicle_plate,
          vehicle_code: detail.ride.vehicle_code,
          crowd_level: detail.ride.crowd_level,
          started_at: detail.ride.started_at,
        });
      }
      setRideEvents(detail.events.slice(0, -1));
      setDetail(null);
      if (last.station_code) setXCode(last.station_code);
      history.replaceState(null, "", `/free?ride=${rideId}`);
      setStage("riding");
    } catch {
      setError("网络异常");
    } finally {
      setUndoing(false);
    }
  };

  const submitCrowd = async (level: number) => {
    if (!rideId || crowdBusy) return;
    setCrowdBusy(true);
    try {
      const d = (await (
        await fetch(`/api/free/${rideId}/crowd`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ level }),
        })
      ).json()) as { ok: boolean; error?: string };
      // ★ v1.1.7：原先只有 `if (d.ok)`、无 else、整函数无 catch →
      //   网络失败或后端报错时按「确认」**毫无反应**，用户以为已记录、实际丢了。
      if (d.ok) {
        setRide((p) => (p ? { ...p, crowd_level: level } : p));
        setCrowdDraft(null);
        setCrowdEdit(false);
      } else {
        setError(d.error ?? "拥挤度保存失败，请重试");
      }
    } catch {
      setError("拥挤度保存失败（网络异常），请重试");
    } finally {
      setCrowdBusy(false);
    }
  };

  /** riding / done 阶段站名查询（优先用本程站序，查不到退回站码） */
  const rideName = (code: string | null) =>
    code ? (rideStops.find((s) => s.code === code)?.name ?? code) : "—";

  const fmtClock = (iso: string) =>
    new Date(iso).toLocaleTimeString("zh-CN", { timeZone: "Asia/Macau", hour12: false });
  const fmtDur = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m} 分 ${String(s % 60).padStart(2, "0")} 秒`;
  };
  const fmtGap = (sec: number | null) =>
    sec === null ? "—" : sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}` : `${sec}s`;
  const isLrt = (code: string) => code.startsWith("LRT-");

  return (
    <main className="page">
      <header style={{ marginBottom: 14, width: "100%", padding: "0 2px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h1 className="h-headline" style={{ margin: 0 }}>
            ⏱ 自由记站
          </h1>
          <button
            className="btn btn--text btn--sm t-muted"
            style={{ marginLeft: "auto" }}
            onClick={() => router.push("/free/history")}
          >
            📋 采集记录
          </button>
        </div>
        <p className="t-label t-muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
          独立于通勤计时 · 实测「任意两站间行车时长」，供自动选线建模
        </p>
      </header>

      {/* ★ v1.1.7：错误横幅改成 **sticky**。
          原先它是页顶一个普通块：而打点按钮在页面下方，用户滚下去按按钮后
          失败提示出现在**看不见的页顶** → 以为已记录、实际丢了数据。
          现吸附在视口顶部（z-index 高于内容），并加 role="alert" 让读屏立刻播报。 */}
      {error && (
        <p
          className="t-error t-body"
          role="alert"
          style={{
            position: "sticky",
            top: 8,
            zIndex: 5,
            marginBottom: 10,
            padding: "8px 12px",
            borderRadius: 10,
            background: "var(--error-container)",
            color: "var(--on-error-container)",
          }}
        >
          {error}
        </p>
      )}

      {/* ==================== riding ==================== */}
      {stage === "riding" && ride && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div
            className="card"
            style={{ padding: "13px 14px", borderLeft: `4px solid ${rideColor ?? "var(--primary)"}` }}
          >
            <p className="t-label t-muted" style={{ lineHeight: 1.5 }}>
              {isLrt(ride.route_code) ? "🚈" : "🚌"}{" "}
              <RouteStack codes={[ride.route_code]} colorOf={() => rideColor ?? undefined} size="sm" />
              {rideDirLabel ? ` · ${rideDirLabel}` : ""}
              {ride.vehicle_plate ? ` · 车 ${ride.vehicle_plate}` : ""}
            </p>
            <p className="h-display" style={{ margin: "4px 0 0", fontVariantNumeric: "tabular-nums" }}>
              {fmtDur(elapsedMs)}
            </p>
            <p className="t-label t-muted">上车：{fmtClock(ride.started_at)}</p>
          </div>

          {/* 拥挤度（上车后记录本次采集的拥挤度，可改） */}
          {!crowdRecorded(ride) || crowdEdit ? (
            <div className="card" style={{ padding: "12px 14px" }}>
              <p className="t-label" style={{ marginBottom: 8 }}>
                这趟车挤吗？
              </p>
              <div className="chip-row">
                {CROWD.map((c) => (
                  <button
                    key={c.value}
                    className={`chip${crowdDraft === c.value ? " chip--on" : ""}`}
                    aria-pressed={crowdDraft === c.value}
                    onClick={() => setCrowdDraft(crowdDraft === c.value ? null : c.value)}
                  >
                    <span style={{ fontWeight: 700 }}>{c.label}</span>
                    <span style={{ fontSize: 11, opacity: 0.75, marginLeft: 4 }}>{c.hint}</span>
                  </button>
                ))}
              </div>
              <button
                className="btn btn--tonal btn--block"
                style={{ marginTop: 10 }}
                disabled={crowdDraft == null || crowdBusy}
                onClick={() => crowdDraft != null && submitCrowd(crowdDraft)}
              >
                {crowdBusy ? "记录中…" : "确认"}
              </button>
            </div>
          ) : (
            <p className="t-label t-muted" style={{ margin: 0 }}>
              已记录：{CROWD.find((c) => c.value === ride.crowd_level)?.label ?? "—"}
              <button
                className="btn--undo"
                style={{ marginLeft: 8 }}
                onClick={() => {
                  setCrowdDraft(ride.crowd_level);
                  setCrowdEdit(true);
                }}
              >
                修改
              </button>
            </p>
          )}

          {/* 下一站 + 打点按钮 */}
          <div className="card" style={{ padding: 14 }}>
            <p className="t-label t-muted" style={{ margin: 0 }}>
              下一站
            </p>
            <p
              className="h-headline"
              style={{
                margin: 0,
                lineHeight: 1.3,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {rideStops.find((s) => s.code === xCode)?.name ?? xCode}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
              <button
                className="btn btn--tonal btn--block"
                disabled={busy}
                onClick={() => postEvent("stop_arrive")}
              >
                ✓ 到站 · 记时刻（继续坐）
              </button>
              {!isLrt(ride.route_code) && (
                <button
                  className="btn btn--outline btn--block"
                  disabled={busy}
                  onClick={() => postEvent("stop_pass")}
                >
                  ↷ 甩站没停
                </button>
              )}
              <button
                className="btn btn--outline btn--block"
                style={{ alignSelf: "stretch" }}
                disabled={busy}
                onClick={() => postEvent("stop_skip")}
              >
                忘记打卡（已过站）
              </button>
              <button
                className="btn btn--primary btn--lg btn--block"
                disabled={busy}
                style={{ marginTop: 4 }}
                onClick={() => postEvent("alight")}
              >
                在此下车 · 结束采集
              </button>
            </div>
            <p className="t-label t-muted t-center" style={{ marginTop: 10 }}>
              在此站下车结束；不指定终点，可随时下车
            </p>
          </div>

          {/* v0.22.0：本程已记（逐条时刻 + 撤销最近一条）——此前 riding 页看不到已打的点 */}
          {rideEvents.length > 0 && (
            <div className="card" style={{ padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <p className="t-label t-muted" style={{ margin: 0 }}>
                  本程已记 {rideEvents.length} 点
                </p>
                <button
                  className="btn btn--danger-outline btn--sm"
                  style={{ marginLeft: "auto" }}
                  disabled={undoing || busy}
                  onClick={() => void undoLatest()}
                >
                  {undoing ? "撤销中…" : "撤销最近一条"}
                </button>
              </div>
              <div className="timeline">
                {[...rideEvents]
                  .reverse()
                  .slice(0, 6)
                  .map((e) => (
                    <div key={e.id} className="timeline-item">
                      <span className="timeline-dot" />
                      <span className={e.event_type === "stop_skip" ? "t-muted" : undefined}>
                        {e.event_type === "stop_skip"
                          ? "（无时刻） "
                          : `${fmtClock(e.recorded_at)} `}
                        {EVENT_TC[e.event_type] ?? e.event_type}（{rideName(e.station_code)}）
                      </span>
                    </div>
                  ))}
              </div>
              {rideEvents.length > 6 && (
                <p className="t-label t-muted" style={{ marginTop: 6 }}>
                  仅显示最近 6 点，共 {rideEvents.length} 点
                </p>
              )}
            </div>
          )}

          <button className="btn btn--text t-muted" onClick={() => router.push(`/free?ride=${rideId}`)} style={{ alignSelf: "center" }}>
            暂离（回来可继续）
          </button>
        </div>
      )}

      {/* ==================== done / summary ==================== */}
      {stage === "done" && detail && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card" style={{ padding: "13px 14px" }}>
            <p className="t-body" style={{ lineHeight: 1.5 }}>
              {isLrt(detail.ride.route_code) ? "🚈" : "🚌"}{" "}
              <RouteStack
                codes={[detail.ride.route_code]}
                colorOf={() => rideColor ?? undefined}
                size="sm"
              />
              <span className="t-muted">
                {" "}
                · {detail.ride.board_station ? detail.nameOf(detail.ride.board_station) : "?"}
                {" → "}
                {detail.ride.alight_station ? detail.nameOf(detail.ride.alight_station) : "?"}
              </span>
            </p>
            <p className="t-label t-muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
              总耗时{" "}
              {detail.ride.total_ms != null ? fmtDur(detail.ride.total_ms) : "—"}
              {detail.ride.vehicle_plate ? ` · 车 ${detail.ride.vehicle_plate}` : ""}
              {detail.ride.crowd_level != null
                ? ` · 拥挤度 ${CROWD.find((c) => c.value === detail.ride.crowd_level)?.label ?? "?"}`
                : ""}
            </p>
          </div>

          <p className="t-label t-muted" style={{ margin: "0 2px" }}>
            逐站实测（间隔 = 到站时刻差；甩站/忘记不计间隔）
          </p>
          <div className="timeline">
            {detail.events.map((e, i) => {
              const gap = e.event_type === "stop_arrive" ? detail.relSecs[i] : null;
              const isTime = e.event_type === "board" || e.event_type === "stop_arrive";
              return (
                <div key={e.id} className="timeline-item">
                  <span className="timeline-dot" />
                  <span className={isTime ? undefined : "t-muted"}>
                    {e.event_type === "stop_skip" ? "" : `${fmtClock(e.recorded_at)} `}
                    {EVENT_TC[e.event_type] ?? e.event_type}（{detail.nameOf(e.station_code)}）
                    {gap !== null && e.event_type === "stop_arrive" && ` · ${fmtGap(gap)}`}
                  </span>
                </div>
              );
            })}
          </div>

          {/* v0.22.0：误触「下车」的补救——撤销后回到 riding 继续记录 */}
          {detail.events[detail.events.length - 1]?.event_type === "alight" && (
            <button
              className="btn btn--danger-outline btn--block"
              disabled={undoing}
              onClick={() => void undoAlight()}
            >
              {undoing ? "撤销中…" : "撤销「下车」· 继续记录"}
            </button>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button
              className="btn btn--primary btn--block"
              style={{ flex: 1 }}
              onClick={() => {
                resetSetup();
                setDetail(null);
                setRideEvents([]);
                history.replaceState(null, "", "/free");
                setStage("setup");
              }}
            >
              再来一次
            </button>
            <button
              className="btn btn--outline btn--block"
              style={{ flex: 1 }}
              onClick={() => router.push("/")}
            >
              回首页
            </button>
          </div>
          <p className="t-label t-muted t-center" style={{ opacity: 0.75 }}>
            本次数据用于站间行车时长建模（独立采集，不计入通勤统计）
          </p>
        </div>
      )}

      {/* ==================== setup ==================== */}
      {stage === "setup" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="chip-row">
            <button
              className={`chip${mode === "route" ? " chip--on" : ""}`}
              onClick={() => {
                setMode("route");
                resetSetup();
              }}
            >
              🚌 按线路选
            </button>
            <button
              className={`chip${mode === "station" ? " chip--on" : ""}`}
              onClick={() => {
                setMode("station");
                resetSetup();
              }}
            >
              📍 按站点选
            </button>
          </div>

          {/* —— 路线方式 —— */}
          {mode === "route" && (
            <>
              {!selRoute ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {/* v0.21.0：全澳线路（~95 条）→ 搜索过滤 */}
                  <input
                    className="inp"
                    value={routeKw}
                    onChange={(e) => setRouteKw(e.target.value)}
                    placeholder="搜索线路（如 10、MT1、N6、氹仔）"
                    style={{ padding: "10px 12px", borderRadius: 10 }}
                  />
                  {!routes && <p className="t-body t-muted">加载中…</p>}
                  {(routes ?? [])
                    .filter((r) => {
                      const k = routeKw.trim().toLowerCase();
                      if (!k) return true;
                      const label = r.code.startsWith("LRT-") ? freeLineLabel(r.code) : r.code;
                      return (
                        r.code.toLowerCase().includes(k) ||
                        label.toLowerCase().includes(k) ||
                        r.dirs.some((d) => d.label.toLowerCase().includes(k))
                      );
                    })
                    .map((r) => (
                    <button
                      key={r.code}
                      className="card"
                      style={{
                        padding: "11px 13px",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        borderLeft: r.color ? `4px solid ${r.color}` : undefined,
                        textAlign: "left",
                      }}
                      onClick={() => {
                        // 方向多/单选方向
                        if (r.dirs.length <= 1) void pickDir(r, r.dirs[0]?.dir ?? "0");
                        else setSelRoute(r); // 进入方向选择态（渲染在下方）
                      }}
                    >
                      {kindBadge(r.kind)}
                      <RouteStack codes={[r.code]} colorOf={() => r.color ?? undefined} size="sm" />
                      <span className="t-label t-muted" style={{ marginLeft: "auto" }}>
                        {r.dirs.length} 方向
                      </span>
                    </button>
                    ))}
                </div>
              ) : !selDir ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <p className="t-label t-muted">选择方向</p>
                  {selRoute.dirs.map((d) => (
                    <button key={d.dir} className="btn btn--outline" onClick={() => void pickDir(selRoute, d.dir)}>
                      {d.label}
                    </button>
                  ))}
                  <button className="btn btn--text t-muted" onClick={() => setSelRoute(null)}>
                    返回线路
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* ★ v1.1.7：线路码/线路名统一用**主题色标签**（用户 2026-09-16：所有出现线路的地方都要是主题色标签）。
                      原先这里是纯文字「26A 路 · 往蓮花」，与全站其它位置的 RouteStack 标签口径不一致。 */}
                  <p className="t-body" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <RouteStack codes={[selRoute.code]} colorOf={() => selRoute.color ?? undefined} size="sm" />
                    <span className="t-muted">{selDirLabel}</span>
                  </p>
                  <input
                    className="inp"
                    value={stopKw}
                    onChange={(e) => setStopKw(e.target.value)}
                    placeholder="搜索上车站（站名 / 站号）"
                    style={{ padding: "10px 12px", borderRadius: 10 }}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 320, overflowY: "auto" }}>
                    {stops
                      .filter((s) => !stopKw || s.name.includes(stopKw.trim()) || s.code.includes(stopKw.trim().toUpperCase()))
                      .map((s) => (
                        <button
                          key={s.code}
                          className={`card${boardCode === s.code ? " card--sel" : ""}`}
                          // ★ v1.1.7：原 padding 9/12 → 卡片高仅 41px、行距 6px；
                          //   站点模式一次列 60~100 项，滚动中抬手极易选中**隔壁站**。
                          //   现撑到 48px + 行距 10px（配合 `.card--sel` 新增的选中底色，
                          //   选中状态也终于看得见了）。
                          style={{ padding: "12px 14px", minHeight: 48, textAlign: "left" }}
                          onClick={() => setBoardCode(s.code)}
                        >
                          {s.name}
                        </button>
                      ))}
                  </div>
                  <button
                    className="btn btn--primary btn--lg"
                    disabled={!boardCode || busy}
                    onClick={() => void startRide()}
                  >
                    {boardCode
                      ? `在「${stops.find((s) => s.code === boardCode)?.name ?? boardCode}」上车 · 开始`
                      : "请选择上车站"}
                  </button>
                  <button className="btn btn--text t-muted" onClick={() => { setSelRoute(null); setSelDir(null); setBoardCode(null); }}>
                    重新选择
                  </button>
                </div>
              )}
            </>
          )}

          {/* —— 站点方式 —— */}
          {mode === "station" && (
            <>
              {!selStation ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <input
                    className="inp"
                    value={stationKw}
                    onChange={(e) => setStationKw(e.target.value)}
                    placeholder="搜索站点（站名 / 站号，如 路环市区、C688）"
                    style={{ padding: "10px 12px", borderRadius: 10 }}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 420, overflowY: "auto" }}>
                    {/* ★ v1.1.7：补「加载中 / 加载失败 / 无匹配」三态。
                        原先 stations 为 null 时直接渲染空列表 → 用户看到**一片空白**，
                        分不清是还在加载、坏了、还是搜不到。 */}
                    {stationsLoading && !stations && (
                      <p className="t-label t-muted t-center" style={{ padding: "20px 0" }}>
                        正在載入站點列表…
                      </p>
                    )}
                    {stationsErr && !stations && (
                      <p className="t-error t-body t-center" role="alert" style={{ padding: "16px 0" }}>
                        {stationsErr}
                        <br />
                        <button
                          className="btn btn--outline btn--sm"
                          style={{ marginTop: 10 }}
                          onClick={() => {
                            setStationsErr(null);
                            void loadStations();
                          }}
                        >
                          重試
                        </button>
                      </p>
                    )}
                    {(stations ?? [])
                      .filter((s) => matchStation(s, stationKw))
                      .slice(0, stationKw ? 100 : 60)
                      .map((s) => (
                        <button
                          key={s.code}
                          className="card"
                          // ★ v1.1.7：与「按线路选」同一处理 —— 41px → 48px + 行距 10px，防滚动误选邻站
                          style={{ padding: "12px 14px", minHeight: 48, textAlign: "left", display: "flex", gap: 8, alignItems: "center" }}
                          onClick={() => {
                            setSelStation(s);
                            setStationRoutes(null);
                            fetch(`/api/free/station-routes?station=${encodeURIComponent(s.code)}`, { cache: "no-store" })
                              .then((r) => r.json())
                              .then((d) => d.ok && setStationRoutes(d.routes))
                              .catch(() => {});
                          }}
                        >
                          {s.kind === "lrt" ? "🚈" : "🚌"}
                          <span>{s.name}</span>
                        </button>
                      ))}
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <p className="t-body">
                    📍 {selStation.name}
                    <button className="btn btn--text t-muted" style={{ marginLeft: 8 }} onClick={() => setSelStation(null)}>
                      返回
                    </button>
                  </p>
                  <p className="t-label t-muted">
                    在{selStation.name}上车 · 选坐哪路（点线路即开始，多方向先选方向）
                  </p>
                  {!stationRoutes && <p className="t-body t-muted">加载该站线路…</p>}
                  {stationRoutes?.map((r) =>
                    r.dirs.length <= 1 ? (
                      <button
                        key={r.code}
                        className="card"
                        style={{
                          padding: "11px 13px",
                          display: "flex",
                          gap: 10,
                          alignItems: "center",
                          borderLeft: r.color ? `4px solid ${r.color}` : undefined,
                          textAlign: "left",
                        }}
                        onClick={() => void pickFromStation(r, r.dirs[0] ?? "0")}
                      >
                        {kindBadge(r.kind)}
                        {/* ★ v1.1.7：单方向分支原先也是纯文字，而紧邻的多方向分支（下方）已用 RouteStack
                            → 同一张卡两种样式，口径不一致。统一为主题色标签。 */}
                        <RouteStack codes={[r.code]} colorOf={() => r.color ?? undefined} size="sm" />
                      </button>
                    ) : (
                      <div key={r.code} className="card" style={{ padding: "11px 13px", borderLeft: r.color ? `4px solid ${r.color}` : undefined }}>
                        <p className="t-body t-strong" style={{ marginBottom: 6 }}>
                          {kindBadge(r.kind)}{" "}
                          <RouteStack codes={[r.code]} colorOf={() => r.color ?? undefined} size="sm" />
                        </p>
                        {r.dirs.map((dd) => {
                          const dl = (routes ?? [])
                            .find((x) => x.code === r.code)
                            ?.dirs.find((d) => d.dir === dd)?.label;
                          return (
                            <button
                              key={dd}
                              className="btn btn--outline btn--sm"
                              style={{ margin: "0 6px 6px 0" }}
                              disabled={busy}
                              onClick={() => void pickFromStation(r, dd)}
                            >
                              {dl ?? `方向 ${dd}`} · 坐这路
                            </button>
                          );
                        })}
                      </div>
                    ),
                  )}
                </div>
              )}
            </>
          )}

        </div>
      )}
    </main>
  );
}

function crowdRecorded(ride: { crowd_level: number | null }): boolean {
  return ride.crowd_level !== null;
}
