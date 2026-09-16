"use client";
/**
 * 详情页客户端壳（src/components/card/CardDetailClient.tsx，v1.1.8）
 *
 * 自上而下（用户口径）：
 *   ① 步行信息 ② 上车站信息
 *   ③ 折叠栏 —— 本班 + 后续班车**始终显示**（本班字号更大）；**默认折叠**的是
 *      「该站台剩余所有可达线路的报站」，每条右侧可链接到它自己的详情页
 *   ④（由 `<StationStrip>` 渲染）纵向站条
 *   ⑤ 底部 步行 + 目的地 ⑥ 开发者模式按钮
 *
 * ★ zone 兜底：URL 里缺 `zone` 时用客户端 `readZone()` 补（`readZone` 在 `"use client"` 文件里，
 *   服务端调用会抛）→ 顶部给座区选择器让用户重选并重载。
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LrtEtaInline } from "@/components/LrtEta";
import RouteStack from "@/components/RouteStack";
import { macauClock, Row, TierBadge } from "@/components/RoutePieces";
import CardDevActions from "./CardDevActions";
import StationStrip from "./StationStrip";
import { useDevMode } from "@/lib/dev-mode";
import { lineNameOf } from "@/lib/route-label";
import { DEFAULT_ZONE, SCHOOL_ZONES, type CardDetailPayload, type SchoolZone } from "@/lib/recommend/types";

export default function CardDetailClient({
  fromSlug,
  toSlug,
  fromLabel,
  toLabel,
  zone,
  rank,
  initial,
  error,
}: {
  fromSlug: string;
  toSlug: string;
  fromLabel: string;
  toLabel: string;
  zone: SchoolZone | null;
  rank?: number;
  initial: CardDetailPayload | null;
  error: string | null;
}) {
  const router = useRouter();
  const devMode = useDevMode();
  const [data, setData] = useState<CardDetailPayload | null>(initial);
  const [err, setErr] = useState<string | null>(error);
  const [openFold, setOpenFold] = useState(false);
  const [busy, setBusy] = useState(false);

  /** 座区兜底：URL 缺 zone 时用本地记忆补上并重载（服务端读不到 localStorage） */
  useEffect(() => {
    if (zone) return;
    try {
      const saved = localStorage.getItem("must.zone") as SchoolZone | null;
      if (saved && ["B/C", "N/O", "R"].includes(saved)) {
        const q = new URLSearchParams(window.location.search);
        q.set("zone", saved);
        router.replace(`/card?${q.toString()}`);
      }
    } catch {
      /* 隐私模式下 localStorage 可能抛 → 忽略，页面用 DEFAULT_ZONE 展示 */
    }
  }, [zone, router]);

  async function refresh() {
    if (busy) return;
    setBusy(true);
    try {
      const q = new URLSearchParams(window.location.search);
      q.set("force", "1");
      const r = await fetch(`/api/card?${q.toString()}`, { cache: "no-store" });
      const j = (await r.json()) as ({ ok: true } & CardDetailPayload) | { ok: false; error: string };
      if (j.ok) {
        setData(j);
        setErr(null);
      } else {
        setErr(j.error);
      }
    } catch {
      setErr("重新整理失敗");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <main className="page rc-detail">
        <div className="rc-top">
          <Link href={`/recommend?from=${fromSlug}&to=${toSlug}${zone ? `&zone=${encodeURIComponent(zone)}` : ""}`} className="btn btn--text btn--sm">
            ← 返回
          </Link>
        </div>
        <div className="card rc-empty">
          <p className="t-body">
            {err === "route_changed" ? "這條路線現在的班次變了，暫時算不出來。" : (err ?? "暫時沒有資料。")}
          </p>
          <Link
            className="btn btn--outline btn--sm"
            style={{ marginTop: 12 }}
            href={`/recommend?from=${fromSlug}&to=${toSlug}${zone ? `&zone=${encodeURIComponent(zone)}` : ""}`}
          >
            返回自動選線
          </Link>
        </div>
      </main>
    );
  }

  const card = data.card;
  const first = card.rides[0];
  const colorOf = (c: string) => data.colors[c] ?? null;
  const zoneOr = zone ?? DEFAULT_ZONE;
  const zoneBadge = toSlug === "school" ? `（${zoneOr} 座）` : "";

  return (
    <main className="page rc-detail">
      <div className="rc-top">
        <Link
          href={`/recommend?from=${fromSlug}&to=${toSlug}${zone ? `&zone=${encodeURIComponent(zone)}` : ""}`}
          className="btn btn--text btn--sm"
        >
          ← 返回
        </Link>
        <button className="btn btn--text btn--sm" onClick={() => void refresh()} disabled={busy}>
          {busy ? "…" : "↻ 刷新"}
        </button>
      </div>

      <h1 className="h-headline rc-title">
        {fromLabel} → {toLabel}
        {zoneBadge && <span className="rc-zone">{zoneBadge}</span>}
      </h1>
      <p className="t-label t-muted rc-subtitle">
        {rank ? `第 ${rank} 名 · ` : ""}
        全程 {Math.round(card.totalMin)} 分 · 預計 {macauClock(card.arriveAt)} 到達
        {card.crossBorder && <span className="rc-warn"> · 不含通關</span>}
      </p>

      {/* 座区缺失时的兜底选择器（改完重载，服务端才能按座算步行） */}
      {!zone && (
        <div className="rc-zonebar">
          {SCHOOL_ZONES.map((z) => (
            <button
              key={z.value}
              className={`chip${z.value === zoneOr ? " chip--on" : ""}`}
              onClick={() => {
                const q = new URLSearchParams(window.location.search);
                q.set("zone", z.value);
                router.replace(`/card?${q.toString()}`);
              }}
            >
              {z.value} 座
            </button>
          ))}
        </div>
      )}

      {data.liveDegraded && (
        <p className="rc-warn-block" role="alert">
          實時報站暫時不可用 · 請按右上角「刷新」重試
        </p>
      )}

      {/* ① 步行信息 + ② 上车站信息 */}
      <section className="rc-block">
        <h2 className="rc-block__title">出發</h2>
        <Row
          dot="walk"
          main={
            <>
              步行 <b>{card.walkOut.minutes}</b> 分 → {card.walkOut.toLabel}
              {card.walkOut.estimated && <span className="rc-est">估算</span>}
              {first?.tierHint && <span className="rc-sub">（{first.tierHint}）</span>}
            </>
          }
        />
        <Row
          dot="wait"
          main={
            <>
              在 <b>{first?.boardLabel ?? card.walkOut.toLabel}</b> 上車
              <span className="rc-sub">
                （站台 {first?.board ?? "—"} ·{" "}
                {card.walkOut.samples ? `步行樣本 ${card.walkOut.samples} 次` : "步行為估算"}）
              </span>
            </>
          }
        />
      </section>

      {/* ③ 折叠栏 */}
      <section className="rc-block rc-fold">
        <h2 className="rc-block__title">本班車</h2>

        {/* 本班：始终显示、字号更大 */}
        {first && (
          <div className="rc-fold__first">
            <RouteStack codes={[first.route]} colorOf={colorOf} />
            <div className="rc-fold__firstline">
              {first.kind === "lrt" && first.liveDepartures?.length ? (
                <LrtEtaInline
                  lineCode={first.route}
                  departuresMs={first.liveDepartures}
                  clocks={first.liveClocks}
                  state="running"
                  directionName={null}
                />
              ) : (
                <span className="rc-fold__live">{first.liveText || `等 ${first.waitMin} 分`}</span>
              )}
              <TierBadge tier={first.tier} tierText={first.tierText} />
            </div>
            <p className="rc-fold__meta">
              {first.boardLabel} → {first.alightLabel} · 車上 <b>{first.minutes}</b> 分
            </p>
          </div>
        )}

        {/* 后续班次：始终显示、字号更小 */}
        {(card.altBuses?.length ?? 0) > 0 && (
          <div className="rc-fold__alts">
            <p className="t-label t-muted">後續班次</p>
            {card.altBuses!.map((a, k) => (
              <div className="rc-altrow" key={k}>
                <span>
                  還有 <b>{a.stopsAway}</b> 站 · {a.waitText}
                </span>
                <span className="rc-altrow__right">
                  全程 {a.totalMin} 分
                  <span className={`rc-tier rc-tier--${a.tier}`}>{a.tierText}</span>
                </span>
              </div>
            ))}
          </div>
        )}

        {/* 默认折叠：该站台剩余所有可达线路的报站 */}
        <button
          className="rc-fold__head"
          onClick={() => setOpenFold((v) => !v)}
          aria-expanded={openFold}
        >
          <span>
            本站台其他可達路線
            <span className="rc-sub">（{data.reports.length} 條 · 點擊展開）</span>
          </span>
          <span className="rc-strip__caret">{openFold ? "▲" : "▼"}</span>
        </button>

        {openFold && (
          <div className="rc-fold__body">
            {data.reports.length === 0 && <p className="t-label t-muted">（暫無資料）</p>}
            {data.reports.map((rp) => (
              <div className="rc-report" key={`${rp.route}-${rp.alightLabel}`}>
                <RouteStack codes={[rp.route]} colorOf={colorOf} size="sm" />
                <span className="rc-report__live">{rp.live ? rp.liveText : "暫無實時報站"}</span>
                <span className="rc-report__right">
                  {rp.minutes !== null ? (
                    <>
                      全程 {Math.round(rp.minutes)} 分
                      {rp.tierText && <span className={`rc-tier rc-tier--${rp.tier}`}>{rp.tierText}</span>}
                    </>
                  ) : rp.inPlan ? (
                    // 在方案表里，但本轮没有在途车（收车 / 不在营运时段）→ 不编数字
                    <span className="t-muted t-label">暫無實時車</span>
                  ) : (
                    // 方案表外的线（如 N5）→ 永远算不出门到门总时长，只展示报站
                    <span className="t-muted t-label">未收錄於方案</span>
                  )}
                  {rp.href && (
                    <Link className="rc-report__link" href={rp.href} aria-label={`看 ${lineNameOf(rp.route)} 詳情`}>
                      ›
                    </Link>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ④ 纵向站条：一趟一条 */}
      <section className="rc-block">
        <h2 className="rc-block__title">路線</h2>
        {data.strips.map((s, i) => (
          <StationStrip key={`${s.route}-${i}`} strip={s} color={colorOf(s.route)} last={i === data.strips.length - 1} />
        ))}
      </section>

      {/* ⑤ 步行 + 目的地 */}
      <section className="rc-block">
        <h2 className="rc-block__title">到達</h2>
        <Row
          dot="walk"
          last
          main={
            <>
              下車 → 步行 <b>{card.walkIn.minutes}</b> 分
              {card.walkIn.estimated && <span className="rc-est">估算</span>} → {card.walkIn.toLabel}
              {zoneBadge}
            </>
          }
        />
      </section>

      {/* ⑥ 开发者模式按钮（计时入口） */}
      {devMode && <CardDevActions card={card} zone={zone} />}

      <footer className="rc-footer">
        <p>
          {card.hints.map((h, i) => (
            <span key={i}>
              {h}
              {i < card.hints.length - 1 && <br />}
            </span>
          ))}
        </p>
      </footer>
    </main>
  );
}
