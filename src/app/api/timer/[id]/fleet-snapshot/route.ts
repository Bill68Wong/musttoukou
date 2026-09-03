import { NextRequest, NextResponse } from "next/server";
import { captureFleetSnapshot, type SnapshotStage } from "@/lib/dsat/fleet-snapshot";

/** 就近部署：Supabase 新加坡池化器 → sin1 */
export const preferredRegion = "sin1";

/**
 * POST /api/timer/[id]/fleet-snapshot { stage: "depart"|"wait_start"|"alight" }
 *
 * 反事实车队快照（需求 9）：打点 depart/wait_start/alight 成功后由前端触发（不阻塞打点）。
 * 服务端自解析：候选线路 = 方案 compare_routes；参照站 = 乘车段上车站。
 * 快照落 bus_snapshots（session_id/stage/ref_station/stops_away），跨时点按车牌追踪。
 * 任何失败都静默返回 { ok:true, skipped }，绝不影响计时主流程。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sessionId = Number(id);
    const body = (await req.json().catch(() => ({}))) as { stage?: string; routes?: string[] };
    if (!Number.isInteger(sessionId)) {
      return NextResponse.json({ error: "无效的会话 ID" }, { status: 400 });
    }
    const stage = body.stage as SnapshotStage;
    if (stage !== "depart" && stage !== "wait_start" && stage !== "alight") {
      return NextResponse.json({ ok: true, skipped: "bad_stage" });
    }

    const result = await captureFleetSnapshot({
      sessionId,
      stage,
      routes: Array.isArray(body.routes) ? body.routes : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.warn("[fleet-snapshot] 路由异常：", (err as Error).message);
    return NextResponse.json({ ok: true, skipped: "error" });
  }
}
