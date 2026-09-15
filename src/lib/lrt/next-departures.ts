/**
 * 轻轨发车查询（src/lib/lrt/next-departures.ts，v1.0.0）
 *
 * 从 `/api/lrt/eta/route.ts` **抽取**的核心逻辑（v1.0.0 只为自动选线复用，口径零变更）：
 *   站序推方向 → lrt_api_stations 换 api 站/方向码 → 当日班别 + 昨日跨午夜续班
 *   → next/nextN → 空态枚举（首班前/收车/无数据）。
 *
 * ⚠️ 输入一律**本库码**（`LRT-氹仔线` / `LRT-MUST`）；motransportinfo 的 route_no / api_id
 *    只在服务端内部出现。换乘站目标台码常属他线，勿拿他线码反推（项目教训）。
 * ⚠️ 不依赖 DSAT；日期/假期基准均 GMT+8 本地判定。
 */
import type { Pool } from "pg";
import { type DayType, dayTypeOf, macauNowParts, shiftYmd } from "./day-type";
import { LRT_LINE_TO_ROUTE_NO, destLabelOf, directionOfTravel, isLrtLineCode, isLrtStationCode } from "./map";
import { type LrtTimetableMinutes, hhmmOf, hhmmOfMinutes, nextN, rowCandidateSec } from "./eta";

const DAY_MS = 86_400_000;

export interface LrtDepartureRow {
  /** 'HH:MM' */
  clock: string;
  /** 绝对毫秒（服务日 D 00:00 + 偏移；可跨午夜） */
  depMs: number;
}

export interface LrtDeparturesOk {
  ok: true;
  state: "running" | "before_first" | "after_last" | "no_data";
  stationCode: string;
  lineCode: string;
  routeNo: string;
  dir: string;
  directionCode: string;
  directionName: string;
  dayType: DayType;
  serviceDay: string;
  firstClock: string | null;
  lastClock: string | null;
  departures: LrtDepartureRow[];
  serverNow: string;
}

export interface LrtDeparturesErr {
  ok: false;
  error: string;
  /** HTTP 语义状态（400 = 参数错；500 = 数据缺失） */
  status: number;
}

export type LrtDeparturesResult = LrtDeparturesOk | LrtDeparturesErr;

export interface LrtDeparturesInput {
  /** 本库站码（LRT-*） */
  station: string;
  /** 本库线路码（LRT-*线） */
  route: string;
  /** 目的地本库站码（可省；给了就能推方向） */
  dest?: string | null;
  /** 本段方向（dest 推不出时用） */
  dir?: string | null;
  /** 返回班次数上限（默认 2 —— 与既有 /api/lrt/eta 完全一致；推荐层传更多） */
  take?: number;
  /**
   * ★ v1.0.0：时间基准注入（默认 `Date.now()`）。
   * 用途：① 探针在**收班时段**用假时间验证白天行为（深夜无法验证「出卡」，
   *       但可以证明同一份时刻表在 08:00 会给出正常班次）；
   *      ② 未来「按计划出发时间规划」的接口预留。
   * ⚠️ 不传 = 完全走旧路径，`/api/lrt/eta` 行为字节级不变。
   */
  nowMs?: number;
}

/** 后续第 n 班（严格晚于 atMs 的最近一班） */
export function nextAfter(departures: LrtDepartureRow[], atMs: number): LrtDepartureRow | null {
  return departures.find((d) => d.depMs > atMs) ?? null;
}

/**
 * 查某站某线的后续发车时刻。
 * @returns ok:false 时 `status` 给出 HTTP 语义（400/500），调用方直接透传
 */
export async function queryLrtDepartures(
  pool: Pool,
  input: LrtDeparturesInput,
): Promise<LrtDeparturesResult> {
  const station = input.station?.trim() ?? "";
  const route = input.route?.trim() ?? "";
  const dest = input.dest?.trim() || null;
  const dirParam = input.dir?.trim() || null;
  const take = Math.max(1, Math.min(20, input.take ?? 2));

  if (!isLrtStationCode(station)) {
    return { ok: false, error: "参数 station 须为本库轻轨站码（LRT-*）", status: 400 };
  }
  if (!isLrtLineCode(route) || !LRT_LINE_TO_ROUTE_NO[route]) {
    return { ok: false, error: "参数 route 须为本库轻轨线路码（LRT-*线）", status: 400 };
  }
  if (dest && !isLrtStationCode(dest)) {
    return { ok: false, error: "参数 dest 须为本库轻轨站码（LRT-*）", status: 400 };
  }
  if (!dest && !dirParam) {
    return { ok: false, error: "缺少 dest 或 dir", status: 400 };
  }
  const routeNo = LRT_LINE_TO_ROUTE_NO[route];

  try {
    // 1) 线路站序（本库码，按 dsat_dir 分组）→ 乘车方向 & 终点站
    const stopsRes = await pool.query(
      `SELECT rs.dsat_dir, rs.station_code
       FROM route_stations rs
       JOIN routes r ON r.id = rs.route_id
       WHERE r.code = $1 AND r.kind = 'lrt'
       ORDER BY rs.dsat_dir, rs.seq`,
      [route],
    );
    const dirStops: Record<string, string[]> = {};
    for (const row of stopsRes.rows as { dsat_dir: string; station_code: string }[]) {
      (dirStops[row.dsat_dir] ??= []).push(row.station_code);
    }
    const dirs = Object.keys(dirStops);
    if (dirs.length === 0) {
      return { ok: false, error: "线路站序缺失（route_stations 未同步？）", status: 500 };
    }
    const dir = dest ? directionOfTravel(dirStops, station, dest, dirParam ?? "0") : (dirParam ?? "0");
    const terminusDb = dirStops[dir]?.[(dirStops[dir]?.length ?? 0) - 1];
    if (!terminusDb) {
      return { ok: false, error: `方向 ${dir} 无站序`, status: 500 };
    }

    // 2) 上车站 & 方向终点 → motransportinfo 站码（API 码只在服务端内部）
    const stRes = await pool.query(`SELECT api_id FROM lrt_api_stations WHERE db_code = $1`, [station]);
    const termRes = await pool.query(`SELECT api_id, name_tc FROM lrt_api_stations WHERE db_code = $1`, [
      terminusDb,
    ]);
    const stationApi = (stRes.rows[0] as { api_id?: string } | undefined)?.api_id;
    const termRow = termRes.rows[0] as { api_id?: string; name_tc?: string } | undefined;
    if (!stationApi || !termRow?.api_id) {
      return { ok: false, error: "站点映射缺失（lrt_api_stations）", status: 500 };
    }
    const directionApi = termRow.api_id;
    const directionName = destLabelOf(termRow.name_tc);

    // 3) 班别：今日 + 昨日（昨日仅用于跨午夜续班，班别各自按日判定）
    const nowMsRef = input.nowMs ?? Date.now();
    const now = macauNowParts(new Date(nowMsRef));
    const holRes = await pool.query(`SELECT 1 FROM lrt_holidays WHERE holiday_date = $1`, [now.ymd]);
    const dayType: DayType = dayTypeOf(now.weekday, (holRes.rowCount ?? 0) > 0);
    const prevYmd = shiftYmd(now.ymd, -1);
    const prevWeekday = new Date(`${prevYmd}T00:00:00Z`).getUTCDay();
    const prevHol = await pool.query(`SELECT 1 FROM lrt_holidays WHERE holiday_date = $1`, [prevYmd]);
    const prevDayType: DayType = dayTypeOf(prevWeekday, (prevHol.rowCount ?? 0) > 0);

    // 4) 时刻行（并行取今日 + 昨日跨午夜续班）
    const rowSql = `SELECT first_min, last_min, minutes FROM lrt_timetables
                    WHERE api_station = $1 AND route_no = $2 AND direction = $3 AND day_type = $4`;
    const [todayRes, prevRes] = await Promise.all([
      pool.query(rowSql, [stationApi, routeNo, directionApi, dayType]),
      pool.query(rowSql, [stationApi, routeNo, directionApi, prevDayType]),
    ]);
    const todayRow = todayRes.rows[0] as LrtTimetableMinutes | undefined;
    const prevRow = prevRes.rows[0] as LrtTimetableMinutes | undefined;

    // 5) 合并候选（「服务日 D 00:00 起秒」单轴）→ 后续 n 班
    const candSec: number[] = [];
    if (todayRow) candSec.push(...rowCandidateSec(todayRow, false));
    if (prevRow) candSec.push(...rowCandidateSec(prevRow, true));
    const nowMs = nowMsRef;
    const dayStartUtcMs = nowMs - ((nowMs + 8 * 3_600_000) % DAY_MS); // 澳门今日 00:00
    const next = nextN(candSec, now.daySec, take);

    // 6) 空态判定
    let state: LrtDeparturesOk["state"] = "no_data";
    if (next.length > 0) state = "running";
    else if (todayRow && now.daySec < todayRow.first_min * 60) state = "before_first";
    else if (todayRow) state = "after_last";

    return {
      ok: true,
      state,
      stationCode: station,
      lineCode: route,
      routeNo,
      dir,
      directionCode: directionApi,
      directionName,
      dayType,
      serviceDay: now.ymd,
      firstClock: todayRow ? hhmmOfMinutes(todayRow.first_min) : null,
      lastClock: todayRow ? hhmmOfMinutes(todayRow.last_min) : null,
      departures: next.map((s) => ({ clock: hhmmOf(s), depMs: dayStartUtcMs + s * 1000 })),
      serverNow: new Date(nowMs).toISOString(),
    };
  } catch (err) {
    console.error("[lrt/next-departures] 查询失败：", (err as Error).message);
    return { ok: false, error: "时刻表查询失败", status: 500 };
  }
}
