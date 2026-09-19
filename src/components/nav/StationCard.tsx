"use client";

/**
 * 巴士站点信息卡（src/components/nav/StationCard.tsx，v2.1.0）
 *
 * ── 定位（产品口径 2026-09-19）─────────────────────────────────────────
 *   首页地图点击巴士站 → 浮层卡片：**站名（繁体）+ 该站所有线路的实时报站**
 *   + 「设为起点 / 设为目的地」（联动上方搜索框）。可关闭。
 *
 * ── 数据 ──────────────────────────────────────────────────────────────
 *   · 站名/坐标由调用方（NavShell，来自 `/api/stations`）传入；
 *   · 报站列表 `fetch('/api/station/eta?code=…')`（进入卡片时拉一次；含加载/失败态）。
 *
 * ── 降级 ──────────────────────────────────────────────────────────────
 *   接口失败/空 ⇒ 就地提示「暂无报站」，**不阻塞**设为起点/目的地与搜索、出发。
 *
 * ★ 站名/线路名用**繁体**，界面文案用**简体**（§6.2）。
 */
import { useEffect, useState } from "react";
import RouteStack from "@/components/RouteStack";

export interface StationCardStation {
  /** 主码 */
  code: string;
  /** 站名（繁体） */
  name: string;
  /** 经度（GCJ-02） */
  lng: number;
  /** 纬度（GCJ-02） */
  lat: number;
}

/** `/api/station/eta` 一条（与后端 `StationEtaItem` 对应） */
interface EtaItem {
  route: string;
  dir: string;
  dirLabel: string;
  stopsAway: number | null;
  etaMin: number | null;
  ok: boolean;
}

interface EtaResponse {
  code: string;
  fetchedAt: string;
  items: EtaItem[];
}

/** 报站文案（简体）：ok=false→暂无数据；无车→暂无在途车；0 站→即将到站；否则「还有 N 站 · 约 M 分」 */
function etaText(it: EtaItem): string {
  if (!it.ok) return "暂无数据";
  if (it.stopsAway === null) return "暂无在途车";
  if (it.stopsAway === 0) return "即将到站";
  return `还有 ${it.stopsAway} 站 · 约 ${it.etaMin ?? 0} 分`;
}

export default function StationCard({
  station,
  colors,
  onClose,
  onSetFrom,
  onSetTo,
}: {
  station: StationCardStation;
  colors: Record<string, string>;
  onClose: () => void;
  onSetFrom: () => void;
  onSetTo: () => void;
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [items, setItems] = useState<EtaItem[]>([]);

  useEffect(() => {
    let alive = true;
    setPhase("loading");
    setItems([]);
    fetch(`/api/station/eta?code=${encodeURIComponent(station.code)}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<EtaResponse>)
      .then((j) => {
        if (!alive) return;
        setItems(Array.isArray(j.items) ? j.items : []);
        setPhase("ready");
      })
      .catch(() => {
        if (alive) setPhase("failed");
      });
    return () => {
      alive = false;
    };
  }, [station.code]);

  return (
    <div className="nav-station-card" role="dialog" aria-label={`站点 ${station.name}`}>
      <div className="nav-station-card__head">
        <span className="nav-station-card__name">{station.name || station.code}</span>
        <button className="nav-station-card__close" type="button" aria-label="关闭" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="nav-station-card__list">
        {phase === "loading" && <p className="t-label t-muted">读取报站中…</p>}
        {phase === "failed" && <p className="t-label t-muted">暂无报站</p>}
        {phase === "ready" && !items.length && <p className="t-label t-muted">暂无报站</p>}
        {phase === "ready" &&
          items.map((it) => (
            <div className="nav-station-card__row" key={`${it.route}-${it.dir}`}>
              <RouteStack codes={[it.route]} colorOf={(c) => colors[c] ?? null} size="sm" />
              <span className="nav-station-card__dir t-label t-muted">{it.dirLabel}</span>
              <span className="nav-station-card__eta t-label">{etaText(it)}</span>
            </div>
          ))}
      </div>

      <div className="nav-station-card__acts">
        <button className="btn btn--outline btn--sm" type="button" onClick={onSetFrom}>
          设为起点
        </button>
        <button className="btn btn--primary btn--sm" type="button" onClick={onSetTo}>
          设为目的地
        </button>
      </div>
    </div>
  );
}
