import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const preferredRegion = "sin1";

/**
 * POST /api/timer/[id]/crowd —— 记录「本趟车」的拥挤度（v0.18.0）
 *
 * body: { vehIndex: number, level: 0|1|2|3|4, routeCode?: string | null }
 *  - vehIndex = 载具段序号（0-based，与 buildSteps 的 Step.vehIndex 同构）
 *  - 换乘方案每程各记一条（同 session + 同 vehIndex 幂等覆盖，用户改选即更新）
 *  - level 语义：0 空（随便坐）/ 1 正常（有座）/ 2 饱和（没座位但站稳）
 *                3 挤（贴着站）/ 4 爆满（前胸贴后背）
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sessionId = Number(id);
    if (!Number.isInteger(sessionId)) {
      return NextResponse.json({ error: "无效的会话 ID" }, { status: 400 });
    }
    const body = (await req.json()) as {
      vehIndex?: number;
      level?: number;
      routeCode?: string | null;
    };
    const { vehIndex, level, routeCode } = body;
    if (!Number.isInteger(vehIndex) || (vehIndex as number) < 0) {
      return NextResponse.json({ error: "无效的段序号" }, { status: 400 });
    }
    if (!Number.isInteger(level) || (level as number) < 0 || (level as number) > 4) {
      return NextResponse.json({ error: "无效的拥挤度（应为 0-4）" }, { status: 400 });
    }
    const pool = getPool();
    const exists = await pool.query(
      `SELECT id FROM timer_sessions WHERE id = $1 AND deleted_at IS NULL`,
      [sessionId],
    );
    if (!exists.rows.length) {
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    }
    await pool.query(
      `INSERT INTO ride_crowd (session_id, veh_index, level, route_code)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, veh_index)
       DO UPDATE SET level = EXCLUDED.level,
                     route_code = EXCLUDED.route_code,
                     created_at = now()`,
      [sessionId, vehIndex, level, routeCode ?? null],
    );
    return NextResponse.json({ ok: true, sessionId, vehIndex, level });
  } catch (err) {
    console.error("[crowd] 写入失败：", (err as Error).message);
    return NextResponse.json({ error: "记录拥挤度失败" }, { status: 500 });
  }
}
