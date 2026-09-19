"use client";

/**
 * 详情页折叠栏 · 「本站台其他线路」（src/components/nav/StationReachFold.tsx，v1.3.0 · T05）
 *
 * 旧 `/card` 的详情页有「该站台剩余所有可达线路」折叠栏；`/nav/detail` 原缺此块（T04 遗留 ⑥）。
 * 本组件**单独实现**（⚠️ **不改 `StationStrip`**，以免波及旧 `/card`）。
 *
 * ★ §11.6：线路名一律 `.route-stack`（主题色标签）。
 * 范围说明（诚实）：本轮**只列线路标签**（不含实时报站 ETA）—— 实时报站需 `fetchStationLive`
 * 的完整接线，属后续增强；此处给出「还有哪些线路经过本站台」。
 */
import { useState } from "react";
import RouteStack from "@/components/RouteStack";

export default function StationReachFold({
  stationLabel,
  routes,
  colors,
}: {
  /** 站台显示名（如「C653 金峰南岸」） */
  stationLabel: string;
  /** 该站台其他可达线路码 */
  routes: string[];
  colors: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  if (!routes.length) return null;

  return (
    <div className="rc-fold">
      <button className="rc-fold__head" type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        本站台其他线路 · <b>{routes.length}</b> 条
        <span className="rc-strip__caret">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="rc-fold__body">
          <span className="t-label t-muted" style={{ marginRight: 8 }}>
            {stationLabel}
          </span>
          <RouteStack codes={routes} colorOf={(c) => colors[c] ?? null} size="sm" />
        </div>
      )}
    </div>
  );
}
