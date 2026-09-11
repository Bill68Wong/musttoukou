"use client";

/**
 * 自由记站 · 采集记录（v0.23.0）：独立页面 /free/history
 * 列表（线路 / 上下车站 / 耗时 / 时刻点数）→ 展开逐站时刻 → 单条删除（二次确认）
 * v0.22.0 该列表内嵌在 /free 最底部，v0.23.0 拆成独立页面并支持删除。
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import RouteStack from "./RouteStack";
import {
  FREE_CROWD,
  FREE_EVENT_LABELS,
  fmtFreeClock,
  fmtFreeDateTime,
  fmtFreeDur,
} from "@/lib/free-shared";
import type { FreeStop, HistoryRow, RideDetail, RideEventRow } from "@/lib/free-shared";

export default function FreeHistoryClient() {
  const router = useRouter();
  const [rides, setRides] = useState<HistoryRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<{
    ride: RideDetail;
    events: RideEventRow[];
    stops: FreeStop[];
  } | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function load() {
    try {
      const d = (await (await fetch("/api/free/rides", { cache: "no-store" })).json()) as {
        ok: boolean;
        rides?: HistoryRow[];
        error?: string;
      };
      if (d.ok) setRides(d.rides ?? []);
      else setErr(d.error ?? "加载失败");
    } catch {
      setErr("加载失败，请刷新重试");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /** 展开 / 收起某条的逐站时刻 */
  async function toggle(id: number) {
    if (open === id) {
      setOpen(null);
      setDetail(null);
      return;
    }
    setOpen(id);
    setDetail(null);
    setDetailErr(null);
    try {
      const d = (await (await fetch(`/api/free/${id}`, { cache: "no-store" })).json()) as {
        ok: boolean;
        ride?: RideDetail;
        events?: RideEventRow[];
      };
      if (!d.ok || !d.ride) {
        setDetailErr("详情加载失败");
        return;
      }
      let stops: FreeStop[] = [];
      try {
        const sd = (await (
          await fetch(
            `/api/free/stops?route=${encodeURIComponent(d.ride.route_code)}&dir=${d.ride.dsat_dir}`,
            { cache: "no-store" },
          )
        ).json()) as { ok: boolean; stops?: FreeStop[] };
        stops = sd.stops ?? [];
      } catch {
        /* 站序拉不到时退回显示站码 */
      }
      setDetail({ ride: d.ride, events: d.events ?? [], stops });
    } catch {
      setDetailErr("详情加载失败");
    }
  }

  /** 展开详情里的站名查询 */
  const nameOf = (code: string | null) =>
    code ? (detail?.stops.find((s) => s.code === code)?.name ?? code) : "—";

  /** 删除单条行程（软删除，二次确认） */
  async function remove(h: HistoryRow) {
    const label =
      `${fmtFreeDateTime(h.started_at)} · ${h.route_code} ` +
      `${h.board_name ?? h.board_station ?? "?"} → ${h.alight_name ?? h.alight_station ?? "—"}`;
    if (!window.confirm(`删除这条采集记录？\n\n${label}\n\n删除后不再计入统计，且无法恢复。`)) return;
    setBusyId(h.id);
    setErr(null);
    try {
      const r = await fetch(`/api/free/${h.id}`, { method: "DELETE" });
      const d = (await r.json()) as { ok: boolean; error?: string };
      if (!d.ok) {
        setErr(d.error ?? "删除失败");
      } else {
        setRides((prev) => (prev ?? []).filter((x) => x.id !== h.id));
        if (open === h.id) {
          setOpen(null);
          setDetail(null);
        }
      }
    } catch {
      setErr("删除失败，请重试");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="page">
      <header style={{ marginBottom: 14, width: "100%", padding: "0 2px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h1 className="h-headline" style={{ margin: 0 }}>
            📋 采集记录
          </h1>
          <button
            className="btn btn--text btn--sm t-muted"
            style={{ marginLeft: "auto" }}
            onClick={() => router.push("/free")}
          >
            ← 返回记站
          </button>
        </div>
        <p className="t-label t-muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
          自由记站的历史行程 · 点卡片展开逐站时刻 · 点「删除」移除该条
        </p>
      </header>

      {err && (
        <p className="t-error t-body" style={{ marginBottom: 10 }}>
          {err}
        </p>
      )}

      {!rides && <p className="t-body t-muted">加载中…</p>}
      {rides?.length === 0 && (
        <div className="card" style={{ padding: "14px 15px" }}>
          <p className="t-body t-muted" style={{ margin: 0, lineHeight: 1.6 }}>
            还没有采集记录 —— 回「自由记站」选好线路和上车站就能开始
          </p>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {(rides ?? []).map((h) => (
          <div
            key={h.id}
            className="card"
            style={{
              padding: "12px 14px",
              borderLeft: h.route_color ? `4px solid ${h.route_color}` : undefined,
            }}
          >
            <button
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: "inherit",
                font: "inherit",
              }}
              onClick={() => void toggle(h.id)}
            >
              <p className="t-body" style={{ margin: 0, lineHeight: 1.5 }}>
                {h.route_code.startsWith("LRT-") ? "🚈" : "🚌"}{" "}
                <RouteStack
                  codes={[h.route_code]}
                  colorOf={() => h.route_color ?? undefined}
                  size="sm"
                />
                {!h.ended_at && <span className="t-accent"> · 进行中</span>}
              </p>
              <p className="t-label t-muted" style={{ marginTop: 4, lineHeight: 1.5 }}>
                {fmtFreeDateTime(h.started_at)} · {h.board_name ?? h.board_station ?? "?"}
                {" → "}
                {h.alight_name ?? h.alight_station ?? "—"}
                {h.total_ms != null ? ` · ${fmtFreeDur(h.total_ms)}` : ""}
                {h.crowd_level != null
                  ? ` · ${FREE_CROWD.find((c) => c.value === h.crowd_level)?.label ?? "?"}`
                  : ""}
                {` · ${h.timed_count} 个时刻点`}
              </p>
              <p className="t-label t-muted" style={{ marginTop: 2, marginBottom: 0 }}>
                {open === h.id ? "收起逐站时刻 ▲" : "展开逐站时刻 ▼"}
              </p>
            </button>

            {open === h.id && (
              <div style={{ marginTop: 8 }}>
                {detailErr && <p className="t-error t-label">{detailErr}</p>}
                {!detail && !detailErr && <p className="t-label t-muted">加载中…</p>}
                {detail && (
                  <div className="timeline">
                    {detail.events.map((e) => (
                      <div key={e.id} className="timeline-item">
                        <span className="timeline-dot" />
                        <span className={e.event_type === "stop_skip" ? "t-muted" : undefined}>
                          {e.event_type === "stop_skip"
                            ? "（无时刻） "
                            : `${fmtFreeClock(e.recorded_at)} `}
                          {FREE_EVENT_LABELS[e.event_type] ?? e.event_type}（{nameOf(e.station_code)}）
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
              {!h.ended_at && (
                <button
                  className="btn btn--outline btn--sm"
                  onClick={() => router.push(`/free?ride=${h.id}`)}
                >
                  继续这趟
                </button>
              )}
              <button
                className="btn btn--text btn--sm t-error"
                style={{ marginLeft: "auto" }}
                disabled={busyId === h.id}
                onClick={() => void remove(h)}
              >
                {busyId === h.id ? "删除中…" : "🗑 删除"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
