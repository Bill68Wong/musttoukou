/**
 * 地点↔站点步行时长重建（scripts/rebuild-walk-times.ts）
 * 用法：npm run db:walktimes -- [local|cloud] [--dry]
 *
 * 从计时数据（timer_sessions + timer_events + plan_legs）全量重算各地点的
 * 「步行到站 / 下车步行」耗时，写入 walk_times。**可重复运行**（派生表，
 * 每次清空后重算），随着样本累积数值会自动收敛 —— 符合「数据越多越准」的口径。
 *
 * ── 步行口径（v0.24.0）────────────────────────────────────────────
 * 事件表没有独立的「步行」事件类型，步行耗时只能由相邻事件相减反推：
 *
 *   ① 起点步行（place = 行程起点）
 *       = wait_start(首站) − depart(起点)
 *       首站由 plan_legs 首个 walk 段的 to_station 决定（不盲取首个 wait_start，
 *       避免把换乘站误当起点站）。
 *
 *   ② 到校/到点步行（place = 行程终点）
 *       = arrive(终点) − alight(末站)
 *       末站由 plan_legs 最后一个 walk 段的 from_station 决定。
 *       ⚠️ 必须取「末次 alight」——换乘方案中途的 alight（如 LRT-UH）是换乘下车，
 *          把它当末站会得到「换乘+再乘车+出站」的整段时长（实测可达 21 分钟）。
 *
 * 两者均为**合并量**（含掏手机、找站台等操作延迟），用于加总预测总时长，不做拆分。
 *
 * ── 清洗 ────────────────────────────────────────────────────────
 *   · 扣除区间内的暂停时长（pause → resume 成对）
 *   · 保留 0.3 ~ 20.0 分钟；区间外视为连点误触或中途他事，剔除
 *   · 只有一个样本的值同样写入，由 samples 列体现可信度
 *
 * ── zone ────────────────────────────────────────────────────────
 *   仅澳科大（places.slug = 'school'）填 from_zone / to_zone（'B/C'|'N/O'|'R'）；
 *   其余地点（家、口岸）为 NULL —— 它们没有校区概念。
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const dry = process.argv.includes("--dry");
const target = (process.argv[2] ?? "local") as "local" | "cloud";
const dbUrl = target === "cloud" ? process.env.DATABASE_URL : process.env.DATABASE_URL_LOCAL;
if (!dbUrl) throw new Error(`未找到 ${target === "cloud" ? "DATABASE_URL" : "DATABASE_URL_LOCAL"}`);
const u = new URL(dbUrl);
const pool = new Pool({
  host: u.hostname,
  port: Number(u.port || 5432),
  database: u.pathname.slice(1),
  user: u.username,
  password: decodeURIComponent(u.password || ""),
  ...(target === "cloud" ? { ssl: { rejectUnauthorized: false } } : {}),
});
const q = async (sql: string, args?: unknown[]) =>
  (await pool.query(sql, args)).rows as Record<string, unknown>[];

/** 有效区间：0.3 ~ 20 分钟 */
const MIN_MIN = 0.3;
const MAX_MIN = 20.0;
const r1 = (n: number) => Math.round(n * 10) / 10;

interface Sample {
  placeId: number;
  station: string;
  zone: string | null;
  minutes: number;
  date: string; // YYYY-MM-DD（澳门时间）
  sid: number;
  kind: "start" | "end";
  excluded?: string; // 非空 = 被剔除的原因（--dry 时展示）
}

/**
 * 取会话内「某事件 → 另一事件」的真实间隔（分钟），扣除区间内 pause→resume。
 * fromSeq / toSeq 限定事件序号区间，避免换乘会话取错点。
 */
async function gapMinutes(
  sid: number,
  fromType: string,
  toType: string,
): Promise<{ minutes: number; pausedMin: number; fromAt: Date; toAt: Date; station: string | null } | null> {
  const rows = await q(
    `SELECT seq, event_type, station_code, recorded_at
       FROM timer_events WHERE session_id = $1 ORDER BY seq`,
    [sid],
  );
  if (!rows.length) return null;

  // 起点侧：第一个 fromType → 其后第一个 toType
  // 到点侧：最后一个 toType → 其前最后一个 fromType
  let i = -1;
  let j = -1;
  if (fromType === "depart") {
    i = rows.findIndex((r) => r.event_type === "depart");
    if (i < 0) return null;
    j = rows.findIndex((r, k) => k > i && r.event_type === toType);
  } else {
    // fromType = 'alight' → 取末次 alight 与末次 arrive
    for (let k = rows.length - 1; k >= 0; k--) {
      if (j < 0 && rows[k].event_type === toType && (toType !== "alight" || j < 0)) {
        if (rows[k].event_type === toType) j = k;
      }
      if (i < 0 && rows[k].event_type === fromType) i = k;
      if (i >= 0 && j >= 0) break;
    }
  }
  if (i < 0 || j < 0 || j <= i) return null;

  const t0 = new Date(rows[i].recorded_at as string);
  const t1 = new Date(rows[j].recorded_at as string);
  const raw = (t1.getTime() - t0.getTime()) / 60000;

  // 扣除区间内 pause → resume
  let paused = 0;
  let pStart: Date | null = null;
  for (let k = i; k <= j; k++) {
    const t = rows[k].event_type;
    if (t === "pause" && !pStart) pStart = new Date(rows[k].recorded_at as string);
    else if (t === "resume" && pStart) {
      paused += (new Date(rows[k].recorded_at as string).getTime() - pStart.getTime()) / 60000;
      pStart = null;
    }
  }
  // 区间结尾仍处于暂停态 → 计到区间末
  if (pStart) paused += (t1.getTime() - pStart.getTime()) / 60000;

  return {
    minutes: raw - paused,
    pausedMin: paused,
    fromAt: t0,
    toAt: t1,
    station: (fromType === "depart" ? rows[j].station_code : rows[i].station_code) as string | null,
  };
}

const macauDate = (t: Date) =>
  new Date(t.getTime() + 8 * 3600e3).toISOString().slice(0, 10);

async function main() {
  console.log(`=== 步行时长重建（${target}${dry ? " · DRY RUN" : ""}）`);

  const places = await q(`SELECT id, slug FROM places`);
  const placeIdOf = new Map<string, number>();
  for (const p of places) placeIdOf.set(p.slug as string, p.id as number);
  const schoolId = placeIdOf.get("school")!;

  // —— 起点步行：行程「最开头」的 walk 段（seq 最小者，且其前无载具段）——
  //     到点步行：行程「最末尾」的 walk 段（seq 最大者，且其后无载具段）
  //     ⚠️ 只有一段 walk 的行程（如 school-home-1：walk→bus→walk 有两段；
  //        但 home-school-9：walk→lrt→transfer→lrt→walk 也是两段）
  //        必须用 seq 的首/末位置判定，不能简单取 min/max —— 单段 walk 的行程
  //        （理论上存在）应视为「起点步行」，因其位于行程开头。
  const walkLegs = await q(`
    SELECT p.id plan_id, p.from_place, p.to_place,
           l.seq, l.leg_kind, l.from_station, l.to_station,
           (SELECT min(l2.seq) FROM plan_legs l2 WHERE l2.plan_id = p.id) AS min_seq,
           (SELECT max(l2.seq) FROM plan_legs l2 WHERE l2.plan_id = p.id) AS max_seq
      FROM commute_plans p
      JOIN plan_legs l ON l.plan_id = p.id AND l.leg_kind = 'walk'
     ORDER BY p.id, l.seq
  `);
  const startByPlan = new Map<number, { place: number; station: string }>();
  const endByPlan = new Map<number, { place: number; station: string }>();
  for (const r of walkLegs) {
    const planId = r.plan_id as number;
    const seq = r.seq as number;
    const minSeq = r.min_seq as number;
    const maxSeq = r.max_seq as number;
    if (seq === minSeq) {
      // 行程开头的 walk → 起点步行（走到第一程上车站）
      if (r.to_station)
        startByPlan.set(planId, { place: r.from_place as number, station: r.to_station as string });
    } else if (seq === maxSeq) {
      // 行程末尾的 walk → 到点步行（下车后走到目的地）
      if (r.from_station)
        endByPlan.set(planId, { place: r.to_place as number, station: r.from_station as string });
    }
  }

  const sessions = await q(`
    SELECT s.id, s.plan_id, s.from_zone, s.to_zone, s.started_at, s.ended_at
      FROM timer_sessions s
     WHERE s.deleted_at IS NULL
       AND NOT COALESCE(s.is_test, false)
       AND s.plan_id IS NOT NULL
     ORDER BY s.id
  `);
  console.log(`扫描会话：${sessions.length} 条`);

  const samples: Sample[] = [];

  for (const s of sessions) {
    const sid = s.id as number;
    const planId = s.plan_id as number;

    // ① 起点步行
    const sp = startByPlan.get(planId);
    if (sp) {
      const g = await gapMinutes(sid, "depart", "wait_start");
      if (g && g.station && g.station === sp.station) {
        const zone = sp.place === schoolId ? ((s.from_zone as string) ?? null) : null;
        const ok = g.minutes >= MIN_MIN && g.minutes <= MAX_MIN;
        samples.push({
          placeId: sp.place,
          station: g.station,
          zone,
          minutes: ok ? g.minutes : NaN,
          date: macauDate(g.fromAt),
          sid,
          kind: "start",
          excluded: ok ? undefined : `间隔 ${g.minutes.toFixed(2)} 分（越界）`,
        });
      }
    }

    // ② 到点步行
    const ep = endByPlan.get(planId);
    if (ep) {
      const g = await gapMinutes(sid, "alight", "arrive");
      if (g && g.station && g.station === ep.station) {
        const zone = ep.place === schoolId ? ((s.to_zone as string) ?? null) : null;
        const ok = g.minutes >= MIN_MIN && g.minutes <= MAX_MIN;
        samples.push({
          placeId: ep.place,
          station: g.station,
          zone,
          minutes: ok ? g.minutes : NaN,
          date: macauDate(g.fromAt),
          sid,
          kind: "end",
          excluded: ok ? undefined : `间隔 ${g.minutes.toFixed(2)} 分（越界）`,
        });
      }
    }
  }

  const valid = samples.filter((x) => !Number.isNaN(x.minutes));
  const dropped = samples.filter((x) => Number.isNaN(x.minutes));
  console.log(`\n采集到样本：${samples.length}（有效 ${valid.length} / 剔除 ${dropped.length}）`);
  for (const d of dropped) console.log(`   ✗ 剔除 s${d.sid} ${d.kind} ${d.station} —— ${d.excluded}`);

  // 聚合：键 = (placeId, station, zone)
  const agg = new Map<string, { s: Sample; vals: number[] }>();
  for (const x of valid) {
    const key = `${x.placeId}|${x.station}|${x.zone ?? ""}`;
    if (!agg.has(key)) agg.set(key, { s: x, vals: [] });
    agg.get(key)!.vals.push(x.minutes);
  }

  const rows: { placeId: number; station: string; zone: string | null; minutes: number; samples: number; date: string }[] = [];
  for (const { s, vals } of agg.values()) {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const latest = valid.filter((x) => x.placeId === s.placeId && x.station === s.station && x.zone === s.zone)
      .map((x) => x.date).sort().at(-1)!;
    rows.push({
      placeId: s.placeId,
      station: s.station,
      zone: s.zone,
      minutes: r1(avg),
      samples: vals.length,
      date: latest,
    });
  }
  rows.sort((a, b) => a.placeId - b.placeId || a.station.localeCompare(b.station) || (a.zone ?? "").localeCompare(b.zone ?? ""));

  console.log(`\n聚合结果（${rows.length} 行）：`);
  for (const r of rows)
    console.log(
      `   place=${r.placeId} ${r.station.padEnd(10)} zone=${(r.zone ?? "-").padEnd(4)} ${String(r.minutes).padStart(5)} 分  n=${r.samples}  ${r.date}`,
    );

  if (dry) {
    console.log("\n（--dry）未写库");
    await pool.end();
    return;
  }

  await pool.query(`DELETE FROM walk_times`);
  for (const r of rows) {
    await pool.query(
      `INSERT INTO walk_times (place_id, station_code, zone, minutes, samples, source, measured_at)
       VALUES ($1,$2,$3,$4,$5,'timer',$6)`,
      [r.placeId, r.station, r.zone, r.minutes, r.samples, r.date],
    );
  }
  const chk = await q(`SELECT count(*)::int n, sum(samples)::int total FROM walk_times`);
  console.log(`\n✅ 已写入 walk_times：${chk[0].n} 行 / 累计 ${chk[0].total} 个样本（${target}）`);
  await pool.end();
}

main().catch((e) => {
  console.error("重建失败：", e);
  process.exit(1);
});
