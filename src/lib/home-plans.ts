import { getPool } from "@/lib/db";
import type { PlanRow, ActiveSession } from "@/lib/home-plans-shared";

/**
 * 首页 / 路线选择页共用查询（src/lib/home-plans.ts，v0.13.x）
 * 首页按「方向对」分行（每行去程/回程两卡），点方向卡进 /routes?from=&to= 选具体方案。
 * 本文件仅可被服务端组件（page.tsx / routes）import；客户端共享常量见 home-plans-shared.ts。
 */

export type { PlanRow, ActiveSession } from "@/lib/home-plans-shared";
export { HOME_SLUG, PAIR_ORDER, PLACE_SHORT, dirLabel } from "@/lib/home-plans-shared";

/** 查询活动方案（可按 from/to place slug 过滤；不带条件 = 全部） */
export async function queryPlans(opts: { from?: string; to?: string } = {}): Promise<PlanRow[]> {
  const pool = getPool();
  const conds = ["p.is_active"];
  const params: string[] = [];
  if (opts.from) {
    params.push(opts.from);
    conds.push(`pf.slug = $${params.length}`);
  }
  if (opts.to) {
    params.push(opts.to);
    conds.push(`pt.slug = $${params.length}`);
  }
  const where = conds.join(" AND ");
  const res = await pool.query(
    `
      SELECT p.id, p.summary,
             pf.slug AS from_slug, pf.kind AS from_kind, pf.name AS from_name,
             pt.slug AS to_slug,   pt.kind AS to_kind,   pt.name AS to_name,
             (SELECT count(*)::int FROM timer_sessions s
               WHERE s.plan_id = p.id AND s.deleted_at IS NULL
                 AND NOT COALESCE(s.is_test, false)
                 AND s.total_minutes IS NOT NULL) AS samples,
             COALESCE(
               (SELECT array_agg(r.color ORDER BY l.seq)
                  FROM plan_legs l
                  LEFT JOIN routes r
                    ON r.code = (l.route_options::jsonb ->> 0) AND r.kind = l.leg_kind
                 WHERE l.plan_id = p.id
                   AND l.leg_kind IN ('bus','lrt')
                   AND l.route_options IS NOT NULL
                   AND r.color IS NOT NULL),
               '{}'::text[]) AS colors
      FROM commute_plans p
      JOIN places pf ON p.from_place = pf.id
      JOIN places pt ON p.to_place = pt.id
      WHERE ${where}
      ORDER BY samples DESC,
               (SELECT max(s.started_at) FROM timer_sessions s WHERE s.plan_id = p.id) DESC NULLS LAST,
               p.id
    `,
    params,
  );
  return res.rows as PlanRow[];
}

/** 进行中的真实计时（未结束 & 未删除 & 非测试） */
export async function queryActiveSession(): Promise<ActiveSession | null> {
  const pool = getPool();
  const res = await pool.query(`
    SELECT s.id, p.summary FROM timer_sessions s
    JOIN commute_plans p ON s.plan_id = p.id
    WHERE s.ended_at IS NULL AND s.deleted_at IS NULL
      AND NOT COALESCE(s.is_test, false)
    ORDER BY s.id DESC LIMIT 1
  `);
  return (res.rows[0] as ActiveSession | undefined) ?? null;
}
