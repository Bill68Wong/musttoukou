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
  // ★ v1.0.2：**服务端聚合 + 站名单独取**，把跨洲传输量压掉 ~90%。
  //
  //   原实现是「逐站一行」（2870 行 / 270 KB，实测），而线上函数执行在 iad1（美东）、
  //   主库在 ap-southeast-1（新加坡，RTT ~230ms）→ 270 KB 要十来个往返才能传完
  //   （TCP 慢启动）→ 线上冷启 staticMs 实测 **2313ms**，几乎全耗在这一项上。
  //   改成 `array_agg`（119 行 / 26 KB，**−90%**），站名走 `stations`（613 行 / 30 KB）。
  //   等价性已对拍（`.verify/route-index-eq.ts`，5 项 0 不一致）：
  //     · dirStops / dirsOf / adjOwners —— 逐字段一致
  //     · seqIdx —— 仅**基址**不同（DB rs.seq 1 基 → 数组下标 0 基），相对顺序一致；
  //       该字段全仓无消费方（grep 确认），故无影响
  //     · nameOf —— 新实现是**超集**：多出 3 个「未被任何线路站序引用」的孤立站
  //       （C688 / C690 / M8/1），只增不减，且能让主码站显示出站名（改善）
  const [stopsRes, stRes] = await Promise.all([
    pool.query(
      `SELECT r.code AS route, rs.dsat_dir,
              array_agg(rs.station_code ORDER BY rs.seq) AS stops
         FROM route_stations rs
         JOIN routes r ON r.id = rs.route_id
        GROUP BY r.code, rs.dsat_dir
        ORDER BY r.code, rs.dsat_dir`,
    ),
    // 站名与 kind 只随「站」变化（613 行），没必要在每一行停靠里重复 2870 次
    pool.query(`SELECT code, name_tc, kind FROM stations`),
  ]);

  const dirStops = new Map<string, string[]>();
  const seqIdx = new Map<string, Map<string, number[]>>();
  const dirsOf = new Map<string, string[]>();
  const nameOf = new Map<string, string>();
  const adjOwners = new Map<string, Set<string>>();

  for (const r of stopsRes.rows as { route: string; dsat_dir: string; stops: string[] | null }[]) {
    const key = `${r.route}|${r.dsat_dir}`;
    const stops = r.stops ?? [];
    dirStops.set(key, stops);

    // seqIdx：站码 → 该方向内的出现位置（相对先后顺序，等价于原 rs.seq）
    const m = new Map<string, number[]>();
    for (let i = 0; i < stops.length; i++) {
      const code = stops[i];
      if (!m.has(code)) m.set(code, []);
      m.get(code)!.push(i);
    }
    seqIdx.set(key, m);

    const arr = dirsOf.get(r.route) ?? [];
    arr.push(r.dsat_dir);
    dirsOf.set(r.route, arr);

    // 邻接归属：数组相邻 = 原「同一 (route,dir) 内上一站 → 本站」
    for (let i = 1; i < stops.length; i++) {
      const adj = `${mainCodeOf(stops[i - 1])}→${mainCodeOf(stops[i])}`;
      if (!adjOwners.has(adj)) adjOwners.set(adj, new Set());
      adjOwners.get(adj)!.add(r.route);
    }
  }

  // 巴士带站号前缀（「C653 金峰南岸」），轻轨不带（「氹仔碼頭」）——与 LiveEta / LrtEta 口径一致
  for (const s of stRes.rows as { code: string; name_tc: string | null; kind: string | null }[]) {
    if (!s.name_tc) continue;
    nameOf.set(s.code, s.kind === "bus" ? `${s.code} ${s.name_tc}` : s.name_tc);
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
