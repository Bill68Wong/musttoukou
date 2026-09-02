import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getBusPositions } from "@/lib/dsat/client";
import { findStopIdx } from "@/lib/station-match";

/**
 * GET /api/dsat/eta?station=T358&routes=26,51A&dir=0&dest=C688
 * 实时车距：对每条线路查 DB 站序 + DSAT 实时车辆，算最近的車距用户站还有几站。
 *  - dest（目标站）提供时，每条线路自行推导方向（from 在 to 之前的 dir），
 *    多段方案各段方向不同也能查对；推导不出时回退 dir 参数
 *  - status='1'（進站中/到达）→ 车就在挂载站，stopsAway = 站差
 *  - status='0'（行驶中）→ 挂载站是车的下一站，stopsAway = 站差 + 1
 *  - 循环线（DB 只有 dir=0 一套站序）取模 wrap；双方向线跳过已过站的车
 *  - 30 秒 globalThis 缓存（避免前端 60s 轮询 + 手动刷新打爆 DSAT）
 *  - 最多 3 条线路（一次调用 = 最多 3 次 DSAT 请求）
 */

interface EtaBus {
  plate: string | null;
  stopsAway: number; // 0 = 已到站
  atStation: string;
  atStationName: string;
  status: string | null;
  speed: string | number | null;
}

interface EtaRouteResult {
  route: string;
  ok: boolean;
  /** 本线路实际查询的方向（按 dest 推导，可能不同于 dir 参数） */
  dir?: string;
  isLoop?: boolean;
  nearest?: EtaBus;
  busCount?: number;
  error?: string;
}

interface EtaResponse {
  fetchedAt: string;
  results: EtaRouteResult[];
}

// 30s 缓存（dev 热重载下存活）
const CACHE_TTL_MS = 30_000;
const g = globalThis as unknown as {
  __etaCache?: Map<string, { ts: number; data: EtaResponse }>;
};
if (!g.__etaCache) g.__etaCache = new Map();

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const station = sp.get("station")?.trim() ?? "";
  const routesParam = sp.get("routes")?.trim() ?? "";
  const dir = sp.get("dir")?.trim() || "0";
  const dest = sp.get("dest")?.trim() || "";

  if (!station || !routesParam) {
    return NextResponse.json({ error: "缺少 station 或 routes 参数" }, { status: 400 });
  }
  const routes = routesParam
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 3); // 最多 3 条
  if (routes.length === 0) {
    return NextResponse.json({ error: "routes 参数为空" }, { status: 400 });
  }

  // 缓存命中直接返回
  const cacheKey = `${station}|${routes.join(",")}|${dir}|${dest}`;
  const cached = g.__etaCache!.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  const pool = getPool();
  const results: EtaRouteResult[] = [];

  for (const route of routes) {
    try {
      // 方向推导：dest 提供时按 from→to 找方向；推导不出回退 dir 参数
      // （循环线单方向 + from>to 时也回退，因循环线绕圈无所谓先后）
      let queryDir = dir;
      if (dest) {
        const dirRes = await pool.query(
          `SELECT rs.dsat_dir,
                  max(rs.seq) FILTER (WHERE rs.station_code = $2 OR rs.station_code LIKE $2 || '/%') AS from_seq,
                  max(rs.seq) FILTER (WHERE rs.station_code = $3 OR rs.station_code LIKE $3 || '/%') AS to_seq
           FROM route_stations rs
           JOIN routes r ON rs.route_id = r.id
           WHERE r.code = $1 AND r.kind = 'bus'
           GROUP BY rs.dsat_dir`,
          [route, station, dest],
        );
        let fallbackDir: string | null = null;
        let bothCount = 0;
        for (const row of dirRes.rows as {
          dsat_dir: string;
          from_seq: number | null;
          to_seq: number | null;
        }[]) {
          if (row.from_seq !== null && row.to_seq !== null) {
            bothCount++;
            fallbackDir = row.dsat_dir;
          }
          if (row.from_seq !== null && row.to_seq !== null && row.from_seq < row.to_seq) {
            queryDir = row.dsat_dir;
            break;
          }
        }
        // 兜底：循环线只有一套站序（from>to 绕圈）→ 用唯一含两站的方向
        if (queryDir === dir && bothCount === 1 && fallbackDir) {
          queryDir = fallbackDir;
        }
      }

      // 站序 + 站名（该方向）
      const stopsRes = await pool.query(
        `SELECT rs.seq, rs.station_code AS code, st.name_tc AS name
         FROM route_stations rs
         JOIN routes r ON rs.route_id = r.id
         JOIN stations st ON rs.station_code = st.code
         WHERE r.code = $1 AND r.kind = 'bus' AND rs.dsat_dir = $2
         ORDER BY rs.seq`,
        [route, queryDir],
      );
      const stops = stopsRes.rows as { seq: number; code: string; name: string }[];
      if (stops.length === 0) {
        results.push({ route, ok: false, error: `线路 ${route} 未同步站序（dir=${queryDir}）` });
        continue;
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
        results.push({ route, ok: false, error: `站 ${station} 不在 ${route} 的站序中` });
        continue;
      }

      // DSAT 实时车辆
      const res = await getBusPositions(route, queryDir, "poll");
      if (!res.ok || !res.data?.routeInfo) {
        results.push({ route, ok: false, error: res.error ?? "DSAT 无数据" });
        continue;
      }

      const N = stops.length;
      let nearest: EtaBus | null = null;
      let busCount = 0;

      for (const st of res.data.routeInfo) {
        if (!st.busInfo?.length) continue;
        const busIdx = findStopIdx(stops, st.staCode);
        if (busIdx < 0) continue;
        for (const b of st.busInfo) {
          busCount++;
          const arrived = b.status === "1";
          const diff = userIdx - busIdx; // >0 车在用户站后方（会开来）；=0 同站；<0 已过
          let stopsAway: number;
          if (diff >= 0) {
            stopsAway = arrived ? diff : diff + 1;
          } else {
            // 车已过用户站：循环线绕一圈；双方向线跳过（不会开来）
            if (!isLoop) continue;
            stopsAway = diff + N + (arrived ? 0 : 1);
          }
          // 已离站（status=0 且挂载站=用户站）的车已经开走：循环线算整圈，双方向线跳过
          if (diff === 0 && !arrived && !isLoop) continue;
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

      results.push({
        route,
        ok: true,
        dir: queryDir,
        isLoop,
        nearest: nearest ?? undefined,
        busCount,
      });
    } catch (err) {
      console.error(`[eta] 线路 ${route} 失败：`, (err as Error).message);
      results.push({ route, ok: false, error: "查询失败" });
    }
  }

  const data: EtaResponse = { fetchedAt: new Date().toISOString(), results };
  g.__etaCache!.set(cacheKey, { ts: Date.now(), data });
  return NextResponse.json(data);
}
