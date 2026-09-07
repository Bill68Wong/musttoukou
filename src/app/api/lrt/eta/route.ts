/**
 * GET /api/lrt/eta —— 轻轨时刻表报站（本地算，v0.15.0）
 * 参数：station(本库站码 LRT-xxx) & route(本库线路码 LRT-氹仔线…) & dest(目的地站码，可省)
 *       dir(本段方向 '0'|'1'，dest 可推导时省略)
 * 逻辑：route_stations 推方向 → lrt_api_stations 换 api 站/方向码 → 当日班别 + 昨日跨午夜
 *       续班 取 next/next2 → 空态枚举（首班前/收车/无数据）。
 * ⚠️ 输入一律本库码，API 码只在服务端内部；换乘站目标台码常属他线，勿拿他线码反推（教训）。
 * ⚠️ 不依赖 DSAT 实时；日期/假期基准均 GMT+8 本地判定。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import {
  LRT_LINE_TO_ROUTE_NO,
  isLrtLineCode,
  isLrtStationCode,
  directionOfTravel,
  destLabelOf,
} from "@/lib/lrt/map";
import { type DayType, dayTypeOf, macauNowParts, shiftYmd } from "@/lib/lrt/day-type";
import {
  rowCandidateSec,
  nextTwo,
  hhmmOf,
  hhmmOfMinutes,
  type LrtTimetableMinutes,
} from "@/lib/lrt/eta";

export const preferredRegion = "sin1";
export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const station = sp.get("station")?.trim() ?? "";
  const route = sp.get("route")?.trim() ?? "";
  const dest = sp.get("dest")?.trim() || null;
  const dirParam = sp.get("dir")?.trim() || null;

  if (!isLrtStationCode(station)) {
    return NextResponse.json(
      { ok: false, error: "参数 station 须为本库轻轨站码（LRT-*）" },
      { status: 400 },
    );
  }
  if (!isLrtLineCode(route) || !LRT_LINE_TO_ROUTE_NO[route]) {
    return NextResponse.json(
      { ok: false, error: "参数 route 须为本库轻轨线路码（LRT-*线）" },
      { status: 400 },
    );
  }
  if (dest && !isLrtStationCode(dest)) {
    return NextResponse.json({ ok: false, error: "参数 dest 须为本库轻轨站码（LRT-*）" }, { status: 400 });
  }
  if (!dest && !dirParam) {
    return NextResponse.json({ ok: false, error: "缺少 dest 或 dir" }, { status: 400 });
  }
  const routeNo = LRT_LINE_TO_ROUTE_NO[route];

  const pool = getPool();
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
      return NextResponse.json(
        { ok: false, error: "线路站序缺失（route_stations 未同步？）" },
        { status: 500 },
      );
    }
    const dir = dest
      ? directionOfTravel(dirStops, station, dest, dirParam ?? "0")
      : (dirParam ?? "0");
    const terminusDb = dirStops[dir]?.[(dirStops[dir]?.length ?? 0) - 1];
    if (!terminusDb) {
      return NextResponse.json({ ok: false, error: `方向 ${dir} 无站序` }, { status: 500 });
    }

    // 2) 上车站 & 方向终点 → motransportinfo 站码（API 码只在服务端内部）
    const stRes = await pool.query(`SELECT api_id FROM lrt_api_stations WHERE db_code = $1`, [station]);
    const termRes = await pool.query(`SELECT api_id, name_tc FROM lrt_api_stations WHERE db_code = $1`, [
      terminusDb,
    ]);
    const stationApi = (stRes.rows[0] as { api_id?: string } | undefined)?.api_id;
    const termRow = termRes.rows[0] as { api_id?: string; name_tc?: string } | undefined;
    if (!stationApi || !termRow?.api_id) {
      return NextResponse.json(
        { ok: false, error: "站点映射缺失（lrt_api_stations）" },
        { status: 500 },
      );
    }
    const directionApi = termRow.api_id;
    const directionName = destLabelOf(termRow.name_tc);

    // 3) 班别：今日 + 昨日（昨日仅用于跨午夜续班，班别各自按日判定）
    const now = macauNowParts();
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

    // 5) 合并候选（「服务日 D 00:00 起秒」单轴）→ next/next2
    const candSec: number[] = [];
    if (todayRow) candSec.push(...rowCandidateSec(todayRow, false));
    if (prevRow) candSec.push(...rowCandidateSec(prevRow, true));
    const nowMs = Date.now();
    const dayStartUtcMs = nowMs - ((nowMs + 8 * 3_600_000) % DAY_MS); // 澳门今日 00:00
    const next = nextTwo(candSec, now.daySec);

    // 6) 空态判定
    let state: "running" | "before_first" | "after_last" | "no_data" = "no_data";
    if (next.length > 0) state = "running";
    else if (todayRow && now.daySec < todayRow.first_min * 60) state = "before_first";
    else if (todayRow) state = "after_last";

    return NextResponse.json({
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
      departures: next.map((s) => ({
        clock: hhmmOf(s),
        depMs: dayStartUtcMs + s * 1000,
      })),
      serverNow: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[lrt/eta] 查询失败：", (err as Error).message);
    return NextResponse.json({ ok: false, error: "时刻表查询失败" }, { status: 500 });
  }
}
