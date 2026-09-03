import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { queryEta, nearestStopsAway } from "@/lib/dsat/eta";

/**
 * POST /api/timer/[id]/auto-snapshot
 * body: { moment: "depart" | "wait_start", station, routes: string[], dir, dest }
 *
 * 系统自动记录车距（替代手动 0-11 快捷条）：
 *  - 用户在「出发」或「到站，开始等车」打点成功后由前端触发（不阻塞打点）
 *  - 复用 /api/dsat/eta 同款核心（queryEta + 30s 缓存），口径与 LiveEta 卡片一致
 *  - 取跨线路最近一辆车的 stopsAway，写入 wait_snapshots（value_kind='stops'）
 *  - source 区分自动时刻（auto_depart / auto_wait_start），配合唯一约束保证同会话同一时刻只记一次
 *  - 查不到任何在途车（DSAT 失败 / 未发车 / 暂无车辆）→ 静默跳过不写库，绝不影响计时
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sessionId = Number(id);
    const body = (await req.json()) as {
      moment?: string;
      station?: string;
      routes?: string[];
      dir?: string;
      dest?: string;
    };
    const pool = getPool();

    // 会话存在且未结束
    const sessRes = await pool.query(
      `SELECT id, ended_at FROM timer_sessions WHERE id = $1 AND deleted_at IS NULL`,
      [sessionId],
    );
    const session = sessRes.rows[0] as { id: number; ended_at: string | null } | undefined;
    if (!session) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    if (session.ended_at) return NextResponse.json({ ok: true, skipped: "ended" });

    const source =
      body.moment === "wait_start"
        ? "auto_wait_start"
        : body.moment === "depart"
          ? "auto_depart"
          : null;
    if (!source) return NextResponse.json({ ok: true, skipped: "bad_moment" });

    const station = body.station?.trim() ?? "";
    const routes = (body.routes ?? []).map((r) => r.trim()).filter(Boolean);
    const dir = body.dir?.trim() || "0";
    const dest = body.dest?.trim() || "";
    if (!station || routes.length === 0) {
      return NextResponse.json({ ok: true, skipped: "no_bus_leg" }); // 非巴士段（轻轨）不自动记录
    }

    // 查询实时车距（30s 缓存：刚看过 LiveEta 时通常零额外 DSAT 请求）
    const eta = await queryEta(station, routes, dir, dest);
    const stopsAway = nearestStopsAway(eta); // 跨线路最近
    if (stopsAway === null) {
      // DSAT 失败 / 全部未发车 / 无在途车 → 无可记录的车距
      return NextResponse.json({ ok: true, skipped: "no_bus_near" });
    }

    // value_kind='stops'，value 存真实站数；source 幂等（同会话同自动时刻仅一条）
    const ins = await pool.query(
      `INSERT INTO wait_snapshots (session_id, value_kind, value, source)
       VALUES ($1, 'stops', $2, $3)
       ON CONFLICT (session_id, source)
       WHERE source IN ('auto_depart', 'auto_wait_start')
       DO NOTHING
       RETURNING id`,
      [sessionId, stopsAway, source],
    );
    const recorded = (ins.rows[0] as { id: number } | undefined) !== undefined;
    return NextResponse.json({ ok: true, recorded, stopsAway });
  } catch (err) {
    // 自动记录失败永不报错给前端（不影响计时主流程）
    console.warn("[auto-snapshot] 失败：", (err as Error).message);
    return NextResponse.json({ ok: true, skipped: "error" });
  }
}
