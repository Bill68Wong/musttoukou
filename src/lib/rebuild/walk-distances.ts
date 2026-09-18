/**
 * 高德步行距离抓取（src/lib/rebuild/walk-distances.ts，v1.2.0）
 *
 * ── 职责 ─────────────────────────────────────────────────────────────
 *   枚举步行需求组（`walk-candidates.ts`）→ 解析两端坐标 → 调高德步行路径规划
 *   → upsert 到 `station_walk_distance`。
 *   **不碰 `walk_times`** —— 那张表由 `walk-times.ts` 负责（分层见下）。
 *
 * ── 为什么要与 walk_times 分层 ────────────────────────────────────────
 *   `rebuildWalkTimes` 是 `DELETE FROM walk_times` 后**全量重灌**（每日 Cron）。
 *   距离若存在那张表里 → 每天被清掉再重抓 → 浪费配额 + 高德一挂就全丢 ✗
 *   分层后：距离是「外部事实」（慢变、可增量抓），`minutes` 是「派生值」。
 *
 * ── 增量策略 ─────────────────────────────────────────────────────────
 *   只抓「库里没有」或「超过 RETTL_DAYS 天」的组 ⇒ 稳态下每天调用 ≈ 0。
 *
 * ── 🚨 绝不产出「分钟」──────────────────────────────────────────────
 *   本模块只产出**米**。折算成「常速基准分钟」是 `walk-times.ts` 的职责，
 *   且只用一个常量 `WALK_BASE_M_PER_MIN`（= 90）——
 *   因为读端 `catch-up.ts#requiredSec` 还会再做一次分档缩放，此处若也缩放即**双重缩档** ✗
 *
 * ── 健康指标 ─────────────────────────────────────────────────────────
 *   每条记录都存 `snap_start_m` / `snap_end_m`（高德返回路径首末点 vs 我们传入点的距离）。
 *   正常应 < 50m；若整体中位数 > 150m ⇒ 坐标系约定有误，**应整体弃用 API 距离**。
 *   `evaluateHealth()` 就是给这个判断用的。
 */
import type { Pool } from "pg";
import { enumerateWalkNeeds, type WalkNeed } from "./walk-candidates";
import { walkRoute, amapStats, resetAmapStats, type AmapStats } from "@/lib/amap/client";
import type { LatLng } from "@/lib/amap/coord";

/** 距离的保鲜期（天）；超期会在下次抓取时刷新 */
export const RETTL_DAYS = 30;
/** 吸附距离的健康阈值（米）：中位数超过它就认为坐标系有问题 */
export const SNAP_MEDIAN_LIMIT_M = 150;
/** 单次运行的默认时间预算（毫秒）—— 超预算即停止抓取、保留已有结果，不抛错 */
export const DEFAULT_BUDGET_MS = 25_000;

export interface DistanceRowResult {
  placeId: number;
  placeSlug: string;
  stationMain: string;
  zone: string | null;
  distanceM: number;
  snapStartM: number;
  snapEndM: number;
}

export interface DistanceSkip {
  placeSlug: string;
  stationMain: string;
  zone: string | null;
  reason: string;
}

export interface DistanceHealth {
  /** 参与统计的条数 */
  n: number;
  /** snap_start_m 的中位数（米）；-1 = 数据不足 */
  snapMedian: number;
  /** snap_start_m 的 P90 */
  snapP90: number;
  /** 健康判定：中位数 ≤ SNAP_MEDIAN_LIMIT_M */
  ok: boolean;
  verdict: string;
}

export interface WalkDistanceResult {
  /** 需求组总数 */
  needs: number;
  /** 本轮实际抓取的组数（增量命中） */
  fetched: number;
  /** 跳过的组（未命中增量 / 缺坐标 / 接口失败） */
  skipped: DistanceSkip[];
  /** 成功写入的行 */
  rows: DistanceRowResult[];
  /** 高德调用统计 */
  amap: AmapStats;
  /** 坐标系健康度 */
  health: DistanceHealth;
  /** 耗时 */
  ms: number;
  /** 是否因超预算提前停止 */
  budgetExceeded: boolean;
  dry: boolean;
}

function median(xs: number[]): number {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(xs: number[], p: number): number {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

/**
 * 从库里读出坐标：地点侧（含 zone）+ 站点侧（用真实站台码取，与 FK 口径一致）
 */
async function loadCoords(pool: Pool, needs: WalkNeed[]): Promise<{
  placeCoord: Map<string, LatLng>;         // key = `${placeId}|${zone ?? ""}`
  stationCoord: Map<string, LatLng>;       // key = 主码
  missingPlace: Set<string>;
  missingStation: Set<string>;
}> {
  const pcRows = (
    await pool.query(`SELECT place_id, zone, lat, lng FROM place_coords`)
  ).rows as { place_id: number; zone: string | null; lat: number; lng: number }[];
  const placeCoord = new Map<string, LatLng>();
  for (const r of pcRows) placeCoord.set(`${r.place_id}|${r.zone ?? ""}`, { lat: Number(r.lat), lng: Number(r.lng) });

  // 站点：用需求组里给出的真实站台码列表，取第一个有坐标的
  const allCodes = [...new Set(needs.flatMap((n) => n.stationCodes))];
  const stRows = allCodes.length
    ? (
        await pool.query(
          `SELECT code, COALESCE(substring(code from '^[A-Za-z]+[0-9]+'), code) AS main, lat, lng
             FROM stations WHERE code = ANY($1::text[]) AND lat IS NOT NULL AND lng IS NOT NULL`,
          [allCodes],
        )
      ).rows as { code: string; main: string; lat: number; lng: number }[]
    : [];
  const stationCoord = new Map<string, LatLng>();
  for (const r of stRows) {
    if (!stationCoord.has(r.main)) stationCoord.set(r.main, { lat: Number(r.lat), lng: Number(r.lng) });
  }

  const missingPlace = new Set<string>();
  for (const n of needs) {
    if (!placeCoord.has(`${n.placeId}|${n.zone ?? ""}`)) missingPlace.add(`${n.placeSlug}${n.zone ? " · " + n.zone : ""}`);
  }
  const missingStation = new Set<string>();
  for (const n of needs) if (!stationCoord.has(n.stationMain)) missingStation.add(n.stationMain);

  return { placeCoord, stationCoord, missingPlace, missingStation };
}

/**
 * 抓取（或增量刷新）全部步行距离
 *
 * @param opts.dry        只算不写（打印将要抓哪些组）
 * @param opts.force      忽略增量判断，全量重抓
 * @param opts.budgetMs   时间预算；超了停止并保留已有结果
 */
export async function rebuildWalkDistances(
  pool: Pool,
  opts: { dry?: boolean; force?: boolean; budgetMs?: number } = {},
): Promise<WalkDistanceResult> {
  const t0 = Date.now();
  const dry = !!opts.dry;
  const force = !!opts.force;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;

  resetAmapStats();

  const needs = await enumerateWalkNeeds(pool);
  const skipped: DistanceSkip[] = [];

  // ── 增量筛选：已有且新鲜的组跳过 ──
  const have = new Map<string, Date>();
  if (!force) {
    const rows = (
      await pool.query(`SELECT place_id, station_main, zone, fetched_at FROM station_walk_distance`)
    ).rows as { place_id: number; station_main: string; zone: string | null; fetched_at: string }[];
    for (const r of rows) have.set(`${r.place_id}|${r.station_main}|${r.zone ?? ""}`, new Date(r.fetched_at));
  }
  const cutoff = Date.now() - RETTL_DAYS * 86_400_000;
  const pending: WalkNeed[] = [];
  for (const n of needs) {
    const key = `${n.placeId}|${n.stationMain}|${n.zone ?? ""}`;
    const at = have.get(key);
    if (at && at.getTime() > cutoff) {
      skipped.push({ placeSlug: n.placeSlug, stationMain: n.stationMain, zone: n.zone, reason: `已有新鲜距离（${at.toISOString().slice(0, 10)}）` });
      continue;
    }
    pending.push(n);
  }

  // ── 坐标 ──
  const { placeCoord, stationCoord, missingPlace, missingStation } = await loadCoords(pool, pending);

  const rows: DistanceRowResult[] = [];
  let budgetExceeded = false;

  for (const n of pending) {
    if (Date.now() - t0 > budgetMs) { budgetExceeded = true; break; }

    const pk = `${n.placeId}|${n.zone ?? ""}`;
    const origin = placeCoord.get(pk);
    const dest = stationCoord.get(n.stationMain);
    if (!origin) {
      skipped.push({ placeSlug: n.placeSlug, stationMain: n.stationMain, zone: n.zone, reason: `缺地点坐标（${n.placeSlug}${n.zone ? " · " + n.zone : ""}）` });
      continue;
    }
    if (!dest) {
      skipped.push({ placeSlug: n.placeSlug, stationMain: n.stationMain, zone: n.zone, reason: "缺站点坐标" });
      continue;
    }

    const r = await walkRoute(origin, dest);
    if (!r.ok) {
      skipped.push({ placeSlug: n.placeSlug, stationMain: n.stationMain, zone: n.zone, reason: `高德失败：${r.error}${r.infocode ? "(" + r.infocode + ")" : ""}` });
      continue;
    }

    rows.push({
      placeId: n.placeId, placeSlug: n.placeSlug, stationMain: n.stationMain, zone: n.zone,
      distanceM: r.distanceM, snapStartM: r.snapStartM, snapEndM: r.snapEndM,
    });
  }

  // ── 写库 ──
  if (!dry && rows.length) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (const r of rows) {
        await c.query(
          `INSERT INTO station_walk_distance
             (place_id, station_main, zone, distance_m, snap_start_m, snap_end_m, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT (place_id, station_main, zone) DO UPDATE
             SET distance_m = EXCLUDED.distance_m,
                 snap_start_m = EXCLUDED.snap_start_m,
                 snap_end_m = EXCLUDED.snap_end_m,
                 fetched_at = now()`,
          [r.placeId, r.stationMain, r.zone, r.distanceM, r.snapStartM, r.snapEndM],
        );
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally { c.release(); }
  }

  // ── 健康度：用**库里全部**距离算（不只本轮），这样单轮抓得少也能看出趋势 ──
  const allSnap = (
    await pool.query(`SELECT snap_start_m FROM station_walk_distance WHERE snap_start_m IS NOT NULL`)
  ).rows as { snap_start_m: string }[];
  const snaps = allSnap.map((x) => Number(x.snap_start_m)).filter((x) => Number.isFinite(x) && x >= 0);
  const snapMedian = median(snaps);
  const snapP90 = percentile(snaps, 90);
  const healthOk = snaps.length > 0 && snapMedian >= 0 && snapMedian <= SNAP_MEDIAN_LIMIT_M;
  const health: DistanceHealth = {
    n: snaps.length,
    snapMedian: Math.round(snapMedian),
    snapP90: Math.round(snapP90),
    ok: healthOk,
    verdict:
      snaps.length === 0
        ? "（暂无数据，无法判定）"
        : healthOk
          ? `✅ 坐标系约定正确（吸附中位数 ${Math.round(snapMedian)}m ≤ ${SNAP_MEDIAN_LIMIT_M}m）`
          : `🔴 吸附中位数 ${Math.round(snapMedian)}m > ${SNAP_MEDIAN_LIMIT_M}m —— 坐标系约定可能有误，**应弃用 API 距离**`,
  };

  // 缺坐标的提示（只在首次运行时值得看）
  for (const p of missingPlace) skipped.push({ placeSlug: p, stationMain: "—", zone: null, reason: "缺地点坐标（整组跳过）" });
  for (const s of missingStation) skipped.push({ placeSlug: "—", stationMain: s, zone: null, reason: "缺站点坐标（整组跳过）" });

  return {
    needs: needs.length,
    fetched: rows.length,
    skipped,
    rows,
    amap: amapStats(),
    health,
    ms: Date.now() - t0,
    budgetExceeded,
    dry,
  };
}
