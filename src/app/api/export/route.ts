import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

/** 就近部署：Supabase 新加坡池化器 → sin1 */
export const preferredRegion = "sin1";
export const dynamic = "force-dynamic";

/**
 * GET /api/export —— 通勤记录 CSV 导出（T2.4）
 * - UTF-8 BOM（Excel 直接打开不乱码）
 * - 行数 = 导出范围 session 数（非软删的全部会话，含进行中）
 * - v0.23.0：测试模式已移除 → 一律排除测试会话（is_test=true），不再读 cookie
 * - 每行带关键事件时间列（depart/wait_start/board/alight/border_start/border_end/arrive，
 *   取自 timer_events 最早一次对应事件，Asia/Macau HH:MM）
 */
const WEEKDAY_TC = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const BUCKET_LABEL: Record<string, string> = {
  am_peak: "早高峰",
  pm_peak: "晚高峰",
  day: "白天",
  night: "夜间",
};
// v0.18.0：拥挤度五档（0空/1正常/2饱和/3挤/4爆满），按程记录
const CROWD_LABEL = ["空", "正常", "饱和", "挤", "爆满"];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET() {
  try {
    const pool = getPool();
    const res = await pool.query(`
      SELECT s.id,
             to_char(s.travel_date, 'YYYY-MM-DD') AS travel_date,
             cp.plan_key,
             s.route_code,
             s.dsat_dir,
             s.from_zone,
             s.to_zone,
             to_char(s.started_at AT TIME ZONE 'Asia/Macau', 'YYYY-MM-DD HH24:MI') AS start_t,
             to_char(s.ended_at AT TIME ZONE 'Asia/Macau', 'YYYY-MM-DD HH24:MI') AS end_t,
             round(s.total_minutes, 1) AS total,
             -- v0.13.0：通关耗时（border_start→border_end 闭合区间，不计入 total）
             round(s.border_minutes, 1) AS border_total,
             s.weekday,
             s.time_bucket,
             -- v0.18.0：拥挤度按程（ride_crowd），多程以「/」分隔
             (SELECT string_agg(rc.level::text, '/' ORDER BY rc.veh_index)
                FROM ride_crowd rc WHERE rc.session_id = s.id) AS crowd_levels,
             s.missed_count,
             s.vehicle_plate,
             s.vehicle_code,
             s.is_edited,
             ev.depart_t, ev.wait_t, ev.board_t, ev.alight_t,
             ev.border_start_t, ev.border_end_t, ev.arrive_t
      FROM timer_sessions s
      LEFT JOIN commute_plans cp ON cp.id = s.plan_id
      LEFT JOIN LATERAL (
        SELECT to_char((min(recorded_at) FILTER (WHERE event_type = 'depart')) AT TIME ZONE 'Asia/Macau', 'HH24:MI') AS depart_t,
               to_char((min(recorded_at) FILTER (WHERE event_type = 'wait_start')) AT TIME ZONE 'Asia/Macau', 'HH24:MI') AS wait_t,
               to_char((min(recorded_at) FILTER (WHERE event_type = 'board')) AT TIME ZONE 'Asia/Macau', 'HH24:MI') AS board_t,
               to_char((min(recorded_at) FILTER (WHERE event_type = 'alight')) AT TIME ZONE 'Asia/Macau', 'HH24:MI') AS alight_t,
               to_char((min(recorded_at) FILTER (WHERE event_type = 'border_start')) AT TIME ZONE 'Asia/Macau', 'HH24:MI') AS border_start_t,
               to_char((min(recorded_at) FILTER (WHERE event_type = 'border_end')) AT TIME ZONE 'Asia/Macau', 'HH24:MI') AS border_end_t,
               to_char((min(recorded_at) FILTER (WHERE event_type = 'arrive')) AT TIME ZONE 'Asia/Macau', 'HH24:MI') AS arrive_t
        FROM timer_events te
        WHERE te.session_id = s.id
      ) ev ON true
      WHERE s.deleted_at IS NULL
        AND NOT COALESCE(s.is_test, false)
      ORDER BY s.started_at DESC
      LIMIT 2000
    `);

    const rows = res.rows as Record<string, unknown>[];
    const header = [
      "编号", "日期", "方案", "线路", "方向", "出发区", "到达区",
      "开始时间", "结束时间", "总耗时(分钟)", "通关耗时(分钟)", "星期", "时段", "拥挤度", "没挤上",
      "车辆牌号", "车辆编号", "已编辑",
      "出发", "等车开始", "上车", "下车", "通关开始", "通关完成", "到达",
    ];

    const lines = rows.map((r) => [
      r.id,
      r.travel_date,
      r.plan_key,
      r.route_code ? `${r.route_code} 路` : "",
      r.dsat_dir ?? "",
      r.from_zone ?? "",
      r.to_zone ?? "",
      r.start_t,
      r.end_t,
      r.total,
      r.border_total,
      WEEKDAY_TC[(r.weekday as number) ?? -1] ?? "",
      BUCKET_LABEL[(r.time_bucket as string) ?? ""] ?? (r.time_bucket ?? ""),
      // v0.18.0：按程拥挤度（"1/3" → "正常/挤"）
      String(r.crowd_levels ?? "")
        .split("/")
        .filter((x) => x !== "")
        .map((lv) => CROWD_LABEL[Number(lv)] ?? "?")
        .join("/"),
      (r.missed_count as number) ?? 0,
      r.vehicle_plate ?? "",
      r.vehicle_code ?? "",
      r.is_edited ? "是" : "否",
      r.depart_t, r.wait_t, r.board_t, r.alight_t,
      r.border_start_t, r.border_end_t, r.arrive_t,
    ]);

    const csv = [header, ...lines].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const date = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");

    return new NextResponse("\uFEFF" + csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="musttoukou-sessions-${date}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.warn("[export] 导出失败：", (err as Error).message);
    return NextResponse.json({ error: "导出失败" }, { status: 500 });
  }
}
