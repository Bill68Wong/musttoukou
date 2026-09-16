/**
 * 预测卡片**详情页**编排（src/lib/recommend/card.ts，v1.1.8）
 *
 * ⚠️ server-only（含 pg）—— client 组件**禁止** import 本模块；视图类型走 `./types`。
 *
 * 用户口径（2026-09-16）：
 *   · 折叠栏 = 该站台**剩余所有能到达目的地的路线**的报站；报站的车辆 = 第一辆 + 速度优于第 N 张卡的车
 *   · 站条 = **一趟一条**；中间站默认收起；左侧线路主题色轨；中间站之间给模型预测行驶时间
 *   · 详情页承担全部信息，外卡片只留摘要
 *
 * 三条必须守住的事实（已在实现里落实）：
 *   1. **站条的逐跳站点直接用 seed 的 `segments[].hops`** —— 而 `model.ts` 的车上时长正是
 *      `rideOfHops(segIdx, route, seg.hops, weekday)` 逐跳累加 ⇒ 用同一串 hops + 同一个
 *      `lookupHop` 算出的 `rideMin` 与卡片上的 `rides[i].minutes` **逐秒一致**。
 *      ⚠️ 禁止「站数 × 常数」（项目铁律）。
 *   2. **方案表外的线路没有 seed**（如 `N5`）⇒ 算不出总时长 → `minutes: null`，只展报站。
 *   3. 折叠栏那一批实时数据加**软闸**：整体超时 → `reports: []` + `liveDegraded: true`，绝不造假数据。
 */
import type { Pool } from "pg";
import { modelOption } from "./model";
import { optionsFor, contextFor, loadStatics, type RecStatic } from "./query";
import { lookupHop } from "./segment-lookup";
import { recommend } from "./service";
import { destCodesFor, reachableFrom, kindOfRoute } from "./station-routes";
import { fetchStationLive } from "./live";
import { queryLrtDepartures } from "@/lib/lrt/next-departures";
import { buildCardHref } from "./card-link";
import type {
  CardDetailPayload,
  CatchTier,
  ReachReport,
  RecommendCard,
  SchoolZone,
  SegmentStrip,
  StripStop,
} from "./types";
import { LRT_MIN_PER_HOP } from "./types";

/** 折叠栏那一批实时数据的软闸（毫秒）——超时则整体降级，不让详情页卡死 */
const REPORT_DEADLINE_MS = 2_500;

/** 给 promise 加软闸；超时抛 `timeout:report` */
function withDeadline<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout:${tag}`)), ms)),
  ]);
}

export interface CardDetailInput {
  fromSlug: string;
  toSlug: string;
  zone: SchoolZone | null;
  limit?: number;
  /** 命中条件四元组（planId 不唯一，必须带 route/board/alight） */
  planId: number;
  route: string;
  board: string;
  alight: string;
  force?: boolean;
  nowMs?: number;
}

/**
 * 组织详情页数据。
 * @returns `card: null` = 该路线当前算不出卡（实时班次漂移 / 该线已收车）→ 页面提示「返回自動選線」
 */
export async function cardDetail(
  pool: Pool,
  input: CardDetailInput,
): Promise<{ ok: true; data: CardDetailPayload } | { ok: false; error: string }> {
  const limit = Math.max(1, Math.min(20, input.limit ?? 5));

  // ① 复用同一份 service 与它的 10s 缓存（不另开缓存层）
  const rec = await recommend(pool, {
    fromSlug: input.fromSlug,
    toSlug: input.toSlug,
    zone: input.zone,
    limit,
    force: input.force,
    nowMs: input.nowMs,
  });
  const thresholdMin = rec.cards.length ? rec.cards[rec.cards.length - 1]!.totalMin : Number.POSITIVE_INFINITY;

  // ② 命中卡（planId 不唯一 → 必须四元组）
  const card: RecommendCard | undefined = rec.cards.find((c) => {
    const r0 = c.rides[0];
    return c.planId === input.planId && r0?.route === input.route && r0.board === input.board && r0.alight === input.alight;
  });
  if (!card) return { ok: false, error: "route_changed" };

  // ③ 静态层（Data Cache 命中，几乎零成本）
  const st: RecStatic = await loadStatics(pool);
  const nowMs = input.nowMs ?? Date.now();
  const todayWeekday = new Date(nowMs + 8 * 3_600_000).getUTCDay();

  // ④ 站条：每段载具一条。逐跳站点取 **seed 自己的 hops**（见文件头事实 1）
  const seeds = optionsFor(st, input.fromSlug, input.toSlug);
  const seed = seeds.find((s) => {
    const g0 = s.segments[0];
    return s.planId === input.planId && g0?.route === input.route && g0.board === input.board && g0.alight === input.alight;
  });
  const strips: SegmentStrip[] = [];
  for (let i = 0; i < card.rides.length; i++) {
    const ride = card.rides[i]!;
    const seg = seed?.segments[i];
    const hops = seg?.hops ?? [];
    // 用同一串 hops 逐跳取值 → 与 card.rides[i].minutes 同源同值
    let sum = 0;
    const stops: StripStop[] = [];
    for (let k = 0; k < hops.length; k++) {
      const [a, b] = hops[k]!;
      const hit = ride.kind === "lrt" ? { minutes: LRT_MIN_PER_HOP, level: 2 } : lookupHop(st.segIdx, ride.route, a, b, todayWeekday);
      sum += hit.minutes;
      stops.push({
        code: a,
        label: st.routeIdx.nameOf.get(a) ?? a,
        minToNext: hit.minutes,
        level: hit.level,
        role: k === 0 ? "board" : "mid",
      });
    }
    if (stops.length) {
      const lastStop = stops[stops.length - 1]!;
      lastStop.minToNext = 0;
      lastStop.level = 0;
      lastStop.role = "alight";
    }
    strips.push({
      route: ride.route,
      kind: ride.kind,
      board: ride.board,
      alight: ride.alight,
      boardLabel: ride.boardLabel,
      alightLabel: ride.alightLabel,
      stops,
      // ⚠️ 用逐跳累加值；与卡片同源（hops 相同、lookupHop 相同）→ 断言相等
      rideMin: Math.round(sum * 10) / 10,
      transferAfter: card.transfers[i] ?? null,
    });
  }

  // ⑤ 折叠栏：该站台**全部可达线路**（不只本卡方案表）
  const destCodes = destCodesFor(st, input.toSlug);
  const reachable = reachableFrom(st.routeIdx, input.board, destCodes);

  // 每条线在自己的下车站上取值（不同线的 alight 不同 → 必须各自建 job）
  const busJobs = reachable
    .filter((r) => r.kind === "bus")
    .map((r) => ({ station: input.board, dest: r.alights[0]!, routes: [r.route] }));

  let reports: ReachReport[] = [];
  let liveDegraded = false;
  try {
    const liveMap = await withDeadline(
      fetchStationLive(pool, busJobs, st.routeIdx, st.segIdx, { todayWeekday, nowMs }),
      REPORT_DEADLINE_MS,
      "report",
    );
    reports = await buildReports(pool, st, input, card, reachable, liveMap, seeds, nowMs, todayWeekday, thresholdMin);
  } catch {
    liveDegraded = true;
    reports = [];
  }

  return {
    ok: true,
    data: {
      fromSlug: input.fromSlug,
      toSlug: input.toSlug,
      zone: input.zone,
      card,
      colors: rec.colors,
      strips,
      reports,
      thresholdMin,
      generatedAt: rec.generatedAt,
      liveDegraded,
    },
  };
}

/** 组装折叠栏的行：每线取「第一辆可赶车 + 优于阈值的后车」，并用 `modelOption` 复算总时长 */
async function buildReports(
  pool: Pool,
  st: RecStatic,
  input: CardDetailInput,
  card: RecommendCard,
  reachable: ReturnType<typeof reachableFrom>,
  liveMap: Awaited<ReturnType<typeof fetchStationLive>>,
  seeds: ReturnType<typeof optionsFor>,
  nowMs: number,
  todayWeekday: number,
  thresholdMin: number,
): Promise<ReachReport[]> {
  const out: ReachReport[] = [];
  const ctx = contextFor(st, nowMs, input.zone, liveMap as Map<string, never>);

  for (const r of reachable) {
    const alight = r.alights[0]!;
    const alightLabel = `${alight} ${st.routeIdx.nameOf.get(alight) ?? ""}`.trim();
    const boardLabel = `${input.board} ${st.routeIdx.nameOf.get(input.board) ?? ""}`.trim();

    // 找该线的 seed（同线路 + 同方向的上车站）→ 用 modelOption 复算门到门总时长
    const seed = seeds.find((s) => {
      const g0 = s.segments[0];
      return g0 && g0.route === r.route && (g0.board === input.board || g0.board.split("/")[0] === input.board.split("/")[0]);
    });

    let minutes: number | null = null;
    /** 是否出现在在用方案表里（有 seed）—— `minutes === null` 时必须靠它区分两种成因 */
    const inPlan = !!seed;
    let tier: CatchTier | null = null;
    let tierText = "";
    let liveText = "";
    let liveDepartures: number[] | undefined;
    let liveClocks: string[] | undefined;
    let live = false;
    let href: string | null = null;

    if (r.kind === "bus") {
      const lv = liveMap.get(`${r.route}@${input.board}`);
      if (lv && !lv.empty) {
        live = true;
        const n = lv.nearest;
        liveText = n ? `還有 ${n.stopsAway} 站 · 約 ${Math.max(1, Math.round(n.loSec / 60))}~${Math.max(1, Math.round(n.hiSec / 60))} 分` : "有車";
        // ★ 只把该线自己的 live 注入模型，避免其它线的实时数据污染（model.ts 的取用键是 route）
        if (seed) {
          const m = modelOption(seed, { ...ctx, live: new Map([[r.route, lv]]) as never });
          if (m) {
            minutes = m.card.totalMin;
            tier = m.card.rides[0]?.tier ?? null;
            tierText = m.card.rides[0]?.tierText ?? "";
            href = buildCardHref({
              from: input.fromSlug,
              to: input.toSlug,
              zone: input.zone,
              plan: m.card.planId,
              route: r.route,
              board: m.card.rides[0]!.board,
              alight: m.card.rides[0]!.alight,
              limit: input.limit,
            });
          }
        }
        if (!href) {
          href = buildCardHref({
            from: input.fromSlug, to: input.toSlug, zone: input.zone,
            plan: seed?.planId ?? card.planId, route: r.route, board: input.board, alight, limit: input.limit,
          });
        }
      } else {
        // ★ v1.1.8 修正：原先这里直接把 minutes 留成 null → 会和「方案表外」混为一谈。
        //   现在 minutes 仍为 null（本轮确实没有车、算不出门到门时长），
        //   但 UI 靠 inPlan 区分文案：「暫無實時車」（在方案里但没车）vs「未收錄於方案」（没 seed）。
        liveText = "暫無實時車";
      }
    } else {
      // 轻轨：直接问下一班（**必须带 pre**，否则线上跨洲往返恒定超时）
      try {
        const res = await queryLrtDepartures(pool, {
          station: input.board,
          route: r.route,
          dest: alight,
          take: 6,
          nowMs,
          pre: st.lrtPre,
        });
        if (res.ok && res.departures.length) {
          live = true;
          liveDepartures = res.departures.map((d) => d.depMs);
          liveClocks = res.departures.map((d) => d.clock);
          liveText = `${liveClocks[0]} 開出`;
        } else {
          liveText = "暫無實時報站";
        }
      } catch {
        liveText = "暫無實時報站";
      }
      href = buildCardHref({
        from: input.fromSlug, to: input.toSlug, zone: input.zone,
        plan: seed?.planId ?? card.planId, route: r.route, board: input.board, alight, limit: input.limit,
      });
    }

    out.push({
      route: r.route,
      kind: kindOfRoute(r.route),
      boardLabel,
      alightLabel,
      liveText,
      liveDepartures,
      liveClocks,
      alightCandidates: r.alights,
      minutes,
      inPlan,
      tier,
      tierText,
      href,
      live,
    });
  }

  // 用户口径：只保留「第一辆 + 速度优于第 N 张卡的车」——
  //   本卡自己必然在列（它的 totalMin 就是入选卡之一，≤ thresholdMin）；
  //   方案表外的线（minutes === null）无阈值可比 → 保留（只展报站），排最后。
  const kept = out.filter((x) => x.minutes === null || x.minutes <= thresholdMin + 1e-9);
  kept.sort((a, b) => {
    if (a.minutes === null && b.minutes === null) return a.route.localeCompare(b.route, "en", { numeric: true });
    if (a.minutes === null) return 1;
    if (b.minutes === null) return -1;
    return a.minutes - b.minutes;
  });
  return kept;
}
