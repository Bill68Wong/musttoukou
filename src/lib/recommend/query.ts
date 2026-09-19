/**
 * 推荐静态数据装载（src/lib/recommend/query.ts，v1.0.0 / v1.0.4）
 *
 * ⚠️ server-only（含 pg）：client 组件**禁止** import 本模块 → 视图类型走 ./types。
 *
 * ────────────────────────── ★ v1.0.4 缓存架构 ──────────────────────────
 * 静态数据全部来自**派生表**（站序由 db:sync-routes 同步；段/步行/换乘由每日 Cron 重算）
 * → 低频变更 → 放进 **Vercel Data Cache**（`unstable_cache`）：**跨实例、跨冷启动持久**。
 *
 * 缓存的是**原始行**（纯 JSON）；索引（Map）仍在内存里构建
 *   —— Map 不能 JSON 序列化，整体缓存会静默丢成 `{}`。
 *
 * 为什么必须跨实例（这是本轮性能问题的正解）：
 *   线上函数执行在 iad1（美东）、主库在 ap-southeast-1（新加坡）→ **每次冷启动**重建
 *   数据库连接要 5~6 个往返（TCP + TLS + SCRAM 认证 + startup）≈ 2.3s。
 *   实测反证链：v1.0.2 把连接池上限 5→12（无效）、v1.0.3 把 route_stations 传输量
 *   压掉 9 成（仍无效，staticMs 2283ms 几乎不动）→ **传输量与连接数都不是瓶颈，
 *   固定建连成本才是**。走 Data Cache 后，冷启动直接读边缘缓存 → 完全不碰数据库。
 */
import type { Pool } from "pg";
import { unstable_cache } from "next/cache";
import { getPool } from "@/lib/db";
import {
  buildRouteIndexFromRows,
  queryRouteIndexRows,
  type RouteStopRow,
  type StationRow,
} from "@/lib/dsat/route-index";
import { buildLrtPreload, type LrtPreload } from "@/lib/lrt/next-departures";
import type { PlanLegLite } from "@/lib/timer-flow";
import { enumerateOptions, type PlanLite } from "./enumerate";
import { buildSegmentIndex, type SegmentIndex } from "./segment-lookup";
import {
  buildTransferIndex,
  buildWalkIndex,
  type ModelContext,
  type TransferIndex,
  type WalkIndex,
} from "./model";
import type {
  OptionSeed,
  RouteIndex,
  SchoolZone,
  SegmentStatRow,
  TransferWalkRow,
  WalkTimeRow,
  StationWalkDistanceRow,
} from "./types";

export interface RecStatic {
  routeIdx: RouteIndex;
  segIdx: SegmentIndex;
  walkIdx: WalkIndex;
  transferIdx: TransferIndex;
  /**
   * ★ 轻轨预载（v1.0.0 性能修复）：把轻轨的 6 次串行 DB 往返折进本层已有的并行窗口。
   * 不这么做时，线上（函数在 iad1、主库在新加坡）每个轻轨桶恒定 1.2s 超时 → 轻轨方案被剔除。
   * 详见 `src/lib/lrt/next-departures.ts#LrtPreload`。
   */
  lrtPre: LrtPreload;
  placeIds: Record<string, number>;
  /** 全部在用方案的幂等数据（plan + legs） */
  planRows: { plan: PlanLite; legs: PlanLegLite[] }[];
  /** 线路码 → 主题色 */
  routeColors: Record<string, string>;
}

/** 轻轨时刻行（`lrt_timetables` 全量） */
type LrtTtRow = {
  api_station: string;
  route_no: string;
  direction: string;
  day_type: string;
  first_min: number;
  last_min: number;
  minutes: { hour: number; minutes: number[] }[];
};

/** ★ v1.0.4：静态数据原始行（纯 JSON · 可跨实例缓存 · **不含任何 Map**） */
interface StaticRows {
  routeStops: RouteStopRow[];
  stations: StationRow[];
  seg: SegmentStatRow[];
  walk: WalkTimeRow[];
  /** ★ v1.2.0：高德步行距离（独立缓存表） */
  walkDist: StationWalkDistanceRow[];
  transfer: TransferWalkRow[];
  places: { id: number; slug: string }[];
  plans: PlanLite[];
  legs: Record<string, unknown>[];
  colors: { code: string; color: string }[];
  lrtApi: { db_code: string; api_id: string; name_tc: string | null }[];
  lrtHol: { d: string }[];
  lrtTt: LrtTtRow[];
}

/** 全部静态查询**并行发出**（一个 RTT 窗口），返回可序列化的原始行 */
async function fetchStaticRowsUncached(pool: Pool): Promise<StaticRows> {
  const [
    routeIdxRows,
    segRes,
    walkRes,
    walkDistRes,
    transferRes,
    placeRes,
    planRes,
    legRes,
    colorRes,
    lrtApiRes,
    lrtHolRes,
    lrtTtRes,
  ] = await Promise.all([
    queryRouteIndexRows(pool),
    pool.query(
      `SELECT route_code, from_station, to_station, weekday, time_bucket, arrive_kind,
              avg_minutes, p50_minutes, samples FROM segment_stats`,
    ),
    pool.query(`SELECT place_id, station_code, zone, minutes, samples, distance_m FROM walk_times`),
    // ★ v1.2.0：高德步行距离（与 walk_times 分层的独立缓存表）
    //   即使某组还没有实测样本，只要抓过距离，档 1 的随距离衰减就能算 ✓
    //   表尚未建时容错为空（不阻塞推荐）
    pool
      .query(`SELECT place_id, station_main, zone, distance_m FROM station_walk_distance`)
      .catch(() => ({ rows: [] as unknown[] })),
    // transfer_walks 在 v1.0.0 新建；表尚未建时容错为空（不阻塞推荐）
    pool
      .query(`SELECT from_station, to_station, minutes, samples, source FROM transfer_walks`)
      .catch(() => ({ rows: [] as unknown[] })),
    pool.query(`SELECT id, slug FROM places`),
    pool.query(
      `SELECT p.id, p.summary, pf.slug AS from_slug, pt.slug AS to_slug
         FROM commute_plans p
         JOIN places pf ON pf.id = p.from_place
         JOIN places pt ON pt.id = p.to_place
        WHERE p.is_active
        ORDER BY p.id`,
    ),
    pool.query(
      `SELECT l.plan_id, l.seq, l.leg_kind, l.route_options, l.from_station, l.to_station,
              l.board_candidates, l.alight_candidates, l.route_meta, l.border_label
         FROM plan_legs l
         JOIN commute_plans p ON p.id = l.plan_id
        WHERE p.is_active
        ORDER BY l.plan_id, l.seq`,
    ),
    pool.query(`SELECT code, color FROM routes WHERE color IS NOT NULL`),
    // ── 轻轨预载三件套（v1.0.0 性能修复；都是极小静态表）──
    pool
      .query(`SELECT db_code, api_id, name_tc FROM lrt_api_stations`)
      .catch(() => ({ rows: [] as unknown[] })),
    pool.query(`SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d FROM lrt_holidays`),
    pool.query(
      `SELECT api_station, route_no, direction, day_type, first_min, last_min, minutes
         FROM lrt_timetables`,
    ),
  ]);

  const [routeStops, stations] = routeIdxRows;
  return {
    routeStops,
    stations,
    seg: segRes.rows as unknown as SegmentStatRow[],
    walk: walkRes.rows as unknown as WalkTimeRow[],
    walkDist: walkDistRes.rows as unknown as StationWalkDistanceRow[],
    transfer: transferRes.rows as unknown as TransferWalkRow[],
    places: placeRes.rows as { id: number; slug: string }[],
    plans: planRes.rows as unknown as PlanLite[],
    legs: legRes.rows as Record<string, unknown>[],
    colors: colorRes.rows as { code: string; color: string }[],
    lrtApi: lrtApiRes.rows as { db_code: string; api_id: string; name_tc: string | null }[],
    lrtHol: lrtHolRes.rows as { d: string }[],
    lrtTt: lrtTtRes.rows as unknown as LrtTtRow[],
  };
}

/**
 * ★ v1.0.4：静态行 = **跨实例数据缓存**（60s 重新验证，与原有进程内 TTL 同口径）。
 * ⚠️ 不走 `pool` 参数：`unstable_cache` 会把入参序列化进 cache key，
 *    而 Pool 实例不可序列化 → 必须用模块级 `getPool()`。
 *    若 Data Cache 未命中，则回落到一次真实查询（行为与 v1.0.3 相同）。
 */
const getStaticRows = unstable_cache(
  async () => fetchStaticRowsUncached(getPool()),
  ["rec-static-rows-v1"],
  { revalidate: 60, tags: ["rec-static"] },
);

/**
 * 静态数据进程内缓存（同实例复用，避免每次请求重建索引）。
 * 与 Data Cache 是两层：外层（跨实例）管「取行」，内层（本实例）管「建索引」。
 */
const STATIC_TTL_MS = 60_000;
const g = globalThis as unknown as { __recStaticCache?: { ts: number; data: RecStatic } };

/** 装入全部静态数据（默认走 60s 进程内缓存；取行走 Vercel Data Cache） */
export async function loadStatics(pool: Pool, force = false): Promise<RecStatic> {
  // ★ v1.0.4：取行已交给 Data Cache（跨实例），pool 参数仅为兼容既有签名保留
  void pool;
  const c = g.__recStaticCache;
  if (!force && c && Date.now() - c.ts < STATIC_TTL_MS) return c.data;
  const data = await loadStaticsUncached();
  g.__recStaticCache = { ts: Date.now(), data };
  return data;
}

async function loadStaticsUncached(): Promise<RecStatic> {
  // ★ v1.3.0：非 Next 运行时（`tsx` 脚本 / 探针）里 `unstable_cache` 不可用
  //   （会抛 `Invariant: incrementalCache missing`）→ 回落到**直接查库**。
  //   ⚠️ 只在 Next 运行时之外触发 ⇒ 线上行为**零变化**（正常路径仍走 Data Cache）。
  let rows: StaticRows;
  try {
    rows = await getStaticRows();
  } catch {
    rows = await fetchStaticRowsUncached(getPool());
  }

  const placeIds: Record<string, number> = {};
  for (const r of rows.places) placeIds[r.slug] = r.id;

  const routeColors: Record<string, string> = {};
  for (const r of rows.colors) routeColors[r.code] = r.color;

  const legsByPlan = new Map<number, PlanLegLite[]>();
  for (const r of rows.legs) {
    const pid = r.plan_id as number;
    if (!legsByPlan.has(pid)) legsByPlan.set(pid, []);
    const opts = r.route_options ? (JSON.parse(r.route_options as string) as string[]) : null;
    legsByPlan.get(pid)!.push({
      seq: r.seq as number,
      leg_kind: r.leg_kind as PlanLegLite["leg_kind"],
      route_options: opts,
      from_station: (r.from_station as string) ?? null,
      to_station: (r.to_station as string) ?? null,
      board_candidates: (r.board_candidates as string[]) ?? null,
      alight_candidates: (r.alight_candidates as string[]) ?? null,
      route_meta: (r.route_meta as PlanLegLite["route_meta"]) ?? null,
      border_label: (r.border_label as string) ?? null,
      // plan_legs 无 color 列 → 按默认线路（route_options[0]）取线路主题色（口径同 home-plans.ts）
      color: opts?.[0] ? (routeColors[opts[0]] ?? null) : null,
    });
  }

  const planRows = rows.plans.map((plan) => ({
    plan,
    legs: legsByPlan.get(plan.id) ?? [],
  }));

  const routeIdx = buildRouteIndexFromRows(rows.routeStops, rows.stations);

  return {
    routeIdx,
    segIdx: buildSegmentIndex(rows.seg),
    walkIdx: buildWalkIndex(rows.walk, rows.walkDist),
    transferIdx: buildTransferIndex(rows.transfer),
    // 站序直接复用刚构建的 routeIdx.dirStops（不再单独查 route_stations）
    lrtPre: buildLrtPreload({
      apiRows: rows.lrtApi,
      holidayRows: rows.lrtHol,
      ttRows: rows.lrtTt,
      dirStopsAll: routeIdx.dirStops,
    }),
    placeIds,
    planRows,
    routeColors,
  };
}

/** 枚举某方向（from→to）的全部候选路线方案 */
export function optionsFor(st: RecStatic, fromSlug: string, toSlug: string): OptionSeed[] {
  const rows = st.planRows.filter((r) => r.plan.from_slug === fromSlug && r.plan.to_slug === toSlug);
  const out: OptionSeed[] = [];
  for (const r of rows) out.push(...enumerateOptions(r.plan, r.legs, st.routeIdx));
  return out;
}

/** 组装模型上下文（live 由调用方注入） */
export function contextFor(
  st: RecStatic,
  nowMs: number,
  zone: SchoolZone | null,
  live: ModelContext["live"],
): ModelContext {
  // 澳门时间的星期（0=周日…6=周六）—— 时段分层只用到 weekday
  const macau = new Date(nowMs + 8 * 3_600_000);
  return {
    nowMs,
    segIdx: st.segIdx,
    walkIdx: st.walkIdx,
    transferIdx: st.transferIdx,
    placeIds: st.placeIds,
    nameOf: st.routeIdx.nameOf,
    zone,
    live,
    excluded: [],
    missed: [],
    todayWeekday: macau.getUTCDay(),
  };
}

/** 候选方案需要的全部线路码（去重） */
export function routesOf(options: OptionSeed[]): string[] {
  const s = new Set<string>();
  for (const o of options) for (const seg of o.segments) s.add(seg.route);
  return [...s];
}
