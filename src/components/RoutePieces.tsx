/**
 * 共享展示原语（src/components/RoutePieces.tsx，v1.1.8）
 *
 * 从 `RecommendCard.tsx` 抽出的三件套 —— 详情页要用同一套东西，
 * 不抽就只能复制粘贴（两份会漂移）。
 *
 * ⚠️ 本文件**不写 `"use client"`**：三个都是纯展示（无 hooks、无事件），
 *    server component 与 client component 都能直接 import。
 */
import type { CatchTier } from "@/lib/recommend/types";

/** 澳门时刻 HH:MM（与服务端 hhmm 同口径：+8h 后取当日余秒） */
export function macauClock(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * 赶车分档徽章：5 档配色。
 * ★ v1.0.6：**不再有「本班赶不上，等下一班」这一档** —— 首段赶不上的路线已被整条剔除
 *   （见 `model.ts#modelOption`）。这里只可能在 5 档之间取值，兜底返回 null。
 *
 * ★ v1.1.8：签名由「收整个 card」改为「收 tier/tierText」——
 *   详情页的「后续班车」也要画徽章，收 card 无法复用。
 */
export function TierBadge({ tier, tierText }: { tier: CatchTier | null; tierText: string }) {
  if (tier === null || !tierText) return null;
  return <span className={`rc-tier rc-tier--${tier}`}>{tierText}</span>;
}

/** 时间线一行：圆点 + 竖线 + 内容 */
export function Row({
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
