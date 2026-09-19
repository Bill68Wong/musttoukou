"use client";

/**
 * 详情页折叠栏 · 「本站台其他线路」（src/components/nav/StationReachFold.tsx，v1.3.0 · T05；v2.0.1 加实时报站）
 *
 * 旧 `/card` 的详情页有「该站台剩余所有可达线路」折叠栏（含实时报站）；`/nav/detail` 原缺。
 * 本组件**单独实现**（⚠️ **不改 `StationStrip`**，以免波及旧 `/card`）。
 *
 * ★ §11.6：线路名一律 `.route-stack`（主题色标签）。
 * ★ 【5】v2.0.1：**加实时报站** —— 每条线路给出「还有 N 站 · 约 X~Y 分」（巴士，服务端算好传入）
 *   或「暂无在途车」。**站名/线路名用繁体**，界面文案用**简体**。
 */
import { useState } from "react";
import RouteStack from "@/components/RouteStack";

export interface ReachFoldItem {
  /** 线路码 */
  route: string;
  /** 实时报站文案（空串 = 无数据） */
  live: string;
}

export default function StationReachFold({
  stationLabel,
  items,
  colors,
}: {
  /** 站台显示名（如「C653 金峰南岸」） */
  stationLabel: string;
  /** 该站台其他可达线路（含各自实时报站） */
  items: ReachFoldItem[];
  colors: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;

  return (
    <div className="rc-fold">
      <button className="rc-fold__head" type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        本站台其他线路 · <b>{items.length}</b> 条
        <span className="rc-strip__caret">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="rc-fold__body">
          <span className="t-label t-muted" style={{ display: "block", marginBottom: 6 }}>
            {stationLabel}
          </span>
          {items.map((it) => (
            <div className="nav-fold-row" key={it.route}>
              <RouteStack codes={[it.route]} colorOf={(c) => colors[c] ?? null} size="sm" />
              <span className="nav-fold-row__live t-label">{it.live || "暂无报站"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
