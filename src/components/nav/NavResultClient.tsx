"use client";

/**
 * 导航结果页客户端壳（src/components/nav/NavResultClient.tsx，v1.3.0 · T04）
 *
 * · 首屏卡片来自 **SSR**（`/nav` 服务端已算好）→ 直接渲染，无二次请求；
 * · 「刷新」：**保留旧卡片** + 顶部细进度线（不清空→不闪，§11.1）；
 * · `degraded=true` → 卡片区顶部**细提示条**（简体）：「路网数据暂时不可用，以下为本地推算结果」；
 * · `emptyReason` → 各自的空状态（§11.4，简体）；
 * · 卡片点击 → `/nav/detail?<同参数>&plan=<planId>`（`hrefBuilder`）。
 */
import { useCallback, useState } from "react";
import RecommendCards from "@/components/RecommendCards";
import type { RecommendCard } from "@/lib/recommend/types";
import type { NavOutput } from "@/lib/nav/nav-service";

export interface NavResultClientProps {
  /** 当前查询串（原样转发到详情页 + 刷新用） */
  query: string;
  initial: NavOutput;
}

const LOCAL_PLAN_BASE = 900_000;

const EMPTY_TEXT: Record<string, { title: string; body: string }> = {
  too_close: { title: "距离很近", body: "起点与目的地很近，建议直接步行前往。" },
  no_live: { title: "暂时没有可用的班次", body: "这个时段通往该方向的线路大多已收班，或暂时没有在途车辆。" },
  no_candidate: { title: "找不到可用路线", body: "试试更近的车站，或换一个目的地。" },
  amap_unavailable: { title: "路网数据暂时不可用", body: "本地也没能算出可用路线。请稍后重试。" },
};

export default function NavResultClient({ query, initial }: NavResultClientProps) {
  const [data, setData] = useState<NavOutput>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState("");

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setErr("");
    try {
      const res = await fetch(`/api/nav?${query}`, { cache: "no-store" });
      const json = (await res.json()) as { ok: boolean; error?: string } & Partial<NavOutput>;
      if (!json.ok) throw new Error(json.error ?? "刷新失败");
      setData({
        fromSlug: json.fromSlug ?? data.fromSlug,
        toSlug: json.toSlug ?? data.toSlug,
        cards: json.cards ?? [],
        colors: json.colors ?? {},
        degraded: json.degraded ?? false,
        emptyReason: json.emptyReason ?? undefined,
        nearbyWalkMin: json.nearbyWalkMin ?? undefined,
        provenance: json.provenance ?? {},
        excluded: json.excluded ?? [],
        missed: json.missed ?? [],
        stats: json.stats ?? data.stats,
        generatedAt: Date.now(),
      });
    } catch (e) {
      setErr((e as Error).message || "刷新失败，请稍后再试");
    } finally {
      setRefreshing(false);
    }
  }, [query, data.fromSlug, data.toSlug, data.stats]);

  const hrefBuilder = (card: RecommendCard) => {
    const sp = new URLSearchParams(query);
    sp.set("plan", String(card.planId));
    return `/nav/detail?${sp.toString()}`;
  };
  const originOf = (card: RecommendCard): "amap" | "local" =>
    card.planId >= LOCAL_PLAN_BASE ? "local" : "amap";

  const empty = data.cards.length === 0 ? EMPTY_TEXT[data.emptyReason ?? "no_candidate"] : null;

  return (
    <div className="nav-result">
      {refreshing && <span className="nav-result__progress" aria-hidden="true" />}

      <div className="nav-result__bar">
        <span className="t-label t-muted">
          {data.cards.length > 0 ? `${data.cards.length} 条路线` : "无路线"}
        </span>
        <button className="btn btn--text btn--sm" type="button" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>

      {data.degraded && (
        <div className="nav-degraded t-label">
          路网数据暂时不可用，以下为本地推算结果
        </div>
      )}
      {err && <div className="nav-inline-err t-label">{err}</div>}

      {empty ? (
        <div className="card rc-empty">
          <p className="h-title">{empty.title}</p>
          <p className="t-body t-muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
            {empty.body}
          </p>
          {data.emptyReason === "too_close" && data.nearbyWalkMin != null && (
            <p className="t-label t-muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
              步行约 <b>{data.nearbyWalkMin}</b> 分钟（比等车更快）。
            </p>
          )}
        </div>
      ) : (
        <RecommendCards
          cards={data.cards}
          colors={data.colors}
          zone={null}
          fromSlug={data.fromSlug}
          toSlug={data.toSlug}
          excluded={data.excluded}
          missed={data.missed}
          hrefBuilder={hrefBuilder}
          originOf={originOf}
        />
      )}
    </div>
  );
}
