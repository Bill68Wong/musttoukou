/**
 * 站间时长统计重算（共享层，v0.25.0）
 *
 * 从 CLI 脚本 scripts/rebuild-segment-stats.ts 抽取的核心逻辑，做成接受 pool 的纯函数，
 * 供两处复用：
 *   · CLI：npm run db:segments -- local|cloud（本地 / 手动）
 *   · API：GET /api/cron/rebuild（Vercel Cron 每日自动）
 * 抽取原因：Serverless 函数只打包被 import 的模块，无法 execFile 调 .ts 脚本。
 *
 * ── 端点口径（v0.22.0）────────────────────────────────────────────
 * 能当「站点时刻端点」并以真实时刻参与时长计算的：
 *   · station_arrive / stop_arrive —— 停靠，有时刻
 *   · station_pass  / stop_pass   —— 甩站没停，乘客点按钮时车正经过站台，时刻真实
 *   · board                        —— 上车时刻（= 上车站发车时刻）
 *   · alight                       —— 下车时刻（= 下车站到达时刻）
 * 不能当端点：
 *   · station_skip / stop_skip    —— 「忘记打卡」补点，无真实到站时刻，
 *                                    仅用于 UI 推进进度，永不进入时长样本
 *     （排除后其前后两点自然被判为「跨站」，即不会产出错误段）
 *
 * ── 分档（arrive_kind）───────────────────────────────────────────
 * 段时长 = t(下一站) − t(上一站)，差里只含**起点站**的停站时间：
 *   stop —— 起点是停靠 → 含停站 → 乘客感知的实际到站间隔（ETA 主用）
 *   pass —— 起点是甩站 → 近乎纯行驶 → 用于反推停站耗时
 *   all  —— 合并兜底
 * （board 作为起点归 stop 档：上客本身即停站。）
 *
 * ── 分层 ───────────────────────────────────────────────────────
 * weekday 0-6 + time_bucket am_peak|day|pm_peak|night（澳门时间）
 * 另写 weekday=-1 / time_bucket='all' 的兜底行（该 (route, from, to, kind) 全量样本）。
 */
import type { Pool } from "pg";

const mainCode = (code: string) => /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;
const r1 = (n: number) => Math.round(n * 10) / 10;

function bucketOf(h: number): string {
  if (h >= 7 && h < 10) return "am_peak";
  if (h >= 10 && h < 17) return "day";
  if (h >= 17 && h < 20) return "pm_peak";
  return "night";
}
const macauParts = (t: Date) => {
  const m = new Date(t.getTime() + 8 * 3600e3);
  return { weekday: m.getUTCDay(), hour: m.getUTCHours() };
};

/** 归一化后的站点事件类型 */
type Kind = "arrive" | "pass" | "skip" | "board" | "alight" | "pre";
const NORM: Record<string, Kind> = {
  station_arrive: "arrive",
  station_pass: "pass",
  station_skip: "skip",
  stop_arrive: "arrive",
  stop_pass: "pass",
  stop_skip: "skip",
  board: "board",
  alight: "alight",
  depart: "pre",
  wait_start: "pre",
};
/** 可作站间段端点（有真实时刻）*/
const ENDPOINT = new Set<Kind>(["arrive", "pass", "board", "alight"]);
/** 起点站的停站类型 → arrive_kind 档位 */
const kindOfStart = (k: Kind) => (k === "pass" ? "pass" : "stop");

interface Pt {
  code: string;
  t: Date;
  kind: Kind;
}
export interface SegmentSample {
  route: string;
  from: string;
  to: string;
  weekday: number;
  bucket: string;
  arriveKind: "stop" | "pass";
  minutes: number;
  source: "timer" | "free";
}

export interface SegmentPairStat {
  /** route|from|to */
  key: string;
  stop: number[];
  pass: number[];
}

export interface SegmentRebuildResult {
  /** 源会话 / 行程数 */
  sessions: number;
  rides: number;
  /** 提取到的段样本总数 */
  samples: number;
  bySource: { timer: number; free: number };
  byKind: { stop: number; pass: number };
  /** 丢弃统计 */
  stats: {
    head: number;
    tail: number;
    redirect: number;
    sameStation: number;
    zeroGap: number;
    unmatched: number;
    cross: number;
    reverse: number;
  };
  /** 写入行数（dry 时为 0） */
  written: number;
  /** 分层行数（不含兜底） */
  layered: number;
  /** 按线路样本数 */
  routeCount: [string, number][];
  /** 可反推停站耗时的区间 */
  pairs: SegmentPairStat[];
  /** 有 ≥2 次样本的区间（按样本数降序，已排序） */
  rep: SegmentPairStat[];
  inserted: number;
}

export async function rebuildSegmentStats(
  pool: Pool,
  opts: { dry?: boolean } = {},
): Promise<SegmentRebuildResult> {
  const dry = !!opts.dry;
  const q = async (sql: string, args?: unknown[]) =>
    (await pool.query(sql, args)).rows as Record<string, unknown>[];

  // ================= ① 站序索引 =================
  const routeRows = await q(
    `SELECT r.code AS route, rs.dsat_dir, rs.seq, rs.station_code
       FROM route_stations rs JOIN routes r ON r.id = rs.route_id
      ORDER BY r.code, rs.dsat_dir, rs.seq`,
  );
  const seqIdx = new Map<string, Map<string, number[]>>();
  for (const r of routeRows) {
    const key = `${r.route}|${r.dsat_dir}`;
    if (!seqIdx.has(key)) seqIdx.set(key, new Map());
    const m = seqIdx.get(key)!;
    const code = r.station_code as string;
    if (!m.has(code)) m.set(code, []);
    m.get(code)!.push(r.seq as number);
  }
  const seqsOf = (m: Map<string, number[]>, code: string): number[] => {
    const exact = m.get(code);
    if (exact?.length) return [...exact].sort((a, b) => a - b);
    const p = mainCode(code);
    const out: number[] = [];
    for (const [k, v] of m) if (k === p || mainCode(k) === p) out.push(...v);
    return [...new Set(out)].sort((a, b) => a - b);
  };

  // ================= ② 读两套源事件 =================
  const sessions = await q(
    `SELECT id, route_code, dsat_dir, weekday, time_bucket, started_at
       FROM timer_sessions
      WHERE deleted_at IS NULL AND NOT COALESCE(is_test, false) AND route_code IS NOT NULL
      ORDER BY id`,
  );
  const timerEv = sessions.length
    ? await q(
        `SELECT session_id AS rid, event_type, station_code, recorded_at
           FROM timer_events
          WHERE session_id = ANY($1::int[]) AND station_code IS NOT NULL
          ORDER BY session_id, recorded_at, seq`,
        [sessions.map((s) => s.id as number)],
      )
    : [];
  const freeRides = await q(
    `SELECT id, route_code, dsat_dir, started_at
       FROM free_rides
      WHERE deleted_at IS NULL AND NOT COALESCE(is_test, false) AND route_code IS NOT NULL
      ORDER BY id`,
  );
  const freeEv = freeRides.length
    ? await q(
        `SELECT free_ride_id AS rid, event_type, station_code, recorded_at
           FROM free_ride_events
          WHERE free_ride_id = ANY($1::int[]) AND station_code IS NOT NULL
          ORDER BY free_ride_id, seq, recorded_at`,
        [freeRides.map((r) => r.id as number)],
      )
    : [];

  // ================= ③ 会话/行程 → 站点时间线 =================
  const rank = (k: Kind) =>
    k === "board" || k === "alight" ? 3 : k === "arrive" || k === "pass" || k === "skip" ? 2 : 1;

  /** 把原始事件折成「同一站码连续事件合并」的站点时间线 */
  function toPoints(rows: Record<string, unknown>[]): Pt[] {
    const pts: Pt[] = [];
    for (const e of rows) {
      const kind = NORM[e.event_type as string];
      if (!kind) continue;
      const code = e.station_code as string;
      const t = new Date(e.recorded_at as string);
      const last = pts[pts.length - 1];
      if (last && last.code === code) {
        if (rank(kind) > rank(last.kind)) {
          last.t = t;
          last.kind = kind;
        }
        continue;
      }
      pts.push({ code, t, kind });
    }
    return pts;
  }

  /** 以某条站序提取段样本 */
  function extract(
    route: string,
    pts: Pt[],
    m: Map<string, number[]>,
    weekday: number,
    bucket: string,
    source: "timer" | "free",
  ): { samples: SegmentSample[]; st: Record<string, number> } {
    const samples: SegmentSample[] = [];
    const st = { ok: 0, head: 0, tail: 0, sameStation: 0, zeroGap: 0, unmatched: 0, cross: 0, reverse: 0 };
    // skip 不参与，直接过滤（其前后点会变成跨站，从而被丢弃）
    const seq = pts.filter((p) => p.kind !== "skip");
    let lastSeq = -1;
    for (let i = 0; i + 1 < seq.length; i++) {
      const a = seq[i];
      const b = seq[i + 1];
      if (!ENDPOINT.has(a.kind) || !ENDPOINT.has(b.kind)) continue;
      if (mainCode(a.code) === mainCode(b.code)) {
        st.sameStation++;
        continue; // 同站不同台 = 换乘/站内停留
      }
      const minutes = (b.t.getTime() - a.t.getTime()) / 60000;
      if (minutes <= 0.05) {
        st.zeroGap++;
        continue;
      }
      const sa = seqsOf(m, a.code);
      const sb = seqsOf(m, b.code);
      if (!sa.length || !sb.length) {
        st.unmatched++;
        continue;
      }
      let best: { x: number; y: number } | null = null;
      for (const x of sa) {
        if (x < lastSeq) continue;
        for (const y of sb) {
          if (y <= x) continue;
          if (!best || y - x < best.y - best.x) best = { x, y };
        }
      }
      if (!best) {
        if (Math.min(...sb) < Math.min(...sa)) st.reverse++;
        else st.cross++;
        continue;
      }
      lastSeq = best.x;
      if (best.y - best.x !== 1) {
        st.cross++;
        continue;
      }
      st.ok++;
      if (a.kind === "board") st.head++;
      if (b.kind === "alight") st.tail++;
      samples.push({
        route,
        from: a.code,
        to: b.code,
        weekday,
        bucket,
        arriveKind: kindOfStart(a.kind),
        minutes: r1(minutes),
        source,
      });
    }
    return { samples, st };
  }

  const samples: SegmentSample[] = [];
  const stats = {
    head: 0, tail: 0, redirect: 0,
    sameStation: 0, zeroGap: 0, unmatched: 0, cross: 0, reverse: 0,
  };

  /** 对一个行程跑两个方向，取顺向解更多的那个 */
  function runOne(
    route: string,
    pts: Pt[],
    dsatDir: string | null,
    weekday: number,
    bucket: string,
    source: "timer" | "free",
  ) {
    if (pts.length < 2) return;
    const d0 = dsatDir ?? "0";
    let bestRun: { samples: SegmentSample[]; st: Record<string, number> } | null = null;
    let usedDir = d0;
    for (const d of [d0, d0 === "0" ? "1" : "0"]) {
      const m = seqIdx.get(`${route}|${d}`);
      if (!m) continue;
      const run = extract(route, pts, m, weekday, bucket, source);
      if (!bestRun || run.st.ok > bestRun.st.ok) {
        bestRun = run;
        usedDir = d;
      }
    }
    if (!bestRun) return;
    if (usedDir !== d0) stats.redirect++;
    samples.push(...bestRun.samples);
    for (const k of ["head", "tail", "sameStation", "zeroGap", "unmatched", "cross", "reverse"] as const)
      stats[k] += bestRun.st[k] ?? 0;
  }

  const byTimer = new Map<number, Record<string, unknown>[]>();
  for (const e of timerEv) {
    const rid = e.rid as number;
    if (!byTimer.has(rid)) byTimer.set(rid, []);
    byTimer.get(rid)!.push(e);
  }
  let sessionCount = 0;
  for (const s of sessions) {
    const rows = byTimer.get(s.id as number) ?? [];
    if (rows.length < 2) continue;
    sessionCount++;
    const pts = toPoints(rows);
    const base: Date = pts[0]?.t ?? new Date(s.started_at as string);
    const mp = macauParts(base);
    runOne(
      s.route_code as string,
      pts,
      (s.dsat_dir as string | null) ?? null,
      (s.weekday as number | null) ?? mp.weekday,
      (s.time_bucket as string | null) ?? bucketOf(mp.hour),
      "timer",
    );
  }

  const byFree = new Map<number, Record<string, unknown>[]>();
  for (const e of freeEv) {
    const rid = e.rid as number;
    if (!byFree.has(rid)) byFree.set(rid, []);
    byFree.get(rid)!.push(e);
  }
  let rideCount = 0;
  for (const r of freeRides) {
    const rows = byFree.get(r.id as number) ?? [];
    if (rows.length < 2) continue;
    rideCount++;
    const pts = toPoints(rows);
    const base: Date = pts[0]?.t ?? new Date(r.started_at as string);
    const mp = macauParts(base);
    runOne(
      r.route_code as string,
      pts,
      (r.dsat_dir as string | null) ?? null,
      mp.weekday,
      bucketOf(mp.hour),
      "free",
    );
  }

  // ================= ④ 聚合 =================
  const keys = new Map<string, number[]>(); // route|from|to|weekday|bucket|kind -> minutes[]
  const push = (route: string, from: string, to: string, w: number, b: string, k: string, min: number) => {
    const key = `${route}|${from}|${to}|${w}|${b}|${k}`;
    if (!keys.has(key)) keys.set(key, []);
    keys.get(key)!.push(min);
  };
  for (const s of samples) {
    push(s.route, s.from, s.to, s.weekday, s.bucket, s.arriveKind, s.minutes); // 分层 + 档位
    push(s.route, s.from, s.to, -1, "all", s.arriveKind, s.minutes); // 兜底 + 档位
    push(s.route, s.from, s.to, -1, "all", "all", s.minutes); // 兜底 + 合并
  }

  const p50 = (v: number[]) => {
    const a = [...v].sort((x, y) => x - y);
    const n = a.length;
    return n % 2 ? a[(n - 1) / 2] : r1((a[n / 2 - 1] + a[n / 2]) / 2);
  };
  const avg = (v: number[]) => r1(v.reduce((x, y) => x + y, 0) / v.length);

  const rows: (string | number)[][] = [];
  for (const [key, v] of keys) {
    const [route, from, to, w, b, k] = key.split("|");
    rows.push([route, from, to, Number(w), b, k, avg(v), p50(v), v.length]);
  }

  // ================= ⑤ 写入 =================
  let inserted = 0;
  if (dry) {
    // 跳过写入
  } else {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM segment_stats");
      // 🚨 必须批量写：逐行 INSERT 会让「行数 × 单次跨区域往返」累积成总耗时。
      // Vercel 函数默认在 iad1（美东）、Supabase 在 ap-southeast-1（新加坡），
      // 单次往返约 230ms → 354 行 ≈ 80s，直接超过 maxDuration=60s 被掐断
      // （症状：ECONNRESET + 互斥锁卡死）。UNNEST 把全部行压成一次往返。
      if (rows.length) {
        await client.query(
          `INSERT INTO segment_stats
             (route_code, from_station, to_station, weekday, time_bucket, arrive_kind,
              avg_minutes, p50_minutes, samples, updated_at)
           SELECT r, f, t, w, b, k, a, p, s, now()
             FROM UNNEST($1::text[], $2::text[], $3::text[], $4::smallint[], $5::text[],
                         $6::text[], $7::numeric[], $8::numeric[], $9::int[])
                  AS x(r, f, t, w, b, k, a, p, s)`,
          [
            rows.map((r) => r[0]),
            rows.map((r) => r[1]),
            rows.map((r) => r[2]),
            rows.map((r) => r[3]),
            rows.map((r) => r[4]),
            rows.map((r) => r[5]),
            rows.map((r) => r[6]),
            rows.map((r) => r[7]),
            rows.map((r) => r[8]),
          ],
        );
      }
      await client.query("COMMIT");
      inserted = rows.length;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // ================= ⑥ 汇总（返回结构化结果，打印交给调用方） =================
  const bySource = { timer: 0, free: 0 };
  for (const s of samples) bySource[s.source]++;
  const byKind = { stop: 0, pass: 0 };
  for (const s of samples) byKind[s.arriveKind]++;

  const routeCountMap = new Map<string, number>();
  for (const s of samples) routeCountMap.set(s.route, (routeCountMap.get(s.route) ?? 0) + 1);

  const cmp = new Map<string, { stop: number[]; pass: number[] }>();
  for (const s of samples) {
    const k = `${s.route}|${s.from}|${s.to}`;
    let bucket = cmp.get(k);
    if (!bucket) {
      bucket = { stop: [], pass: [] };
      cmp.set(k, bucket);
    }
    bucket[s.arriveKind].push(s.minutes);
  }
  const pairs: SegmentPairStat[] = [...cmp.entries()]
    .filter(([, v]) => v.stop.length && v.pass.length)
    .map(([key, v]) => ({ key, stop: v.stop, pass: v.pass }));
  const rep: SegmentPairStat[] = [...cmp.entries()]
    .filter(([, v]) => v.stop.length + v.pass.length >= 2)
    .sort((a, b) => b[1].stop.length + b[1].pass.length - (a[1].stop.length + a[1].pass.length))
    .map(([key, v]) => ({ key, stop: v.stop, pass: v.pass }));

  const fallback = [...keys.keys()].filter((k) => k.includes("|-1|all|")).length;

  return {
    sessions: sessionCount,
    rides: rideCount,
    samples: samples.length,
    bySource,
    byKind,
    stats,
    written: rows.length,
    layered: rows.length - fallback,
    routeCount: [...routeCountMap.entries()],
    pairs,
    rep,
    inserted,
  };
}

/** 求均值（供 CLI 报告复用） */
export const segAvg = (v: number[]) => r1(v.reduce((x, y) => x + y, 0) / v.length);
