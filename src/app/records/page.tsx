import { cookies } from "next/headers";
import { getPool } from "@/lib/db";
import RecordsClient, { RecordRow } from "@/components/RecordsClient";

export const dynamic = "force-dynamic";

// v0.10.0：默认排除测试会话（is_test=true），「含测试」偏好存 cookie（mtk_include_test=1）
async function includeTestPref(): Promise<boolean> {
  try {
    const store = await cookies();
    return store.get("mtk_include_test")?.value === "1";
  } catch {
    return false;
  }
}

export default async function RecordsPage() {
  let records: RecordRow[] = [];
  let dbError: string | null = null;
  const includeTest = await includeTestPref();

  try {
    const pool = getPool();
    const res = await pool.query(`
      SELECT s.id, s.started_at, s.ended_at, s.total_minutes, s.border_minutes,
             s.missed_count, s.route_code, s.travel_date, s.is_test,
             -- v0.20.0：线路标签底色
             (SELECT rt.color FROM routes rt WHERE rt.code = s.route_code) AS route_color,
             -- v0.18.0：拥挤度按程（ride_crowd），多程以「/」分隔（按 veh_index 顺序）
             (SELECT string_agg(rc.level::text, '/' ORDER BY rc.veh_index)
                FROM ride_crowd rc WHERE rc.session_id = s.id) AS crowd_levels
      FROM timer_sessions s
      JOIN commute_plans p ON s.plan_id = p.id
      WHERE s.deleted_at IS NULL
        ${includeTest ? "" : "AND NOT COALESCE(s.is_test, false)"}
      ORDER BY s.started_at DESC
      LIMIT 100
    `);
    records = res.rows as RecordRow[];
  } catch (err) {
    dbError = (err as Error).message;
  }

  return <RecordsClient records={records} dbError={dbError} includeTest={includeTest} />;
}
