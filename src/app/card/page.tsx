/**
 * 预测卡片**详情页**（src/app/card/page.tsx，v1.1.8）
 *
 * 用户口径（2026-09-16）：点预测卡片进这里，详情页承载全部信息 ——
 *   ① 步行信息 ② 上车站信息 ③ 折叠栏（本班 + 后续班车**不折叠**；默认折叠的是
 *   「该站台剩余所有可达线路的报站」，每条旁可链接到各自详情页）
 *   ④ 纵向站条（一趟一条、中间站默认收起、左侧线路主题色轨、中间站之间给预测行驶时间）
 *   ⑤ 底部步行 + 目的地 ⑥ 开发者模式按钮（计时入口已迁到此处）
 *
 * ⚠️ SSR：深链/分享第一屏即有内容，无需客户端二次请求。
 * ⚠️ `zone` 缺失时由**客户端**补（`readZone()` 在 `"use client"` 文件里，服务端调用会抛）。
 */
import { redirect } from "next/navigation";
import { Suspense } from "react";
import CardDetailClient from "@/components/card/CardDetailClient";
import { getPool } from "@/lib/db";
import { PLACE_SHORT } from "@/lib/home-plans-shared";
import { isAuthed } from "@/lib/auth-server";
import { cardDetail } from "@/lib/recommend/card";
import { parseCardQuery } from "@/lib/recommend/card-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";

const labelOf = (slug: string) => PLACE_SHORT[slug] ?? slug;

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const p = parseCardQuery(sp);
  // 必填项不全 → 回列表页（不猜、不显示半成品）
  if (!p) redirect("/recommend");

  return (
    <Suspense fallback={<CardSkeleton />}>
      <DetailSection
        params={p}
        fromLabel={labelOf(p.from)}
        toLabel={labelOf(p.to)}
        rank={p.rank}
      />
    </Suspense>
  );
}

async function DetailSection({
  params,
  fromLabel,
  toLabel,
  rank,
}: {
  params: NonNullable<ReturnType<typeof parseCardQuery>>;
  fromLabel: string;
  toLabel: string;
  rank?: number;
}) {
  const r = await cardDetail(getPool(), {
    fromSlug: params.from,
    toSlug: params.to,
    zone: params.zone,
    limit: params.limit,
    planId: params.plan,
    route: params.route,
    board: params.board,
    alight: params.alight,
  });
  // ★ v1.1.10：开发者入口（開始計時）只对已过口令门的人渲染（本页对公众公开）
  const authed = await isAuthed();

  return (
    <CardDetailClient
      fromSlug={params.from}
      toSlug={params.to}
      fromLabel={fromLabel}
      toLabel={toLabel}
      zone={params.zone}
      rank={rank}
      authed={authed}
      initial={r.ok ? r.data : null}
      error={r.ok ? null : r.error}
    />
  );
}

/** 路由级骨架（形状与真内容一致，避免填充时跳动） */
function CardSkeleton() {
  return (
    <main className="page rc-detail">
      <div className="rc-top">
        <span className="btn btn--text btn--sm">← 返回</span>
      </div>
      <div className="cd-sk">
        <span className="rc-sk rc-sk--big" />
        <span className="rc-sk rc-sk--line" />
        <span className="rc-sk rc-sk--line rc-sk--short" />
        <span className="rc-sk rc-sk--line" />
      </div>
    </main>
  );
}
