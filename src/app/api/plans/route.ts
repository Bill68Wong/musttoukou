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
             -- v0.7.0 → v0.17.0：合并卡单段含多条线路 → 展开 route_options 全部项取色，
             -- 去重后按「首次出现顺序」保留（前两色即卡面双色）
             COALESCE(
               (SELECT array_agg(t.color ORDER BY t.k)
                  FROM (
                    SELECT r.color, MIN(l.seq * 1000 + ro.ord) AS k
                      FROM plan_legs l
                      CROSS JOIN LATERAL jsonb_array_elements_text(l.route_options::jsonb)
                             WITH ORDINALITY AS ro(code, ord)
                      JOIN routes r
                        ON r.code = ro.code AND r.kind = l.leg_kind
                     WHERE l.plan_id = p.id
                       AND l.leg_kind IN ('bus','lrt')
                       AND l.route_options IS NOT NULL
                       AND r.color IS NOT NULL
                     GROUP BY r.color
                  ) t),
               '{}'::text[]) AS colors,
             -- v0.17.0：'split'=去横琴纯巴士卡（左右两色互换）；'solid'=同起点合并卡含 ≥2 色（整卡交替）
             (CASE
               WHEN pt.slug = 'hengqin'
                 AND EXISTS(SELECT 1 FROM plan_legs lb WHERE lb.plan_id = p.id AND lb.leg_kind = 'bus')
                 AND NOT EXISTS(SELECT 1 FROM plan_legs ll WHERE ll.plan_id = p.id AND ll.leg_kind = 'lrt')
                 THEN 'split'
               WHEN (SELECT count(DISTINCT r2.color)
                       FROM plan_legs l2
                       CROSS JOIN LATERAL jsonb_array_elements_text(l2.route_options::jsonb) AS ro2(code)
                       JOIN routes r2 ON r2.code = ro2.code AND r2.kind = l2.leg_kind
                      WHERE l2.plan_id = p.id
                        AND l2.leg_kind IN ('bus','lrt')
                        AND l2.route_options IS NOT NULL
                        AND jsonb_array_length(l2.route_options::jsonb) > 1
                        AND r2.color IS NOT NULL) >= 2
                 THEN 'solid'
               ELSE NULL
             END) AS blink_style
      FROM commute_plans p
      JOIN places pf ON p.from_place = pf.id
      JOIN places pt ON p.to_place = pt.id
      WHERE p.is_active
      -- v0.18.0：方案显示顺序统一——① 轻轨方案在前 ② 巴士按主线路自然排序
      ORDER BY CASE WHEN (SELECT l.leg_kind FROM plan_legs l
                           WHERE l.plan_id = p.id AND l.leg_kind IN ('bus','lrt')
                           ORDER BY l.seq LIMIT 1) = 'lrt' THEN 0 ELSE 1 END,
               COALESCE(substring(COALESCE((SELECT l.route_options::jsonb ->> 0 FROM plan_legs l
                                             WHERE l.plan_id = p.id AND l.leg_kind IN ('bus','lrt')
                                               AND l.route_options IS NOT NULL
                                             ORDER BY l.seq LIMIT 1), '') from '^\\d+')::int, 2147483647),
               COALESCE((SELECT l.route_options::jsonb ->> 0 FROM plan_legs l
                          WHERE l.plan_id = p.id AND l.leg_kind IN ('bus','lrt')
                            AND l.route_options IS NOT NULL
                          ORDER BY l.seq LIMIT 1), ''),
               p.id
    `);
    // v0.17.0：SQL 别名是 snake_case（blink_style）→ 前端统一用 blinkStyle
    const plans = (rows as (Record<string, unknown> & { blink_style?: string | null })[]).map(
      ({ blink_style, ...r }) => ({
        ...r,
        blinkStyle: (blink_style ?? null) as "split" | "solid" | null,
      }),
    );
    return NextResponse.json({ plans });
  } catch (err) {
    console.error("[plans] 查询失败：", (err as Error).message);
    return NextResponse.json(
      { error: "方案查询失败，请确认数据库已初始化（npm run db:schema && npm run db:seed）" },
      { status: 500 },
    );
  }
}
