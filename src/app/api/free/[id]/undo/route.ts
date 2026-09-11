import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const preferredRegion = "sin1";

/**
 * POST /api/free/[id]/undo
 * body: { event_id: number }
 *
 * 撤销自由记站最近一条打点（v0.22.0）—— 防手滑误点。
 * 与通勤计时 /api/timer/[id]/undo 行为一致：只能撤「最新一条」（seq 最大者），
 * body 的 event_id 不等于最新事件时返回 409（本地连续撤销时逐次调用）。
 *
 * 数据回撤：
 * - alight → 行程「复活」：清 ended_at / alight_station / total_ms，回到 riding 继续打点
 * - 其余（stop_arrive / stop_pass / stop_skip / board）→ 只删行，
 *   前端按剩余事件重算「下一站」（xCode）与已记条数
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const rideId = Number(id);
    if (!Number.isInteger(rideId)) {
      return NextResponse.json({ ok: false, error: "无效的行程 ID" }, { status: 400 });
    }
    const body = (await req.json()) as { event_id?: number };
    if (!Number.isInteger(body.event_id)) {
      return NextResponse.json({ ok: false, error: "缺少 event_id" }, { status: 400 });
    }
    const pool = getPool();

    const rideRes = await pool.query(
      `SELECT id FROM free_rides WHERE id = $1 AND deleted_at IS NULL`,
      [rideId],
    );
    if ((rideRes.rowCount ?? 0) === 0) {
      return NextResponse.json({ ok: false, error: "行程不存在" }, { status: 404 });
    }

    const latestRes = await pool.query(
      `SELECT id, event_type, station_code FROM free_ride_events
        WHERE free_ride_id = $1
        ORDER BY seq DESC, id DESC
        LIMIT 1`,
      [rideId],
    );
    const latest = latestRes.rows[0] as
      | { id: number | string; event_type: string; station_code: string | null }
      | undefined;
    if (!latest) {
      return NextResponse.json({ ok: false, error: "没有可撤销的打点" }, { status: 409 });
    }
    // id 可能是 BIGSERIAL（pg 返回字符串）→ 比较前归一
    if (Number(latest.id) !== Number(body.event_id)) {
      return NextResponse.json(
        { ok: false, error: "只能撤销最近一条打点（可连续撤销）" },
        { status: 409 },
      );
    }

    await pool.query(`DELETE FROM free_ride_events WHERE id = $1 AND free_ride_id = $2`, [
      latest.id,
      rideId,
    ]);

    let resurrected = false;
    if (latest.event_type === "alight") {
      await pool.query(
        `UPDATE free_rides SET ended_at = NULL, alight_station = NULL, total_ms = NULL WHERE id = $1`,
        [rideId],
      );
      resurrected = true;
    }

    return NextResponse.json({
      ok: true,
      removed: { event_type: latest.event_type, station_code: latest.station_code },
      resurrected,
    });
  } catch (err) {
    console.error("[free/undo] 撤销失败：", (err as Error).message);
    return NextResponse.json({ ok: false, error: "撤销失败" }, { status: 500 });
  }
}
