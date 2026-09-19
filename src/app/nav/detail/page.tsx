/**
 * 导航详情页 `/nav/detail`（src/app/nav/detail/page.tsx，v1.3.0 · T04）
 *
 * 与旧 `/card` **同构**：纵向站条（一趟一条、中间站默认收起、线路主题色轨、逐跳分钟）
 * + 步行/换乘 + 到达时刻。**不做开发者模式**（设计 §2.E）。
 * 数据来源：服务端 `planNav` 找 `plan` 指定的那张卡 → `buildStrips` 由我们的逐跳解出站序。
 * 设计：docs/设计-全澳导航-v1-20260918.md §2.E / §C.9
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import type { Pool } from "pg";
import ComplianceBar from "@/components/nav/ComplianceBar";
import StationStrip from "@/components/card/StationStrip";
import RouteStack from "@/components/RouteStack";
import StationReachFold from "@/components/nav/StationReachFold";
import { LrtEtaInline } from "@/components/LrtEta";
import { Row, TierBadge, macauClock } from "@/components/RoutePieces";
import { getPool } from "@/lib/db";
import { parseNavParams } from "@/lib/nav/nav-params";
import { planNav } from "@/lib/nav/nav-service";
import { buildStrips } from "@/lib/nav/strips";
import { rangeText } from "@/lib/recommend/catch-up";
import { fetchStationLive } from "@/lib/recommend/live";
import { loadStatics, type RecStatic } from "@/lib/recommend/query";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { NavPoint } from "@/lib/nav/types";
import type { SchoolZone } from "@/lib/recommend/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const maxDuration = 30;

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const p = parseNavParams(sp);
  if (!p) redirect("/");
  const backHref = `/nav?${p.query}`;

  return (
    <main className="page rc-detail">
      <div className="rc-top">
        <Link href={backHref} className="btn btn--text btn--sm">
          ← 返回路线
        </Link>
        <span className="nav-page__od t-label">
          {p.origin.label} <span className="t-muted">→</span> {p.dest.label}
        </span>
      </div>

      <Suspense fallback={<DetailSkeleton />}>
        <DetailSection
          origin={p.origin}
          dest={p.dest}
          zone={p.zone}
          limit={Math.max(p.limit, 10)}
          planId={p.planId}
          backHref={backHref}
        />
      </Suspense>

      <ComplianceBar />
    </main>
  );
}

async function DetailSection({
  origin,
  dest,
  zone,
  limit,
  planId,
  backHref,
}: {
  origin: NavPoint;
  dest: NavPoint;
  zone: SchoolZone | null;
  limit: number;
  planId?: number;
  backHref: string;
}) {
  const pool = getPool();
  const result = await planNav(pool, { origin, dest, zone, limit });
  const card =
    (planId !== undefined ? result.cards.find((c) => c.planId === planId) : undefined) ?? result.cards[0];
  if (!card) redirect(backHref);

  const st = await loadStatics(pool);
  const weekday = new Date(result.generatedAt + 8 * 3_600_000).getUTCDay();
  const strips = buildStrips(card, {
    routeIdx: st.routeIdx,
    segIdx: st.segIdx,
    nameOf: st.routeIdx.nameOf,
    weekday,
  });
  const colorOf = (c: string) => result.colors[c] ?? null;
  const first = card.rides[0];
  const lastRide = card.rides[card.rides.length - 1];
  const lastAlightMain = lastRide ? mainCodeOf(lastRide.alight) : null;
  const otherRoutes = lastAlightMain ? otherRoutesAt(st, lastAlightMain, card.rides.map((r) => r.route)) : [];
  // ★ 【5】折叠栏「本站台其他线路」的实时报站（巴士）；失败不阻塞（收敛为空）
  const foldLive = lastAlightMain ? await foldLiveAt(pool, st, lastAlightMain, otherRoutes, result.generatedAt) : {};

  return (
    <>
      <div className="card rc-detail__head">
        <div className="rc-head__main">
          <span className="rc-total">{Math.round(card.totalMin)}</span>
          <span className="rc-total__unit">分</span>
        </div>
        <span className="rc-arrive">
          预计 <b>{macauClock(card.arriveAt)}</b> 到达
          {card.crossBorder && <span className="rc-warn"> · 不含通关</span>}
        </span>
        {/* ⚠️ Server Component：**只能传可序列化的 `colors`**，不能传 `colorOf` 函数（RSC 边界） */}
        <RouteStack codes={card.rides.map((r) => r.route)} colors={result.colors} size="sm" />
        {result.degraded && <span className="nav-degraded nav-degraded--inline t-label">本地推算</span>}
      </div>

      <div className="rc-line">
        <Row
          dot="walk"
          main={
            <>
              步行 <b>{card.walkOut.minutes}</b> 分
              {card.walkOut.estimated && <span className="rc-est">估算</span>}
              {" → "}
              {card.walkOut.toLabel}
            </>
          }
        />
        {first && (
          <Row
            dot="wait"
            main={
              /* ★ 【5】与卡片口径一致：轻轨首段的倒计时由客户端每秒重算（`LrtEtaInline`）；
                 巴士用服务端下发的报站文案（「还有 N 站 · 约 X~Y 分」= 距站信息 + 时间）。 */
              first.kind === "lrt" && first.liveDepartures?.length ? (
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
      </div>

      {/* 纵向站条：一趟一条（★【2a】范围 = 上车站 → 下车站） */}
      <div className="rc-strips">
        {strips.map((strip, i) => (
          <StationStrip
            key={`${strip.route}-${strip.board}-${i}`}
            strip={strip}
            color={colorOf(strip.route)}
            last={i === strips.length - 1}
          />
        ))}
      </div>

      <div className="rc-line">
        <Row
          dot="walk"
          last
          main={
            /* ★ 【3】下车步行引导：**下车站编号 站名 → 目的地**（不再是「步行 → 下车站编号」）。
               `card.walkIn.toLabel` = 下车站带名标签（如「C653 金峰南岸/金譽峰」）；
               `dest.label` = 目的地名。繁体站名 + 简体连接词。 */
            <>
              步行 <b>{card.walkIn.minutes}</b> 分
              {card.walkIn.estimated && <span className="rc-est">估算</span>}
              {" → "}
              <b>{card.walkIn.toLabel}</b>
              {" → "}
              {dest.label}
            </>
          }
        />
      </div>

      {/* ★ T05：本站台其他线路（折叠栏，单独实现，不动 StationStrip）；★【5】含实时报站 */}
      {lastAlightMain && (
        <StationReachFold
          stationLabel={lastRide?.alightLabel ?? lastAlightMain}
          items={otherRoutes.map((r) => ({ route: r, live: foldLive[r] ?? "" }))}
          colors={result.colors}
        />
      )}

      <div className="rc-foot">
        <span className="rc-hint t-muted">数据来源：澳门交通事务局（DSAT）· 高德地图</span>
      </div>
    </>
  );
}

/** 该主码站台**其他**可达线路（排除本卡已用的线路；按站序索引统计） */
function otherRoutesAt(st: Awaited<ReturnType<typeof loadStatics>>, main: string, used: string[]): string[] {
  const usedSet = new Set(used);
  const out = new Set<string>();
  for (const [key, stops] of st.routeIdx.dirStops) {
    const route = key.split("|")[0];
    if (usedSet.has(route)) continue;
    for (const code of stops) {
      if (mainCodeOf(code) === main) {
        out.add(route);
        break;
      }
    }
  }
  return [...out].slice(0, 16);
}

/**
 * ★ 【5】「本站台其他线路」实时报站（**巴士**）：route → 文案（「还有 N 站 · 约 X~Y 分」）。
 *
 * 口径：对每条线路，取「经过本站的第一个方向」，以**本站的下一站**为目的点
 *   （DSAT 的 `queryEta` 需要目的点来定方向、并把已过站的车排除）→ 得到该线在本站的
 *   最近一班 → 距站数 + 区间时间。**轻轨**不在本表（走时刻表，非 DSAT）；失败一律收敛为空。
 */
async function foldLiveAt(
  pool: Pool,
  st: RecStatic,
  stationMain: string,
  routes: string[],
  nowMs: number,
): Promise<Record<string, string>> {
  const weekday = new Date(nowMs + 8 * 3_600_000).getUTCDay();
  const jobs: { station: string; dest: string; routes: string[] }[] = [];
  const stopCodeOf: Record<string, string> = {};
  for (const r of routes) {
    if (r.startsWith("LRT-")) continue; // 轻轨无 DSAT 实时；折叠栏暂不含
    for (const d of st.routeIdx.dirsOf.get(r) ?? []) {
      const stops = st.routeIdx.dirStops.get(`${r}|${d}`) ?? [];
      const i = stops.findIndex((c) => mainCodeOf(c) === stationMain);
      if (i >= 0 && i + 1 < stops.length) {
        jobs.push({ station: stops[i], dest: stops[i + 1], routes: [r] });
        stopCodeOf[r] = stops[i];
        break;
      }
    }
  }
  if (!jobs.length) return {};
  const out: Record<string, string> = {};
  try {
    const live = await fetchStationLive(pool, jobs, st.routeIdx, st.segIdx, { todayWeekday: weekday, nowMs });
    for (const r of Object.keys(stopCodeOf)) {
      const b = live.get(`${r}@${stopCodeOf[r]}`)?.nearest ?? null;
      out[r] = b ? `还有 ${b.stopsAway} 站 · ${rangeText(b.loSec, b.hiSec)}` : "暂无在途车";
    }
  } catch {
    /* 实时不可用 → 收敛为空（折叠栏仍显示线路标签） */
  }
  return out;
}

function DetailSkeleton() {
  return (
    <div className="cd-sk">
      <span className="rc-sk rc-sk--big" />
      <span className="rc-sk rc-sk--line" />
      <span className="rc-sk rc-sk--line rc-sk--short" />
      <span className="rc-sk rc-sk--line" />
    </div>
  );
}
