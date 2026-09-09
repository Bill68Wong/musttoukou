import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const preferredRegion = "sin1";

/** POST /api/free/[id]/crowd { level: 0-4 } —— 本次采集的拥挤度（可反复修改） */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const rideId = Number(id);
    const body = (await req.json()) as { level?: number };
    const level = body.level;
    if (!Number.isInteger(level) || (level as number) < 0 || (level as number) > 4) {
      return NextResponse.json({ ok: false, error: "无效拥挤度（0-4）" }, { status: 400 });
    }
    const pool = getPool();
    const res = await pool.query(
      `UPDATE free_rides SET crowd_level = $2
        WHERE id = $1 AND ended_at IS NULL AND deleted_at IS NULL`,
      [rideId, level],
    );
    if (!res.rowCount) {
      return NextResponse.json({ ok: false, error: "会话不存在或已结束" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
