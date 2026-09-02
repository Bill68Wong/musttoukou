import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";

/** GET /api/timer/[id]：会话详情 + 方案分段 + 事件 + 站名表（向导恢复用） */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sessionId = Number(id);
    if (!Number.isInteger(sessionId)) {
      return NextResponse.json({ error: "无效的会话 ID" }, { status: 400 });
    }
    const pool = getPool();

    const sessRes = await pool.query(
      `SELECT s.*, p.summary, p.plan_key, pf.slug AS from_slug, pt.slug AS to_slug
       FROM timer_sessions s
       JOIN commute_plans p ON s.plan_id = p.id
       JOIN places pf ON p.from_place = pf.id
       JOIN places pt ON p.to_place = pt.id
       WHERE s.id = $1 AND s.deleted_at IS NULL`,
      [sessionId],
    );
    const session = sessRes.rows[0];
    if (!session) {
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    }

    const legsRes = await pool.query(
      `SELECT seq, leg_kind, route_options, from_station, to_station
       FROM plan_legs WHERE plan_id = $1 ORDER BY seq`,
      [session.plan_id],
    );

    const eventsRes = await pool.query(
      `SELECT id, seq, event_type, station_code, recorded_at
       FROM timer_events WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    );

    const snapsRes = await pool.query(
      `SELECT id, value_kind, value, recorded_at
       FROM wait_snapshots WHERE session_id = $1 ORDER BY id`,
      [sessionId],
    );

    // 站名对照表（站点总量小，全量取）
    const stationsRes = await pool.query(`SELECT code, name_tc FROM stations`);

    // 各载具段首选项线路的站序（乘车阶段「下一站」提示用）
    const routeStopsByRoute: Record<string, { seq: number; code: string; name: string }[]> = {};
    const vehicleLegs = (legsRes.rows as {
      leg_kind: string;
      route_options: string | null;
    }[]).filter((l) => l.leg_kind === "bus" || l.leg_kind === "lrt");
    for (const leg of vehicleLegs) {
      const opts = leg.route_options ? (JSON.parse(leg.route_options) as string[]) : [];
      const rc = opts[0];
      if (!rc || routeStopsByRoute[rc]) continue;
      const stopsRes = await pool.query(
        `SELECT rs.seq, rs.station_code AS code, st.name_tc AS name
         FROM route_stations rs
         JOIN routes r ON rs.route_id = r.id
         JOIN stations st ON rs.station_code = st.code
         WHERE r.code = $1 AND r.kind = 'bus' AND rs.dsat_dir = $2
         ORDER BY rs.seq`,
        [rc, session.dsat_dir ?? "0"],
      );
      routeStopsByRoute[rc] = stopsRes.rows as { seq: number; code: string; name: string }[];
    }

    return NextResponse.json({
      session,
      legs: legsRes.rows,
      events: eventsRes.rows,
      snapshots: snapsRes.rows,
      stationNames: Object.fromEntries(
        (stationsRes.rows as { code: string; name_tc: string }[]).map((r) => [r.code, r.name_tc]),
      ),
      routeStopsByRoute,
    });
  } catch (err) {
    console.error("[timer] 查询失败：", (err as Error).message);
    return NextResponse.json({ error: "查询会话失败" }, { status: 500 });
  }
}

/** DELETE /api/timer/[id]：软删除会话（记录页单条选择性删除用） */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sessionId = Number(id);
    if (!Number.isInteger(sessionId)) {
      return NextResponse.json({ error: "无效的会话 ID" }, { status: 400 });
    }
    const pool = getPool();
    const res = await pool.query(
      `UPDATE timer_sessions SET deleted_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [sessionId],
    );
    if (res.rowCount === 0) {
      return NextResponse.json({ error: "会话不存在或已删除" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[timer] 删除失败：", (err as Error).message);
    return NextResponse.json({ error: "删除会话失败" }, { status: 500 });
  }
}

/** PATCH /api/timer/[id]：结束页提交拥挤度等收尾字段 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sessionId = Number(id);
    const body = (await req.json()) as { crowd_level?: number };
    if (!Number.isInteger(sessionId) || body.crowd_level === undefined) {
      return NextResponse.json({ error: "参数错误" }, { status: 400 });
    }
    const pool = getPool();
    const res = await pool.query(
      `UPDATE timer_sessions SET crowd_level = $1 WHERE id = $2 AND deleted_at IS NULL
       RETURNING id, crowd_level`,
      [body.crowd_level, sessionId],
    );
    if (res.rowCount === 0) {
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[timer] 更新失败：", (err as Error).message);
    return NextResponse.json({ error: "更新会话失败" }, { status: 500 });
  }
}
