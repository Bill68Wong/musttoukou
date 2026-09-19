/**
 * GET /api/station/eta?code=<主码> —— 某巴士站的**全部线路实时报站**（v2.1.0 · 站点信息卡）
 *
 * ── 定位（产品口径 2026-09-19）─────────────────────────────────────────
 *   首页地图点击巴士站 → 信息卡：站名 + 该站**所有线路**的实时到站 + 「设为起点/目的地」。
 *   本接口只负责**实时报站**部分（站名/坐标由 `/api/stations` 提供）。
 *
 * ── 口径（★ 复用既有唯一实现，不自创第三套）────────────────────────────
 *   · 站序/方向/站名来自 `loadStatics().routeIdx`（= `route_stations` 内存索引，含 `dsat_dir`）；
 *   · 实时车距走 `fetchStationLive`（`src/lib/recommend/live.ts`）——与详情页「本站台其他线路」
 *     **同一函数**（内部 `queryEta`（`src/lib/dsat/eta.ts`）+ 逐跳 `segment_stats` 算分钟，
 *     禁「站数 × 常数」）⇒ 与 `/nav/detail` 报站文案口径**完全一致**。
 *
 * ── 每条 (线路 × 方向) 的构造（同 `nav/detail` 的 `foldLiveAt`）───────────
 *   该主码在某方向站序的**下一个站**作为 `dest` —— 用来自动定方向、并把**已过站**的车排除。
 *   终点站（无「下一站」）⇒ 跳过该方向（车从这里发车，无「到站」语义）。
 *
 * ── 只做巴士 ──────────────────────────────────────────────────────────
 *   轻轨走时刻表（非 DSAT），与本卡口径不同 ⇒ **跳过 `LRT-*`**（产品口径「只做巴士站」）。
 *
 * ── 并发 / 超时 / 缓存 ────────────────────────────────────────────────
 *   · 并发由 `fetchStationLive` 管理（每桶 ≤6 条线，桶间并发）；本接口再加**整体 8s 超时**兜底；
 *   · 内存小缓存 ~20s，防信息卡被连点打爆 DSAT（force 不可用，卡片重开命中缓存即可）。
 *
 * ── 降级 ──────────────────────────────────────────────────────────────
 *   单线失败/timeout ⇒ 该线 `ok=false`（卡片显示「暂无数据」），**不拖垮整体**；
 *   整体失败 ⇒ `items` 为空数组（前端显示「暂无报站」），绝不 500 阻塞地图。
 *
 * 幂等：只读（DSAT 实时 + 内存缓存），无副作用。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { loadStatics } from "@/lib/recommend/query";
import { fetchStationLive } from "@/lib/recommend/live";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { BusLive } from "@/lib/recommend/types";

/** 就近部署：Supabase 新加坡池化器 → sin1；pg/DSAT 需要 Node 运行时；请求期动态执行 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const maxDuration = 30;

/** 整体超时兜底（毫秒）——超过即按「无实时数据」返回，不阻塞卡片 */
const TOTAL_TIMEOUT_MS = 8_000;
/** 内存缓存 TTL（毫秒）——防连点打爆 DSAT */
const CACHE_TTL_MS = 20_000;

interface StationEtaItem {
  /** 线路码 */
  route: string;
  /** 查询方向（我们库 `dsat_dir`） */
  dir: string;
  /** 方向显示标签（如「往 關閘總站」） */
  dirLabel: string;
  /** 最近一辆车还有几站；null = 暂无在途车 */
  stopsAway: number | null;
  /** 最近一辆车约几分钟到站；null = 暂无在途车 */
  etaMin: number | null;
  /** false = 该线查询失败/超时（区别于「查询成功但暂无车」） */
  ok: boolean;
}

interface StationEtaResponse {
  code: string;
  fetchedAt: string;
  items: StationEtaItem[];
}

const g = globalThis as unknown as { __stationEtaCache?: Map<string, { ts: number; data: StationEtaResponse }> };
if (!g.__stationEtaCache) g.__stationEtaCache = new Map();

/** 剥掉站名里的「站码前缀」（`C653 金峰南岸` → `金峰南岸`） */
function stripCodePrefix(raw: string): string {
  return raw.replace(/^[A-Za-z]+\d+(?:\/\d+)?\s+/, "");
}

/** 超时包装：到点即拒（调用方按「无数据」处理） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const code = sp.get("code")?.trim() ?? "";
  if (!code) {
    return NextResponse.json({ error: "缺少 code 参数（站点主码）" }, { status: 400 });
  }
  const main = mainCodeOf(code);
  const nowMs = Date.now();

  // ① 内存缓存（连点保护）
  const cached = g.__stationEtaCache!.get(main);
  if (cached && nowMs - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.data, { headers: { "Cache-Control": "no-store" } });
  }

  let items: StationEtaItem[] = [];
  try {
    const pool = getPool();
    const st = await loadStatics(pool);
    const idx = st.routeIdx;
    const weekday = new Date(nowMs + 8 * 3_600_000).getUTCDay();

    // ② 枚举该主码出现的全部 (线路 × 方向)，构造「本站 → 下一站」查询作业
    const jobs: { station: string; dest: string; routes: string[] }[] = [];
    const meta: { route: string; dir: string; platform: string; dirLabel: string }[] = [];
    for (const [key, stops] of idx.dirStops) {
      const [route, dir] = key.split("|");
      if (route.startsWith("LRT-")) continue; // 只做巴士（轻轨走时刻表，口径不同）
      const i = stops.findIndex((c) => mainCodeOf(c) === main);
      if (i < 0) continue;
      if (i + 1 >= stops.length) continue; // 终点站：无「下一站」定方向 → 跳过
      const platform = stops[i];
      const terminal = idx.nameOf.get(stops[stops.length - 1]) ?? stops[stops.length - 1];
      jobs.push({ station: platform, dest: stops[i + 1], routes: [route] });
      meta.push({ route, dir, platform, dirLabel: `往 ${stripCodePrefix(terminal)}` });
    }

    if (jobs.length) {
      // ③ 实时（复用 fetchStationLive：与详情页报站同一实现）；整体超时兜底
      const liveMap = await withTimeout(
        fetchStationLive(pool, jobs, idx, st.segIdx, { todayWeekday: weekday, nowMs }),
        TOTAL_TIMEOUT_MS,
      ).catch((): Map<string, BusLive> => new Map());

      items = meta.map((m) => {
        const bl = liveMap.get(`${m.route}@${m.platform}`);
        const n = bl?.nearest ?? null;
        return {
          route: m.route,
          dir: m.dir,
          dirLabel: m.dirLabel,
          stopsAway: n ? n.stopsAway : null,
          etaMin: n ? Math.max(0, Math.round(n.loSec / 60)) : null,
          ok: !!bl, // 有 BusLive = 查询成功（nearest 为空 = 该方向暂无在途车，仍算成功）
        };
      });
    }
  } catch (e) {
    console.warn("[api/station/eta] 失败（收敛为空）：", (e as Error).message);
    items = [];
  }

  // ④ 按 etaMin 升序（暂无车排在最后）；同值按线路码稳定排序
  items.sort((a, b) => (a.etaMin ?? Number.POSITIVE_INFINITY) - (b.etaMin ?? Number.POSITIVE_INFINITY) || a.route.localeCompare(b.route));

  const data: StationEtaResponse = { code: main, fetchedAt: new Date(nowMs).toISOString(), items };
  g.__stationEtaCache!.set(main, { ts: nowMs, data });
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
