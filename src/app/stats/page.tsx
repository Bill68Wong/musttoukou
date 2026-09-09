import { cookies } from "next/headers";
import { getPool } from "@/lib/db";
import { sortRouteOptions } from "@/lib/timer-flow";
import { HOME_SLUG, PAIR_ORDER, PLACE_SHORT, dirLabel } from "@/lib/home-plans-shared";
import StatsClient, { DirStat, GroupStat, PlanStat, Summary } from "@/components/StatsClient";

export const dynamic = "force-dynamic";

/**
 * v0.18.2：分块口径改为「与首页一致」——宿舍 ⇄ 學校 / 橫琴口岸 / 關閘（拱北口岸）
 * 每块内再分「去程 / 回程」两个小块（主人定稿：块内分两块、不分列）。
 * 旧口径按「目的地 kind」分四组（去学校/回宿舍/去横琴/去關閘），会把不同起点混进同组。
 */

/** 横琴相关方案不按线路拆分（换乘方案、线路多样，合并一行更易读；主人定稿） */
const isHengqin = (fromSlug: string, toSlug: string) =>
  fromSlug === "hengqin" || toSlug === "hengqin";

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
    // v0.18.2：按「方案 + 实乘线路」拆分（同台多线不再合并统计）——横琴方案例外（route_code 置空合并）
    const planRes = await pool.query(`
      SELECT cp.id AS plan_id, cp.plan_key, cp.summary,
             pf.slug AS from_slug, pt.slug AS to_slug,
             (CASE WHEN pf.slug = 'hengqin' OR pt.slug = 'hengqin'
                   THEN NULL ELSE s.route_code END) AS route_code,
             -- 副标题：剥掉线路前缀（「50路 」/「輕軌 」）与合并提示尾巴（「｜…到站後任選」），
             -- 行首已有线路标签，避免重复
             regexp_replace(regexp_replace(cp.summary, '^[^ ]+\\s+', ''), '｜.*$', '') AS route_summary,
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
      GROUP BY cp.id, cp.plan_key, cp.summary, pf.slug, pt.slug,
               (CASE WHEN pf.slug = 'hengqin' OR pt.slug = 'hengqin'
                     THEN NULL ELSE s.route_code END),
               regexp_replace(regexp_replace(cp.summary, '^[^ ]+\\s+', ''), '｜.*$', '')
      ORDER BY cp.id
    `);
    const plans = planRes.rows as PlanStat[];

    const sumRes = await pool.query(`
      SELECT count(*)::int AS n,
             count(DISTINCT travel_date)::int AS days,
             round(avg(total_minutes), 1)::float8 AS avg_min
      FROM timer_sessions s
      WHERE s.deleted_at IS NULL AND s.total_minutes IS NOT NULL ${testFilter}
    `);
    const s = sumRes.rows[0] as { n: number; days: number; avg_min: number | null };
    summary = {
      n: s.n,
      days: s.days,
      avg_min: s.avg_min,
      met: plans.filter((p) => p.n >= 5).length,
      active: plans.length,
    };

    // v0.18.2：按首页方向对分块，块内分「去程 / 回程」两小块；
    // 小块内同方案的线路行按 sortRouteOptions（轻轨在前 + 巴士自然序）排列，
    // 方案之间仍按「样本缺口优先」（样本少在前），同缺口按方案 id 稳定排序
    const planOrder = (a: PlanStat, b: PlanStat) =>
      a.n === b.n ? a.plan_id - b.plan_id : a.n - b.n;

    groups = PAIR_ORDER.map((other) => {
      const pairPlans = plans.filter(
        (p) =>
          (p.from_slug === HOME_SLUG && p.to_slug === other) ||
          (p.from_slug === other && p.to_slug === HOME_SLUG),
      );
      const dirs: DirStat[] = (["out", "back"] as const)
        .map((d) => {
          const from = d === "out" ? HOME_SLUG : other;
          const to = d === "out" ? other : HOME_SLUG;
          const rows = pairPlans.filter((p) => p.from_slug === from && p.to_slug === to);
          // 同一方案的多条线路行相邻且按线路排序
          const byPlan = new Map<number, PlanStat[]>();
          for (const r of rows) {
            const arr = byPlan.get(r.plan_id) ?? [];
            arr.push(r);
            byPlan.set(r.plan_id, arr);
          }
          const sorted: PlanStat[] = [];
          for (const [pid, arr] of [...byPlan.entries()].sort((a, b) =>
            planOrder(a[1][0], b[1][0]),
          )) {
            const codes = arr.map((r) => r.route_code ?? "");
            const order = sortRouteOptions(codes);
            arr.sort((x, y) => order.indexOf(x.route_code ?? "") - order.indexOf(y.route_code ?? ""));
            sorted.push(...arr);
            void pid;
          }
          return { dir: d, title: dirLabel(from, to), plans: sorted };
        })
        .filter((d) => d.plans.length > 0);
      return {
        kind: other,
        title: `${PLACE_SHORT[HOME_SLUG]} ⇄ ${PLACE_SHORT[other]}`,
        dirs,
      };
    }).filter((g) => g.dirs.length > 0);
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
