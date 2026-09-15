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
  excluded = [],
}: {
  cards: CardData[];
  colors: Record<string, string>;
  zone: SchoolZone | null;
  /** 被排除的线路（无在途车 / 已收车）——空状态时用于解释原因 */
  excluded?: string[];
}) {
  const devMode = useDevMode();

  if (!cards.length) {
    return (
      <div className="card rc-empty">
        <p className="h-title">暫時沒有可用的班次</p>
        <p className="t-body t-muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
          現在這個時段，通往該方向的線路大多已收班或暫時沒有在途車輛。
          {excluded.length > 0 && <>（{excluded.length} 條線路無實時車輛）</>}
        </p>
        <p className="t-label t-muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
          建議：稍後再試，或改用其他交通方式。輕軌服務時間約 06:30–23:30。
        </p>
      </div>
    );
  }

  return (
    <div className="rc-list">
      {/* ★ v1.0.2：不足目标张数时说明原因（用户 2026-09-16 拍板：真实几张就几张 + 明确提示，
          不用估算卡凑满）。少的原因可能是「该时段已收班」或「暂未取到实时班次」，
          因此文案把两种可能都写上，不假装是深夜。 */}
      {cards.length < TARGET_CARDS && (
        <p
          className="t-label t-muted"
          style={{ margin: "0 2px 8px", lineHeight: 1.6 }}
        >
          目前僅 {cards.length} 條路線可用 · 其餘路線此時段已收班或暫未取到實時班次
          （列出均為實時結果，不含估算）
        </p>
      )}
      {cards.map((c, i) => (
        <RecommendCard key={`${c.planId}-${c.rides.map((r) => `${r.route}${r.alight}`).join("_")}`} card={c} colors={colors} devMode={devMode} zone={zone} rank={i + 1} />
      ))}
    </div>
  );
}
