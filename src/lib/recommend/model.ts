/**
 * 路线总耗时模型（src/lib/recommend/model.ts，v1.0.0）
 *
 * 门到门链条（全部从「现在」串行推进）：
 *   T_total = walkOut(出发地→上车站)
 *           + Σ_k [ wait_k + ride_k + transfer_k ]
 *           + walkIn(下车站→目的地)
 *
 * 关键口径：
 *   · `ride`（巴士）= 逐跳累加 `segment_stats`（**离开口径** = t(离B) − t(离A) = run + dwell_B）
 *   · `ride`（轻轨）= 跳数 × `LRT_MIN_PER_HOP`（表定逐跳恒 2 分钟）
 *   · `wait_1`：巴士取 DSAT 实时「区间下限」；**无在途车 → 整条方案排除**（不在运营时间）
 *   · `wait_2+`：**按「到达换乘站的时刻」取班次**（轻轨查时刻表本地算；巴士按间隔 ÷ 2 估）
 *     —— 不能用「现在最近的在途车」，否则换乘方案总耗时被系统性低估
 *   · `transfer`：同场（站码相同且非轻轨）= 0；轻轨站内换乘读 `transfer_walks`
 *   · 巴士查不到可达班次 → 退回 `second`（第二辆在途车，`queryEta` 本来就返回，零额外调用）
 */
import { PLACE_SHORT } from "@/lib/home-plans-shared";
import { hhmmOf } from "@/lib/lrt/eta";
import { pickCatchTier, rangeText, tierTextOf } from "./catch-up";
import { mainCodeOf, rideOfHops, type SegmentIndex } from "./segment-lookup";
import {
  BUS_HEADWAY_FALLBACK_SEC,
  LRT_MIN_PER_HOP,
  TRANSFER_FALLBACK_MIN,
  WALK_FALLBACK_MIN,
  type BusArrival,
  type BusLive,
  type CatchTier,
  type LrtLive,
  type OptionSeed,
  type RecommendCard,
  type RideLegView,
  type RouteLive,
  type SchoolZone,
  type TransferView,
  type TransferWalkRow,
  type WalkLegView,
  type WalkTimeRow,
} from "./types";

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// ─────────────────────────── 步行索引 ───────────────────────────

export interface WalkIndex {
  /** `placeId|main|zone` → 行（zone 空串表示 NULL） */
  byKey: Map<string, WalkTimeRow>;
  /** placeId → 该地点全行样本加权均值 */
  byPlace: Map<number, number>;
  /** 全表样本加权均值 */
  global: number | null;
}

export function buildWalkIndex(rows: WalkTimeRow[]): WalkIndex {
  const byKey = new Map<string, WalkTimeRow>();
  const agg = new Map<number, { sum: number; n: number }>();
  let gs = 0;
  let gn = 0;
  for (const r of rows) {
    const m = num(r.minutes);
    if (m === null || m <= 0) continue;
    const w = Math.max(1, r.samples);
    byKey.set(`${r.place_id}|${mainCodeOf(r.station_code)}|${r.zone ?? ""}`, r);
    const a = agg.get(r.place_id) ?? { sum: 0, n: 0 };
    a.sum += m * w;
    a.n += w;
    agg.set(r.place_id, a);
    gs += m * w;
    gn += w;
  }
  const byPlace = new Map<number, number>();
  for (const [k, v] of agg) if (v.n > 0) byPlace.set(k, v.sum / v.n);
  return { byKey, byPlace, global: gn > 0 ? gs / gn : null };
}

export interface WalkLookup {
  minutes: number;
  /** 1 = (place,主码,zone) 2 = (place,主码,NULL) 3 = 该地点均值 4 = 全表均值 5 = 常数 */
  level: 1 | 2 | 3 | 4 | 5;
  samples: number;
}

/** 步行回退链（非 school 侧 zone 必须传 null） */
export function lookupWalk(
  idx: WalkIndex,
  placeId: number,
  station: string,
  zone: SchoolZone | null,
): WalkLookup {
  const main = mainCodeOf(station);
  const r1 = idx.byKey.get(`${placeId}|${main}|${zone ?? ""}`);
  const v1 = r1 ? num(r1.minutes) : null;
  if (v1 !== null && v1 > 0) return { minutes: v1, level: 1, samples: r1!.samples };

  const r2 = idx.byKey.get(`${placeId}|${main}|`);
  const v2 = r2 ? num(r2.minutes) : null;
  if (v2 !== null && v2 > 0) return { minutes: v2, level: 2, samples: r2!.samples };

  const p = idx.byPlace.get(placeId);
  if (p !== undefined) return { minutes: p, level: 3, samples: 0 };

  if (idx.global !== null) return { minutes: idx.global, level: 4, samples: 0 };

  return { minutes: WALK_FALLBACK_MIN, level: 5, samples: 0 };
}

// ─────────────────────────── 换乘步行索引 ───────────────────────────

export interface TransferInfo {
  minutes: number;
  samples: number;
  source: string;
  /** true = 无实测样本，常量兜底（UI 标「估算」） */
  estimate: boolean;
}

export type TransferIndex = Map<string, TransferInfo>;

export function buildTransferIndex(rows: TransferWalkRow[]): TransferIndex {
  const m: TransferIndex = new Map();
  for (const r of rows) {
    const v = num(r.minutes);
    if (v === null || v < 0) continue;
    m.set(`${mainCodeOf(r.from_station)}|${mainCodeOf(r.to_station)}`, {
      minutes: v,
      samples: r.samples,
      source: r.source,
      estimate: false,
    });
  }
  return m;
}

export function transferMinutes(idx: TransferIndex, from: string, to: string): TransferInfo {
  const hit = idx.get(`${mainCodeOf(from)}|${mainCodeOf(to)}`);
  if (hit) return hit;
  return { minutes: TRANSFER_FALLBACK_MIN, samples: 0, source: "fallback", estimate: true };
}

// ─────────────────────────── 模型上下文 ───────────────────────────

export interface ModelContext {
  /** 现在（ms）—— 一律「现在出发」 */
  nowMs: number;
  segIdx: SegmentIndex;
  walkIdx: WalkIndex;
  transferIdx: TransferIndex;
  /** place slug → id */
  placeIds: Record<string, number>;
  /** 站码 → 显示名（巴士带站号前缀） */
  nameOf: Map<string, string>;
  /** 澳科大座区（仅 school 侧生效） */
  zone: SchoolZone | null;
  /** route → 实时视图 */
  live: Map<string, RouteLive>;
  /** 被排除的线路（无在途车 / 已收车）→ 静默剔除计数器 */
  excluded: string[];
  /** 今天星期（0 = 周日 … 6 = 周六） */
  todayWeekday: number;
}

const labelOf = (ctx: ModelContext, code: string): string => ctx.nameOf.get(code) ?? code;

/** 从实时视图里挑「能赶上的最早一班」（判据用**区间下限**，往短了算） */
function pickBoardable(lv: BusLive, walkMin: number): BusArrival | null {
  for (const cand of [lv.nearest, lv.second]) {
    if (!cand) continue;
    if (pickCatchTier(walkMin, cand.loSec) !== null) return cand;
  }
  return null;
}

/** 轻轨报站文案（口径与 `LrtEta` 一致：氹仔线整分 / 石排湾·横琴线秒级） */
const tickSecLine = (code: string) =>
  code.includes("石排") || code.includes("横琴") || code.includes("橫琴");

function lrtDisplay(
  route: string,
  lv: LrtLive,
  depMs: number,
  nowMs: number,
): { text: string; sub: string | null } {
  const remainSec = Math.max(0, Math.floor((depMs - nowMs) / 1000));
  const clock = hhmmOf(((depMs + 8 * 3_600_000) % 86_400_000) / 1000);
  const dir = lv.directionName ? `往${lv.directionName} · ` : "";
  if (tickSecLine(route)) {
    return {
      text: remainSec < 60 ? "现正到达" : `还有 ${Math.floor(remainSec / 60)} 分 ${remainSec % 60} 秒`,
      sub: `${dir}${clock} 开出`,
    };
  }
  return {
    text: remainSec >= 60 ? `下一班 ${Math.floor(remainSec / 60)} 分钟` : "现正到达",
    sub: `${dir}${clock} 开出`,
  };
}

// ─────────────────────────── 主模型 ───────────────────────────

function walkView(ctx: ModelContext, slug: string, station: string): WalkLegView {
  const pid = ctx.placeIds[slug];
  const zone: SchoolZone | null = slug === "school" ? (ctx.zone ?? null) : null;
  const r = lookupWalk(ctx.walkIdx, pid ?? -1, station, zone);
  return {
    // 取一位小数：样本均值是原始浮点（5.8388888888888895），直接上屏破坏可读性
    minutes: Math.round(r.minutes * 10) / 10,
    toLabel: labelOf(ctx, station),
    level: r.level,
    estimated: r.level >= 3,
    samples: r.samples,
  };
}

/**
 * 把一条候选方案算成一张卡。
 * @returns null = 该方案被排除（无在途车 / 已收车 / 站序缺失），并记入 `ctx.excluded`
 */
export function modelOption(seed: OptionSeed, ctx: ModelContext): RecommendCard | null {
  const nowMs = ctx.nowMs;
  const segs = seed.segments;
  const first = segs[0];

  // ── 步行到上车站 ──
  const wOut = walkView(ctx, seed.fromSlug, first.board);
  const walkOutMs = wOut.minutes * 60_000;

  const rides: RideLegView[] = [];
  const transfers: TransferView[] = [];
  /** 上一段的「下车时刻」（ms） */
  let cursor = nowMs + walkOutMs;

  // ── 第 1 段：等车（DSAT 实时 / 轻轨时刻表）──
  let boardAtMs: number;
  let waitMin0: number;
  let tier: CatchTier | null;
  let liveText: string;
  let liveSub: string | null = null;
  let liveDepartures: number[] | undefined;
  let liveClocks: string[] | undefined;

  if (first.kind === "bus") {
    const lv = ctx.live.get(first.route);
    if (!lv || lv.kind !== "bus" || lv.empty) {
      ctx.excluded.push(first.route);
      return null;
    }
    const chosen = pickBoardable(lv, wOut.minutes);
    if (chosen) {
      boardAtMs = nowMs + chosen.loSec * 1000;
      tier = pickCatchTier(wOut.minutes, chosen.loSec);
      liveText = `还有 ${chosen.stopsAway} 站 · ${rangeText(chosen.loSec, chosen.hiSec)}`;
    } else {
      // 本班都赶不上（连冲刺也不行）→ 等下一班：按班次间隔 ÷ 2 估
      boardAtMs = cursor + (BUS_HEADWAY_FALLBACK_SEC / 2) * 1000;
      tier = null;
      const n = lv.nearest ?? lv.second;
      liveText = n ? `还有 ${n.stopsAway} 站 · ${rangeText(n.loSec, n.hiSec)}` : "暂无实时班次";
    }
    waitMin0 = Math.max(0, (boardAtMs - cursor) / 60_000);
  } else {
    const lv = ctx.live.get(first.route);
    if (!lv || lv.kind !== "lrt" || lv.state !== "running") {
      ctx.excluded.push(first.route);
      return null;
    }
    const depMs = lv.departures.find((d) => d > cursor);
    if (depMs === undefined) {
      ctx.excluded.push(first.route);
      return null;
    }
    boardAtMs = depMs;
    waitMin0 = Math.max(0, (depMs - cursor) / 60_000);
    tier = pickCatchTier(wOut.minutes, waitMin0 * 60);
    const d = lrtDisplay(first.route, lv, depMs, cursor);
    liveText = d.text;
    liveSub = d.sub;
    liveDepartures = lv.departures;
    liveClocks = lv.clocks;
  }

  cursor = boardAtMs;

  // ── 逐段：行驶 + 换乘 + 下一段等车 ──
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const ride =
      seg.kind === "lrt"
        ? { minutes: seg.hops.length * LRT_MIN_PER_HOP, levels: [] as number[] }
        : rideOfHops(ctx.segIdx, seg.route, seg.hops, ctx.todayWeekday);
    cursor += ride.minutes * 60_000;

    rides.push({
      route: seg.route,
      kind: seg.kind,
      board: seg.board,
      alight: seg.alight,
      boardLabel: labelOf(ctx, seg.board),
      alightLabel: labelOf(ctx, seg.alight),
      minutes: Math.round(ride.minutes * 10) / 10,
      hops: seg.hops.length,
      levels: ride.levels,
      waitMin: i === 0 ? Math.round(waitMin0 * 10) / 10 : 0,
      liveText: i === 0 ? liveText : "",
      liveSub: i === 0 ? liveSub : null,
      liveDepartures: i === 0 ? liveDepartures : undefined,
      liveClocks: i === 0 ? liveClocks : undefined,
      tier: i === 0 ? tier : null,
      tierText: i === 0 ? tierTextOf(tier) : "",
    });

    if (i + 1 >= segs.length) break;

    // ── 换乘步行 ──
    const tr = seed.transfers[i];
    const next = segs[i + 1];
    if (tr?.sameField) {
      transfers.push({
        at: seg.alight,
        atLabel: labelOf(ctx, seg.alight),
        minutes: 0,
        estimated: false,
        sameField: true,
      });
    } else {
      const info = transferMinutes(ctx.transferIdx, seg.alight, next.board);
      cursor += info.minutes * 60_000;
      transfers.push({
        at: seg.alight,
        atLabel: labelOf(ctx, seg.alight),
        minutes: info.minutes,
        estimated: info.estimate,
        sameField: false,
      });
    }

    // ── 下一段等车：按「到达换乘站的时刻」取班次 ──
    // ★ v1.0.0：等车分钟回填到**该段自己**的 waitMin。
    //   否则换乘卡的时间分解会出现缺口：总用时含第 2 段等车，但该段 waitMin 恒 0 →
    //   用户按「步行 + 车上 + 换乘」加总会对不上总数，以为算错（实测发现）。
    const nx = rides[i + 1];
    if (next.kind === "lrt") {
      const lv = ctx.live.get(next.route);
      if (!lv || lv.kind !== "lrt" || lv.state !== "running") {
        ctx.excluded.push(next.route);
        return null;
      }
      const depMs = lv.departures.find((d) => d > cursor);
      if (depMs === undefined) {
        ctx.excluded.push(next.route);
        return null;
      }
      const wm = Math.max(0, (depMs - cursor) / 60_000);
      cursor = depMs;
      if (nx) {
        nx.waitMin = Math.round(wm * 10) / 10;
        // 轻轨第 2 段拿到的是**真实班次时刻** → 文案与首段同口径（HH:MM 開出）
        nx.liveText = `${hhmmOf(((depMs + 8 * 3_600_000) % 86_400_000) / 1000)} 開出`;
      }
    } else {
      const wm = BUS_HEADWAY_FALLBACK_SEC / 2 / 60;
      cursor += (BUS_HEADWAY_FALLBACK_SEC / 2) * 1000;
      if (nx) {
        nx.waitMin = Math.round(wm * 10) / 10;
        // 巴士第 2 段没有第二路实时数据源 → 明说是估算（口径见 types.ts 常量注释）
        nx.liveText = "按班次間隔估算";
      }
    }
  }

  // ── 下车后步行到目的地 ──
  const last = segs[segs.length - 1];
  const wIn = walkView(ctx, seed.toSlug, last.alight);
  cursor += wIn.minutes * 60_000;

  const totalMin = Math.max(0, (cursor - nowMs) / 60_000);

  // ── 乘车/换乘提示（开发者模式关闭时点击卡片展开）──
  const hints: string[] = [];
  hints.push(`在 ${labelOf(ctx, first.board)} 上车，乘 ${first.route}`);
  for (let i = 0; i + 1 < segs.length; i++) {
    const t = transfers[i];
    const next = segs[i + 1];
    hints.push(
      t?.sameField
        ? `到 ${labelOf(ctx, segs[i].alight)} 下车，同站台换乘 ${next.route}`
        : `到 ${labelOf(ctx, segs[i].alight)} 下车，步行 ${t?.minutes ?? TRANSFER_FALLBACK_MIN} 分换乘 ${next.route}`,
    );
  }
  hints.push(
    `到 ${labelOf(ctx, last.alight)} 下车，步行 ${wIn.minutes} 分到${
      seed.toSlug === "school" && ctx.zone ? `澳科大（${ctx.zone} 座）` : (PLACE_SHORT[seed.toSlug] ?? seed.toSlug)
    }`,
  );
  if (seed.crossBorder) hints.push("跨境行程：通关时间未计入总用时");

  return {
    planId: seed.planId,
    summary: seed.summary,
    fromSlug: seed.fromSlug,
    toSlug: seed.toSlug,
    totalMin: Math.round(totalMin * 10) / 10,
    arriveAt: cursor,
    walkOut: wOut,
    rides,
    transfers,
    walkIn: wIn,
    hints,
    crossBorder: seed.crossBorder,
  };
}

/** 方案排序：总耗时升序 → 计划 id 升序（稳定） */
export function sortCards(cards: RecommendCard[]): RecommendCard[] {
  return [...cards].sort((a, b) => a.totalMin - b.totalMin || a.planId - b.planId);
}
