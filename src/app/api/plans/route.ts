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
               WHERE s.plan_id = p.id AND s.deleted_at IS NULL) AS samples,
             (SELECT max(s.started_at) FROM timer_sessions s WHERE s.plan_id = p.id) AS last_used
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
