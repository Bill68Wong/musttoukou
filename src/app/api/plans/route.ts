import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

/** GET /api/plans：全部方案（含样本数、最近使用，常用置顶） */
export async function GET() {
  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT p.id, p.plan_key, p.summary,
             pf.slug AS from_slug, pf.name AS from_name,
             pt.slug AS to_slug, pt.name AS to_name, pt.kind AS to_kind,
             (SELECT count(*)::int FROM timer_sessions s
               WHERE s.plan_id = p.id AND s.deleted_at IS NULL
                 AND NOT COALESCE(s.is_test, false)
                 AND s.total_minutes IS NOT NULL) AS samples,
             (SELECT max(s.started_at) FROM timer_sessions s WHERE s.plan_id = p.id) AS last_used,
             -- v0.7.0：各载具段主线路主题色（取 route_options 首项）
             COALESCE(
               (SELECT array_agg(r.color ORDER BY l.seq)
                  FROM plan_legs l
                  LEFT JOIN routes r
                    ON r.code = (l.route_options::jsonb ->> 0) AND r.kind = l.leg_kind
                 WHERE l.plan_id = p.id
                   AND l.leg_kind IN ('bus','lrt')
                   AND l.route_options IS NOT NULL
                   AND r.color IS NOT NULL),
               '{}'::text[]) AS colors,
             (pt.slug = 'hengqin'
               AND EXISTS(SELECT 1 FROM plan_legs lb WHERE lb.plan_id = p.id AND lb.leg_kind = 'bus')
               AND NOT EXISTS(SELECT 1 FROM plan_legs ll WHERE ll.plan_id = p.id AND ll.leg_kind = 'lrt')) AS blink
      FROM commute_plans p
      JOIN places pf ON p.from_place = pf.id
      JOIN places pt ON p.to_place = pt.id
      WHERE p.is_active
      ORDER BY samples DESC, last_used DESC NULLS LAST, p.id
    `);
    return NextResponse.json({ plans: rows });
  } catch (err) {
    console.error("[plans] 查询失败：", (err as Error).message);
    return NextResponse.json(
      { error: "方案查询失败，请确认数据库已初始化（npm run db:schema && npm run db:seed）" },
      { status: 500 },
    );
  }
}
