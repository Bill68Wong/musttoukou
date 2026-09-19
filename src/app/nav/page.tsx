/**
 * 导航结果页 `/nav`（src/app/nav/page.tsx，v1.3.0 · T04）
 *
 * SSR：服务端直接 `planNav`（高德 transit → 二次计算 → 重排 → 补漏）→ 首屏即 5 张卡。
 * ★ 卡片/详情呈现与旧版**完全一致**（复用 `RecommendCards`/`RecommendCard`，仅换 `hrefBuilder`）。
 * ★ `degraded` → 卡片区顶部细提示条（本地推算）；`emptyReason` → 空状态（简体）。
 * 设计：docs/设计-全澳导航-v1-20260918.md §2.E / §C.9 / §11
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import ComplianceBar from "@/components/nav/ComplianceBar";
import NavResultClient from "@/components/nav/NavResultClient";
import { getPool } from "@/lib/db";
import { parseNavParams } from "@/lib/nav/nav-params";
import { planNav } from "@/lib/nav/nav-service";
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

  return (
    <main className="page nav-page">
      <header className="nav-page__top">
        <Link href="/" className="btn btn--text btn--sm">
          ← 返回
        </Link>
        <span className="nav-page__od t-label">
          {p.origin.label} <span className="t-muted">→</span> {p.dest.label}
        </span>
      </header>

      <Suspense fallback={<ResultSkeleton />}>
        <ResultSection query={p.query} origin={p.origin} dest={p.dest} zone={p.zone} limit={p.limit} />
      </Suspense>

      <ComplianceBar />
    </main>
  );
}

async function ResultSection({
  query,
  origin,
  dest,
  zone,
  limit,
}: {
  query: string;
  origin: NavPoint;
  dest: NavPoint;
  zone: SchoolZone | null;
  limit: number;
}) {
  const result = await planNav(getPool(), { origin, dest, zone, limit });
  return <NavResultClient query={query} initial={result} />;
}

/** 结果区骨架（形状与卡片一致 → 零布局跳动，§11.1） */
function ResultSkeleton() {
  return (
    <div className="rc-list" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div className="card rc rc--skeleton" key={i}>
          <span className="rc-sk rc-sk--big" />
          <span className="rc-sk rc-sk--chip" />
          <span className="rc-sk rc-sk--line" />
          <span className="rc-sk rc-sk--line rc-sk--short" />
        </div>
      ))}
    </div>
  );
}
