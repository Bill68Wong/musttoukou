import { getPool } from "@/lib/db";
import RecordsClient, { RecordRow } from "@/components/RecordsClient";

export const dynamic = "force-dynamic";

export default async function RecordsPage() {
  let records: RecordRow[] = [];
  let dbError: string | null = null;

  try {
    const pool = getPool();
    const res = await pool.query(`
      SELECT s.id, s.started_at, s.ended_at, s.total_minutes,
             s.missed_count, s.crowd_level, s.route_code, s.travel_date
      FROM timer_sessions s
      JOIN commute_plans p ON s.plan_id = p.id
      WHERE s.deleted_at IS NULL
      ORDER BY s.started_at DESC
      LIMIT 100
    `);
    records = res.rows as RecordRow[];
  } catch (err) {
    dbError = (err as Error).message;
  }

  return <RecordsClient records={records} dbError={dbError} />;
}
