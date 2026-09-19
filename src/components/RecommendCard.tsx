"use client";

/**
 * 自动选线 · 路线大卡片（src/components/RecommendCard.tsx，v1.0.0 / v1.1.8 精简）
 *
 * ── ★ v1.1.8 精简（用户 2026-09-16 口径）──────────────────────────────
 * 外卡片只留「决策坐哪条线」必需的：
 *   步行 → 坐的車 → 步行 · 總時長 · 到達時刻 · 最近能趕上的那班的**報站 + 趕車分檔** ·
 *   **上車地點** · 後續班次（一班一行、字號比本班小）。
 * 全部细节（换乘、逐站、站台其他线路、文字指引）**移到详情页** —— 点卡片即进 `/card`。
 *
 * 点击行为（v1.1.8 改）：**一律 `router.push` 到详情页**，不再分流。
 *   · 旧行为：开发者模式 → 建计时会话；否则 → 就地展开文字指引。两者**都已移走**。
 *   · 建会话现在只在详情页的开发者按钮里（`card/CardDevActions.tsx`）。
 *   · `.rc--dev` 绿点保留，表示「进详情页后能開計時」。
 *
 * 信息层级参照 Google Maps 的路线条目、排版密度参照 M3 —— 颜色全走现有令牌，
 * 跟随 `prefers-color-scheme`。
 */
import { useRouter } from "next/navigation";
import { LrtEtaInline } from "./LrtEta";
import RouteStack from "./RouteStack";
import { macauClock, Row, TierBadge } from "./RoutePieces";
import { lineNameOf } from "@/lib/route-label";
import { buildCardHref } from "@/lib/recommend/card-link";
import { usePressGuard } from "@/lib/use-press-guard";
import type { RecommendCard as CardData, SchoolZone } from "@/lib/recommend/types";

export default function RecommendCard({
  card,
  colors,
  devMode,
  zone,
  rank,
  fromSlug,
  toSlug,
  delayMs,
  hrefOverride,
  origin,
}: {
  card: CardData;
  /** 线路码 → 主题色（服务端下发） */
  colors: Record<string, string>;
  /** 开发者模式：仅影响右上角绿点（「进详情页后能開計時」） */
  devMode: boolean;
  /** 澳科大座区 */
  zone: SchoolZone | null;
  /** 名次（1 起） */
  rank: number;
  fromSlug: string;
  toSlug: string;
  /** ★ v1.1.8：入场错峰（列表按 i*40ms 传入） */
  delayMs?: number;
  /**
   * ★ v1.3.0（全澳导航）：**覆盖点击跳转目标**（如 `/nav/detail?...`）。
   * 传了则**不再**走旧 `buildCardHref`（旧链路零影响）。
   */
  hrefOverride?: string;
  /** ★ v1.3.0：来源徽章 —— 'local' = 本地补漏（中性文案「其他组合」，§B.5）；'amap' 不显示 */
  origin?: "amap" | "local";
}) {
  const router = useRouter();
  /** ★ v1.1.8：整卡可点 + 列表要滚动 → 位移 >8px 或长按 >700ms 判为滚动，不触发跳转 */
  const press = usePressGuard();
  const colorOf = (c: string) => colors[c] ?? null;
  const first = card.rides[0];
  const multi = card.rides.length > 1;

  function onClick() {
    if (press.isGuarded()) return;
    if (!first) return;
    if (hrefOverride) {
      router.push(hrefOverride);
      return;
    }
    router.push(
      buildCardHref({
        from: fromSlug,
        to: toSlug,
        zone,
        plan: card.planId,
        route: first.route,
        board: first.board,
        alight: first.alight,
        rank,
      }),
    );
  }

  return (
    <div
      className={`card rc${devMode ? " rc--dev" : ""} anim-fade-up`}
      role="button"
      tabIndex={0}
      onPointerDown={press.onPointerDown}
      onPointerMove={press.onPointerMove}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      style={delayMs ? { animationDelay: `${delayMs}ms` } : undefined}
      aria-label={`第 ${rank} 名，全程 ${Math.round(card.totalMin)} 分钟，预计 ${macauClock(card.arriveAt)} 到达，点击看详情`}
    >
      {/* ── 头部：总用时 + 到达 + 线路组合标签 ── */}
      <div className="rc-head">
        <div className="rc-head__main">
          <span className="rc-total">{Math.round(card.totalMin)}</span>
          <span className="rc-total__unit">分</span>
        </div>
        <span className="rc-arrive">
          预计 <b>{macauClock(card.arriveAt)}</b> 到达
          {card.crossBorder && <span className="rc-warn"> · 不含通关</span>}
        </span>
        {origin === "local" && <span className="rc-badge-local">其他組合</span>}
        <RouteStack codes={card.rides.map((r) => r.route)} colorOf={colorOf} size="sm" />
      </div>

      {/* ── 时间线（精简版：步行 → 坐的車 → 步行）── */}
      <div className="rc-line">
        <Row
          dot="walk"
          main={
            <>
              步行 <b>{card.walkOut.minutes}</b> 分
              {card.walkOut.estimated && <span className="rc-est">估算</span>}
              {first?.tierHint && <span className="rc-sub">（{first.tierHint}）</span>}
            </>
          }
        />

        {/* 报站 + 赶车分档（只在首段） */}
        {first && (first.waitMin > 0 || first.liveText || !!first.liveDepartures?.length) && (
          <Row
            dot="wait"
            main={
              first.kind === "lrt" && first.liveDepartures?.length ? (
                /* ★ v1.0.6：轻轨首段的倒计时**只此一份**，由客户端每秒重算 */
                <LrtEtaInline
                  lineCode={first.route}
                  departuresMs={first.liveDepartures}
                  clocks={first.liveClocks}
                  state="running"
                  directionName={null}
                />
              ) : (
                <>{first.liveText || `等 ${first.waitMin} 分`}</>
              )
            }
            aside={first.tierText ? <TierBadge tier={first.tier} tierText={first.tierText} /> : null}
          />
        )}

        {/* ★ v1.1.8 新增：上车地点（用户口径「這班車下面上車地點信息，寫清楚在哪裏上車」） */}
        {first && (
          <Row
            dot="wait"
            main={
              <>
                <span className="rc-board">上车 · {first.boardLabel}</span>
                <span className="rc-sub">
                  {multi ? `共 ${card.rides.length} 段 · 详情见路线图` : `下车 · ${first.alightLabel}（行车 ${first.minutes} 分）`}
                </span>
              </>
            }
          />
        )}

        {/* 乘车（多段压成一行）*/}
        <Row
          dot="ride"
          main={
            <>
              {multi ? (
                <RouteStack codes={card.rides.map((r) => r.route)} colorOf={colorOf} size="sm" />
              ) : (
                <span className="rc-route" style={{ background: colorOf(card.rides[0].route) ?? "var(--primary)" }}>
                  {lineNameOf(card.rides[0].route)}
                </span>
              )}
              <b>{card.rides.reduce((s, r) => s + r.minutes, 0)}</b> 分
            </>
          }
        />
        <Row
          dot="walk"
          last
          main={
            <>
              步行 <b>{card.walkIn.minutes}</b> 分
              {card.walkIn.estimated && <span className="rc-est">估算</span>}
              {" → "}
              {card.walkIn.toLabel}
              {toSlug === "school" && zone ? `（${zone} 座）` : ""}
            </>
          }
        />
      </div>

      {/* ── 后续班次：一班一行、字号比本班小 ── */}
      {(card.altBuses?.length ?? 0) > 0 && (
        <div className="rc-altrows">
          {card.altBuses!.map((a, k) => (
            <div className="rc-altrow" key={k}>
              <span>
                后面还有 <b>{a.stopsAway}</b> 站 · {a.waitText}
              </span>
              <span className="rc-altrow__right">
                全程 {a.totalMin} 分
                <span className={`rc-tier rc-tier--${a.tier}`}>{a.tierText}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="rc-foot">
        <span className="rc-hint">点击看详情 ›</span>
      </div>
    </div>
  );
}
