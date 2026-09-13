/**
 * 步行时长重算（共享层，v0.25.0）
 *
 * 从 CLI 脚本 scripts/rebuild-walk-times.ts 抽取的核心逻辑，做成接受 pool 的纯函数，
 * 供两处复用：
 *   · CLI：npm run db:walktimes -- local|cloud（本地 / 手动）
 *   · API：GET /api/cron/rebuild（Vercel Cron 每日自动）
 * 抽取原因：Serverless 函数只打包被 import 的模块，无法 execFile 调 .ts 脚本。
 *
 * 口径细节见 rebuildWalkTimes 上方注释（与 v0.24.0 定稿一致）。
 */
import type { Pool } from "pg";

/** 有效区间：0.3 ~ 20 分钟 */
const MIN_MIN = 0.3;
const MAX_MIN = 20.0;
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface WalkSample {
  placeId: number;
  station: string;
  zone: string | null;
  minutes: number;
  date: string;
  sid: number;
  kind: "start" | "end";
  excluded?: string;
}

export interface WalkRow {
  placeId: number;
  station: string;
  zone: string | null;
  minutes: number;
  samples: number;
  date: string;
}

export interface WalkRebuildResult {
  scanned: number;
  collected: number;
  valid: number;
  dropped: { sid: number; kind: string; station: string; reason: string }[];
  rows: WalkRow[];
  inserted: number;
  totalSamples: number;
}

const macauDate = (t: Date) => new Date(t.getTime() + 8 * 3600e3).toISOString().slice(0, 10);

interface EvRow {
  seq: number;
  event_type: string;
  station_code: string | null;
  recorded_at: string;
}

/**
 * 取会话内「某事件 → 另一事件」的真实间隔（分钟），扣除区间内 pause→resume。
 * 起点侧：第一个 depart → 其后第一个 wait_start
 * 到点侧：末次 alight ← 其前最后一个 arrive（用倒序扫描取末次，避免换乘中途的 alight 被误用）
 *
 * ⚠️ 纯函数、不查库：会话事件由调用方一次性取回后按 session_id 分组传入。
 * （v0.25.1：原实现是「每会话查一次 timer_events」→ 往返次数 = 会话数 × 2，
 *  跨区域 RTT ~200ms 时样本一多就会撞 maxDuration；改成一次取全量后只剩 1 次往返。）
 */
function gapMinutes(
  rows: EvRow[],
  fromType: string,
  toType: string,
): { minutes: number; station: string | null; fromAt: Date } | null {
  if (!rows.length) return null;

  let i = -1;
  let j = -1;
  if (fromType === "depart") {
    i = rows.findIndex((r) => r.event_type === "depart");
    if (i < 0) return null;
    j = rows.findIndex((r, k) => k > i && r.event_type === toType);
  } else {
    // 倒序：末次 toType（arrive）作为终点，其前最后一个 fromType（alight）作为起点
    for (let k = rows.length - 1; k >= 0; k--) {
      if (j < 0 && rows[k].event_type === toType) j = k;
      if (i < 0 && rows[k].event_type === fromType) i = k;
      if (i >= 0 && j >= 0) break;
    }
  }
  if (i < 0 || j < 0 || j <= i) return null;

  const t0 = new Date(rows[i].recorded_at);
  const t1 = new Date(rows[j].recorded_at);
  const raw = (t1.getTime() - t0.getTime()) / 60000;

  // 扣除区间内 pause → resume
  let paused = 0;
  let pStart: Date | null = null;
  for (let k = i; k <= j; k++) {
    const t = rows[k].event_type;
    if (t === "pause" && !pStart) pStart = new Date(rows[k].recorded_at);
    else if (t === "resume" && pStart) {
      paused += (new Date(rows[k].recorded_at).getTime() - pStart.getTime()) / 60000;
      pStart = null;
    }
  }
  if (pStart) paused += (t1.getTime() - pStart.getTime()) / 60000;

  return {
    minutes: raw - paused,
    station: (fromType === "depart" ? rows[j].station_code : rows[i].station_code) as string | null,
    fromAt: t0,
  };
}

/**
 * 全量重算 walk_times（清表后按实测样本重灌）。**幂等、可重复运行**。
 *
 * 口径（v0.24.0 定稿）：
 *   起点步行 = wait_start(首站) − depart(起点)
 *   到点步行 = arrive(终点) − alight(末站)
 *   站归属按 plan_legs 的 walk 段位置判定（首段 walk 的 to_station = 起点侧；
 *   末段 walk 的 from_station = 到点侧），不盲取首尾事件。
 *   区间内 pause→resume 扣除；保留 0.3~20 分钟；聚合存均值 + samples。
 */
export async function rebuildWalkTimes(pool: Pool, opts: { dry?: boolean } = {}): Promise<WalkRebuildResult> {
  const dry = !!opts.dry;

  const places = (await pool.query(`SELECT id, slug FROM places`)).rows as { id: number; slug: string }[];
  const placeIdOf = new Map<string, number>();
  for (const p of places) placeIdOf.set(p.slug, p.id);
  const schoolId = placeIdOf.get("school")!;

  // 各计划的 walk 段位置判定
  const walkLegs = (
    await pool.query(`
    SELECT p.id plan_id, p.from_place, p.to_place,
           l.seq, l.from_station, l.to_station,
           (SELECT min(l2.seq) FROM plan_legs l2 WHERE l2.plan_id = p.id) AS min_seq,
           (SELECT max(l2.seq) FROM plan_legs l2 WHERE l2.plan_id = p.id) AS max_seq
      FROM commute_plans p
      JOIN plan_legs l ON l.plan_id = p.id AND l.leg_kind = 'walk'
     ORDER BY p.id, l.seq
  `)
  ).rows as {
    plan_id: number;
    from_place: number;
    to_place: number;
    seq: number;
    from_station: string | null;
    to_station: string | null;
    min_seq: number;
    max_seq: number;
  }[];

  const startByPlan = new Map<number, { place: number; station: string }>();
  const endByPlan = new Map<number, { place: number; station: string }>();
  for (const r of walkLegs) {
    if (r.seq === r.min_seq) {
      if (r.to_station) startByPlan.set(r.plan_id, { place: r.from_place, station: r.to_station });
    } else if (r.seq === r.max_seq) {
      if (r.from_station) endByPlan.set(r.plan_id, { place: r.to_place, station: r.from_station });
    }
  }

  const sessions = (
    await pool.query(`
    SELECT s.id, s.plan_id, s.from_zone, s.to_zone
      FROM timer_sessions s
     WHERE s.deleted_at IS NULL
       AND NOT COALESCE(s.is_test, false)
       AND s.plan_id IS NOT NULL
     ORDER BY s.id
  `)
  ).rows as { id: number; plan_id: number; from_zone: string | null; to_zone: string | null }[];

  // 🚨 一次取回全部会话事件再按 session_id 分组（勿逐会话查库）：
  // 逐会话查 = 往返次数随样本线性增长，跨区域 RTT ~200ms 时迟早撞 maxDuration。
  const ids = sessions.map((s) => s.id);
  const evBySession = new Map<number, EvRow[]>();
  if (ids.length) {
    const evRows = (
      await pool.query(
        `SELECT session_id, seq, event_type, station_code, recorded_at
           FROM timer_events
          WHERE session_id = ANY($1::int[])
          ORDER BY session_id, seq`,
        [ids],
      )
    ).rows as (EvRow & { session_id: number })[];
    for (const r of evRows) {
      if (!evBySession.has(r.session_id)) evBySession.set(r.session_id, []);
      evBySession.get(r.session_id)!.push(r);
    }
  }

  const samples: WalkSample[] = [];
  for (const s of sessions) {
    const rows = evBySession.get(s.id) ?? [];
    const sp = startByPlan.get(s.plan_id);
    if (sp) {
      const g = gapMinutes(rows, "depart", "wait_start");
      if (g && g.station && g.station === sp.station) {
        const zone = sp.place === schoolId ? (s.from_zone ?? null) : null;
        const ok = g.minutes >= MIN_MIN && g.minutes <= MAX_MIN;
        samples.push({
          placeId: sp.place,
          station: g.station,
          zone,
          minutes: ok ? g.minutes : NaN,
          date: macauDate(g.fromAt),
          sid: s.id,
          kind: "start",
          excluded: ok ? undefined : `间隔 ${g.minutes.toFixed(2)} 分（越界）`,
        });
      }
    }
    const ep = endByPlan.get(s.plan_id);
    if (ep) {
      const g = gapMinutes(rows, "alight", "arrive");
      if (g && g.station && g.station === ep.station) {
        const zone = ep.place === schoolId ? (s.to_zone ?? null) : null;
        const ok = g.minutes >= MIN_MIN && g.minutes <= MAX_MIN;
        samples.push({
          placeId: ep.place,
          station: g.station,
          zone,
          minutes: ok ? g.minutes : NaN,
          date: macauDate(g.fromAt),
          sid: s.id,
          kind: "end",
          excluded: ok ? undefined : `间隔 ${g.minutes.toFixed(2)} 分（越界）`,
        });
      }
    }
  }

  const valid = samples.filter((x) => !Number.isNaN(x.minutes));
  const dropped = samples
    .filter((x) => Number.isNaN(x.minutes))
    .map((d) => ({ sid: d.sid, kind: d.kind, station: d.station, reason: d.excluded ?? "" }));

  // 聚合：键 = (placeId, station, zone)
  const agg = new Map<string, { s: WalkSample; vals: number[] }>();
  for (const x of valid) {
    const key = `${x.placeId}|${x.station}|${x.zone ?? ""}`;
    if (!agg.has(key)) agg.set(key, { s: x, vals: [] });
    agg.get(key)!.vals.push(x.minutes);
  }

  const rows: WalkRow[] = [];
  for (const { s, vals } of agg.values()) {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const latest = valid
      .filter((x) => x.placeId === s.placeId && x.station === s.station && x.zone === s.zone)
      .map((x) => x.date)
      .sort()
      .at(-1)!;
    rows.push({
      placeId: s.placeId,
      station: s.station,
      zone: s.zone,
      minutes: r1(avg),
      samples: vals.length,
      date: latest,
    });
  }
  rows.sort(
    (a, b) =>
      a.placeId - b.placeId ||
      a.station.localeCompare(b.station) ||
      (a.zone ?? "").localeCompare(b.zone ?? ""),
  );

  if (dry) {
    return {
      scanned: sessions.length,
      collected: samples.length,
      valid: valid.length,
      dropped,
      rows,
      inserted: 0,
      totalSamples: 0,
    };
  }

  // 事务 + UNNEST 批量写（同 segment-stats 的理由：逐行 INSERT 在跨区域
  // Vercel→Supabase 场景下会把「行数 × 往返延迟」累积成总耗时并撞 maxDuration）
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM walk_times`);
    if (rows.length) {
      await client.query(
        `INSERT INTO walk_times (place_id, station_code, zone, minutes, samples, source, measured_at)
         SELECT p, s, z, m, n, 'timer', d
           FROM UNNEST($1::int[], $2::text[], $3::text[], $4::numeric[], $5::int[], $6::date[])
                AS x(p, s, z, m, n, d)`,
        [
          rows.map((r) => r.placeId),
          rows.map((r) => r.station),
          rows.map((r) => r.zone),
          rows.map((r) => r.minutes),
          rows.map((r) => r.samples),
          rows.map((r) => r.date),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  const chk = (
    await pool.query(`SELECT count(*)::int n, COALESCE(sum(samples),0)::int total FROM walk_times`)
  ).rows[0] as { n: number; total: number };

  return {
    scanned: sessions.length,
    collected: samples.length,
    valid: valid.length,
    dropped,
    rows,
    inserted: chk.n,
    totalSamples: chk.total,
  };
}
