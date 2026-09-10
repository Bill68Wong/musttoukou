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
             -- v0.20.5：卡片模板——**每个载具段**的线路码（换乘多程各一组，用 → 连接）
             (SELECT COALESCE(
                       jsonb_agg(CASE WHEN l.route_options IS NULL OR l.route_options = ''
                                      THEN '[]'::jsonb ELSE l.route_options::jsonb END
                                 ORDER BY l.seq),
                       '[]'::jsonb)
                FROM plan_legs l
               WHERE l.plan_id = p.id AND l.leg_kind IN ('bus','lrt')) AS leg_routes,
             -- 上车站：默认线路（route_options 首项）的 meta.board[0]，无则段级 from_station
             (SELECT (CASE WHEN sb.kind = 'bus' THEN sb.code || ' ' || sb.name_tc ELSE sb.name_tc END)
                FROM plan_legs l
                LEFT JOIN stations sb
                  ON sb.code = COALESCE(
                       l.route_meta -> (CASE WHEN l.route_options IS NULL OR l.route_options = ''
                                             THEN NULL ELSE l.route_options::jsonb ->> 0 END) -> 'board' ->> 0,
                       l.from_station)
               WHERE l.plan_id = p.id AND l.leg_kind IN ('bus','lrt')
               ORDER BY l.seq LIMIT 1) AS board_name,
             -- 下车站：默认线路的 meta.to，无则段级 to_station
             (SELECT (CASE WHEN sa.kind = 'bus' THEN sa.code || ' ' || sa.name_tc ELSE sa.name_tc END)
                FROM plan_legs l
                LEFT JOIN stations sa
                  ON sa.code = COALESCE(
                       l.route_meta -> (CASE WHEN l.route_options IS NULL OR l.route_options = ''
                                             THEN NULL ELSE l.route_options::jsonb ->> 0 END) ->> 'to',
                       l.to_station)
               WHERE l.plan_id = p.id AND l.leg_kind IN ('bus','lrt')
               ORDER BY l.seq LIMIT 1) AS alight_name,
             (SELECT count(*)::int FROM timer_sessions s
               WHERE s.plan_id = p.id AND s.deleted_at IS NULL
                 AND NOT COALESCE(s.is_test, false)
                 AND s.total_minutes IS NOT NULL) AS samples,
             -- v0.17.0：合并卡单段含多条线路 → 展开 route_options 全部项取色，
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
             -- v0.17.0：闪烁样式 —— 'split' 去横琴纯巴士卡（左右两色互换）；
             -- 'solid' 同起点合并卡且含 ≥2 家公司色（整卡两色交替）；否则 null
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
      WHERE ${where}
      -- v0.18.0：方案显示顺序统一——① 轻轨方案在前 ② 巴士按主线路自然排序
      --          （数字前缀升序 → 线路码兜底；无数字开头如 N6 排最后）
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
    `,
    params,
  );
  // v0.17.0：SQL 别名是 snake_case（blink_style）→ 前端统一用 blinkStyle
  return (res.rows as (PlanRow & { blink_style?: string | null })[]).map(
    ({ blink_style, ...r }) => ({ ...r, blinkStyle: (blink_style ?? null) as PlanRow["blinkStyle"] }),
  );
}

/** v0.20.0：全量线路色表（code → color），供卡片/标签取主题色 */
export async function queryRouteColors(): Promise<Record<string, string>> {
  const pool = getPool();
  const res = await pool.query(`SELECT code, color FROM routes WHERE color IS NOT NULL`);
  const map: Record<string, string> = {};
  for (const r of res.rows as { code: string; color: string }[]) map[r.code] = r.color;
  return map;
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
