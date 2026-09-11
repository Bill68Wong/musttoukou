import { getPool } from "@/lib/db";
import { sortRouteOptions } from "@/lib/timer-flow";
import { HOME_SLUG, PAIR_ORDER, PLACE_SHORT, dirLabel } from "@/lib/home-plans-shared";
import StatsClient, { DirStat, GroupStat, PlanStat, Summary } from "@/components/StatsClient";

export const dynamic = "force-dynamic";

/**
 * v0.18.2：分块口径改为「与首页一致」——宿舍 ⇄ 學校 / 橫琴口岸 / 關閘（拱北口岸）
 * 每块内再分「去程 / 回程」两个小块（用户定稿：块内分两块、不分列）。
 * 旧口径按「目的地 kind」分四组（去学校/回宿舍/去横琴/去關閘），会把不同起点混进同组。
 */

/** 横琴相关方案不按线路拆分（换乘方案、线路多样，合并一行更易读；SQL 内联 CASE 实现，无需 JS 判定） */

// v0.23.0：测试模式已移除 → 一律排除测试会话（is_test=true），不再读 cookie
export default async function StatsPage() {
  let groups: GroupStat[] = [];
  let summary: Summary | null = null;
  let dbError: string | null = null;

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
             -- v0.20.0：线路标签底色（按实乘线路取主题色；横琴合并行 route_code 为 NULL → 无）
             (SELECT rt.color FROM routes rt
               WHERE rt.code = (CASE WHEN pf.slug = 'hengqin' OR pt.slug = 'hengqin'
                                     THEN NULL ELSE s.route_code END)) AS route_color,
             -- v0.20.0：统一模板用「上车站（编号+全称）→ 下车站（编号+全称）」，不再把线路名混进标题
             (CASE WHEN sb.kind = 'bus' THEN sb.code || ' ' || sb.name_tc ELSE sb.name_tc END) AS board_name,
             (CASE WHEN sa.kind = 'bus' THEN sa.code || ' ' || sa.name_tc ELSE sa.name_tc END) AS alight_name,
             count(s.id) FILTER (WHERE s.total_minutes IS NOT NULL)::int AS n,
             round(avg(s.total_minutes) FILTER (WHERE s.total_minutes IS NOT NULL), 1)::float8 AS avg_min,
             min(s.total_minutes) FILTER (WHERE s.total_minutes IS NOT NULL)::float8 AS min_min,
             max(s.total_minutes) FILTER (WHERE s.total_minutes IS NOT NULL)::float8 AS max_min,
             max(s.ended_at) FILTER (WHERE s.total_minutes IS NOT NULL) AS last_end
      FROM commute_plans cp
      JOIN places pf ON cp.from_place = pf.id
      JOIN places pt ON cp.to_place = pt.id
      -- v0.20.0：首载具段（取 route_meta 供「按实乘线路」解析上/下车站）
      LEFT JOIN LATERAL (
        SELECT l.from_station, l.to_station, l.route_meta
          FROM plan_legs l
         WHERE l.plan_id = cp.id AND l.leg_kind IN ('bus','lrt')
         ORDER BY l.seq LIMIT 1
      ) fl ON true
      -- ⚠️ timer_sessions 必须排在 stations 之前：sb/sa 的 ON 条件引用 s.route_code，
      --    而 Postgres 的 JOIN ON 只能引用「已在左侧 join 好」的表；
      --    放到后面会直接报 missing FROM-clause entry for table "s"（v0.20.0~v0.23.0 的线上 bug）
      LEFT JOIN timer_sessions s ON s.plan_id = cp.id AND s.deleted_at IS NULL
        AND NOT COALESCE(s.is_test, false)
      -- 上车站：该线路的 meta.board[0]（同台多线各线站台可能不同），无则段级默认
      LEFT JOIN stations sb ON sb.code = COALESCE(
        CASE WHEN fl.route_meta IS NOT NULL AND s.route_code IS NOT NULL
                  AND NOT (pf.slug = 'hengqin' OR pt.slug = 'hengqin')
             THEN fl.route_meta -> s.route_code -> 'board' ->> 0 END,
        fl.from_station)
      -- 下车站：该线路的 meta.to
      LEFT JOIN stations sa ON sa.code = COALESCE(
        CASE WHEN fl.route_meta IS NOT NULL AND s.route_code IS NOT NULL
                  AND NOT (pf.slug = 'hengqin' OR pt.slug = 'hengqin')
             THEN fl.route_meta -> s.route_code ->> 'to' END,
        fl.to_station)
      WHERE cp.is_active
      GROUP BY cp.id, cp.plan_key, cp.summary, pf.slug, pt.slug,
               (CASE WHEN pf.slug = 'hengqin' OR pt.slug = 'hengqin'
                     THEN NULL ELSE s.route_code END),
               regexp_replace(regexp_replace(cp.summary, '^[^ ]+\\s+', ''), '｜.*$', ''),
               (SELECT rt.color FROM routes rt
                 WHERE rt.code = (CASE WHEN pf.slug = 'hengqin' OR pt.slug = 'hengqin'
                                       THEN NULL ELSE s.route_code END)),
               (CASE WHEN sb.kind = 'bus' THEN sb.code || ' ' || sb.name_tc ELSE sb.name_tc END),
               (CASE WHEN sa.kind = 'bus' THEN sa.code || ' ' || sa.name_tc ELSE sa.name_tc END)
      ORDER BY cp.id
    `);
    const plans = planRes.rows as PlanStat[];

    const sumRes = await pool.query(`
      SELECT count(*)::int AS n,
             count(DISTINCT travel_date)::int AS days,
             round(avg(total_minutes), 1)::float8 AS avg_min
      FROM timer_sessions s
      WHERE s.deleted_at IS NULL AND s.total_minutes IS NOT NULL
        AND NOT COALESCE(s.is_test, false)
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
    <StatsClient groups={groups} summary={summary} dbError={dbError} />
  );
}
