/**
 * 路线总耗时模型（src/lib/recommend/model.ts，v1.0.6）
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
 *
 * ★ v1.0.6 三处修正（线上只读取证实测倒逼）： *   ① **首段赶不上 → 整条剔除**（`ctx.missed`），不再退回「班距÷2」估算卡。
 *      旧行为：巴士两辆在途车都赶不上 → 等车按 180s 估、卡面却写「还有 0 站 · 约 0 分」
 *      + 徽章「本班赶不上」→ 自相矛盾且总用时偏小；轻轨更是**直接用赶不上的那班车**算总用时。
 *   ② **第 2 段起的等车分钟真正回填**：旧代码在 push 本段后才去写 `rides[i + 1]`，
 *      而那一刻下标 `i+1` 尚不存在 → 赋值恒为 no-op（`nx` 永远 undefined）→
 *      第 2 段等车**计入了总用时却显示 0**，卡面加总对不上（线上实测缺 2~11 分钟）。
 *      现在改为「先算出来、下一轮 push 时写进去」。
 *   ③ **轻轨首段的赶车档判据参照修正**（详见 `catch-up.ts` 顶部注释）。
 *
 * ⚠️ zone（澳科大座区）判据是 `slug === "school"`，**与方向无关** ——
 *    去程的 `walkIn` 与回程的 `walkOut` 都会吃到它（`walk_times` 本来就是
 *    `(place, 站主码, zone)` 合并键、不分出发/到达）。
 *
 * ──────────────────── ★ v1.1.3 两处修正（用户实测倒逼）────────────────────
 *   ① **轻轨首段的发车表只下发「你走得到的那几班」**：旧版把全部班次交给客户端读秒，
 *      客户端取第一班 → 显示的是「马上就要开、但人还在路上」那班，与 `waitMin`
 *      自相矛盾（实测步行 4.6 分却显示「1.8 分后开」）。现按 `> cursor` 过滤。
 *   ② **巴士两辆候选改取「到站更早」的那辆**：见 `pickBoardable` 注释 ——
 *      `eta.ts` 的排序不区分 `status`，旧写法会选中实际更晚的车。**只改本模型，不动 `eta.ts`**。
 */
import { PLACE_SHORT } from "@/lib/home-plans-shared";
import { hhmmOf } from "@/lib/lrt/eta";
import { pickCatchTier, rangeText, tierHintOf, tierTextOf } from "./catch-up";
import { mainCodeOf, rideOfHops, type SegmentIndex } from "./segment-lookup";
import {
  BUS_HEADWAY_FALLBACK_SEC,
  LRT_MIN_PER_HOP,
  TRANSFER_FALLBACK_MIN,
  WALK_FALLBACK_MIN,
  type BusArrival,
  type BusLive,
  type CatchTier,
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
  /** 澳科大座区（★ 只要**任一侧**是 school 就生效，与出发/到达方向无关） */
  zone: SchoolZone | null;
  /** route → 实时视图 */
  live: Map<string, RouteLive>;
  /** 被排除的线路（无在途车 / 已收车 / 站序缺失）→ 静默剔除计数器 */
  excluded: string[];
  /**
   * ★ v1.0.6：因「**首段赶不上**」被剔除的线路（与 `excluded` 分开记账）。
   * 分开的理由：UI 要能区分「这条线现在没车」与「这班你赶不上」——
   * 合成一个数组会让文案与诊断都失真。
   */
  missed: string[];
  /** 今天星期（0 = 周日 … 6 = 周六） */
  todayWeekday: number;
}

const labelOf = (ctx: ModelContext, code: string): string => ctx.nameOf.get(code) ?? code;

/**
 * 从实时视图里挑「能赶上的最早一班」（判据用**区间下限**，往短了算）。
 *
 * ★ v1.1.3：改为在**两辆都可能赶上**时取 `loSec` 更小的那辆（= 到站更早）。
 *   旧写法取列表序第一个，而 `eta.ts` 的 `inTransit` 只按 `stopsAway` 排序、
 *   **不区分 `status`** —— 同站同站数时「已离站驶向下一站」(status=0，第 1 跳已算 0)
 *   其实比「仍停靠该站」(status=1，含第 1 跳) **更早到**，却可能被排在后面
 *   → 旧行为会选中更晚的那辆（等更久，且档位偏保守）。
 *   ⚠️ 只改本模型内部，**不动 `eta.ts`**（那是计时/开发者模式共用的，改它会波及计时）。
 *
 * ★ v1.1.4：候选从**两辆放宽到五辆**（`nearest` + `second` + `lv.more`，见 `types.ts#BusLive`）。
 *   结论先行：这是**纯增益**——`service.ts` 按总用时升序取前 5，等待更久的路线只会排到后面
 *   （填满空位或不显示），**不会挤掉更优的方案**。放宽只是把「前两辆都赶不上 → 整条剔除」
 *   的路线救回来（改由第 3~5 辆兜底）。
 *
 * @returns null = 前五辆在途车都赶不上 → 调用方**整条剔除**该方案（v1.0.6）
 */
function pickBoardable(lv: BusLive, walkMin: number): BusArrival | null {
  let best: BusArrival | null = null;
  for (const cand of [lv.nearest, lv.second, ...(lv.more ?? [])]) {
    if (!cand) continue;
    if (pickCatchTier(walkMin, cand.loSec) === null) continue;
    if (!best || cand.loSec < best.loSec) best = cand;
  }
  return best;
}

// ─────────────────────────── 主模型 ───────────────────────────

function walkView(ctx: ModelContext, slug: string, station: string): WalkLegView {
  const pid = ctx.placeIds[slug];
  // ⚠️ 判据只看「这个 place 是不是学校」，**不看它是起点还是终点** ——
  //    `walk_times` 是 (place, 站主码, zone) 合并键、不分出发/到达口径，
  //    所以「去学校」与「从学校出发」两侧都该吃同一个座区样本。
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

/** place 展示名：学校侧带上座区（起点/终点都用它，保证两个方向都能看到座区） */
function placeLabelOf(ctx: ModelContext, slug: string): string {
  if (slug === "school" && ctx.zone) return `澳科大（${ctx.zone} 座）`;
  return PLACE_SHORT[slug] ?? slug;
}

/**
 * 把一条候选方案算成一张卡。
 * @returns null = 该方案被排除：
 *   · 无在途车 / 已收车 / 站序缺失 → 记入 `ctx.excluded`
 *   · ★ v1.0.6 **首段赶不上** → 记入 `ctx.missed`（两者分开记账，UI 文案才能说实话）
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
  /** 「到达上车站」的时刻（ms）—— 首段等车以它为基准 */
  let cursor = nowMs + walkOutMs;

  // ── 第 1 段：等车（DSAT 实时 / 轻轨时刻表）──
  // ★ v1.0.6：首段赶不上 → **整条剔除**（不再退回估算）。
  let boardAtMs: number;
  let waitMin0: number;
  let tier: CatchTier;
  let liveText: string;
  let liveDepartures: number[] | undefined;
  let liveClocks: string[] | undefined;

  if (first.kind === "bus") {
    const lv = ctx.live.get(first.route);
    if (!lv || lv.kind !== "bus" || lv.empty) {
      ctx.excluded.push(first.route);
      return null;
    }
    const chosen = pickBoardable(lv, wOut.minutes);
    const t0 = chosen ? pickCatchTier(wOut.minutes, chosen.loSec) : null;
    if (!chosen || t0 === null) {
      // 最近两辆在途车都赶不上（连冲刺也不行）→ 不显示这张卡。
      // 旧行为是「按班距 ÷ 2 估一个等车值」，但卡面同时又写「还有 0 站 · 约 0 分」
      // 与「本班赶不上」→ 三个数字互相打架，且总用时偏小会把它排到很前面。
      ctx.missed.push(first.route);
      return null;
    }
    boardAtMs = nowMs + chosen.loSec * 1000;
    tier = t0;
    liveText = `还有 ${chosen.stopsAway} 站 · ${rangeText(chosen.loSec, chosen.hiSec)}`;
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
    // ★ 判据必须取「**从现在起**车还有多久到站」（与巴士侧的 `chosen.loSec` 同语义）。
    //   旧代码误传 `waitMin0 * 60`（= 你走完站台后才剩的余量）→ 参照系错位 →
    //   档位系统性偏保守，实测把「正常走能赶上」误报成「本班赶不上」。
    const t0 = pickCatchTier(wOut.minutes, (depMs - nowMs) / 1000);
    if (t0 === null) {
      // 连冲刺都赶不上这一班 → 整条剔除（旧行为是直接用这班车算总用时 → 必然低估）
      ctx.missed.push(first.route);
      return null;
    }
    tier = t0;
    // ★ 首段倒计时**只由客户端**每秒重算（`<LrtEtaInline>` 消费 `liveDepartures`）：
    //   服务端再下发一份冻结文案，同一行就会出现两个数字 —— 而且两者参照系不同
    //   （冻结那份用 `cursor` = 你走到站台的时刻，客户端那份用「现在」）→ 会互相矛盾。
    liveText = "";
    // ★★ v1.1.3：下发给客户端的发车表**必须从「你能赶上的那一班」开始**。
    //   旧写法原样下发 `lv.departures`（含**早于你到达站台**的班次）→ 客户端取第一班做倒计时
    //   → 显示的是「马上就要开、但你还在路上」的那班，与 `waitMin`（按 `cursor` 之后第一班算）
    //     自相矛盾。实测：步行出门 4.6 分，却显示「1.8 分后开」→ 用户怀疑「显示的不是能赶上的班次」。
    //   现在只下发 `> cursor` 的班次，客户端的第一班 ≡ 模型用的那一班。
    const afterWalk = lv.departures
      .map((d, k) => ({ d, c: lv.clocks[k] ?? "" }))
      .filter((x) => x.d > cursor);
    liveDepartures = afterWalk.map((x) => x.d);
    liveClocks = afterWalk.map((x) => x.c);
  }

  cursor = boardAtMs;

  // ── 逐段：行驶 + 换乘 + 下一段等车 ──
  // ★ v1.0.6：等车分钟必须写进**它自己那一段**。
  //   旧写法是 push 完本段后去改 `rides[i + 1]`，而那一刻下标 `i+1` 还不存在
  //   （数组长度恰好是 `i + 1`，合法索引只到 `i`）→ `nx` 恒为 `undefined` → 整个
  //   回填块是**静默死代码** → 第 2 段起等车计入总用时却显示 0，卡面加总对不上。
  //   现在改成「**先算出来、下一轮 push 时直接写进去**」，顺序与旧版完全一致。
  let waitNext = waitMin0;
  let liveTextNext = liveText;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const waitMin = waitNext;
    const legText = liveTextNext;

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
      waitMin: Math.round(waitMin * 10) / 10,
      liveText: legText,
      liveDepartures: i === 0 ? liveDepartures : undefined,
      liveClocks: i === 0 ? liveClocks : undefined,
      tier: i === 0 ? tier : null,
      tierText: i === 0 ? tierTextOf(tier) : "",
      // ★ v1.1.2：档 1~2（要比常速更快）时补一句「需較常速快 X 分」——
      //   卡面那一行「步行 X 分」是**常速实测均值**，而总用时按该档速度算
      //   ⇒ 可见项直接相加会比顶部大字大。大字没错，缺的是这句解释。
      //   字段挂在 rides[0]，但渲染在卡面第一行「步行」上（差额正出在那一行）。
      tierHint: i === 0 ? tierHintOf(wOut.minutes, tier) : "",
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
    // ★ v1.0.6：结果只写进 `waitNext` / `liveTextNext`（局部变量），由**下一轮**
    //   在 push 那一段时一并写入 —— 旧代码在这里直接改 `rides[i + 1]`，而下标 `i+1`
    //   此刻还不存在 → 赋值静默失效 → 第 2 段等车「算了却看不到」。
    //   ⚠️ `cursor` 的推进顺序与旧版完全一致，因此**总用时数值不变**，只是卡面显示补全。
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
      waitNext = Math.max(0, (depMs - cursor) / 60_000);
      cursor = depMs;
      // 轻轨第 2 段拿到的是**真实班次时刻** → 文案用绝对时刻（就是你会坐的那一班）
      liveTextNext = `${hhmmOf(((depMs + 8 * 3_600_000) % 86_400_000) / 1000)} 開出`;
    } else {
      waitNext = BUS_HEADWAY_FALLBACK_SEC / 2 / 60;
      cursor += (BUS_HEADWAY_FALLBACK_SEC / 2) * 1000;
      // 巴士第 2 段没有第二路实时数据源 → 明说是估算（口径见 types.ts 常量注释）
      liveTextNext = "按班次間隔估算";
    }
  }

  // ── 下车后步行到目的地 ──
  const last = segs[segs.length - 1];
  const wIn = walkView(ctx, seed.toSlug, last.alight);
  cursor += wIn.minutes * 60_000;

  const totalMin = Math.max(0, (cursor - nowMs) / 60_000);

  // ── 乘车/换乘提示（开发者模式关闭时点击卡片展开）──
  // ★ v1.0.6：起点侧若是学校，指引里也写出发座区（否则「标题有座区、指引没有」会让人怀疑没生效）
  const hints: string[] = [];
  hints.push(
    seed.fromSlug === "school" && ctx.zone
      ? `從澳科大（${ctx.zone} 座）步行出發，在 ${labelOf(ctx, first.board)} 上车，乘 ${first.route}`
      : `在 ${labelOf(ctx, first.board)} 上车，乘 ${first.route}`,
  );
  for (let i = 0; i + 1 < segs.length; i++) {
    const t = transfers[i];
    const next = segs[i + 1];
    hints.push(
      t?.sameField
        ? `到 ${labelOf(ctx, segs[i].alight)} 下车，同站台换乘 ${next.route}`
        : `到 ${labelOf(ctx, segs[i].alight)} 下车，步行 ${t?.minutes ?? TRANSFER_FALLBACK_MIN} 分换乘 ${next.route}`,
    );
  }
  hints.push(`到 ${labelOf(ctx, last.alight)} 下车，步行 ${wIn.minutes} 分到${placeLabelOf(ctx, seed.toSlug)}`);
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
