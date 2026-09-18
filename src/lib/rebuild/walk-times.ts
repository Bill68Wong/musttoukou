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
import { SPEED_RATIO, WALK_BASE_M_PER_MIN } from "@/lib/recommend/types";

// ═══════════════════════════════════════════════════════════════════════════
// 🚨 防「双重缩档」断言（v1.2.0 · 三层防线的第 1 层）
//
// 背景：读端 `src/lib/recommend/catch-up.ts#requiredSec` **已经**对步行分钟做了分档缩放：
//     requiredSec(min, tier) = OVERHEAD + (min*60 − OVERHEAD) × SPEED_RATIO[tier]
// 而本模块负责把「高德步行距离」折成 `walk_times.minutes`。
//
// 🚫 **落库只能存「常速基准分钟」**（= distance_m ÷ WALK_BASE_M_PER_MIN）。
//    若在这里也按「分档速度」算，读端会再乘一次 ⇒ **双重缩档** ✗
//
// 这条断言守住「基准速度」与「SPEED_RATIO 的归一基准」不脱钩：
//   `SPEED_RATIO[3] === 1` 意味着档 3（正常走）就是基准 ⇒ WALK_BASE_M_PER_MIN / 60
//   必须等于那个基准速度。一旦有人改了其中一个而忘了另一个，这里直接抛错。
//
// 三道防线（缺一层都会有人踩进去）：
//   ① 本断言（运行时，成本一行）
//   ② `src/lib/amap/**` 禁止 import `catch-up.ts` / `SPEED_RATIO`（见 client.ts 文件头）
//   ③ `walk_times.minutes` 的 COMMENT 写死禁令（见 db/migrate-v1200.ts）
// ═══════════════════════════════════════════════════════════════════════════
const WALK_BASE_MPS = WALK_BASE_M_PER_MIN / 60; // 应为 1.4 m/s
if (SPEED_RATIO[3] !== 1) {
  throw new Error(
    `[walk-times] SPEED_RATIO[3] 必须 === 1（它是「正常走」的归一基准），实际为 ${SPEED_RATIO[3]}。` +
      ` 若有意改动，请同步核对 WALK_BASE_M_PER_MIN 与 docs/步行速度五档-文献依据-20260918.md。`,
  );
}
if (Math.abs(WALK_BASE_MPS - 1.4) > 1e-9) {
  throw new Error(
    `[walk-times] WALK_BASE_M_PER_MIN 必须对应 1.4 m/s（= 84 米/分钟），实际 ${WALK_BASE_M_PER_MIN}` +
      `（${WALK_BASE_MPS.toFixed(3)} m/s）。` +
      ` 🚫 改它会全局影响所有卡片的步行分钟数；且必须与 SPEED_RATIO[3] 的基准口径一致。`,
  );
}

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
 *
 * 起点侧（side='start'）—— 由「出发」走到上车站：
 *   锚点 = 第一个 `depart`（常规方案的「出发」打点）；
 *   🚨 跨境**入境**侧（例如从橫琴口岸／關閘（拱北口岸）出发回擎天匯）会话里**没有 `depart`**，
 *   首段是 cross_border 腿 → 退回第一个 `border_end`（通关完成 = 已到口岸外，开始走向车站）。
 *   终点 = 锚点之后第一个 `wait_start`（到站、开始等车），站码取这一条。
 *
 * 到点侧（side='end'）—— 由下车站走到目的地：
 *   锚点 = 末次 `alight`（末次是必要的：换乘方案中途也有 alight）之后**最先出现**的到达性事件：
 *   `border_start`（跨境**出境**侧：走到口岸、开始通关）优先于 `arrive`（常规：步行到达目的地）。
 *   🚨 不能一律取 `arrive` —— 跨境方案的 arrive 若落在 border_end 之后，
 *   会把整段通关时间算进步行（实测 M1/13 關閘總站 12.9 分 → 修正为 2.8 分）；
 *   而有的跨境方案干脆**没有 arrive**（以 border_end 结算收尾）→ 旧逻辑找不到锚点，样本直接丢。
 *
 * ⚠️ 纯函数、不查库：会话事件由调用方一次性取回后按 session_id 分组传入。
 * （v0.25.1：原实现是「每会话查一次 timer_events」→ 往返次数 = 会话数 × 2，
 *  跨区域 RTT ~200ms 时样本一多就会撞 maxDuration；改成一次取全量后只剩 1 次往返。）
 */
function gapMinutes(
  rows: EvRow[],
  side: "start" | "end",
): { minutes: number; station: string | null; fromAt: Date } | null {
  if (!rows.length) return null;

  let i = -1;
  let j = -1;
  if (side === "start") {
    i = rows.findIndex((r) => r.event_type === "depart");
    if (i < 0) i = rows.findIndex((r) => r.event_type === "border_end");
    if (i < 0) return null;
    j = rows.findIndex((r, k) => k > i && r.event_type === "wait_start");
  } else {
    // 末次 alight = 真正的下车点（换乘方案中途也会有 alight，不能取第一次）
    for (let k = rows.length - 1; k >= 0; k--) {
      if (rows[k].event_type === "alight") {
        i = k;
        break;
      }
    }
    if (i < 0) return null;
    // 其后的最先到达性事件：走到口岸（border_start）或走到目的地（arrive）
    for (let k = i + 1; k < rows.length; k++) {
      if (rows[k].event_type === "arrive" || rows[k].event_type === "border_start") {
        j = k;
        break;
      }
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
    station: (side === "start" ? rows[j].station_code : rows[i].station_code) as string | null,
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
 *   ⚠️ v0.26.2：「首段/末段 walk」只比较 leg_kind='walk' 的腿的 seq 极值 ——
 *   不能用「所有腿」的极值（跨境方案的 cross_border 腿会插在步行腿之后/之前，
 *   把到点步行、起点步行挤出极值位而被静默跳过）。
 *   ★ v0.28.0：站点匹配改为**候选集合 + 主码归一**，不再要求与 walk 腿写死的站码逐字相等 ——
 *   方案摘要里的「到站後任選」「動態下車」在实际打点时会在不同站停靠，
 *   旧逻辑把这些真实样本全部丢弃（详见 mainCode 上方注释）。
 *   区间内 pause→resume 扣除；保留 0.3~20 分钟；聚合存均值 + samples。
 *   ★ v0.28.0：聚合键的站码按**主码归一**（C690/3 → C690、M9/2 → M9）—— 同台多线站台是
 *   同一物理位置、步行时长一致，样本需合并成一行（与读端 gap-report 的 mainCode 口径一致）；
 *   但落库的 station_code 写该组**首个实测原始站台码**：walk_times.station_code 有 FK 指向
 *   stations.code，而 stations 里只有 T363/2 这类带站台号的行、没有主码 T363。
 */
export async function rebuildWalkTimes(pool: Pool, opts: { dry?: boolean } = {}): Promise<WalkRebuildResult> {
  const dry = !!opts.dry;

  const places = (await pool.query(`SELECT id, slug FROM places`)).rows as { id: number; slug: string }[];
  const placeIdOf = new Map<string, number>();
  for (const p of places) placeIdOf.set(p.slug, p.id);
  const schoolId = placeIdOf.get("school")!;

  // ── 各方案的上下车候选点（v0.28.0）──────────────────────────────────
  // 🚨 min/max 必须只统计 leg_kind='walk' 的腿（v0.26.2 修）：
  // 跨境方案末尾还有 cross_border 腿（如「關閘（拱北口岸）」卡的出境段），若按「所有腿」取极值，
  // 出境的到点步行与入境的起点步行就都不在极值位上 → 被静默跳过，
  // 导致關閘／橫琴口岸侧的步行样本从未回写（实测 14 个方案受影响）。
  //
  // 🚨🚨 v0.28.0 修「动态上下车点丢样本」：方案的 walk 腿只写死**一个**站码，但摘要常声明
  // 「到站後任選」「動態下車」—— 例：家（C653 金峰南岸）→ 澳科大，50/26/26A/25 任選，
  // 实际可在 T400 路氹東／新濠天地、T367 望德聖母灣馬路、T363 連貫公路／威尼斯人 任一站下车；
  // 轻轨线更明显：石排灣 → 科大，摘要写明「科大 或 路氹東（動態下車）」。
  // 原逻辑 `g.station === sp.station` 要求实测站码与写死值**逐字相等**，不符即丢弃 →
  // 已实测过的 T367 望德聖母灣馬路、T363 連貫公路／威尼斯人、LRT-LDE 路氹東、
  // C688 和諧廣場、M1/13 關閘總站、M9/2 關閘廣場 等站点样本**全部静默丢失**（事件仍在库）。
  // 现改为「候选集合命中即接受」，候选来自三处：
  //   ① walk 腿自身的 to_station（起点侧）/ from_station（到点侧）
  //   ② veh 腿的 board_candidates / alight_candidates 两列（方案数据里已存在）
  //   ③ veh 腿 route_meta 中每条备选线路的 board / alight / to
  // 比较时按主码归一 —— 同台多线站台视为同一站、步行时长一致
  // （C688 ≡ C688/1 ≡ C688/2、M9/2 ≡ M9/3 ≡ M9/4、C690 ≡ C690/1 ≡ C690/2 ≡ C690/3）。
  const allLegs = (
    await pool.query(`
    SELECT p.id AS plan_id, p.from_place, p.to_place,
           l.seq, l.leg_kind, l.from_station, l.to_station,
           l.board_candidates, l.alight_candidates, l.route_meta
      FROM commute_plans p
      JOIN plan_legs l ON l.plan_id = p.id
     ORDER BY p.id, l.seq
  `)
  ).rows as {
    plan_id: number;
    from_place: number;
    to_place: number;
    seq: number;
    leg_kind: string;
    from_station: string | null;
    to_station: string | null;
    board_candidates: string[] | null;
    alight_candidates: string[] | null;
    route_meta: Record<string, { board?: string[]; alight?: string[]; to?: string }> | null;
  }[];

  /** 站码主码归一：剥掉站台号后缀（C690/3 → C690、M9/2 → M9、T376/1 → T376） */
  const mainCode = (c: string) => /^[A-Za-z]+\d+/.exec(c)?.[0] ?? c;

  interface WalkSide {
    /** 该步行段所属地点（起点侧 = 出发地，到点侧 = 目的地） */
    place: number;
    /** walk 腿里写死的站码（报告用） */
    declared: string;
    /** 主码归一后的候选站码集合（命中即接受） */
    cands: Set<string>;
  }
  const startByPlan = new Map<number, WalkSide>();
  const endByPlan = new Map<number, WalkSide>();

  {
    const byPlan = new Map<number, typeof allLegs>();
    for (const r of allLegs) {
      const arr = byPlan.get(r.plan_id);
      if (arr) arr.push(r);
      else byPlan.set(r.plan_id, [r]);
    }
    for (const [pid, ls] of byPlan) {
      const ws = ls.filter((l) => l.leg_kind === "walk");
      if (!ws.length) continue;
      const mn = Math.min(...ws.map((x) => x.seq));
      const mx = Math.max(...ws.map((x) => x.seq));
      const boards = new Set<string>();
      const alights = new Set<string>();
      for (const v of ls) {
        if (v.leg_kind !== "bus" && v.leg_kind !== "lrt") continue;
        for (const c of v.board_candidates ?? []) boards.add(c);
        for (const c of v.alight_candidates ?? []) alights.add(c);
        const m = v.route_meta;
        if (m) {
          for (const k of Object.keys(m)) {
            for (const c of m[k]?.board ?? []) boards.add(c);
            for (const c of m[k]?.alight ?? []) alights.add(c);
            if (m[k]?.to) alights.add(m[k].to);
          }
        }
      }
      const sLeg = ws.find((x) => x.seq === mn);
      if (sLeg?.to_station) {
        boards.add(sLeg.to_station);
        startByPlan.set(pid, {
          place: sLeg.from_place,
          declared: sLeg.to_station,
          cands: new Set([...boards].map(mainCode)),
        });
      }
      const eLeg = ws.find((x) => x.seq === mx);
      if (eLeg?.from_station) {
        alights.add(eLeg.from_station);
        endByPlan.set(pid, {
          place: eLeg.to_place,
          declared: eLeg.from_station,
          cands: new Set([...alights].map(mainCode)),
        });
      }
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
      const g = gapMinutes(rows, "start");
      // v0.28.0：候选集合命中即接受（主码归一），不再要求与 walk 腿写死的站码逐字相等
      if (g && g.station && sp.cands.has(mainCode(g.station))) {
        const zone = sp.place === schoolId ? (s.from_zone ?? null) : null;
        const ok = g.minutes >= MIN_MIN && g.minutes <= MAX_MIN;
        samples.push({
          placeId: sp.place,
          // v0.28.0：这里保留**实测原始站台码**（walk_times.station_code 有 FK 指向
          // stations.code，必须是真实存在的行；stations 里只有 T363/2 这类带站台号的行，
          // 没有主码 T363）→ 同台合并交给下方聚合键的 mainCode 归一。
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
      const g = gapMinutes(rows, "end");
      if (g && g.station && ep.cands.has(mainCode(g.station))) {
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

  // 聚合：键 = (placeId, 主码(station), zone)
  // 🚨 v0.28.0：键里的站码必须 mainCode 归一 —— 同台多线站台（C690/1≡/2≡/3、M9/2≡/3≡/4）
  // 是同一物理位置、步行时长一致，样本要合到一行；但落库的 station_code 仍写该组**首个
  // 实测原始站台码**（FK 要求 stations 表存在该行，主码行在库里没有）。
  const agg = new Map<string, { s: WalkSample; vals: number[] }>();
  for (const x of valid) {
    const key = `${x.placeId}|${mainCode(x.station)}|${x.zone ?? ""}`;
    if (!agg.has(key)) agg.set(key, { s: x, vals: [] });
    agg.get(key)!.vals.push(x.minutes);
  }

  const rows: WalkRow[] = [];
  for (const { s, vals } of agg.values()) {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const latest = valid
      .filter((x) => x.placeId === s.placeId && mainCode(x.station) === mainCode(s.station) && x.zone === s.zone)
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
