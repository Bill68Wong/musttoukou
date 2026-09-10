"use client";

/**
 * 自由记站（v0.19.0）：独立数据采集——平时坐车时逐站实测行车时长
 * 模式：setup（选线路/选站点 → 方向 → 上车站）→ riding（站序推进逐站打点）→ summary
 * 与乘车计时完全隔离（free_rides / free_ride_events 表，不入 stats/records）。
 */
import RouteStack from "./RouteStack";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { freeLineLabel } from "@/lib/free-shared";

interface FreeStop {
  seq: number;
  code: string;
  name: string;
}
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
interface RideDetail {
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
interface RideEventRow {
  id: number;
  seq: number;
  event_type: "board" | "stop_arrive" | "stop_pass" | "stop_skip" | "alight";
  station_code: string | null;
  recorded_at: string;
}

const CROWD = [
  { value: 0, label: "空", hint: "随便坐" },
  { value: 1, label: "正常", hint: "有座" },
  { value: 2, label: "饱和", hint: "没座位但站稳" },
  { value: 3, label: "挤", hint: "贴着站" },
  { value: 4, label: "爆满", hint: "前胸贴后背" },
];
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

export default function FreeRideClient({
  includeTest,
  restoreRideId,
}: {
  includeTest: boolean;
  restoreRideId: number | null;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>(restoreRideId ? "riding" : "setup");
  const [error, setError] = useState<string | null>(null);

  // —— setup 状态 ——
  const [mode, setMode] = useState<"route" | "station">("route");
  const [routes, setRoutes] = useState<RouteOpt[] | null>(null);
  const [stations, setStations] = useState<StationOpt[] | null>(null);
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

  // —— 汇总 ——
  const [detail, setDetail] = useState<{
    ride: RideDetail;
    events: RideEventRow[];
    nameOf: (code: string | null) => string;
    relSecs: (number | null)[]; // events 中每个「到站」相对上一「到站」的秒
  } | null>(null);

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
    if (!stations) {
      fetch("/api/free/stations", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (d.ok) setStations(d.stations);
        })
        .catch(() => {});
    }
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

  const startRide = async () => {
    if (!selRoute || !selDir || !boardCode || busy) return;
    setBusy(true);
    try {
      const d = (await (
        await fetch("/api/free/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ route: selRoute.code, dir: selDir, boardStation: boardCode }),
        })
      ).json()) as { ok: boolean; id?: number; error?: string; vehiclePlate?: string | null };
      if (!d.ok || !d.id) {
        setError(d.error ?? "启动失败");
        return;
      }
      const bi = stops.findIndex((s) => s.code === boardCode);
      setRide({
        route_code: selRoute.code,
        dsat_dir: selDir,
        board_station: boardCode,
        vehicle_plate: d.vehiclePlate ?? null,
        vehicle_code: null,
        crowd_level: null,
        started_at: new Date().toISOString(),
      });
      setRideId(d.id);
      setRideStops(stops);
      setRideDirLabel(selDirLabel);
      setRideColor(selRoute.color ?? null);
      setXCode(stops[(bi + 1) % stops.length].code);
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
      const d = (await (
        await fetch(`/api/free/${rideId}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, station: xCode }),
        })
      ).json()) as { ok: boolean; ended?: boolean; totalMs?: number; error?: string };
      if (!d.ok) {
        setError(d.error ?? "打点失败");
        return;
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
      ).json()) as { ok: boolean };
      if (d.ok) {
        setRide((p) => (p ? { ...p, crowd_level: level } : p));
        setCrowdDraft(null);
        setCrowdEdit(false);
      }
    } finally {
      setCrowdBusy(false);
    }
  };

  const fmtClock = (iso: string) =>
    new Date(iso).toLocaleTimeString("zh-CN", { timeZone: "Asia/Macau", hour12: false });
  const fmtDur = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m} 分 ${String(s % 60).padStart(2, "0")} 秒`;
  };
  const fmtGap = (sec: number | null) =>
    sec === null ? "—" : sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}` : `${sec}s`;
  const toggleTest = () => {
    document.cookie = `mtk_include_test=${includeTest ? "0" : "1"}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };
  const isLrt = (code: string) => code.startsWith("LRT-");

  return (
    <main className="page">
      <header style={{ marginBottom: 14, width: "100%", padding: "0 2px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h1 className="h-headline" style={{ margin: 0 }}>
            ⏱ 自由记站
          </h1>
          <button
            role="switch"
            aria-checked={includeTest}
            className={`chip${includeTest ? " chip--on" : ""}`}
            onClick={toggleTest}
            style={{ marginLeft: "auto" }}
          >
            🧪 测试 {includeTest ? "开" : "关"}
          </button>
        </div>
        <p className="t-label t-muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
          独立于通勤计时 · 实测「任意两站间行车时长」，供自动选线建模
        </p>
      </header>

      {error && <p className="t-error t-body" style={{ marginBottom: 10 }}>{error}</p>}

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

          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button
              className="btn btn--primary btn--block"
              style={{ flex: 1 }}
              onClick={() => {
                resetSetup();
                setDetail(null);
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
                  {!routes && <p className="t-body t-muted">加载中…</p>}
                  {(routes ?? []).map((r) => (
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
                  <p className="t-body">
                    {selRoute.code.startsWith("LRT-")
                      ? freeLineLabel(selRoute.code)
                      : `${selRoute.code} 路`}{" "}
                    · {selDirLabel}
                  </p>
                  <input
                    className="inp"
                    value={stopKw}
                    onChange={(e) => setStopKw(e.target.value)}
                    placeholder="搜索上车站（站名 / 站号）"
                    style={{ padding: "10px 12px", borderRadius: 10 }}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
                    {stops
                      .filter((s) => !stopKw || s.name.includes(stopKw.trim()) || s.code.includes(stopKw.trim().toUpperCase()))
                      .map((s) => (
                        <button
                          key={s.code}
                          className={`card${boardCode === s.code ? " card--sel" : ""}`}
                          style={{ padding: "9px 12px", textAlign: "left" }}
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
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 420, overflowY: "auto" }}>
                    {(stations ?? [])
                      .filter((s) => matchStation(s, stationKw))
                      .slice(0, stationKw ? 100 : 60)
                      .map((s) => (
                        <button
                          key={s.code}
                          className="card"
                          style={{ padding: "9px 12px", textAlign: "left", display: "flex", gap: 8, alignItems: "center" }}
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
                  <p className="t-label t-muted">在{selStation.name}上车 · 选坐哪路（多方向选完方向继续）</p>
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
                        onClick={() => {
                          setSelRoute({ code: r.code, kind: r.kind, color: r.color, dirs: [] });
                          void pickDir({ code: r.code, kind: r.kind, color: r.color, dirs: [] }, r.dirs[0] ?? "0");
                        }}
                      >
                        {kindBadge(r.kind)}
                        <span className="t-body t-strong">
                          {r.code.startsWith("LRT-") ? freeLineLabel(r.code) : `${r.code} 路`}
                        </span>
                      </button>
                    ) : (
                      <div key={r.code} className="card" style={{ padding: "11px 13px", borderLeft: r.color ? `4px solid ${r.color}` : undefined }}>
                        <p className="t-body t-strong" style={{ marginBottom: 6 }}>
                          {kindBadge(r.kind)}{" "}
                          <RouteStack codes={[r.code]} colorOf={() => r.color ?? undefined} size="sm" />
                        </p>
                        {r.dirs.map((dd) => {
                          const rr = { code: r.code, kind: r.kind, color: r.color, dirs: [] };
                          return (
                            <button key={dd} className="btn btn--outline btn--sm" style={{ margin: "0 6px 6px 0" }} onClick={() => void pickDir(rr, dd)}>
                              坐这路
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
