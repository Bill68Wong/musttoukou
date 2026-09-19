"use client";

/**
 * 自动选线 · 卡片列表（src/components/RecommendCards.tsx，v1.0.0）
 *
 * 只负责渲染：把 `RecommendCard[]` 铺成一组大卡，并统一注入线路色 / 开发者模式 / 座区。
 * 数据来源由父级决定（SSR 首屏来自 server 组件；刷新后来自 `/api/recommend`）。
 *
 * 空状态：深度时段多数线路已收班 / 无在途车 → 0 张卡时给明确原因与出口，
 *   不留白屏（计划 §7.1）。
 */
import RecommendCard from "./RecommendCard";
import { useDevMode } from "@/lib/dev-mode";
import type { RecommendCard as CardData, SchoolZone } from "@/lib/recommend/types";

/** UI 目标卡数（用户门槛：点首页卡 2 秒内看到 5 张）；实际不足时给出原因说明 */
const TARGET_CARDS = 5;

export default function RecommendCards({
  cards,
  colors,
  zone,
  fromSlug,
  toSlug,
  excluded = [],
  missed = [],
  hrefBuilder,
  originOf,
}: {
  cards: CardData[];
  colors: Record<string, string>;
  zone: SchoolZone | null;
  /** ★ v1.1.8：卡片点击要跳详情页，需要带上起终点（详情页 URL 契约） */
  fromSlug: string;
  toSlug: string;
  /** 被排除的线路（无在途车 / 已收车）——不足目标张数 / 空状态时用于解释原因 */
  excluded?: string[];
  /** ★ v1.0.6：因「首段赶不上」被剔除的路线（与 excluded 分开，文案要说实话） */
  missed?: string[];
  /** ★ v1.3.0（全澳导航）：覆盖点击跳转（如 `/nav/detail?…`） */
  hrefBuilder?: (card: CardData) => string;
  /** ★ v1.3.0：来源（本地补漏 → 卡片带中性徽章「其他组合」） */
  originOf?: (card: CardData) => "amap" | "local";
}) {
  const devMode = useDevMode();

  // 剔除原因（分两类：没车 vs 赶不上）—— 合并成一个数组只用于文案拼接
  // ★ P1-2（T05 修复）：界面文案**一律简体**（站名/线路名才用繁体）—— 旧版此处是简繁混排 bug
  const reasons: string[] = [];
  if (excluded.length > 0) reasons.push(`${excluded.length} 条线路无实时车辆`);
  if (missed.length > 0) reasons.push(`${missed.length} 条路线赶不上首班车`);

  if (!cards.length) {
    return (
      <div className="card rc-empty">
        <p className="h-title">暂时没有可用的班次</p>
        <p className="t-body t-muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
          现在这个时段，通往该方向的线路大多已收班或暂时没有在途车辆。
          {reasons.length > 0 && <>（{reasons.join("・")}）</>}
        </p>
        <p className="t-label t-muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
          建议：稍后再试，或改用其他交通方式。轻轨服务时间约 06:30–23:30。
        </p>
      </div>
    );
  }

  return (
    <div className="rc-list">
      {/* ★ v1.0.2：不足目标张数时说明原因（用户 2026-09-16 拍板：真实几张就几张 + 明确提示，
          不用估算卡凑满）。★ v1.0.6：原因分两类——「没实时车」与「首班赶不上」，
          后者已整条剔除而不是塞一张带估算等车的卡。 */}
      {cards.length < TARGET_CARDS && (
        <p className="t-label t-muted" style={{ margin: "0 2px 8px", lineHeight: 1.6 }}>
          目前仅有 {cards.length} 条路线可用
          {reasons.length > 0 && <>・{reasons.join("・")}</>}
          （均为实时结果，不含估算）
        </p>
      )}
      {cards.map((c, i) => (
        <RecommendCard
          key={`${c.planId}-${c.rides.map((r) => `${r.route}${r.alight}`).join("_")}`}
          card={c}
          colors={colors}
          devMode={devMode}
          zone={zone}
          rank={i + 1}
          fromSlug={fromSlug}
          toSlug={toSlug}
          hrefOverride={hrefBuilder?.(c)}
          origin={originOf?.(c)}
          /* ★ v1.1.8：入场错峰（原先 5 张卡同时同速上浮，既没方向感也白花一次动画预算） */
          delayMs={i * 40}
        />
      ))}
    </div>
  );
}
