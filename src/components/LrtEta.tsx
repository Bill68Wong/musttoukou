"use client";

/**
 * 轻轨时刻表报站卡（src/components/LrtEta.tsx）v0.15.1
 * 与巴士 LiveEta 同位置同视觉：只显示「下一班 / 再下一班」，无整日时刻表。
 * 数据链路：/api/lrt/eta（本地算）→ 一次拉取当日该站该线该方向时刻，
 *   之后客户端按绝对发车时刻（depMs）本地每秒重算倒计时——秒级不依赖网络。
 *
 * 口径（与方案一致；v0.15.1 文案/读秒优化）：
 *   - 氹仔线：剩余 ≥60s → 「下一班 X 分钟」（floor）；<60s 且未过 → 「现正到达」（flash）
 *   - 石排湾线/横琴线：秒级读秒 —— 剩余 ≥60s → 「还有 X 分 Y 秒」（每秒重渲染）；<60s → 「现正到达」
 *   - 轻轨一律用「现正到达」；「即将进站」是巴士（DSAT 实时车距）专属文案
 *   - 滚动：超过下一班发车时刻后自动落到再下一班（同数据，无请求）
 *   - 空态：首班前/已收车/无数据 文案与 LiveEta 空态同风格
 *   - 日切（澳门 0 点）自动重新拉取（服务班别/日期已变）
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** v0.15.1：轻轨线路展示名（与 TimerWizard lrtLabelOf 一致，无「輕軌·」前缀）：
 *  LRT-石排湾线 → 石排灣線；标题前的 🚈 已标识载具，无需重复 */
const lineLabel = (code: string) =>
  code
    .replace(/^LRT-/, "")
    .replace(/湾/g, "灣")
    .replace(/横/g, "橫")
    .replace(/线/g, "線");

/** 秒级读秒线路：石排湾线/横琴线（班次稀疏，倒计时需精确到秒）；
 *  氹仔线班次密仍按整分显示。码内含简/繁写法兜底匹配 */
const tickSecLine = (code: string) =>
  code.includes("石排") || code.includes("横琴") || code.includes("橫琴");

interface LrtDeparture {
  clock: string; // 'HH:MM'
  depMs: number; // 绝对毫秒时刻（D 00:00 + 偏移）
}

interface LrtEtaData {
  ok: boolean;
  error?: string;
  state: "running" | "before_first" | "after_last" | "no_data";
  lineCode: string;
  directionName: string | null;
  dayType: string;
  serviceDay: string; // 'YYYY-MM-DD'（澳门）
  firstClock: string | null;
  lastClock: string | null;
  departures: LrtDeparture[];
  serverNow: string;
}

/** 澳门自然日 ymd（GMT+8，本地纯算） */
function macauYmd(ms: number): string {
  const d = new Date(ms + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

export default function LrtEta({
  station,
  route,
  dest,
  refreshKey = 0,
  onRemainChange,
}: {
  station: string;
  /** 本库线路码（LRT-氹仔线…）；调用方已按段解析好（effRoute 取 LRT 项） */
  route: string;
  dest?: string | null;
  /** 父级关键打点后递增 → 重新拉取（对齐 LiveEta 刷新节奏） */
  refreshKey?: number;
  /** 下一班剩余毫秒变化回调（TimerWizard 自动写 wait_snapshot 用；null=无下一班） */
  onRemainChange?: (remainMs: number | null) => void;
}) {
  const [data, setData] = useState<LrtEtaData | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldownSec, setCooldownSec] = useState(0);
  // v0.15.1：秒级读秒渲染节拍（+1 强制以最新 nowMs 重算；石排湾/横琴线「还有 X 分 Y 秒」实时滚动）
  const [, setNowTick] = useState(0);
  const reqId = useRef(0);
  const cooldownUntil = useRef(0);
  const serverOffsetMs = useRef(0);
  const lastReportedRemain = useRef<number | null>(null);

  const fetchEta = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    cooldownUntil.current = Date.now() + 10_000;
    setCooldownSec(10);
    try {
      const qs = new URLSearchParams({ station, route });
      if (dest) qs.set("dest", dest);
      const res = await fetch(`/api/lrt/eta?${qs.toString()}`, { cache: "no-store" });
      const body = (await res.json()) as LrtEtaData;
      if (id !== reqId.current) return;
      if (!res.ok || !body.ok) {
        setData({ ok: false, error: body.error ?? "获取失败", state: "no_data", lineCode: route, directionName: null, dayType: "", serviceDay: "", firstClock: null, lastClock: null, departures: [], serverNow: new Date().toISOString() });
        return;
      }
      serverOffsetMs.current = Date.parse(body.serverNow) - Date.now();
      setData(body);
    } catch {
      if (id === reqId.current) {
        setData({ ok: false, error: "网络异常", state: "no_data", lineCode: route, directionName: null, dayType: "", serviceDay: "", firstClock: null, lastClock: null, departures: [], serverNow: new Date().toISOString() });
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [station, route, dest]);

  // 挂载 / 参数 / 打点刷新
  const prevKey = useRef(refreshKey);
  useEffect(() => {
    fetchEta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchEta]);
  useEffect(() => {
    if (refreshKey !== prevKey.current) {
      prevKey.current = refreshKey;
      fetchEta();
    }
  }, [refreshKey, fetchEta]);

  // 冷却读秒（与 LiveEta 手感一致）
  useEffect(() => {
    if (cooldownSec <= 0) return;
    const t = setInterval(() => {
      const left = Math.ceil((cooldownUntil.current - Date.now()) / 1000);
      setCooldownSec(left <= 0 ? 0 : left);
    }, 500);
    return () => clearInterval(t);
  }, [cooldownSec]);

  // 本地每秒重算：下一/再下一剩余、跨班滚动、日切重拉、onRemainChange 上报
  useEffect(() => {
    if (!data) return;
    const report = () => {
      const nowMs = Date.now() + serverOffsetMs.current;
      const dep = data.departures;
      if (dep.length === 0) {
        if (lastReportedRemain.current !== null) {
          lastReportedRemain.current = null;
          onRemainChange?.(null);
        }
        return;
      }
      const firstLeft = dep[0].depMs - nowMs;
      const nxtDep =
        firstLeft > 0 ? dep[0] : dep[1] && dep[1].depMs - nowMs > 0 ? dep[1] : null;
      if (!nxtDep) {
        if (lastReportedRemain.current !== null) {
          lastReportedRemain.current = null;
          onRemainChange?.(null);
        }
        return;
      }
      const remainMs = nxtDep.depMs - nowMs;
      if (remainMs !== lastReportedRemain.current) {
        lastReportedRemain.current = remainMs;
        onRemainChange?.(remainMs);
      }
    };
    report(); // 数据就绪立即上报一次（不等首跳）
    const tick = setInterval(() => {
      const nowMs = Date.now() + serverOffsetMs.current;
      const dep = data.departures;
      if (dep.length > 0 && dep[dep.length - 1].depMs - nowMs <= 0) {
        // 末班也已开出 → 重拉（跨日/换班表后旧数据失效）
        fetchEta();
        return;
      }
      // 澳门日切 → 重拉（班别/日期变化）
      if (data.serviceDay && macauYmd(nowMs) !== data.serviceDay) {
        fetchEta();
        return;
      }
      report();
      // v0.15.1：运行中每秒 tick 一次 → 秒级倒计时与「下一班→再下一班」到点滚动即时生效
      if (data.state === "running") setNowTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(tick);
  }, [data, fetchEta, onRemainChange]);

  const manualRefresh = () => {
    if (Date.now() < cooldownUntil.current) return;
    fetchEta();
  };

  // —— 渲染 ——
  const nowMs = data ? Date.now() + serverOffsetMs.current : 0;
  const nxtDep = (() => {
    if (!data || data.departures.length === 0) return null;
    const dep = data.departures;
    const remainOf = (ms: number) => ms - nowMs;
    if (remainOf(dep[0].depMs) > 0) return dep[0];
    if (dep[1] && remainOf(dep[1].depMs) > 0) return dep[1];
    return null;
  })();
  const sndDep = (() => {
    if (!data || !nxtDep) return null;
    const i = data.departures.indexOf(nxtDep);
    return data.departures[i + 1] ?? null;
  })();
  const remainMs = nxtDep ? nxtDep.depMs - nowMs : null;
  // v0.15.1：石排湾/横琴线秒级读秒（氹仔线维持整分显示）
  const tickSec = !!data && tickSecLine(data.lineCode);
  const totalSec = remainMs != null ? Math.ceil(remainMs / 1000) : null;

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("zh-CN", {
      timeZone: "Asia/Macau",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  return (
    <div className="card anim-fade-up" style={{ padding: "12px 14px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <p
          className="h-title"
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          🚈 实时到站 · {lineLabel(route)}
        </p>
        <button
          className="btn btn--text btn--sm"
          onClick={manualRefresh}
          disabled={loading || cooldownSec > 0}
          aria-label="刷新轻轨到站"
        >
          <span className={loading ? "anim-spin" : ""} style={{ display: "inline-block" }}>
            ↻
          </span>{" "}
          {loading ? "刷新中…" : cooldownSec > 0 ? `${cooldownSec}s` : "刷新"}
        </button>
      </div>

      {!data ? (
        <p className="t-body t-muted">获取中…</p>
      ) : !data.ok ? (
        <p className="t-body t-muted" style={{ lineHeight: 1.7 }}>
          輕軌時刻暫不可用 · {data.error}
        </p>
      ) : data.state !== "running" || !nxtDep ? (
        <p className="t-body t-muted" style={{ lineHeight: 1.7, textAlign: "center", marginTop: 4 }}>
          {data.state === "before_first" && data.firstClock
            ? `首班 ${data.firstClock} 開出${data.directionName ? ` · 往${data.directionName}` : ""}`
            : data.state === "after_last" && data.lastClock
              ? `今日已收車 · 末班 ${data.lastClock}`
              : data.state === "before_first"
                ? "尚未開出首班"
                : data.state === "after_last"
                  ? "今日已收車"
                  : "該方向暫無時刻數據"}
        </p>
      ) : (
        <div style={{ marginTop: 2 }}>
          {/* 下一班大数字 */}
          <p
            className={`t-accent eta-big${
              remainMs !== null && remainMs < 60_000 ? " eta-big--flash" : ""
            }`}
            style={{ textAlign: "center", margin: "4px 0 0" }}
          >
            {remainMs !== null && remainMs >= 60_000
              ? tickSec
                ? `还有 ${Math.floor(totalSec! / 60)} 分 ${totalSec! % 60} 秒`
                : `下一班 ${Math.floor(remainMs / 60_000)} 分钟`
              : "现正到达"}
          </p>
          {/* 副行：方向 + 绝对时刻 */}
          <p
            className="t-label t-muted"
            style={{ textAlign: "center", lineHeight: 1.5, marginTop: 2 }}
          >
            {data.directionName ? `往${data.directionName} · ` : ""}
            {nxtDep.clock} 開出
          </p>
          {/* 再下一班 */}
          {sndDep && (
            <p
              className="t-label t-muted"
              style={{ textAlign: "center", lineHeight: 1.5, marginTop: 4 }}
            >
              再下一班{" "}
              {Math.max(0, Math.floor((sndDep.depMs - nowMs) / 60_000))} 分钟 · {sndDep.clock}
            </p>
          )}
        </div>
      )}

      {data?.ok && data.serverNow && (
        <p className="t-label t-muted" style={{ marginTop: 8 }}>
          更新于 {fmtTime(data.serverNow)} · 時刻表來源 澳門輕軌
        </p>
      )}
    </div>
  );
}
