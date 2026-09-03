"use client";

/**
 * 实时车距卡片（src/components/LiveEta.tsx）
 * 出门/等车阶段显示候选线路最近的車距本站还有几站。
 * 数据链路：/api/dsat/eta → DSAT routestation/bus（30s 服务端缓存）。
 * 60 秒自动刷新 + 手动刷新；失败静默保留旧数据（不打断计时流程）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface EtaNearest {
  plate: string | null;
  stopsAway: number; // 0 = 已到站
  atStation: string;
  atStationName: string;
  status: string | null; // '1' 進站中 / '0' 行驶中
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

const REFRESH_MS = 60_000;

export default function LiveEta({
  station,
  routes,
  dir,
  dest,
}: {
  station: string;
  routes: string[];
  dir: string;
  dest?: string | null;
}) {
  const [data, setData] = useState<EtaData | null>(null);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);
  const routesKey = routes.join(",");

  const fetchEta = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        station,
        routes: routesKey,
        dir,
        ...(dest ? { dest } : {}),
      });
      const res = await fetch(`/api/dsat/eta?${qs.toString()}`, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as EtaData;
      if (id === reqId.current) setData(body);
    } catch {
      // 静默失败，保留旧数据
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [station, routesKey, dir, dest]);

  useEffect(() => {
    fetchEta();
    const t = setInterval(fetchEta, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchEta]);

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
    <div
      style={{
        marginBottom: 16,
        padding: "12px 14px",
        borderRadius: 14,
        background: "var(--card)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <p style={{ fontSize: 14, fontWeight: 600 }}>🚌 实时车距</p>
        <button
          onClick={fetchEta}
          disabled={loading}
          style={{
            background: "transparent",
            color: "var(--muted)",
            fontSize: 13,
            padding: "2px 8px",
            minWidth: 0,
          }}
        >
          {loading ? "刷新中…" : "↻ 刷新"}
        </button>
      </div>

      {!data ? (
        <p style={{ fontSize: 14, color: "var(--muted)" }}>获取中…</p>
      ) : (
        data.results.map((r) => {
          if (!r.ok) {
            return (
              <p key={r.route} style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.8 }}>
                {r.route} 路 · {r.error ?? "暂无数据"}
              </p>
            );
          }
          if (!r.nearest) {
            // 没有在途车：总站有待发车 → 未发车；否则按有无在线车辆区分
            if ((r.pending?.length ?? 0) > 0) {
              const p = r.pending![0];
              return (
                <p key={r.route} style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.8 }}>
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
              <p key={r.route} style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.8 }}>
                {r.route} 路 · {(r.busCount ?? 0) > 0 ? "本方向暂无来车" : "暂无在线车辆"}
              </p>
            );
          }
          const isNearest = minAway === r.nearest.stopsAway;
          // 报站档位（2026-09-03 主人定义的口径）：
          //   s0 挂用户站（正驶来）→ 即将进站；s1 挂用户站 → 已进站；
          //   s1 挂前一站 → 还有 1 站；更远 → 还有 N 站
          const n = r.nearest.stopsAway;
          const stage =
            n === 0
              ? { text: "已进站！", flash: true }
              : n === 1 && r.nearest.status === "0"
                ? { text: "即将进站", flash: true }
                : { text: `还有 ${n} 站`, flash: false };
          return (
            <p key={r.route} style={{ fontSize: 15, lineHeight: 1.8 }}>
              <span
                style={{
                  fontWeight: 700,
                  color: stage.flash ? "var(--accent)" : isNearest ? "var(--accent)" : undefined,
                }}
              >
                {r.route} 路 · {stage.text}
              </span>
              <span style={{ fontSize: 13, color: "var(--muted)" }}>
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
        <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
          更新于 {fmtTime(data.fetchedAt)} · DSAT 数据约 1 分钟一轮，仅供参考
        </p>
      )}
    </div>
  );
}
