/**
 * 推荐静态数据装载（src/lib/recommend/query.ts，v1.0.0）
 *
 * ⚠️ server-only（含 pg）：client 组件**禁止** import 本模块 → 视图类型走 ./types。
 *
 * 性能要点：全部静态查询**并行发出**（一个 RTT 窗口），再在内存里建索引：
 *   站序（route-index）· segment_stats · walk_times · transfer_walks · places · 方案腿 · 线路色
 */
import type { Pool } from "pg";
import { loadRouteIndex } from "@/lib/dsat/route-index";
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
} from "./types";

export interface RecStatic {
  routeIdx: RouteIndex;
  segIdx: SegmentIndex;
  walkIdx: WalkIndex;
  transferIdx: TransferIndex;
  placeIds: Record<string, number>;
  /** 全部在用方案的幂等数据（plan + legs） */
  planRows: { plan: PlanLite; legs: PlanLegLite[] }[];
  /** 线路码 → 主题色 */
  routeColors: Record<string, string>;
}

/**
 * 静态数据进程内缓存。
 *
 * 为什么必须有：本机→新加坡 RTT 高时 `loadStatics` 实测 **743ms**（§六 预算「静态 ~0.1s」是
 * sin1 同区线上的数字）—— 每次点卡都重查会让 2 秒目标失守。而这些数据全是**派生表**
 * （站序由 db:sync-routes 同步、段/步行/换乘由每日 Cron 重算），低频变更 → 缓存 60 秒零风险。
 * ⚠️ 线上（Vercel↔Supabase 同 ap-southeast-1）本就快，此缓存主要保住冷路径与突发流量。
 */
const STATIC_TTL_MS = 60_000;
const g = globalThis as unknown as { __recStaticCache?: { ts: number; data: RecStatic } };

/** 并行装入全部静态数据（**一次 RTT 窗口**；默认走 60s 进程内缓存） */
export async function loadStatics(pool: Pool, force = false): Promise<RecStatic> {
  const c = g.__recStaticCache;
  if (!force && c && Date.now() - c.ts < STATIC_TTL_MS) return c.data;
  const data = await loadStaticsUncached(pool);
  g.__recStaticCache = { ts: Date.now(), data };
  return data;
}

async function loadStaticsUncached(pool: Pool): Promise<RecStatic> {
  const [routeIdx, segRes, walkRes, transferRes, placeRes, planRes, legRes, colorRes] =
    await Promise.all([
      loadRouteIndex(pool),
      pool.query(
        `SELECT route_code, from_station, to_station, weekday, time_bucket, arrive_kind,
                avg_minutes, p50_minutes, samples FROM segment_stats`,
      ),
      pool.query(`SELECT place_id, station_code, zone, minutes, samples FROM walk_times`),
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
    ]);

  const placeIds: Record<string, number> = {};
  for (const r of placeRes.rows as { id: number; slug: string }[]) placeIds[r.slug] = r.id;

  const routeColors: Record<string, string> = {};
  for (const r of colorRes.rows as { code: string; color: string }[]) routeColors[r.code] = r.color;

  const legsByPlan = new Map<number, PlanLegLite[]>();
  for (const r of legRes.rows as Record<string, unknown>[]) {
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

  const planRows = (planRes.rows as unknown as PlanLite[]).map((plan) => ({
    plan,
    legs: legsByPlan.get(plan.id) ?? [],
  }));

  return {
    routeIdx,
    segIdx: buildSegmentIndex(segRes.rows as unknown as SegmentStatRow[]),
    walkIdx: buildWalkIndex(walkRes.rows as unknown as WalkTimeRow[]),
    transferIdx: buildTransferIndex(transferRes.rows as unknown as TransferWalkRow[]),
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
    todayWeekday: macau.getUTCDay(),
  };
}

/** 候选方案需要的全部线路码（去重） */
export function routesOf(options: OptionSeed[]): string[] {
  const s = new Set<string>();
  for (const o of options) for (const seg of o.segments) s.add(seg.route);
  return [...s];
}
