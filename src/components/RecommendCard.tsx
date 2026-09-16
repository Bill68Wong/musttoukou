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
 * ⚠️ **唯一例外**：首段档位为 1~2（要比常速更快）时，顶部大字按**该档速度**算，
 *    而「步行」那一行显示的是**常速实测均值** → 可见项之和会比大字大（相差 = 省下的秒数）。
 *    大字本身正确（「现在出门、跑到站能赶上的话几点到」），故在该行补一句
 *    `rides[0].tierHint`（「需較常速快 X 分」）说明差额，而不是改数字。
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
              {/* ★ v1.1.2：档 1~2（要小跑/冲刺）时说明差额 —— 这一行显示的是**常速**均值，
                  而顶部大字按该档速度算 ⇒ 逐项相加会比大字大。见 model.ts 同名注释。 */}
              {first?.tierHint && <span className="rc-sub">（{first.tierHint}）</span>}
            </>
          }
        />

        {card.rides.map((r, i) => (
          <div key={`${r.route}-${i}`}>
            {/* 等车（第 1 段 = 实时班次；第 2 段起：轻轨 = 绝对开出时刻，巴士 = 间隔估算） */}
            {(r.waitMin > 0 || r.liveText || !!r.liveDepartures?.length) && (
              <Row
                dot="wait"
                main={
                  r.kind === "lrt" && r.liveDepartures?.length ? (
                    /* ★ v1.0.6：轻轨首段的倒计时**只此一份**，由客户端每秒重算。
                       旧版这里还并排一个服务端冻结的文案 → 同一行出现两个数字，
                       而且两者参照系不同（冻结那份量的是「你走到站台后还要等多久」，
                       这份量的是「车还有多久到站」）→ 甚至会出现「现正到达 + 赶不上」。 */
                    <LrtEtaInline
                      lineCode={r.route}
                      departuresMs={r.liveDepartures}
                      clocks={r.liveClocks}
                      state="running"
                      directionName={null}
                    />
                  ) : (
                    <>{r.liveText || `等 ${r.waitMin} 分`}</>
                  )
                }
                aside={i === 0 && r.tierText ? <TierBadge card={card} /> : null}
              />
            )}

            {/* ★ v1.1.5：本班之外的后续班次 —— 只列「坐它的门到门总时长不差于第 5 张卡」的，
                并在右侧标出赶这一班需要的档位。动机：本班要冲刺（档 1~2）时，后面
                「正常走就能赶上」的车原本完全不显示 → 不想跑的用户以为这条线没戏。
                ⚠️ 只有首段（`i === 0`），且列车由服务端算好（`service.ts` 排序后回填）。 */}
            {i === 0 && (card.altBuses?.length ?? 0) > 0 && (
              <Row
                dot="wait"
                main={
                  <span className="rc-alts">
                    {card.altBuses!.map((a, k) => (
                      <span key={k} className="rc-alt">
                        後面還有 <b>{a.stopsAway}</b> 站 · {a.waitText}
                        <span className={`rc-tier rc-tier--${a.tier}`}>{a.tierText}</span>
                      </span>
                    ))}
                  </span>
                }
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

/**
 * 赶车分档徽章：5 档配色。
 * ★ v1.0.6：**不再有「本班赶不上，等下一班」这一档** —— 首段赶不上的路线已被整条剔除
 *   （见 `model.ts#modelOption`）。这里只可能在 5 档之间取值，兜底返回 null。
 */
function TierBadge({ card }: { card: CardData }) {
  const r0 = card.rides[0];
  if (!r0 || r0.tier === null || !r0.tierText) return null;
  return <span className={`rc-tier rc-tier--${r0.tier}`}>{r0.tierText}</span>;
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
