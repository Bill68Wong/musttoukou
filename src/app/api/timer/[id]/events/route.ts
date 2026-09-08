import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { timeBucketOf, type EventType } from "@/lib/timer-flow";
import { deriveRouteDir } from "@/lib/dsat/eta";

/** 就近部署：Supabase 新加坡池化器 → sin1 */
export const preferredRegion = "sin1";

const VALID_EVENTS: EventType[] = [
  "depart",
  "wait_start",
  "missed",
  "board",
  "station_arrive",
  "station_pass",
  "alight",
  "border_start",
  "border_end",
  "arrive",
  // v0.12.0：步行暂停/继续（瞬态状态事件，不入 steps 不推进；撤销时服务端排除）
  "pause",
  "resume",
];

/** 学校分区：B/C 座、N/O 座、R 座（步行分组上下文，需求 10） */
const ZONES = ["B/C", "N/O", "R"];

/** 站区码三段式兼容（C688↔C688/2）——board 选线修正时匹配上车段用 */
function sameStation(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

/**
 * v0.16.1：会话收尾结算（arrive 与「以通关结尾方案的 border_end」共用）。
 * ended_at/total_minutes/time_bucket/border_minutes 一次落定：
 *   总时长 = now(收尾时刻) - 首个 depart（无则 started_at）
 *          - 暂停闭合区间 - 通关闭合区间（通关耗时独立入 border_minutes，不计行程）
 */
async function settleSession(sessionId: number, pool: ReturnType<typeof getPool>): Promise<void> {
  const now = new Date();
  const macau = new Date(now.getTime() + 8 * 3600 * 1000);
  const bucket = timeBucketOf(macau.getUTCHours());
  await pool.query(
    `UPDATE timer_sessions
     SET ended_at = now(),
         time_bucket = $2,
         total_minutes = round(
           GREATEST(0,
             extract(epoch from (now() - coalesce(
               (SELECT min(recorded_at) FROM timer_events
                 WHERE session_id = $1 AND event_type = 'depart'),
               started_at)))
             - COALESCE((
                 SELECT sum(extract(epoch from (resume_at - pause_at)))
                 FROM (
                   SELECT recorded_at AS pause_at,
                          lead(recorded_at) OVER w AS resume_at,
                          lead(event_type) OVER w AS resume_type
                   FROM timer_events
                   WHERE session_id = $1 AND event_type IN ('pause', 'resume')
                   WINDOW w AS (ORDER BY seq, id)
                 ) pr
                 WHERE pr.resume_type = 'resume'
               ), 0)
             - COALESCE((
                 SELECT sum(extract(epoch from (border_end_at - border_start_at)))
                 FROM (
                   SELECT recorded_at AS border_start_at,
                          lead(recorded_at) OVER w AS border_end_at,
                          lead(event_type) OVER w AS border_end_type
                   FROM timer_events
                   WHERE session_id = $1 AND event_type IN ('border_start', 'border_end')
                   WINDOW w AS (ORDER BY seq, id)
                 ) bb
                 WHERE bb.border_end_type = 'border_end'
               ), 0)
           ) / 60.0, 1),
         border_minutes = round(
           GREATEST(0, COALESCE((
             SELECT sum(extract(epoch from (border_end_at - border_start_at)))
             FROM (
               SELECT recorded_at AS border_start_at,
                      lead(recorded_at) OVER w AS border_end_at,
                      lead(event_type) OVER w AS border_end_type
               FROM timer_events
               WHERE session_id = $1 AND event_type IN ('border_start', 'border_end')
               WINDOW w AS (ORDER BY seq, id)
             ) bb
             WHERE bb.border_end_type = 'border_end'
           ), 0)) / 60.0, 1)
     WHERE id = $1`,
    [sessionId, bucket],
  );
}

/**
 * POST /api/timer/[id]/events
 * body: { type: EventType, station_code?, from_zone?, to_zone?, tap_id?, route? }
 *       { type: "wait_snapshot", value: number, value_kind: "stops"|"minutes", station_code? } → 写 wait_snapshots
 *
 * 幂等（v0.10.0 A8）：普通事件带 tap_id —— 同 (session_id, tap_id) 已存在 → 返回 {dedup:true} 不双写
 *   （网络重试/双击同一次打点只记一条，missed 不重复 +1）
 * A11：board 事件若附 route（实际乘的非首选线路），且该站属方案首个载具段 → 修正
 *   session.route_code / dsat_dir 到实际乘坐线（乘车推进/车辆抓取按实乘线）
 * A9：arrive 收尾 total_minutes 改从 depart 事件起算（无 depart 回退 started_at）
 * arrive 事件触发收尾：ended_at / total_minutes / time_bucket（GMT+8）
 * from_zone/to_zone（B/C|N/O|R）：随 depart/arrive 打点附带，落到会话做步行分组
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sessionId = Number(id);
    const body = (await req.json()) as {
      type?: string;
      station_code?: string | null;
      value?: number;
      value_kind?: "stops" | "minutes";
      from_zone?: string | null;
      to_zone?: string | null;
      tap_id?: string | null;
      route?: string | null;
      /** v0.15.0：wait_snapshot 来源 —— manual（手动）/ auto_wait_start（轻轨时刻表自动） */
      source?: string | null;
    };
    const pool = getPool();
    // 本次插入的真实事件 id（撤销依赖；wait_snapshot/dedup 为 null）
    let eventId: number | null = null;

    // 会话存在且未结束
    const sessRes = await pool.query(
      `SELECT id, ended_at, plan_id, dsat_dir FROM timer_sessions WHERE id = $1 AND deleted_at IS NULL`,
      [sessionId],
    );
    const session = sessRes.rows[0] as
      | { id: number; ended_at: string | null; plan_id: number | null; dsat_dir: string | null }
      | undefined;
    if (!session) {
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    }
    if (session.ended_at) {
      return NextResponse.json({ error: "会话已结束" }, { status: 409 });
    }

    // 等车快照：单独表
    // - minutes（轻轨手动）：同一会话同一站只保留一条（单次乘坐只记一次）；改选分钟 = 覆盖原值（UPDATE）
    // - stops（巴士自动）：走 /auto-snapshot（本路由不落 stops 手动）
    if (body.type === "wait_snapshot") {
      if (typeof body.value !== "number" || !body.value_kind) {
        return NextResponse.json({ error: "快照参数错误" }, { status: 400 });
      }
      if (body.value_kind === "stops") {
        return NextResponse.json({ error: "巴士段车距由系统自动记录" }, { status: 400 });
      }
      // 轻轨分钟（v0.9）：必须带上车站——无站行无法去重、无法归属分段，历史已清并建索引防再犯
      if (body.value_kind === "minutes" && !body.station_code) {
        return NextResponse.json({ error: "轻轨分钟快照必须带上车站 station_code" }, { status: 400 });
      }
      // 来源分流：
      //  - manual（历史手动 chips）：部分唯一索引 (session_id, station_code) WHERE source='manual'…，改选覆盖
      //  - auto_wait_start（v0.15.0 轻轨时刻表自动）：uq_wait_snap_auto_once (session_id, source, station_code)
      //    WHERE source IN ('auto_depart','auto_wait_start') —— 与巴士 auto 同索引幂等，重复 wait_start 覆盖
      const snapSource = body.source === "auto_wait_start" ? "auto_wait_start" : "manual";
      if (snapSource === "auto_wait_start") {
        await pool.query(
          `INSERT INTO wait_snapshots (session_id, value_kind, value, source, station_code)
           VALUES ($1, 'minutes', $2, 'auto_wait_start', $3)
           ON CONFLICT (session_id, source, station_code)
             WHERE source IN ('auto_depart', 'auto_wait_start')
           DO UPDATE SET value = EXCLUDED.value, recorded_at = now()`,
          [sessionId, body.value, body.station_code ?? null],
        );
      } else {
        await pool.query(
          `INSERT INTO wait_snapshots (session_id, value_kind, value, source, station_code)
           VALUES ($1, 'minutes', $2, 'manual', $3)
           ON CONFLICT (session_id, station_code)
             WHERE source = 'manual' AND value_kind = 'minutes' AND station_code IS NOT NULL
           DO UPDATE SET value = EXCLUDED.value, recorded_at = now()`,
          [sessionId, body.value, body.station_code ?? null],
        );
      }
      return NextResponse.json({ ok: true });
    }

    if (!body.type || !VALID_EVENTS.includes(body.type as EventType)) {
      return NextResponse.json({ error: `无效事件类型：${body.type}` }, { status: 400 });
    }
    const type = body.type as EventType;

    // v0.10.0 幂等：同 (session_id, tap_id) 已记录 → 直接返回（不双写；missed 不重复 +1）。
    // 查重 + 唯一索引兜底（并发同 id 时靠 uq_events_session_tap 抛 23505 转 dedup）。
    if (body.tap_id) {
      const dup = await pool.query(
        `SELECT id FROM timer_events WHERE session_id = $1 AND tap_id = $2`,
        [sessionId, body.tap_id],
      );
      if ((dup.rowCount ?? 0) > 0) {
        // 幂等命中：回传已入库事件 id（客户端把乐观负 id 换成真实 id，撤销标签可用）
        const existing = dup.rows[0] as { id: number };
        return NextResponse.json({ ok: true, dedup: true, finished: false, event_id: existing.id });
      }
    }

    // 事件序号 = 当前最大 seq + 1
    const seqRes = await pool.query(
      `SELECT coalesce(max(seq), 0) + 1 AS next FROM timer_events WHERE session_id = $1`,
      [sessionId],
    );
    const seq = (seqRes.rows[0] as { next: number }).next;

    try {
      const ins = await pool.query<{ id: number }>(
        `INSERT INTO timer_events (session_id, seq, event_type, station_code, tap_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [sessionId, seq, type, body.station_code ?? null, body.tap_id ?? null],
      );
      // 真实事件 id 回传 → 前端把乐观负 id 替换为库内 id（撤销依赖真实 id）
      eventId = ins.rows[0]?.id ?? null;
    } catch (err) {
      // 并发同 tap_id 撞唯一索引 → 视为幂等成功
      if ((err as { code?: string }).code === "23505" && body.tap_id) {
        return NextResponse.json({ ok: true, dedup: true, finished: false });
      }
      throw err;
    }

    // 学校分区随打点落到会话（B/C | N/O | R），仅合法值写入
    if (body.from_zone && ZONES.includes(body.from_zone)) {
      await pool.query(`UPDATE timer_sessions SET from_zone = $1 WHERE id = $2`, [
        body.from_zone,
        sessionId,
      ]);
    }
    if (body.to_zone && ZONES.includes(body.to_zone)) {
      await pool.query(`UPDATE timer_sessions SET to_zone = $1 WHERE id = $2`, [
        body.to_zone,
        sessionId,
      ]);
    }

    if (type === "missed") {
      await pool.query(
        `UPDATE timer_sessions SET missed_count = missed_count + 1 WHERE id = $1`,
        [sessionId],
      );
    }

    // v0.10.0 A11：board 事件附 route（多候选线路实际乘的非首选项）且该站属「首个载具段」时，
    // 修正会话主线路与方向到实乘线——只认首个载具段（route_code 语义 = 首段实乘线）。
    if (type === "board" && body.route) {
      const legRes = await pool.query(
        `SELECT from_station, to_station, route_options, route_meta FROM plan_legs
         WHERE plan_id = $1 AND leg_kind IN ('bus', 'lrt')
         ORDER BY seq LIMIT 1`,
        [session.plan_id],
      );
      const firstLeg = legRes.rows[0] as
        | {
            from_station: string | null;
            to_station: string | null;
            route_options: string | null;
            route_meta: Record<string, { to?: string; board?: string[] }> | string | null;
          }
        | undefined;
      // v0.17.0：合并卡各线路上车台不同（51A 在 C690/1、51B 在 C690/2）——
      // 同站判定放宽到「段默认站 或 该线路自己的 board 列表」
      const rawMeta = firstLeg?.route_meta ?? null;
      const meta: Record<string, { to?: string; board?: string[] }> | null =
        typeof rawMeta === "string"
          ? (JSON.parse(rawMeta) as Record<string, { to?: string; board?: string[] }>)
          : rawMeta;
      const routeMeta = meta?.[body.route] ?? null;
      const boardOk =
        !!firstLeg &&
        (sameStation(body.station_code, firstLeg.from_station) ||
          (routeMeta?.board ?? []).some((b) => sameStation(body.station_code, b)));
      if (boardOk) {
        const opts = firstLeg!.route_options
          ? ((JSON.parse(firstLeg!.route_options) as string[]) ?? [])
          : [];
        if (opts.includes(body.route)) {
          // v0.17.0：方向按「该线路自己的终点 + 实际登车站」推导
          // （59→M9/2 与 25→M1/13 终点不同；51A 实际在 C690/1 上车而非卡默认 C690/3）
          const toStation = routeMeta?.to ?? firstLeg!.to_station;
          const fromStation = body.station_code ?? firstLeg!.from_station;
          // 实乘线有方向推导条件时重算 dir（循环线/无站序 → 保持原值）
          const dir =
            fromStation && toStation
              ? await deriveRouteDir(body.route, fromStation, toStation, session.dsat_dir ?? "0")
              : session.dsat_dir;
          await pool.query(
            `UPDATE timer_sessions SET route_code = $1, dsat_dir = $2 WHERE id = $3`,
            [body.route, dir ?? null, sessionId],
          );
        }
      }
    }

    if (type === "border_end") {
      // v0.16.1：方案以 cross_border 结尾（去程口岸卡，border 即最后一步）→ 通关完成即结束行程并结算
      // （主人 2026-09-07 实测口径：通关完即结束，无「到达」收尾步；回程口岸卡 border 在中段不收尾）
      const lastLeg = await pool.query(
        `SELECT leg_kind FROM plan_legs WHERE plan_id = $1 ORDER BY seq DESC LIMIT 1`,
        [session.plan_id],
      );
      const lastKind = (lastLeg.rows[0] as { leg_kind?: string } | undefined)?.leg_kind;
      if (lastKind === "cross_border") {
        await settleSession(sessionId, pool);
        return NextResponse.json({ ok: true, finished: true, event_id: eventId });
      }
    }

    if (type === "arrive") {
      // 收尾：总时长（v0.10.0 起从 depart 事件起算——建卡后挂后台不再虚高；无 depart 回退 started_at）
      // + 时段分桶（GMT+8，语义统一延至分析阶段，仍按到达时刻）
      // v0.12.0：总时长再扣除「暂停闭合区间」（pause→resume 成对出现的秒数），
      // 步行中途买东西/停留等暂停时间不计入总时长
      // v0.13.0：总时长同样扣除「通关闭合区间」（border_start→border_end 成对秒数），
      // 通关耗时独立写入 border_minutes（展示为「行程 xx + 通关 xx」），不计入行程时间
      await settleSession(sessionId, pool);
      return NextResponse.json({ ok: true, finished: true, event_id: eventId });
    }

    return NextResponse.json({ ok: true, finished: false, event_id: eventId });
  } catch (err) {
    console.error("[events] 写入失败：", (err as Error).message);
    return NextResponse.json({ error: "事件写入失败" }, { status: 500 });
  }
}
