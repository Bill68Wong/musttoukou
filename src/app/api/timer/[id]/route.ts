import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { deriveRouteDir } from "@/lib/dsat/eta";

/** 就近部署：Supabase 新加坡池化器 → sin1 */
export const preferredRegion = "sin1";

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
      `SELECT seq, leg_kind, route_options, from_station, to_station,
              border_label, board_candidates, alight_candidates, minutes,
              route_meta
       FROM plan_legs WHERE plan_id = $1 ORDER BY seq`,
      [session.plan_id],
    );
    // v0.7.0：线路主题色表（code → color），给 legs 每段主线路填色
    const colorRows = await pool.query(`SELECT code, color FROM routes`);
    const colorByCode = new Map(
      (colorRows.rows as { code: string; color: string | null }[])
        .filter((r) => !!r.color)
        .map((r) => [r.code, r.color] as [string, string]),
    );
    // route_options 是 TEXT 列存的 JSON 字符串 → 统一解析成数组（客户端按数组使用）
    const legs = (
      legsRes.rows as {
        seq: number;
        leg_kind: string;
        route_options: string | string[] | null;
        from_station: string | null;
        to_station: string | null;
        border_label: string | null;
        board_candidates: string[] | null;
        alight_candidates: string[] | null;
        /** v0.17.0：合并卡每线路差异化（JSONB 列，pg 直接返回对象；本地可能为字符串） */
        route_meta: Record<string, unknown> | string | null;
      }[]
    ).map((r) => {
      const route_options =
        typeof r.route_options === "string"
          ? (JSON.parse(r.route_options) as string[])
          : r.route_options;
      const isVehicle = r.leg_kind === "bus" || r.leg_kind === "lrt";
      const route_meta =
        typeof r.route_meta === "string"
          ? ((JSON.parse(r.route_meta) as Record<string, unknown>) ?? null)
          : (r.route_meta ?? null);
      return {
        ...r,
        route_options,
        route_meta,
        // 主线路 = route_options 首项（与首页卡片色带同口径）；无则中性
        color:
          isVehicle && route_options?.length
            ? (colorByCode.get(route_options[0]) ?? null)
            : null,
      };
    });

    const eventsRes = await pool.query(
      `SELECT id, seq, event_type, station_code, recorded_at
       FROM timer_events WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    );

    const snapsRes = await pool.query(
      `SELECT id, value_kind, value, station_code, recorded_at
       FROM wait_snapshots WHERE session_id = $1 ORDER BY id`,
      [sessionId],
    );

    // 站名对照表（站点总量小，全量取）；v0.4.0：巴士站值带站号前缀 "T358 偉龍/科大醫院"，轻轨不带
    const stationsRes = await pool.query(`SELECT code, name_tc, kind FROM stations`);

    // 各载具段候选线路的站序（乘车阶段「下一站/途经站」推进用；v0.10.0 起覆盖整段 route_options
    // 全部备选，用户乘非首选项时同样可逐站推进）
    // v0.8.0：不再硬编码 kind='bus'——轻轨三线已入 route_stations；
    // 方向按本段 from→to 推导（bus 沿用 DSAT dir 语义；轻轨 dir0=正向编号递增向、dir1=反向），
    // 使「科大→協和」（反向乘坐）取到与行进方向一致的站序，中间站正常逐站显示。
    const routeStopsByRoute: Record<string, { seq: number; code: string; name: string }[]> = {};
    const vehicleLegs = legs.filter((l) => l.leg_kind === "bus" || l.leg_kind === "lrt");
    for (const leg of vehicleLegs) {
      const opts = leg.route_options ?? [];
      const meta = (leg.route_meta ?? null) as Record<
        string,
        { to?: string; board?: string[] }
      > | null;
      for (const rc of opts) {
        if (!rc || routeStopsByRoute[rc]) continue;
        // v0.17.0：合并卡各线路的起终点不同（59→M9/2 与 25→M1/13；51A 在 C690/1 上车而非
        // 卡默认 C690/3）→ 方向必须按「该线路自己的 from/to」推导，否则站序会取错方向
        const rm = meta?.[rc] ?? null;
        const fromForDir = rm?.board?.[0] ?? leg.from_station;
        const toForDir = rm?.to ?? leg.to_station;
        const dir =
          fromForDir && toForDir
            ? await deriveRouteDir(rc, fromForDir, toForDir, session.dsat_dir ?? "0")
            : (session.dsat_dir ?? "0");
        const stopsRes = await pool.query(
          `SELECT rs.seq, rs.station_code AS code,
                  (CASE WHEN st.kind = 'bus' THEN rs.station_code || ' ' || st.name_tc ELSE st.name_tc END) AS name
           FROM route_stations rs
           JOIN routes r ON rs.route_id = r.id
           JOIN stations st ON rs.station_code = st.code
           WHERE r.code = $1 AND rs.dsat_dir = $2
           ORDER BY rs.seq`,
          [rc, dir],
        );
        routeStopsByRoute[rc] = stopsRes.rows as { seq: number; code: string; name: string }[];
      }
    }

    // v0.18.0：每程拥挤度（换乘每趟车一条；前端按 veh_index 判断是否已记录）
    const crowdRes = await pool.query(
      `SELECT veh_index, level, route_code FROM ride_crowd
        WHERE session_id = $1 ORDER BY veh_index`,
      [sessionId],
    );

    return NextResponse.json({
      session,
      legs,
      events: eventsRes.rows,
      snapshots: snapsRes.rows,
      crowd: crowdRes.rows as { veh_index: number; level: number; route_code: string | null }[],
      stationNames: Object.fromEntries(
        (stationsRes.rows as { code: string; name_tc: string; kind: string }[]).map((r) => [
          r.code,
          r.kind === "bus" ? `${r.code} ${r.name_tc}` : r.name_tc,
        ]),
      ),
      // v0.16.2：全量线路色表（code → color）——乘车段随实乘线选择联动标签/进度条颜色
      routeColors: Object.fromEntries(colorByCode),
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

/**
 * PATCH /api/timer/[id]：收尾字段
 * ⚠️ v0.18.0 起拥挤度改走 POST /api/timer/[id]/crowd（按程记录），本接口保留仅为兼容旧调用
 */
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
