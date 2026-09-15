import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { deriveRouteDir } from "@/lib/dsat/eta";

/** 就近部署：Supabase 新加坡池化器 → sin1 */
export const preferredRegion = "sin1";

/** 座区取值白名单（与 src/lib/recommend/types.ts 的 SchoolZone 对齐） */
const SCHOOL_ZONE_VALUES = ["B/C", "N/O", "R"];

/**
 * POST /api/timer：创建计时会话 {planId, route?, board?, alight?, zone?}
 * 自动填充：日期/星期/时段（GMT+8）、主线路、DSAT 方向（由 route_stations 推导，未同步则为 null）
 * v0.23.0：测试模式已移除 → is_test 恒 false（请求体若仍带该字段一律忽略）
 *
 * v1.0.0：新增 4 个**全可选**字段，供「自动选线」大卡片一键建会话：
 *   · route  实乘线路码（覆盖 plan_legs.route_options[0]；多线同方向时用户点的是哪条）
 *   · board  实际上车站码（覆盖分段 from_station，DSAT 方向推导用）
 *   · alight 实际下车站码（覆盖分段 to_station）
 *   · zone   澳科大座区（B/C | N/O | R）→ 落 from_zone / to_zone（哪侧是 school 就记哪侧）
 * ⚠️ 一个都不传时，本接口行为与 v0.28.x **完全一致**（老入口 /routes 不传参 → 走老逻辑）。
 */
export async function POST(req: NextRequest) {
  try {
    const { planId, route, board, alight, zone } = (await req.json()) as {
      planId?: number;
      route?: string;
      board?: string;
      alight?: string;
      zone?: string;
    };
    if (!planId) {
      return NextResponse.json({ error: "缺少 planId" }, { status: 400 });
    }
    const overrideRoute =
      typeof route === "string" && route.trim() !== "" ? route.trim() : null;
    const boardCode =
      typeof board === "string" && board.trim() !== "" ? board.trim() : null;
    const alightCode =
      typeof alight === "string" && alight.trim() !== "" ? alight.trim() : null;
    const zoneVal =
      typeof zone === "string" && SCHOOL_ZONE_VALUES.includes(zone) ? zone : null;
    const pool = getPool();

    // 查方案与首个巴士/轻轨分段
    const legRes = await pool.query(
      `SELECT l.leg_kind, l.route_options, l.from_station, l.to_station
       FROM plan_legs l WHERE l.plan_id = $1 ORDER BY l.seq`,
      [planId],
    );
    const legs = legRes.rows as {
      leg_kind: string;
      route_options: string | null;
      from_station: string | null;
      to_station: string | null;
    }[];
    if (legs.length === 0) {
      return NextResponse.json({ error: "方案不存在" }, { status: 404 });
    }

    const vehicleLeg = legs.find((l) => l.leg_kind === "bus" || l.leg_kind === "lrt");
    let routeCode: string | null = null;
    let dsatDir: string | null = null;
    if (vehicleLeg) {
      const options = vehicleLeg.route_options
        ? (JSON.parse(vehicleLeg.route_options) as string[])
        : [];
      // v1.0.0：大卡指定的实乘线优先；未指定 → 沿用首选项（历史行为）
      routeCode = overrideRoute ?? options[0] ?? null;
      // 上/下车站：大卡传来的实际停靠站优先（如 51 系分台、轻轨科大/路氹東）
      const fromForDir = boardCode ?? vehicleLeg.from_station;
      const toForDir = alightCode ?? vehicleLeg.to_station;
      // 由共享推导（src/lib/dsat/eta.ts）：from 站在 to 站之前的方向；
      // 循环线兜底（仅一套站序时用唯一方向）；轻轨无站序 → null（保持历史语义）
      // ⚠️ 历史判据是 leg_kind==='bus'；改用「线路码非 LRT-」等价且对 override 更安全
      //    （老数据里 bus 段的 route_options[0] 不可能是 LRT-*）
      if (routeCode && !routeCode.startsWith("LRT-") && fromForDir && toForDir) {
        dsatDir = await deriveRouteDir(routeCode, fromForDir, toForDir, "0");
      }
    }

    // v1.0.0：座区 → from_zone / to_zone（哪一侧是澳科大就记哪一侧）。
    // ⚠️ 只在传了 zone 时才多查一次方向（不带 zone 的老路径查询条数不变）
    let fromZone: string | null = null;
    let toZone: string | null = null;
    if (zoneVal) {
      const dirRes = await pool.query(
        `SELECT pf.slug AS from_slug, pt.slug AS to_slug
           FROM commute_plans p
           JOIN places pf ON p.from_place = pf.id
           JOIN places pt ON p.to_place = pt.id
          WHERE p.id = $1`,
        [planId],
      );
      const slugs = dirRes.rows[0] as { from_slug: string; to_slug: string } | undefined;
      if (slugs?.from_slug === "school") fromZone = zoneVal;
      if (slugs?.to_slug === "school") toZone = zoneVal;
    }

    // 澳门时间（GMT+8）
    const now = new Date();
    const macau = new Date(now.getTime() + 8 * 3600 * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    const travelDate = `${macau.getUTCFullYear()}-${p(macau.getUTCMonth() + 1)}-${p(macau.getUTCDate())}`;
    const weekday = macau.getUTCDay();

    const ins = await pool.query(
      `INSERT INTO timer_sessions
         (plan_id, route_code, dsat_dir, from_zone, to_zone, travel_date, weekday, started_at, is_test)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), false)
       RETURNING id`,
      [planId, routeCode, dsatDir, fromZone, toZone, travelDate, weekday],
    );
    const sessionId = (ins.rows[0] as { id: number }).id;
    return NextResponse.json({ sessionId });
  } catch (err) {
    console.error("[timer] 创建失败：", (err as Error).message);
    return NextResponse.json({ error: "创建计时会话失败" }, { status: 500 });
  }
}
