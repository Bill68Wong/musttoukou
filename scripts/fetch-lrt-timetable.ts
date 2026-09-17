/**
 * 澳门轻轨（MLM）时刻表抓取入库（scripts/fetch-lrt-timetable.ts）
 * 用法：npm run lrt:fetch -- [local|cloud]     （默认 local）
 *
 * 数据源：motransportinfo.com（DSAT 同源官方结构化接口）
 *   1. getLrtStations.php          → 站清单（merge lat/lng 到 lrt_api_stations）
 *   2. getMlmTimetable.php?all=1   → 每站每线每方向三班别整表 → lrt_timetables upsert
 *
 * 幂等：同 (api_station, route_no, direction, day_type) 覆盖 minutes/first/last/fetched_at。
 * ⚠️ 数据完整性：首末班存「当日 00:00 起分钟偏移」（可 >1440 = 周五/假期跨午夜 25:xx 收车）。
 * ⚠️ 自检：抓取日若为周末/假期，各站 today 应一致（周六/日 → sat_sun_holiday）；
 *          不符则告警（班别语义需人工复核，勿静默吞掉）。
 */
import { Pool } from "pg";
import { LRT_API_STATIONS } from "../db/data/lrt-api-stations";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const target = process.argv[2] as "local" | "cloud" | undefined;
const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL)
      : ((process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL) || process.env.DATABASE_URL);
if (!connStr) {
  console.error("❌ 未找到连接串：请先在 .env 配置");
  process.exit(1);
}
console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);

const BASE = "https://motransportinfo.com/its";
const LANGS = "zh";

type DayType = "mon_thurs" | "fri" | "sat_sun_holiday";
interface ApiStation {
  main_stop_id: string;
  name_zh: string;
  name: string;
  lat: string;
  lng: string;
}
interface TimetableDay {
  first: string;
  last: string;
  timetable: { hour: number; minutes: number[] }[];
}
interface TimetableRoute {
  route_no: string;
  direction: string;
  direction_name: string;
  days: Partial<Record<DayType, TimetableDay>>;
}
interface TimetableResp {
  today?: DayType;
  routes: TimetableRoute[];
}

/** 'HH:MM'（可 >24h，如 '25:05'）→ 当日 00:00 起分钟偏移 */
function hhmmToMin(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return (await res.json()) as T;
}

async function main() {
  const pool = new Pool({ connectionString: connStr });
  const known = new Map(LRT_API_STATIONS.map((s) => [s.api_id, s]));
  let inserted = 0;
  let updated = 0;
  let skippedStation = 0;
  const todaySeen = new Map<string, number>();

  try {
    // 1) 站清单：刷新坐标（名保持本库口径不覆盖；未映射的新站告警跳过）
    let apiStations: ApiStation[] = [];
    try {
      apiStations = await fetchJson<ApiStation[]>(`${BASE}/getLrtStations.php?lang=${LANGS}`);
      console.log(`📡 getLrtStations: ${apiStations.length} 条（含多站台重复）`);
    } catch (e) {
      console.error(`❌ getLrtStations 失败：`, (e as Error).cause ?? (e as Error).message);
    }
    const seenApi = new Set<string>();
    for (const st of apiStations) {
      if (seenApi.has(st.main_stop_id)) continue; // LOT/UH 多站台取首条坐标
      seenApi.add(st.main_stop_id);
      if (!known.has(st.main_stop_id)) {
        console.warn(`⚠️ 未映射站 ${st.main_stop_id}(${st.name_zh})——请补 db/data/lrt-api-stations.ts`);
        continue;
      }
      const lat = st.lat === "" || st.lat == null ? null : Number(st.lat);
      const lng = st.lng === "" || st.lng == null ? null : Number(st.lng);
      await pool.query(
        `UPDATE lrt_api_stations SET lat = COALESCE($2, lat), lng = COALESCE($3, lng)
         WHERE api_id = $1`,
        [st.main_stop_id, lat, lng],
      );
    }

    // 2) 逐站抓整表（全部三班别入库）
    const apiIds = [...known.keys()];
    for (const apiId of apiIds) {
      let resp: TimetableResp;
      try {
        resp = await fetchJson<TimetableResp>(
          `${BASE}/getMlmTimetable.php?station_id=${apiId}&all=1&lang=${LANGS}`,
        );
      } catch (e) {
        console.error(
          `❌ ${apiId} getMlmTimetable 失败：`,
          (e as Error).cause ?? (e as Error).message,
        );
        skippedStation++;
        continue;
      }
      if (resp.today) todaySeen.set(resp.today, (todaySeen.get(resp.today) ?? 0) + 1);
      for (const route of resp.routes) {
        for (const [dayType, day] of Object.entries(route.days) as [DayType, TimetableDay][]) {
          if (!day) continue;
          const firstMin = hhmmToMin(day.first);
          const lastMin = hhmmToMin(day.last);
          if (firstMin == null || lastMin == null) {
            console.warn(
              `⚠️ ${apiId} ${route.route_no}→${route.direction} ${dayType} 首末班异常 first=${day.first} last=${day.last}，跳过`,
            );
            continue;
          }
          const r = await pool.query(
            `INSERT INTO lrt_timetables (api_station, route_no, direction, day_type, first_min, last_min, minutes, fetched_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, now())
             ON CONFLICT (api_station, route_no, direction, day_type) DO UPDATE
               SET first_min = EXCLUDED.first_min, last_min = EXCLUDED.last_min,
                   minutes = EXCLUDED.minutes, fetched_at = now()
             RETURNING (xmax = 0) AS was_insert`,
            [apiId, route.route_no, route.direction, dayType, firstMin, lastMin, JSON.stringify(day.timetable)],
          );
          const wasInsert = (r.rows[0] as { was_insert: boolean }).was_insert;
          if (wasInsert) inserted++;
          else updated++;
        }
      }
      await new Promise((res) => setTimeout(res, 150)); // 温和限速
      console.log(`  ✅ ${apiId}（${known.get(apiId)?.db_code}） ${resp.routes.length} 条线路已入库`);
    }

    // 3) 汇总
    console.log("----");
    console.log(`✅ 完成：lrt_timetables 新增 ${inserted} 行 / 覆盖 ${updated} 行`);
    if (skippedStation > 0) console.warn(`⚠️ ${skippedStation} 站抓取失败（见上）`);
    if (todaySeen.size > 0) {
      const toks = [...todaySeen.entries()].map(([k, v]) => `${k}×${v}`).join(", ");
      console.log(`ℹ️ 各站 today 分布：${toks}`);
      // 自检：今天若为周六/日/假期，today 应全部 sat_sun_holiday
      const macauNow = new Date(Date.now() + 8 * 3600 * 1000);
      const dow = macauNow.getUTCDay(); // 0=周日
      if ((dow === 0 || dow === 6) && [...todaySeen.keys()].some((k) => k !== "sat_sun_holiday")) {
        console.warn(
          "⚠️ 今日为周末但存在非 sat_sun_holiday 的 today —— 班别语义与预期不符，需人工复核！",
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ 抓取失败：", (err as Error).cause ?? (err as Error).message);
  process.exit(1);
});
