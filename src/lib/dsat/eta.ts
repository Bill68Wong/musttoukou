import { getPool } from "@/lib/db";
import { getBusPositions } from "@/lib/dsat/client";
import { findStopIdx } from "@/lib/station-match";

/**
 * DSAT 实时车距查询核心（src/lib/dsat/eta.ts）
 * 供多处复用，保证口径唯一、不漂移：
 *   1. GET  /api/dsat/eta           —— 前端 LiveEta 卡片展示
 *   2. POST /api/timer/[id]/auto-snapshot —— 出发/到站时系统自动记录车距
 *   3.     fleet-snapshot / grab    —— 通过 deriveRouteDir 共用方向推导
 *
 * 刷新规则：
 *  - v0.4.0（2026-09-03）：服务端缓存 30s → 10s，支持 force=true 直查并回写
 *  - v0.8.1（2026-09-04）：缓存 TTL 10s → 5s（缩短 Vercel 多实例 globalThis 旧缓存窗口）
 *  - 手动刷新最小间隔由前端守卫（10s），服务端不做节流；手动刷新不带 force
 *
 * 对每条线路查 DB 站序 + DSAT 实时车辆，算最近的車距用户站还有几站。
 *  - dest（目标站）提供时，每条线路自行推导方向（from 在 to 之前的 dir），
 *    多段方案各段方向不同也能查对；推导不出时回退 dir 参数
 *  - status='1'（進站中/到达）→ 车就在挂载站，stopsAway = 站差
 *  - status='0'（行驶中）→ 挂载站是车的下一站，stopsAway = 站差 + 1
 *  - 总站待发（status=1 + 挂首/末站）→ 不参与站数计算，列入 pending 显示"未发车"
 *    ★ speed 不可靠不参与判定（实测待发车可能残留非空速度）
 *  - 循环线（DB 只有 dir=0 一套站序）取模 wrap；双方向线跳过已过站的车
 *  - v0.8.1 修复多线截断：最多 6 条（与 fleet-snapshot 上限一致），≤3 条/批并发查询
 *    （修复前 slice(0,3)：横琴 6 线方案的 102/701X/N6 永不返回）
 */

export interface EtaBus {
  plate: string | null;
  stopsAway: number; // 0 = 已到站
  atStation: string;
  atStationName: string;
  status: string | null;
  speed: string | number | null;
}

/** 总站停靠待发的车（status=1 + 挂首/末站）：不算站数，显示"未发车" */
export interface EtaPendingBus {
  plate: string | null;
  atStation: string;
  atStationName: string;
}

export interface EtaRouteResult {
  route: string;
  ok: boolean;
  /** 本线路实际查询的方向（按 dest 推导，可能不同于 dir 参数） */
  dir?: string;
  isLoop?: boolean;
  nearest?: EtaBus;
  /** 停在首/末总站尚未发车的车辆（不参与站数计算） */
  pending?: EtaPendingBus[];
  busCount?: number;
  error?: string;
}

export interface EtaResponse {
  fetchedAt: string;
  results: EtaRouteResult[];
}

/** 跨线路聚合：所有线路里最近一辆车的站数（即"还要等 N 站"口径） */
export function nearestStopsAway(res: EtaResponse): number | null {
  let best: number | null = null;
  for (const r of res.results) {
    if (r.ok && r.nearest) {
      best = best === null ? r.nearest.stopsAway : Math.min(best, r.nearest.stopsAway);
    }
  }
  return best;
}

// 5s 缓存（dev 热重载下存活；按 站|线路组|dir|dest 聚合，覆盖 51A/51B 共站组合）
// v0.4.0：30s → 10s；v0.8.1：10s → 5s（Vercel 多实例缓存隔离，缩窗口缓解数据横跳）
// force=true 绕过读取但写回
const CACHE_TTL_MS = 5_000;
/** 一次调用最多查询的线路数（修复 A：原 3 → 6，与 fleet-snapshot 上限一致） */
const MAX_ROUTES = 6;
/** 并发批大小：批内 Promise.all 同时查，批间串行（对 DSAT 温和，不突刺） */
const BATCH_CONCURRENCY = 3;
const g = globalThis as unknown as {
  __etaCache?: Map<string, { ts: number; data: EtaResponse }>;
};
if (!g.__etaCache) g.__etaCache = new Map();

/**
 * 方向推导（共享，eta / 创建会话 / fleet-snapshot / timer 乘车站序 同口径）：
 * dest 提供时找 from 在 to 之前的 dir；推导不出回退 fallbackDir；
 * 循环线兜底：两站同时只出现在唯一一套站序时用该方向。
 * v0.8.0 起不限 kind：轻轨（LRT-*）也走本推导（route_stations 中 dir0=正向/dir1=反向）。
 */
export async function deriveRouteDir(
  route: string,
  fromStation: string | null | undefined,
  toStation: string | null | undefined,
  fallbackDir = "0",
): Promise<string> {
  if (!fromStation || !toStation) return fallbackDir;
  const pool = getPool();
  const dirRes = await pool.query(
    `SELECT rs.dsat_dir,
            max(rs.seq) FILTER (WHERE rs.station_code = $2 OR rs.station_code LIKE $2 || '/%') AS from_seq,
            max(rs.seq) FILTER (WHERE rs.station_code = $3 OR rs.station_code LIKE $3 || '/%') AS to_seq
     FROM route_stations rs
     JOIN routes r ON rs.route_id = r.id
     WHERE r.code = $1
     GROUP BY rs.dsat_dir`,
    [route, fromStation, toStation],
  );
  let dir = fallbackDir;
  let fallbackDirCandidate: string | null = null;
  let bothCount = 0;
  for (const row of dirRes.rows as {
    dsat_dir: string;
    from_seq: number | null;
    to_seq: number | null;
  }[]) {
    if (row.from_seq !== null && row.to_seq !== null) {
      bothCount++;
      fallbackDirCandidate = row.dsat_dir;
    }
    if (row.from_seq !== null && row.to_seq !== null && row.from_seq < row.to_seq) {
      dir = row.dsat_dir;
      break;
    }
  }
  // 兜底：循环线只有一套站序（from>to 绕圈）→ 用唯一含两站的方向
  if (dir === fallbackDir && bothCount === 1 && fallbackDirCandidate) {
    dir = fallbackDirCandidate;
  }
  return dir;
}

/** 查询多线路实时车距（命中 5s 缓存直接返回；force=true 绕过缓存直查并回写） */
export async function queryEta(
  station: string,
  routesIn: string[],
  dirIn: string,
  dest: string,
  force = false,
): Promise<EtaResponse> {
  const routes = routesIn
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, MAX_ROUTES); // 最多 6 条（修复 A：横琴 6 线不再截断）
  const cacheKey = `${station}|${routes.join(",")}|${dirIn}|${dest}`;
  const cached = g.__etaCache!.get(cacheKey);
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const pool = getPool();
  const dir = dirIn || "0";
  const results: EtaRouteResult[] = [];

  /** 单线路查询（并发批内调用）：返回自身结果而非 push，保证 Promise.all 顺序 = routes 顺序 */
  const queryOne = async (route: string): Promise<EtaRouteResult> => {
    try {
      // 方向推导：dest 提供时按 from→to 找方向；推导不出回退 dir 参数
      // （循环线单方向 + from>to 时也回退，因循环线绕圈无所谓先后）
      const queryDir = dest
        ? await deriveRouteDir(route, station, dest, dir)
        : dir;

      // 站序 + 站名（该方向）；v0.4.0 起巴士站名带站号前缀（"T358 偉龍/科大醫院"），轻轨不带
      const stopsRes = await pool.query(
        `SELECT rs.seq, rs.station_code AS code,
                (CASE WHEN st.kind = 'bus' THEN rs.station_code || ' ' || st.name_tc ELSE st.name_tc END) AS name
         FROM route_stations rs
         JOIN routes r ON rs.route_id = r.id
         JOIN stations st ON rs.station_code = st.code
         WHERE r.code = $1 AND r.kind = 'bus' AND rs.dsat_dir = $2
         ORDER BY rs.seq`,
        [route, queryDir],
      );
      const stops = stopsRes.rows as { seq: number; code: string; name: string }[];
      if (stops.length === 0) {
        return { route, ok: false, error: `线路 ${route} 未同步站序（dir=${queryDir}）` };
      }

      // 循环线判定：该线路在 DB 只有 dir=0 一套站序（双方向线会有 dir=0/1 两套）
      const dirsRes = await pool.query(
        `SELECT DISTINCT rs.dsat_dir FROM route_stations rs
         JOIN routes r ON rs.route_id = r.id WHERE r.code = $1 AND r.kind = 'bus'`,
        [route],
      );
      const isLoop = dirsRes.rows.length <= 1;

      const userIdx = findStopIdx(stops, station);
      if (userIdx < 0) {
        return { route, ok: false, error: `站 ${station} 不在 ${route} 的站序中` };
      }

      // DSAT 实时车辆
      const res = await getBusPositions(route, queryDir, "poll");
      if (!res.ok || !res.data?.routeInfo) {
        return { route, ok: false, error: res.error ?? "DSAT 无数据" };
      }

      const N = stops.length;
      let nearest: EtaBus | null = null;
      let busCount = 0;
      const pending: EtaPendingBus[] = [];

      for (const st of res.data.routeInfo) {
        if (!st.busInfo?.length) continue;
        const busIdx = findStopIdx(stops, st.staCode);
        if (busIdx < 0) continue;
        for (const b of st.busInfo) {
          busCount++;
          const arrived = b.status === "1"; // s1=已到挂载站；s0=正在驶向挂载站（挂载站=下一站）
          // 总站停靠待发：s1 + 挂首/末站 + 该站不是用户等车站 → 不算站数（发车时间未知）
          // ★ speed 不可靠（实测 2026-09-03：待发车可能残留非空速度），不参与判定
          if (arrived && (busIdx === 0 || busIdx === N - 1) && busIdx !== userIdx) {
            pending.push({
              plate: b.busPlate ?? null,
              atStation: st.staCode,
              atStationName: stops[busIdx]?.name ?? st.staCode,
            });
            continue;
          }
          const diff = userIdx - busIdx; // >0 车在用户站后方；=0 挂用户站；<0 已过用户站
          let stopsAway: number;
          if (diff >= 0) {
            stopsAway = arrived ? diff : diff + 1;
          } else {
            // 车已过用户站：循环线绕一圈；双方向线跳过（不会再来）
            if (!isLoop) continue;
            stopsAway = diff + N + (arrived ? 0 : 1);
          }
          if (stopsAway > N) stopsAway = N;

          if (!nearest || stopsAway < nearest.stopsAway) {
            nearest = {
              plate: b.busPlate ?? null,
              stopsAway,
              atStation: st.staCode,
              atStationName: stops[busIdx]?.name ?? st.staCode,
              status: b.status ?? null,
              speed: b.speed ?? null,
            };
          }
        }
      }

      return {
        route,
        ok: true,
        dir: queryDir,
        isLoop,
        nearest: nearest ?? undefined,
        pending: pending.length > 0 ? pending : undefined,
        busCount,
      };
    } catch (err) {
      console.error(`[eta] 线路 ${route} 失败：`, (err as Error).message);
      return { route, ok: false, error: "查询失败" };
    }
  };

  // 并发分批：≤3 条/批，批内 Promise.all（顺序 = routes 传入顺序），避免多线路串行拖长耗时
  for (let i = 0; i < routes.length; i += BATCH_CONCURRENCY) {
    const batch = routes.slice(i, i + BATCH_CONCURRENCY);
    const batchResults = await Promise.all(batch.map((route) => queryOne(route)));
    results.push(...batchResults);
  }

  const data: EtaResponse = { fetchedAt: new Date().toISOString(), results };
  g.__etaCache!.set(cacheKey, { ts: Date.now(), data });
  return data;
}
