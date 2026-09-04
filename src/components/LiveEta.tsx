"use client";

/**
 * 实时车距卡片（src/components/LiveEta.tsx）
 * 出门/等车阶段显示候选线路最近的車距本站还有几站。
 * 数据链路：/api/dsat/eta → DSAT routestation/bus（5s 服务端缓存，v0.8.1 10s → 5s）。
 *
 * v0.4.0 刷新规则（用户定稿，2026-09-03）：
 *  - ★ 无自动轮询（移除 60s setInterval）
 *  - 手动刷新：最小间隔 10s（本地守卫，不带 force，命中服务端缓存即可）
 *  - 打点（depart/wait_start 等系统时刻）后经 refreshKey 递增 → force=true 直查最新
 *    （v0.8.1 修复竞态：此前 GET 不带 force 会命中打点前旧缓存，与 auto-snapshot 的
 *      force 直查结果不一致导致界面横跳；现打点后两者同刻直查，口径一致）
 *  - 失败静默保留旧数据（不打断计时流程）
 *
 * v0.8.2/0.8.3（2026-09-04）：同车只降不升平滑（src/lib/eta-smooth.ts，模块级记忆）。
 * v0.8.4 根因已修（eta.ts 站距口径 s0/s1 同值，不再有 2→3），平滑降级为纯防御层，
 * 仅兜底 DSAT 数据自身的偶发回跳（换车/换向/毛刺）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { smoothStopsAway, getSmoothMem } from "@/lib/eta-smooth";

interface EtaNearest {
  plate: string | null;
  stopsAway: number; // 0 = 已到站
  atStation: string;
  atStationName: string;
  status: string | null; // '1' 停靠挂载站 / '0' 已离挂载站驶向下一站（v0.8.4 口径）
  speed: string | number | null;
}

interface EtaResult {
  route: string;
  ok: boolean;
  isLoop?: boolean;
  nearest?: EtaNearest;
  pending?: { plate: string | null; atStation: string; atStationName: string }[];
  busCount?: number;
  error?: string;
}

interface EtaData {
  fetchedAt: string;
  results: EtaResult[];
}

/** 手动刷新最小间隔（毫秒） */
const MANUAL_MIN_MS = 10_000;

export default function LiveEta({
  station,
  routes,
  dir,
  dest,
  refreshKey = 0,
}: {
  station: string;
  routes: string[];
  dir: string;
  dest?: string | null;
  /** 打点成功后父组件递增 → 立即刷新（系统时刻，不受 10s 手动下限约束） */
  refreshKey?: number;
}) {
  const [data, setData] = useState<EtaData | null>(null);
  const [loading, setLoading] = useState(false);
  const [manualHint, setManualHint] = useState<string | null>(null);
  const reqId = useRef(0);
  const lastManualAt = useRef(0);
  /**
   * 同车单调记忆（v0.8.2 修复 C 抖动 2→3→1）——必须模块级单例：
   * TimerWizard 步骤容器 <div key={idx}> 每次打点推进都会卸载重建 LiveEta，
   * useRef 会随之清零导致平滑失效；getSmoothMem() 跨 remount 存活。
   */
  const prevByBus = useRef(getSmoothMem());
  const routesKey = routes.join(",");

  const fetchEta = useCallback(
    async (force = false) => {
      const id = ++reqId.current;
      setLoading(true);
      try {
        const qs = new URLSearchParams({
          station,
          routes: routesKey,
          dir,
          ...(dest ? { dest } : {}),
          ...(force ? { force: "1" } : {}),
        });
        const res = await fetch(`/api/dsat/eta?${qs.toString()}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as EtaData;
        if (id === reqId.current) {
          // v0.8.2：同车只降不升（记忆含等车站，跨步骤 remount 存活），消除 2→3→1 假倒退
          smoothStopsAway(prevByBus.current, body.results, station);
          setData(body);
        }
      } catch {
        // 静默失败，保留旧数据
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [station, routesKey, dir, dest],
  );

  // 挂载时取一次
  useEffect(() => {
    fetchEta();
  }, [fetchEta]);

  // 系统打点（refreshKey 递增）→ 事件驱动 force 直查最新；跳过首帧 0
  // v0.8.1：带 force=true，与 auto-snapshot 打点直查同刻一致，避免命中打点前旧缓存横跳
  const prevKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey !== prevKey.current && refreshKey > 0) {
      prevKey.current = refreshKey;
      fetchEta(true);
    }
  }, [refreshKey, fetchEta]);

  // 手动刷新：10s 最小间隔（本地守卫；不带 force，命中服务端 10s 缓存）
  const manualRefresh = () => {
    const now = Date.now();
    if (now - lastManualAt.current < MANUAL_MIN_MS) {
      setManualHint("10 秒后可再次手动刷新");
      return;
    }
    lastManualAt.current = now;
    setManualHint(null);
    fetchEta();
  };

  // 所有线路里最近的站数（高亮"坐哪辆先来"）
  const okWithBus = data?.results.filter((r) => r.ok && r.nearest) ?? [];
  const minAway =
    okWithBus.length > 0 ? Math.min(...okWithBus.map((r) => r.nearest!.stopsAway)) : null;

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
        <p className="h-title">🚌 实时车距</p>
        <button
          className="btn btn--text btn--sm"
          onClick={manualRefresh}
          disabled={loading}
          aria-label="刷新车距"
        >
          <span className={loading ? "anim-spin" : ""} style={{ display: "inline-block" }}>
            ↻
          </span>{" "}
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>
      {manualHint && (
        <p className="t-label t-muted" style={{ marginBottom: 6 }}>
          {manualHint}
        </p>
      )}

      {!data ? (
        <p className="t-body t-muted">获取中…</p>
      ) : (
        data.results.map((r) => {
          if (!r.ok) {
            return (
              <p key={r.route} className="t-body t-muted" style={{ lineHeight: 1.7 }}>
                {r.route} 路 · {r.error ?? "暂无数据"}
              </p>
            );
          }
          if (!r.nearest) {
            // 没有在途车：总站有待发车 → 未发车；否则按有无在线车辆区分
            if ((r.pending?.length ?? 0) > 0) {
              const p = r.pending![0];
              return (
                <p key={r.route} className="t-body t-muted" style={{ lineHeight: 1.7 }}>
                  {r.route} 路 · 未发车
                  <span style={{ fontSize: 12 }}>
                    {" "}
                    ({p.plate ?? ""}
                    {p.atStationName ? `在${p.atStationName}` : ""}
                    {(r.pending?.length ?? 0) > 1 ? ` 等${r.pending!.length}辆` : ""})
                  </span>
                </p>
              );
            }
            return (
              <p key={r.route} className="t-body t-muted" style={{ lineHeight: 1.7 }}>
                {r.route} 路 · {(r.busCount ?? 0) > 0 ? "本方向暂无来车" : "暂无在线车辆"}
              </p>
            );
          }
          const isNearest = minAway === r.nearest.stopsAway;
          // 报站档位（v0.8.4 口径修正，2026-09-04）：
          //   s1 挂用户站 → 0 = 已进站（车停靠中）
          //   s0 挂紧邻前站 → 1 = 即将进站（车已离前站驶来，还有 1 次停靠）
          //   s1 挂前一站 → 还有 1 站（车停着没动）；更远 → 还有 N 站
          const n = r.nearest.stopsAway;
          const stage =
            n === 0
              ? { text: "已进站！", flash: true }
              : n === 1 && r.nearest.status === "0"
                ? { text: "即将进站", flash: true }
                : { text: `还有 ${n} 站`, flash: false };
          return (
            <p key={r.route} className="t-body" style={{ lineHeight: 1.7 }}>
              <span
                className={stage.flash || isNearest ? "t-accent t-strong" : undefined}
              >
                {r.route} 路 · {stage.text}
              </span>
              <span className="t-muted" style={{ fontSize: 13 }}>
                {" "}
                {r.nearest.plate ?? ""}
                {r.nearest.atStationName ? ` · 在${r.nearest.atStationName}` : ""}
                {(r.pending?.length ?? 0) > 0 && ` · 另有 ${r.pending!.length} 辆总站待发`}
              </span>
            </p>
          );
        })
      )}

      {data && (
        <p className="t-label t-muted" style={{ marginTop: 6 }}>
          更新于 {fmtTime(data.fetchedAt)} · 手动刷新 ≥10s 间隔 · DSAT 仅供参考
        </p>
      )}
    </div>
  );
}
