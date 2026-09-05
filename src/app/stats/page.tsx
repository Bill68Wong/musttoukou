import { cookies } from "next/headers";
import { getPool } from "@/lib/db";
import StatsClient, { GroupStat, PlanStat, Summary } from "@/components/StatsClient";

export const dynamic = "force-dynamic";

// v0.13.0：border（口岸）按目的地 slug 拆组——横琴 与 關閘（拱北）各自成组
const GROUP_TITLES: { kind: string; title: string; slug?: string }[] = [
  { kind: "school", title: "去学校" },
  { kind: "dorm", title: "回宿舍" },
  { kind: "border", slug: "hengqin", title: "去横琴口岸" },
  { kind: "border", slug: "guanqin", title: "去關閘（拱北）" },
];

// v0.10.0：默认排除测试会话（is_test=true），「含测试」偏好存 cookie（mtk_include_test=1）
async function includeTestPref(): Promise<boolean> {
  try {
    const store = await cookies();
    return store.get("mtk_include_test")?.value === "1";
  } catch {
    return false;
  }
}

export default async function StatsPage() {
  let groups: GroupStat[] = [];
  let summary: Summary | null = null;
  let dbError: string | null = null;
  const includeTest = await includeTestPref();
  const testFilter = includeTest ? "" : "AND NOT COALESCE(s.is_test, false)";

  try {
    const pool = getPool();

    // 统计口径：非软删 且 非测试 且 已完成（total_minutes 非空）的会话才算 1 个样本
    const planRes = await pool.query(`
      SELECT cp.id AS plan_id, cp.plan_key, cp.summary,
             pt.kind AS to_kind, pt.slug AS to_slug,
             count(s.id) FILTER (WHERE s.total_minutes IS NOT NULL)::int AS n,
             round(avg(s.total_minutes) FILTER (WHERE s.total_minutes IS NOT NULL), 1)::float8 AS avg_min,
             min(s.total_minutes) FILTER (WHERE s.total_minutes IS NOT NULL)::float8 AS min_min,
             max(s.total_minutes) FILTER (WHERE s.total_minutes IS NOT NULL)::float8 AS max_min,
             max(s.ended_at) FILTER (WHERE s.total_minutes IS NOT NULL) AS last_end
      FROM commute_plans cp
      JOIN places pf ON cp.from_place = pf.id
      JOIN places pt ON cp.to_place = pt.id
      LEFT JOIN timer_sessions s ON s.plan_id = cp.id AND s.deleted_at IS NULL
        ${includeTest ? "" : "AND NOT COALESCE(s.is_test, false)"}
      WHERE cp.is_active
      GROUP BY cp.id, cp.plan_key, cp.summary, pf.kind, pt.kind, pt.slug
      ORDER BY cp.id
    `);
    const plans = planRes.rows as PlanStat[];

    const sumRes = await pool.query(`
      SELECT count(*)::int AS n,
             count(DISTINCT travel_date)::int AS days,
             round(avg(total_minutes), 1)::float8 AS avg_min
      FROM timer_sessions
      WHERE deleted_at IS NULL AND total_minutes IS NOT NULL ${testFilter}
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
    // group.kind 唯一化：border 组拼上 slug（dorm/school/border:hengqin/border:guanqin），
    // 避免 StatsClient 里 section key 冲突
    groups = GROUP_TITLES.map((g) => {
      const groupPlans = plans
        .filter((p) => p.to_kind === g.kind && (!g.slug || p.to_slug === g.slug))
        .sort((a, b) => (a.n === b.n ? a.plan_id - b.plan_id : a.n - b.n));
      return {
        kind: g.slug ? `${g.kind}:${g.slug}` : g.kind,
        title: g.title,
        plans: groupPlans,
      };
    }).filter((g) => g.plans.length > 0);
  } catch (err) {
    dbError = (err as Error).message;
  }

  return (
    <StatsClient
      groups={groups}
      summary={summary}
      dbError={dbError}
      includeTest={includeTest}
    />
  );
}
