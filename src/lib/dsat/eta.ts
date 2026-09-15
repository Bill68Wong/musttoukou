import { getPool } from "@/lib/db";
import { getBusPositions } from "@/lib/dsat/client";
import { findStopIdx } from "@/lib/station-match";
import { deriveDirInMemory } from "@/lib/recommend/enumerate";
import type { RouteIndex } from "@/lib/recommend/types";

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
 *  - v0.8.4 起站距口径（2026-09-04 实测修正，推翻 9-3 假设）：
 *    DSAT 挂载站按「到站事件」更新——车离站后仍挂旧站（status=0），直到驶到
 *    下一站停稳才切换。因此：
 *      status='1' = 停靠挂载站（到站/上下客中）→ stopsAway = 站差
 *      status='0' = 已离开挂载站驶向下一站（挂载站=刚离的站）→ stopsAway = 站差
 *    （s0/s1 同值：车从停 X 到离 X 再到停 X+1，剩余停靠数不变，数字单调递减，
 *      不再有 s0 的 +1，整段站间的虚高从根上消失）
 *    实测证据：用户"车驶离 C654/3（紧邻等车站）仍显示还有 2 站"；
 *    probe-switch.ts 采样 AB5503 s0@C652 连续 40s+ 后才 s1@C655（到站才切）
 *  - s0 挂用户站 = 车刚离站：环线按绕一圈 N 站计；双方向线跳过（不会再来）
 *  - 总站停靠（status=1 + 挂首/末站，且非用户等车站）= 未发车，不在途——
 *    直接排除，不参与站数计算（★ speed 不可靠不参与判定：实测待发车可能残留非空速度）
 *  - v0.12.2（2026-09-05）返回「最近车 nearest + 再下一班车 second」两辆在途车，
 *    不再收集/展示"另有 N 辆总站待发"（该信息不可靠，用户定稿删除）
 *  - 循环线（DB 只有 dir=0 一套站序）已过站按绕圈计；双方向线跳过已过站的车
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
  /**
   * ★ v1.0.0：挂载站 → 用户站的**逐跳站码对**（`[[a,b],...]`，长度 = stopsAway）。
   * 仅当调用方注入 `routeIndex` 时填充（旧路径不填，保持输出字节级不变）。
   *
   * 意义：自动选线要按逐跳查 segment_stats 算「还有几分钟」（禁「站数 × 常数」）。
   * 这里由 queryEta **自己**给出它算 stopsAway 时用的那段区间 —— 环线（只有 dir=0 一套站序、
   * 首尾同码）在别处重新展开极易取到**另一圈**的跳（实测把 2 站报成 16.8 分）→ 必须同源。
   */
  hops?: [string, string][];
}

export interface EtaRouteResult {
  route: string;
  ok: boolean;
  /** 本线路实际查询的方向（按 dest 推导，可能不同于 dir 参数） */
  dir?: string;
  isLoop?: boolean;
  /** 最近一辆在途车 */
  nearest?: EtaBus;
  /** v0.12.2：再下一班在途车（第二近；站数不突出显示，副行展示） */
  second?: EtaBus;
  busCount?: number;
  /** v0.13.x：等车站 = 本方向站序首站（总站/起点）——前端据此区分「暂未发车」文案 */
  headTerminal?: boolean;
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
/**
 * ★ v1.0.2：**推荐路径**的批并发（6 = MAX_ROUTES，即一个桶一次并发完）。
 *
 * 线上函数执行在 iad1（美东）、DSAT 在澳门 → 冷启动时首轮请求需先建 TLS（~0.6s）。
 * 一个桶最多 6 条线，按 3 条/批会串成两批 ≈ 1.1s，**紧贴 `live.ts` 的 1.2s 桶超时**
 * → 实测冷启动 11 个桶里 9 个超时（`✗bus:…=1200ms`），巴士线被整批剔除、只剩轻轨卡。
 * 推荐路径放宽到 6 一次并发完，桶耗时约减半。
 *
 * 峰值仍温和：桶多为「1 桶 1 线」，实测一次推荐总计 ≈ 9 次 DSAT 调用
 * （与采集器并发 6 同量级）；计时主流程仍走 3，行为不变。
 */
const BATCH_CONCURRENCY_RECOMMEND = 6;
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

/** 查询多线路实时车距（命中 5s 缓存直接返回；force=true 绕过缓存直查并回写）
 *
 * ★ v1.0.0：新增可选 `routeIndex` 注入（自动选线用）——传入时，方向推导 / 循环线判定 /
 *   站序与站名全部走**内存索引**，把每条线路的 3 次 DB 往返压成 0 次（12 条线 ≈ 36 次往返 → 0）。
 *   **不传 = 完全走旧路径**（计时主流程 / LiveEta 行为字节级不变）。
 */
export async function queryEta(
  station: string,
  routesIn: string[],
  dirIn: string,
  dest: string,
  force = false,
  /** v0.20.9：合并卡各线上车台不同（M9/2、M9/3、M9/4）→ 按线路指定查询站台 */
  stationByRoute?: Record<string, string>,
  /** ★ v1.0.0：站序内存索引（不传 = 旧路径，逐条查库） */
  routeIndex?: RouteIndex,
  /** ★ v1.0.0：DSAT 调用用途（推荐路径用 'recommend' → 不进熔断判定 + 独立超时） */
  purpose: "timer_grab" | "poll" | "recommend" = "timer_grab",
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
      // v0.20.9：该线路自己的上车台（合并卡各线站台不同），缺省用传入 station
      const st = stationByRoute?.[route] || station;
      // 方向推导：dest 提供时按 from→to 找方向；推导不出回退 dir 参数
      // （循环线单方向 + from>to 时也回退，因循环线绕圈无所谓先后）
      // ★ v1.0.0：注入 routeIndex 时走内存版（同一套语义，省 1 次 DB 往返）
      const queryDir = dest
        ? routeIndex
          ? deriveDirInMemory(routeIndex, route, st, dest, dir)
          : await deriveRouteDir(route, st, dest, dir)
        : dir;

      // 循环线判定：该线路在 DB 只有 dir=0 一套站序（双方向线会有 dir=0/1 两套）
      const isLoop = routeIndex
        ? (routeIndex.dirsOf.get(route)?.length ?? 0) <= 1
        : (
            await pool.query(
              `SELECT DISTINCT rs.dsat_dir FROM route_stations rs
               JOIN routes r ON rs.route_id = r.id WHERE r.code = $1 AND r.kind = 'bus'`,
              [route],
            )
          ).rows.length <= 1;

      // 站序 + 站名（该方向）；v0.4.0 起巴士站名带站号前缀（"T358 偉龍/科大醫院"），轻轨不带
      const loadStops = async (d: string): Promise<{ seq: number; code: string; name: string }[]> => {
        if (routeIndex) {
          const codes = routeIndex.dirStops.get(`${route}|${d}`);
          if (!codes) return [];
          return codes.map((code, i) => ({ seq: i, code, name: routeIndex.nameOf.get(code) ?? code }));
        }
        const res = await pool.query(
          `SELECT rs.seq, rs.station_code AS code,
                  (CASE WHEN st.kind = 'bus' THEN rs.station_code || ' ' || st.name_tc ELSE st.name_tc END) AS name
           FROM route_stations rs
           JOIN routes r ON rs.route_id = r.id
           JOIN stations st ON rs.station_code = st.code
           WHERE r.code = $1 AND r.kind = 'bus' AND rs.dsat_dir = $2
           ORDER BY rs.seq`,
          [route, d],
        );
        return res.rows as { seq: number; code: string; name: string }[];
      };

      // v0.18.4：同台多线候选的方向未必与「dest 推导/会话方向」一致——典型 26A 仅在
      // dir1（北行 C669/2→M95/3）停 C653，而 dir0（南行）不含；若 dest 不属于该线
      // （如 C653 合并卡的 dest=T400 是 50 的终点）方向推导会偏 → 所选方向站序不含
      // 用户站时，换另一方向兜底（仅双方向线），避免「站 C653 不在 26A 的站序中」误报
      let effDir = queryDir;
      let stops = await loadStops(queryDir);
      let userIdx = findStopIdx(stops, st);
      if (userIdx < 0 && !isLoop) {
        const alt = queryDir === "0" ? "1" : "0";
        const altStops = await loadStops(alt);
        if (altStops.length > 0 && findStopIdx(altStops, st) >= 0) {
          effDir = alt;
          stops = altStops;
          userIdx = findStopIdx(stops, st);
        }
      }
      if (stops.length === 0) {
        return { route, ok: false, error: `线路 ${route} 未同步站序（dir=${effDir}）` };
      }
      if (userIdx < 0) {
        return { route, ok: false, error: `站 ${st} 不在 ${route} 的站序中` };
      }

      // DSAT 实时车辆
      // ★ v1.0.0：推荐路径用 purpose='recommend' → 不进熔断判定 + 独立 1.5s 超时
      const res = await getBusPositions(route, effDir, purpose === "recommend" ? "recommend" : "poll");
      if (!res.ok || !res.data?.routeInfo) {
        return { route, ok: false, error: res.error ?? "DSAT 无数据" };
      }

      const N = stops.length;
      let busCount = 0;
      /**
       * 从挂载站起沿行驶方向走 steps 步的逐跳站码对。
       * 与下方 `stopsAway` 的计算**同源**（同一套 stops/索引）→ 环线绕圈也不会取到另一圈。
       * 仅注入 routeIndex 时随结果返回（v1.0.0 自动选线用来逐跳查 segment_stats）。
       */
      const hopPairsOf = (fromIdx: number, steps: number): [string, string][] => {
        const out: [string, string][] = [];
        for (let k = 0; k < steps; k++) {
          const a = stops[(fromIdx + k) % N];
          const b = stops[(fromIdx + k + 1) % N];
          if (!a || !b) break;
          out.push([a.code, b.code]); // 站码口径 = station_code（带站台号，如 T355/1）
        }
        return out;
      };
      // v0.12.2：收集在途候选车，按站距排序取前二（最近车 + 再下一班车）。
      // 总站停靠（status=1 + 挂首/末站，非用户等车站）= 未发车，不在途，直接排除——
      // 不再收集展示（原 v0.6.0「另有 N 辆总站待发」信息不可靠，用户定稿删除）。
      const inTransit: EtaBus[] = [];
      const seenPlates = new Set<string>();

      for (const st of res.data.routeInfo) {
        if (!st.busInfo?.length) continue;
        const busIdx = findStopIdx(stops, st.staCode);
        if (busIdx < 0) continue;
        for (const b of st.busInfo) {
          busCount++;
          // ★ v0.8.4 口径修正（2026-09-04 用户实测 + 切站采样推翻 9-3 假设）：
          //   DSAT 挂载站更新 =「到站事件」驱动——车离站后仍挂旧站（s0），直到驶到下一站
          //   停稳才切换。因此 s0 挂 X = 车已离开 X（已过站），不是"正在驶向 X（未到）"。
          //   ⇒ 站距 = 用户站与挂载站的站差，s0/s1 同值，不再 +1；
          //     数字从"停 X"到"离 X"到"停 X+1"单调递减，过渡帧虚高从根上消失。
          //   实测证据（probe-switch.ts，26 路 5 帧 20s 间隔）：AB5503 s0@C652 连续 40s+
          //     → 直接 s1@C655；MX7866/AC4098 同模式（离站挂旧站→到站才切）。
          //   用户场景：车驶离 C654/3（紧邻等车站 C653）应显示"即将进站"而非"还有 2 站"。
          const arrived = b.status === "1"; // s1=停靠挂载站；s0=已离挂载站驶向下一站
          // 总站停靠待发（s1 + 挂首/末站 + 该站不是用户等车站）→ 不在途，跳过
          // ★ speed 不可靠（实测 2026-09-03：待发车可能残留非空速度），不参与判定
          if (arrived && (busIdx === 0 || busIdx === N - 1) && busIdx !== userIdx) {
            continue;
          }
          // 同牌去重：DSAT 极少把同一辆车挂多站，防同一辆车占掉最近+下一班两个名额
          if (b.busPlate) {
            if (seenPlates.has(b.busPlate)) continue;
            seenPlates.add(b.busPlate);
          }
          // ★ v0.13.x（2026-09-05 用户实测 51 路蝴蝶谷总站）总站等车统一规则：
          //   等车站 = 本方向站序首站（总站/起点，userIdx===0）时，乘客能上的只有
          //   「正停在首站待发」的车（arrived@首站 → 0 站 = 已进站）；
          //   其余车辆一律不计站数——
          //     · 已从首站开出的车（s0@首站 或途中的车）= 这一趟已错过，上不了；
          //     · 绕回总站段的车（循环线回程，如 51 路 seq12~18）= 到站下客 ≠ 立刻折返再发，
          //       不能按绕一圈折算站数（旧逻辑 N+diff 折算成 1~9 站误导）。
          //   实测铁证（probe-51.ts）：51 路 11 辆车中 4 辆挂回总站段（T354 seq12 / T418 seq14
          //   / T433 seq15 / T385 seq18）。
          if (userIdx === 0) {
            if (arrived && busIdx === 0) {
              inTransit.push({
                plate: b.busPlate ?? null,
                stopsAway: 0,
                atStation: st.staCode,
                atStationName: stops[0]?.name ?? st.staCode,
                status: b.status ?? null,
                speed: b.speed ?? null,
                hops: routeIndex ? [] : undefined,
              });
            }
            continue;
          }
          const diff = userIdx - busIdx; // >0 车在用户站后方；=0 挂用户站；<0 已过用户站
          let stopsAway: number;
          if (diff > 0) {
            // 车停 busIdx（s1）或已离 busIdx 驶向 busIdx+1（s0）：到用户站还要停靠
            // busIdx+1..userIdx 共 diff 次 → 两者同值
            stopsAway = diff;
          } else if (diff === 0) {
            if (arrived) {
              stopsAway = 0; // 停靠用户站 = 已进站
            } else if (isLoop) {
              stopsAway = N; // 环线车刚离用户站：绕一圈才回，显示整环站数
            } else {
              continue; // 双方向线车刚离用户站：已过站不会再来，跳过
            }
          } else {
            // 车已过用户站：循环线绕一圈回来；双方向线跳过（不会再来）
            if (!isLoop) continue;
            stopsAway = N + diff; // 车停或已离 busIdx（均>userIdx）：绕回 userIdx 的停靠数恒 N+diff
          }
          if (stopsAway > N) stopsAway = N;

          inTransit.push({
            plate: b.busPlate ?? null,
            stopsAway,
            atStation: st.staCode,
            atStationName: stops[busIdx]?.name ?? st.staCode,
            status: b.status ?? null,
            speed: b.speed ?? null,
            hops: routeIndex ? hopPairsOf(busIdx, stopsAway) : undefined,
          });
        }
      }

      // 按站距升序取前二：nearest = 最近车，second = 再下一班车
      inTransit.sort(
        (a, b) =>
          a.stopsAway - b.stopsAway ||
          (a.atStation === b.atStation ? (a.plate ?? "").localeCompare(b.plate ?? "") : a.atStation.localeCompare(b.atStation)),
      );
      const nearest = inTransit[0];
      const second = inTransit[1];

      return {
        route,
        ok: true,
        dir: effDir,
        isLoop,
        nearest,
        second,
        busCount,
        headTerminal: userIdx === 0,
      };
    } catch (err) {
      console.error(`[eta] 线路 ${route} 失败：`, (err as Error).message);
      return { route, ok: false, error: "查询失败" };
    }
  };

  // 并发分批：批内 Promise.all（顺序 = routes 传入顺序），避免多线路串行拖长耗时。
  // ★ v1.0.2：推荐路径放宽到 6（一个桶一次并发完，见 BATCH_CONCURRENCY_RECOMMEND）；
  //   计时主流程仍 3 条/批（对 DSAT 温和，不突刺）。
  const batchSize = purpose === "recommend" ? BATCH_CONCURRENCY_RECOMMEND : BATCH_CONCURRENCY;
  for (let i = 0; i < routes.length; i += batchSize) {
    const batch = routes.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((route) => queryOne(route)));
    results.push(...batchResults);
  }

  const data: EtaResponse = { fetchedAt: new Date().toISOString(), results };
  g.__etaCache!.set(cacheKey, { ts: Date.now(), data });
  return data;
}
