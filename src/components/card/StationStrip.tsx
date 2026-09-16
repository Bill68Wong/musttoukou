"use client";
/**
 * 纵向站条（src/components/card/StationStrip.tsx，v1.1.8）
 *
 * 用户口径：**一趟一条**（每段载具各一条）· 中间站**默认收起** ·
 * 左侧是线路主题色的纵条 · 中间站之间给出模型预测的行驶时间 ·
 * 转车时：巴士标上一趟终点 + 写换乘站台，然后接下一条；轻轨写明换乘步行时长。
 */
import { useState } from "react";
import { lineNameOf } from "@/lib/route-label";
import type { SegmentStrip } from "@/lib/recommend/types";

export default function StationStrip({
  strip,
  color,
  last,
}: {
  strip: SegmentStrip;
  /** 该线路主题色 */
  color?: string | null;
  /** 是否为行程最后一段（决定换乘行是否渲染） */
  last?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rail = color ?? "var(--primary)";
  const mids = strip.stops.filter((s) => s.role === "mid").length;
  const board = strip.stops[0];
  const alight = strip.stops[strip.stops.length - 1];
  const est = strip.stops.some((s) => s.role === "mid" && s.level >= 3);

  return (
    <div className="rc-strip" style={{ ["--strip-color" as string]: rail }}>
      <span className="rc-strip__rail" aria-hidden="true" />

      {/* 上车站（默认显示） */}
      {board && (
        <div className="rc-strip__node rc-strip__node--end">
          <span className="rc-strip__dot" aria-hidden="true" />
          <span className="rc-strip__label">
            <span className={`rc-route rc-route--inline`} style={{ background: rail }}>
              {lineNameOf(strip.route)}
            </span>
            <b>{board.label}</b>
            <span className="rc-sub">上車</span>
          </span>
        </div>
      )}

      {/* 中间站：默认收起成一行可点的说明 */}
      {mids > 0 && !open && (
        <button className="rc-strip__toggle" onClick={() => setOpen(true)} aria-expanded={false}>
          途經 <b>{mids}</b> 站 · 車上約 <b>{strip.rideMin}</b> 分
          {est && <span className="rc-est">含估算</span>}
          <span className="rc-strip__caret">▼</span>
        </button>
      )}

      {/* 中间站：展开后逐站 + 逐跳分钟 */}
      {mids > 0 &&
        open &&
        strip.stops
          .filter((s) => s.role === "mid")
          .map((s) => (
            <div className="rc-strip__node" key={`${s.code}-${s.minToNext}`}>
              <span className="rc-strip__dot" aria-hidden="true" />
              <span className="rc-strip__label">
                {s.label}
                {s.level >= 3 && <span className="rc-est">估算</span>}
              </span>
              <span className="rc-strip__hop">{s.minToNext} 分</span>
            </div>
          ))}

      {mids > 0 && open && (
        <button className="rc-strip__toggle rc-strip__toggle--collapse" onClick={() => setOpen(false)}>
          收起中間站 <span className="rc-strip__caret">▲</span>
        </button>
      )}

      {/* 下车站（默认显示） */}
      {alight && (
        <div className="rc-strip__node rc-strip__node--end">
          <span className="rc-strip__dot rc-strip__dot--end" aria-hidden="true" />
          <span className="rc-strip__label">
            <b>{alight.label}</b>
            <span className="rc-sub">下車 · 車上約 {strip.rideMin} 分</span>
          </span>
        </div>
      )}

      {/* 转车：巴士标上一趟终点 + 换乘站台；轻轨写明换乘步行时长 */}
      {!last && strip.transferAfter && (
        <div className="rc-strip__transfer">
          <span aria-hidden="true">↕</span>
          {strip.transferAfter.sameField ? (
            <>同站台換乘 · 無需步行</>
          ) : (
            <>
              換乘步行 <b>{strip.transferAfter.minutes}</b> 分
              {strip.transferAfter.estimated && <span className="rc-est">估算</span>}
            </>
          )}
          <span className="rc-sub">（{strip.transferAfter.atLabel}）</span>
        </div>
      )}
    </div>
  );
}
