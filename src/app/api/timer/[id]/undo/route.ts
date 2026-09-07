import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";

/** 就近部署：Supabase 新加坡池化器 → sin1 */
export const preferredRegion = "sin1";

/**
 * POST /api/timer/[id]/undo
 * body: { event_id: number }
 *
 * 撤销最近一条事件（v0.12.0）——防手滑误点（如乘车中误记途经站）。
 * 约束与语义：
 * - 只能撤销「最新一条」（seq 最大者）；body 的 event_id 若不等于最新事件 → 409
 *   （本地连续撤销时逐次调用，每次删掉当时的 max seq）
 * - 排除 pause/resume（瞬态控制事件，非手滑打点对象，且可能打破暂停闭合配对）
 * - 撤销会真实删除 timer_events 行（非软删），数据回撤：
 *   - missed → timer_sessions.missed_count - 1（GREATEST 0 兜底）
 *   - arrive → 会话「复活」：清 ended_at / total_minutes / time_bucket（重新计时收尾）
 *   - board 曾把 route_code/dsat_dir 修正为实乘线 → 不还原（等下次 board 按新选择覆盖）
 *   - station_arrive/station_pass → 只删行，乘车进度由剩余事件自然回退
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sessionId = Number(id);
    if (!Number.isInteger(sessionId)) {
      return NextResponse.json({ error: "无效的会话 ID" }, { status: 400 });
    }
    const body = (await req.json()) as { event_id?: number };
    if (!Number.isInteger(body.event_id)) {
      return NextResponse.json({ error: "缺少 event_id" }, { status: 400 });
    }
    const pool = getPool();

    const sessRes = await pool.query(
      `SELECT id FROM timer_sessions WHERE id = $1 AND deleted_at IS NULL`,
      [sessionId],
    );
    if ((sessRes.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    }

    // 最新一条事件（seq 最大；seq 同值按 id 兜底）
    const latestRes = await pool.query(
      `SELECT id, event_type, station_code FROM timer_events
       WHERE session_id = $1
       ORDER BY seq DESC, id DESC
       LIMIT 1`,
      [sessionId],
    );
    const latest = latestRes.rows[0] as
      | { id: number | string; event_type: string; station_code: string | null }
      | undefined;
    if (!latest) {
      return NextResponse.json({ error: "没有可撤销的事件" }, { status: 409 });
    }
    // id 为 BIGSERIAL，pg 默认返回字符串 → 与前端数字 event_id 比较前归一
    if (Number(latest.id) !== Number(body.event_id)) {
      return NextResponse.json(
        { error: "只能撤销最近一条事件（可连续撤销）" },
        { status: 409 },
      );
    }
    if (latest.event_type === "pause" || latest.event_type === "resume") {
      return NextResponse.json(
        { error: "暂停/继续为瞬态控制事件，不可撤销" },
        { status: 400 },
      );
    }

    // 真实删除（数据回撤核心）
    await pool.query(
      `DELETE FROM timer_events WHERE id = $1 AND session_id = $2`,
      [latest.id, sessionId],
    );

    let missedDecremented = false;
    let resurrected = false;
    if (latest.event_type === "missed") {
      await pool.query(
        `UPDATE timer_sessions SET missed_count = GREATEST(0, missed_count - 1) WHERE id = $1`,
        [sessionId],
      );
      missedDecremented = true;
    } else if (latest.event_type === "arrive") {
      // arrive 触发过收尾 → 会话复活为计时中（ended_at 清空后向导继续停留在原步骤）
      // v0.13.0：border_minutes（通关耗时）一并清空，等待重新 arrive 收尾
      await pool.query(
        `UPDATE timer_sessions
         SET ended_at = NULL, total_minutes = NULL, time_bucket = NULL, border_minutes = NULL
         WHERE id = $1`,
        [sessionId],
      );
      resurrected = true;
    } else if (latest.event_type === "border_end") {
      // v0.16.1：去程口岸卡的 border_end 触发过自动结算收尾 → 同样复活（清结算字段，
      // 向导停留回 border_end 步，可重按「通关完成」再次收尾）
      await pool.query(
        `UPDATE timer_sessions
         SET ended_at = NULL, total_minutes = NULL, time_bucket = NULL, border_minutes = NULL
         WHERE id = $1`,
        [sessionId],
      );
      resurrected = true;
    }

    return NextResponse.json({
      ok: true,
      removed: { event_type: latest.event_type, station_code: latest.station_code },
      missed_decremented: missedDecremented,
      resurrected,
    });
  } catch (err) {
    console.error("[undo] 撤销失败：", (err as Error).message);
    return NextResponse.json({ error: "撤销失败" }, { status: 500 });
  }
}
