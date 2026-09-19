"use client";

/**
 * 自动选线 · 页面壳（src/components/RecommendClient.tsx，v1.0.0）
 *
 * 职责：标题 / 刷新 / 结果区 / 页脚。**不含业务计算** —— 首屏数据由 server 组件传下来，
 * 刷新时向 `/api/recommend?force=1` 取新的一批（同一份 service，口径不可能漂移）。
 *
 * 刷新语义：`force=1` 穿透服务端 10s 缓存直算；未刷新时同一方向的重复进入会命中缓存（体感即时）。
 *
 * 页脚：合规声明摘要 + 「關於」链接（四条红线的落地见 /about；推荐属派生值，必须注明算法）。
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import DevModeToggle from "./DevModeToggle";
import RecommendCards from "./RecommendCards";
import { useDevMode } from "@/lib/dev-mode";
import type { RecommendCard, SchoolZone } from "@/lib/recommend/types";

interface Payload {
  cards: RecommendCard[];
  colors: Record<string, string>;
  /** 被排除的线路（无在途车 / 已收车） */
  excluded: string[];
  /** ★ v1.0.6：因「首段赶不上」被剔除的线路（与 excluded 分开，空状态文案要区分） */
  missed: string[];
  generatedAt: number;
  count: number;
}

/**
 * 方向标题：学校**在任一侧**都标出座区。
 * ★ v1.0.6：旧版只在 `toSlug === "school"`（去学校）时标 —— 但座区对「从学校出发」的
 *   出门步行**同样生效**（`walk_times` 是 (place, 站主码, zone) 合并键、不分出发/到达），
 *   界面不标会让人以为回程没吃座区。
 */
function DirectionTitle({
  fromSlug,
  toSlug,
  fromLabel,
  toLabel,
  zone,
}: {
  fromSlug: string;
  toSlug: string;
  fromLabel: string;
  toLabel: string;
  zone: SchoolZone | null;
}) {
  const badge = zone ? <span className="rc-zone">（{zone} 座）</span> : null;
  if (zone && toSlug === "school") {
    return (
      <>
        {fromLabel} → {toLabel}
        {badge}
      </>
    );
  }
  if (zone && fromSlug === "school") {
    return (
      <>
        {fromLabel}
        {badge} → {toLabel}
      </>
    );
  }
  return (
    <>
      {fromLabel} → {toLabel}
    </>
  );
}

export default function RecommendClient({
  fromSlug,
  toSlug,
  fromLabel,
  toLabel,
  zone,
  authed,
  initial,
}: {
  fromSlug: string;
  toSlug: string;
  fromLabel: string;
  toLabel: string;
  zone: SchoolZone | null;
  /** ★ v1.1.10：是否已过口令门 —— 开发者入口只对已登录者渲染（本页对公众公开） */
  authed: boolean;
  initial: Payload;
}) {
  const devModeRaw = useDevMode();
  // 只在已登录时开发者模式才「生效」（开关本身对公众不渲染）
  const devMode = devModeRaw && authed;
  const [data, setData] = useState<Payload>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({ from: fromSlug, to: toSlug, limit: "5", force: "1" });
      if (zone) qs.set("zone", zone);
      const res = await fetch(`/api/recommend?${qs.toString()}`, { cache: "no-store" });
      const body = (await res.json()) as {
        ok?: boolean;
        cards?: RecommendCard[];
        colors?: Record<string, string>;
        excluded?: string[];
        missed?: string[];
        stats?: unknown;
        error?: string;
      };
      if (!res.ok || !body.ok || !body.cards) throw new Error(body.error ?? "刷新失败");
      setData({
        cards: body.cards,
        colors: body.colors ?? initial.colors, // 线路色来自静态层，通常不变
        excluded: body.excluded ?? [],
        missed: body.missed ?? [],
        generatedAt: Date.now(),
        count: body.cards.length,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "刷新失败");
    } finally {
      setBusy(false);
    }
  }, [fromSlug, toSlug, zone, initial.colors]);

  // 每 30 秒自动静默刷新一次（不 force → 命中服务端 10s 缓存，网络与算力都可忽略），
  // 让停在页面上的「还有 N 站」不会越看越旧
  useEffect(() => {
    const t = setInterval(() => {
      void refresh();
    }, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const clock = new Date(data.generatedAt + 8 * 3_600_000);
  const hhmm = `${String(clock.getUTCHours()).padStart(2, "0")}:${String(clock.getUTCMinutes()).padStart(2, "0")}`;

  return (
    <main className="page">
      <header className="rc-top">
        <Link href="/" className="btn btn--text btn--sm" aria-label="返回首頁">
          ← 返回
        </Link>
        <button className="btn btn--text btn--sm" onClick={() => void refresh()} disabled={busy}>
          <span className={busy ? "anim-spin" : ""} style={{ display: "inline-block" }}>
            ↻
          </span>{" "}
          {busy ? "更新中…" : "刷新"}
        </button>
      </header>

      <h1 className="h-headline rc-title">
        <DirectionTitle
          fromSlug={fromSlug}
          toSlug={toSlug}
          fromLabel={fromLabel}
          toLabel={toLabel}
          zone={zone}
        />
      </h1>
      <p className="t-label t-muted rc-subtitle">
        现在出发 · 最快 {data.count} 条 · 更新于 {hhmm}
      </p>

      {err && <p className="t-error rc-err">{err}</p>}

      <RecommendCards
        cards={data.cards}
        colors={data.colors}
        zone={zone}
        fromSlug={fromSlug}
        toSlug={toSlug}
        excluded={data.excluded}
        missed={data.missed}
      />

      {devMode && (
        <div className="rc-devbar">
          {/* v1.0.0：旧「全部路線」列表带上门禁（DevGate），这里把方向参数一并带上 */}
          <Link
            href={`/routes?from=${encodeURIComponent(fromSlug)}&to=${encodeURIComponent(toSlug)}`}
            className="btn btn--outline btn--sm"
          >
            查看全部路线（含第 6 名以后）→
          </Link>
        </div>
      )}

      <footer className="rc-footer">
        <p>
          行驶时间为站间实测统计、步行时间为实测样本均值、轻轨按表定逐跳 2 分钟估算 —— 均可能有误差，
          请以现场为准。跨境行程不计通关时间。
        </p>
        <p>
          数据来源：澳门特别行政区交通事务局实时报站 · 澳门轻轨时刻表 ·{" "}
          {/* ★ v1.1.7：纯文字链接热区仅 ~19px，走路点不中 → .link-hit 撑到 44px */}
          <Link href="/about" className="link-hit">
            关于本专案与数据说明
          </Link>
        </p>
        <p>
          {/* ★ v1.1.11：开关**始终可见**（用户口径「开启开发者模式才需要密钥」）。
              未登录时点它 → /login；登录后即可正常开/关。与首页共用同一组件，行为一致。 */}
          <DevModeToggle authed={authed} />
        </p>
      </footer>
    </main>
  );
}
