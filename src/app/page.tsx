import { getPool } from "@/lib/db";
import HomeClient, { PlanRow, ActiveSession } from "@/components/HomeClient";

export const dynamic = "force-dynamic";

export default async function Home() {
  let plans: PlanRow[] = [];
  let active: ActiveSession | null = null;
  let dbError: string | null = null;

  try {
    const pool = getPool();
    const plansRes = await pool.query(`
      SELECT p.id, p.summary,
             pt.kind AS to_kind,
             (SELECT count(*)::int FROM timer_sessions s
               WHERE s.plan_id = p.id AND s.deleted_at IS NULL
                 AND s.total_minutes IS NOT NULL) AS samples
      FROM commute_plans p
      JOIN places pt ON p.to_place = pt.id
      WHERE p.is_active
      ORDER BY samples DESC,
               (SELECT max(s.started_at) FROM timer_sessions s WHERE s.plan_id = p.id) DESC NULLS LAST,
               p.id
    `);
    plans = plansRes.rows as PlanRow[];

    const activeRes = await pool.query(`
      SELECT s.id, p.summary FROM timer_sessions s
      JOIN commute_plans p ON s.plan_id = p.id
      WHERE s.ended_at IS NULL AND s.deleted_at IS NULL
      ORDER BY s.id DESC LIMIT 1
    `);
    active = (activeRes.rows[0] as ActiveSession | undefined) ?? null;
  } catch (err) {
    dbError = (err as Error).message;
  }

  return <HomeClient plans={plans} active={active} dbError={dbError} />;
}
