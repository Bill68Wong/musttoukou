"use client";

/**
 * 自动选线 · 路线大卡片（src/components/RecommendCard.tsx，v1.0.0）
 *
 * 信息层级参照 Google Maps 的路线条目、排版密度参照 M3 —— 但**颜色全走现有令牌**，
 * 跟随 `prefers-color-scheme`，不固定白底（暗色系统下不刺眼）。
 *
 * 时间线自上而下 = 门到门的真实推进顺序：
 *   步行出门 → [等车 → 乘车] ×N（段间插换乘行）→ 步行进校
 * 每行的分钟数之和 + 各段等车 = 卡片顶部的大字总用时（可加总核对，不留缺口）。
 *
 * 点击行为由**开发者模式**分流：
 *   · 开 → `POST /api/timer` 建会话（带上本条的线路/上下车站/座区）→ `/timer/[id]` 打点计时
 *   · 关 → 就地展开 `hints[]`（「在哪上车、坐几站、到哪换乘」的文字指引）
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LrtEtaInline } from "./LrtEta";
import RouteStack from "./RouteStack";
import { lineNameOf } from "@/lib/route-label";
import type { RecommendCard as CardData, SchoolZone } from "@/lib/recommend/types";

/** 澳门时刻 HH:MM（与服务端 hhmm 同口径：+8h 后取当日余秒） */
function macauClock(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export default function RecommendCard({
  card,
  colors,
  devMode,
  zone,
  rank,
}: {
  card: CardData;
  /** 线路码 → 主题色（服务端下发） */
  colors: Record<string, string>;
  /** 开发者模式：开 = 点卡进计时；关 = 点卡展开文字指引 */
  devMode: boolean;
  /** 澳科大座区（建会话时要随之上报，供步行统计分座） */
  zone: SchoolZone | null;
  /** 名次（1 起）：仅用于副标题文案 */
  rank: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const colorOf = (c: string) => colors[c] ?? null;
  const first = card.rides[0];

  /** 开发者模式：按本条的线路 + 上下车站 + 座区建计时会话 */
  async function startTimer() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/timer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          planId: card.planId,
          route: first.route,
          board: first.board,
          alight: first.alight,
          zone,
        }),
      });
      const body = (await res.json()) as { sessionId?: number; error?: string };
      if (!res.ok || !body.sessionId) throw new Error(body.error ?? "创建会话失败");
      router.push(`/timer/${body.sessionId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "创建会话失败");
      setBusy(false);
    }
  }

  function onClick() {
    if (devMode) void startTimer();
    else setOpen((v) => !v);
  }

  return (
    <div
      className={`card rc${devMode ? " rc--dev" : ""} anim-fade-up`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      aria-label={`第 ${rank} 名，全程 ${Math.round(card.totalMin)} 分钟`}
    >
      {/* ── 头部：总用时 + 线路组合标签 ── */}
      <div className="rc-head">
        <div className="rc-head__main">
          <span className="rc-total">{Math.round(card.totalMin)}</span>
          <span className="rc-total__unit">分</span>
        </div>
        <RouteStack codes={card.rides.map((r) => r.route)} colorOf={colorOf} size="sm" />
      </div>

      {/* ── 时间线 ── */}
      <div className="rc-line">
        <Row
          dot="walk"
          main={
            <>
              步行 <b>{card.walkOut.minutes}</b> 分 → {card.walkOut.toLabel}
              {card.walkOut.estimated && <span className="rc-est">估算</span>}
            </>
          }
        />

        {card.rides.map((r, i) => (
          <div key={`${r.route}-${i}`}>
            {/* 等车（含第 2 段起；巴士第 2 段为间隔估算，文案已注明） */}
            {(r.waitMin > 0 || r.liveText) && (
              <Row
                dot="wait"
                main={
                  <>
                    {r.liveText || `等 ${r.waitMin} 分`}
                    {r.kind === "lrt" && r.liveDepartures?.length ? (
                      <>
                        {" · "}
                        <LrtEtaInline
                          lineCode={r.route}
                          departuresMs={r.liveDepartures}
                          clocks={r.liveClocks}
                          state="running"
                          directionName={null}
                        />
                      </>
                    ) : null}
                  </>
                }
                aside={i === 0 && r.tierText ? <TierBadge card={card} /> : null}
              />
            )}

            {/* 乘车 */}
            <Row
              dot="ride"
              main={
                <>
                  <span className="rc-route" style={{ background: colorOf(r.route) ?? "var(--primary)" }}>
                    {lineNameOf(r.route)}
                  </span>
                  <b>{r.minutes}</b> 分
                  {r.waitMin > 0 && <span className="rc-sub">（含等車 {r.waitMin} 分）</span>}
                  <span className="rc-pair">
                    {r.boardLabel} → {r.alightLabel}
                  </span>
                </>
              }
            />

            {/* 换乘 */}
            {card.transfers[i] && (
              <Row
                dot="transfer"
                main={
                  <>
                    {card.transfers[i].sameField ? (
                      <>同站台換乘 · 無需步行</>
                    ) : (
                      <>
                        換乘步行 <b>{card.transfers[i].minutes}</b> 分
                        {card.transfers[i].estimated && <span className="rc-est">估算</span>}
                      </>
                    )}
                    <span className="rc-sub">（{card.transfers[i].atLabel}）</span>
                  </>
                }
              />
            )}
          </div>
        ))}

        <Row
          dot="walk"
          main={
            <>
              下車 → 步行 <b>{card.walkIn.minutes}</b> 分
              {card.walkIn.estimated && <span className="rc-est">估算</span>}
              {" → "}
              {card.walkIn.toLabel}
              {card.toSlug === "school" && zone ? `（${zone} 座）` : ""}
            </>
          }
          last
        />
      </div>

      {/* ── 底部：到达时刻 / 提示 ── */}
      <div className="rc-foot">
        <span>
          預計 <b>{macauClock(card.arriveAt)}</b> 到達
          {card.crossBorder && <span className="rc-warn"> · 不含通關</span>}
        </span>
        <span className="rc-hint">
          {devMode ? (busy ? "開啟中…" : "點擊開始計時") : open ? "收起指引" : "點擊看指引"}
        </span>
      </div>

      {err && <p className="t-error rc-err">{err}</p>}

      {/* 非开发者模式：展开文字指引 */}
      {!devMode && open && (
        <ol className="rc-hints">
          {card.hints.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** 赶车分档徽章：5 档配色 + 连冲刺都赶不上时的「等下一班」 */
function TierBadge({ card }: { card: CardData }) {
  const tier = card.rides[0]?.tier ?? null;
  const text = card.rides[0]?.tierText || "本班趕不上，等下一班";
  return (
    <span className={`rc-tier rc-tier--${tier ?? "miss"}`}>
      {tier === null ? "🚏 " : ""}
      {text}
    </span>
  );
}

/** 时间线一行：圆点 + 竖线 + 内容 */
function Row({
  dot,
  main,
  aside,
  last,
}: {
  dot: "walk" | "wait" | "ride" | "transfer";
  main: React.ReactNode;
  aside?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`rc-row rc-row--${dot}${last ? " rc-row--last" : ""}`}>
      <span className={`rc-dot rc-dot--${dot}`} aria-hidden="true">
        {dot === "walk" ? "🚶" : dot === "wait" ? "🚏" : dot === "transfer" ? "↕" : ""}
      </span>
      <span className="rc-text">{main}</span>
      {aside}
    </div>
  );
}
