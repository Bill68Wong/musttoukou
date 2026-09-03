import { getPool } from "@/lib/db";
import StatsClient, { GroupStat, PlanStat, Summary } from "@/components/StatsClient";

export const dynamic = "force-dynamic";

const GROUP_TITLES: { kind: string; title: string }[] = [
  { kind: "school", title: "去学校" },
  { kind: "dorm", title: "回宿舍" },
  { kind: "border", title: "去横琴口岸" },
];

export default async function StatsPage() {
  let groups: GroupStat[] = [];
  let summary: Summary | null = null;
  let dbError: string | null = null;

  try {
    const pool = getPool();

    // 统计口径：非软删 且 已完成（total_minutes 非空）的会话才算 1 个样本
    const planRes = await pool.query(`
      SELECT cp.id AS plan_id, cp.plan_key, cp.summary,
             pt.kind AS to_kind,
             count(s.id) FILTER (WHERE s.total_minutes IS NOT NULL)::int AS n,
             round(avg(s.total_minutes) FILTER (WHERE s.total_minutes IS NOT NULL), 1)::float8 AS avg_min,
             min(s.total_minutes) FILTER (WHERE s.total_minutes IS NOT NULL)::float8 AS min_min,
             max(s.total_minutes) FILTER (WHERE s.total_minutes IS NOT NULL)::float8 AS max_min,
             max(s.ended_at) FILTER (WHERE s.total_minutes IS NOT NULL) AS last_end
      FROM commute_plans cp
      JOIN places pf ON cp.from_place = pf.id
      JOIN places pt ON cp.to_place = pt.id
      LEFT JOIN timer_sessions s ON s.plan_id = cp.id AND s.deleted_at IS NULL
      WHERE cp.is_active
      GROUP BY cp.id, cp.plan_key, cp.summary, pf.kind, pt.kind
      ORDER BY cp.id
    `);
    const plans = planRes.rows as PlanStat[];

    const sumRes = await pool.query(`
      SELECT count(*)::int AS n,
             count(DISTINCT travel_date)::int AS days,
             round(avg(total_minutes), 1)::float8 AS avg_min
      FROM timer_sessions
      WHERE deleted_at IS NULL AND total_minutes IS NOT NULL
    `);
    const s = sumRes.rows[0] as { n: number; days: number; avg_min: number | null };
    summary = {
      n: s.n,
      days: s.days,
      avg_min: s.avg_min,
      met: plans.filter((p) => p.n >= 5).length,
      active: plans.length,
    };

    // 按场景分组；组内按缺口优先（样本少在前），同缺口按方案 id 稳定排序
    groups = GROUP_TITLES.map((g) => {
      const groupPlans = plans
        .filter((p) => p.to_kind === g.kind)
        .sort((a, b) => (a.n === b.n ? a.plan_id - b.plan_id : a.n - b.n));
      return { kind: g.kind, title: g.title, plans: groupPlans };
    }).filter((g) => g.plans.length > 0);
  } catch (err) {
    dbError = (err as Error).message;
  }

  return <StatsClient groups={groups} summary={summary} dbError={dbError} />;
}
