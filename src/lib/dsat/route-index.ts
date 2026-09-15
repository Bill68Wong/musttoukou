/**
 * 站序索引（src/lib/dsat/route-index.ts，v1.0.0）
 *
 * **一次 SQL 取全量站序 / 站名 / 方向 / 邻接归属**，供两处共用：
 *   · `src/lib/dsat/eta.ts#queryEta` —— 消灭 per-route DB 往返
 *     （现状 12 条线 ≈ 36~48 次往返 → 1 次）
 *   · `src/lib/recommend/*` —— 枚举逐跳、方向推导
 *
 * ⚠️ 站序数据是**低频变更**的静态数据（由 db:sync-routes 同步）→ 进程内缓存 5 分钟即可，
 *    不必每次请求都查库（Vercel 同一实例复用）。
 */
import type { Pool } from "pg";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { RouteIndex } from "@/lib/recommend/types";

const CACHE_TTL_MS = 5 * 60_000;

const g = globalThis as unknown as {
  __routeIndexCache?: { ts: number; idx: RouteIndex };
};

/** 从库构建站序索引（不做缓存） */
export async function buildRouteIndex(pool: Pool): Promise<RouteIndex> {
  const res = await pool.query(
    `SELECT r.code AS route, rs.dsat_dir, rs.seq, rs.station_code, st.name_tc, st.kind
       FROM route_stations rs
       JOIN routes r ON r.id = rs.route_id
       LEFT JOIN stations st ON st.code = rs.station_code
      ORDER BY r.code, rs.dsat_dir, rs.seq`,
  );

  const dirStops = new Map<string, string[]>();
  const seqIdx = new Map<string, Map<string, number[]>>();
  const dirsOf = new Map<string, string[]>();
  const nameOf = new Map<string, string>();
  const adjOwners = new Map<string, Set<string>>();

  for (const r of res.rows as {
    route: string;
    dsat_dir: string;
    seq: number;
    station_code: string;
    name_tc: string | null;
    kind: string | null;
  }[]) {
    const key = `${r.route}|${r.dsat_dir}`;
    let prev: string | null = null;
    if (!dirStops.has(key)) {
      dirStops.set(key, []);
      seqIdx.set(key, new Map());
      const arr = dirsOf.get(r.route) ?? [];
      arr.push(r.dsat_dir);
      dirsOf.set(r.route, arr);
    } else {
      const arr = dirStops.get(key)!;
      prev = arr[arr.length - 1] ?? null;
    }
    dirStops.get(key)!.push(r.station_code);

    const m = seqIdx.get(key)!;
    if (!m.has(r.station_code)) m.set(r.station_code, []);
    m.get(r.station_code)!.push(r.seq);

    // 巴士带站号前缀（「C653 金峰南岸」），轻轨不带（「氹仔碼頭」）——与 LiveEta / LrtEta 口径一致
    if (r.name_tc && !nameOf.has(r.station_code)) {
      nameOf.set(r.station_code, r.kind === "bus" ? `${r.station_code} ${r.name_tc}` : r.name_tc);
    }

    if (prev) {
      const adj = `${mainCodeOf(prev)}→${mainCodeOf(r.station_code)}`;
      if (!adjOwners.has(adj)) adjOwners.set(adj, new Set());
      adjOwners.get(adj)!.add(r.route);
    }
  }

  return { dirStops, seqIdx, dirsOf, nameOf, adjOwners };
}

/** 带进程内缓存的站序索引（TTL 5 分钟；force=true 绕过） */
export async function loadRouteIndex(pool: Pool, force = false): Promise<RouteIndex> {
  const c = g.__routeIndexCache;
  if (!force && c && Date.now() - c.ts < CACHE_TTL_MS) return c.idx;
  const idx = await buildRouteIndex(pool);
  g.__routeIndexCache = { ts: Date.now(), idx };
  return idx;
}
