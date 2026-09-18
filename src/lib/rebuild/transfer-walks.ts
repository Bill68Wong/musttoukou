/**
 * 换乘步行时长重算（共享层，v1.0.0）
 *
 * 从 CLI 脚本 scripts/rebuild-transfer-walks.ts 抽取的核心逻辑，做成接受 pool 的纯函数，
 * 供两处复用：
 *   · CLI：npm run db:transferwalks -- local|cloud（本地 / 手动）
 *   · API：GET /api/cron/rebuild（Vercel Cron 每日自动，第三步）
 * 抽取原因：Serverless 函数只打包被 import 的模块，无法 execFile 调 .ts 脚本。
 *
 * ────────────────────────── 口径（v1.0.0 定稿）──────────────────────────
 * 样本定义：**换乘步行 = 「下车」打点 → 紧随其后的「到站开始等车」打点**之间的间隔。
 *
 * 为什么锚点是 wait_start 而不是 board（★ 关键）：
 *   计时流程里换乘段的真实事件序列是
 *       alight(下 A 车) → [走到 B 站台] → wait_start(到达 B 站台、开始等车) → board(上 B 车)
 *   从 wait_start 到 board 是**等车时间**，与「走多远」无关 —— 若取 alight→board，
 *   会把车距差算进步行（等 8 分钟的车会被算成"步行 8 分钟"）。取 wait_start 即**天然扣掉等车段**，
 *   无需另做减法。这正是本表叫「换乘步行」而不是「换乘耗时」的原因：
 *   换乘总耗时 = 本表 minutes + 该段的实时等车时长，两者由模型层分别计入。
 *
 * 换乘 vs 终点下车的区分（同一会话里两种 alight 都有）：
 *   一个 alight 之后**最近的到达性事件**决定性质 ——
 *     · wait_start           → 后面还有一段车要坐 = 换乘 → 采样本
 *     · arrive / border_start → 已到目的地 / 已到口岸开始通关 = 终点下车 → 不采
 *     · alight                → 异常序列（连续两次下车）→ 放弃
 *   直达会话（无换乘）天然产不出样本，无需特判。
 *
 * 清洗：扣除区间内 pause→resume；保留 0.3 ~ 20 分钟（与 walk_times 同一窗口）。
 *   ⚠️ 同台换乘（C690/1 → C690/2 这类同一物理站台的不同停靠位）真实步行≈0，
 *     会自然落在 0.3 分钟下限之外而被剔除并计入 dropped —— 属预期，报告里可见。
 *     （模型层另有「同台 = 0 分钟」判定，不依赖本表。）
 *
 * 聚合：键 = `主码(下车站) | 主码(上车站)`，**主码归一**——同台多线站台（C690/1≡/2≡/3、
 *   M9/2≡/3≡/4）是同一物理位置，换乘距离一致，样本必须合并成一行；
 *   与读端 buildTransferIndex 的键口径、以及 segment_stats 的跨线邻接键口径完全一致。
 *   落库的 from_station / to_station 写该组**首个实测原始站台码**：两列都有 FK 指向
 *   stations.code，而 stations 里只有 T355/1 这类带站台号的行、没有主码 T355。
 *
 * 幂等：清表后全量重灌，可重复运行。
 */
import type { Pool } from "pg";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";

/** 有效区间：0.3 ~ 20 分钟（与 walk_times 一致） */
const MIN_MIN = 0.3;
const MAX_MIN = 20.0;
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface TransferSample {
  from: string;
  to: string;
  minutes: number;
  date: string;
  sid: number;
  excluded?: string;
}

export interface TransferRow {
  from: string;
  to: string;
  minutes: number;
  samples: number;
  date: string;
}

export interface TransferRebuildResult {
  scanned: number;
  collected: number;
  valid: number;
  dropped: { sid: number; from: string; to: string; reason: string }[];
  rows: TransferRow[];
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
 * 取一个会话内全部换乘步行样本（一次出行可能有多次换乘 → 最多 2~3 条）。
 *
 * ⚠️ 纯函数、不查库：会话事件由调用方一次性取回后按 session_id 分组传入
 * （与 walk-times.gapMinutes 同一理由：逐会话查库的往返次数随样本线性增长，
 *  跨区域 RTT ~200ms 时会撞 maxDuration）。
 */
export function transferSamplesOf(
  rows: EvRow[],
): { from: string; to: string; minutes: number; fromAt: Date }[] {
  const out: { from: string; to: string; minutes: number; fromAt: Date }[] = [];
  if (!rows.length) return out;

  for (let i = 0; i < rows.length; i++) {
    if (rows[i].event_type !== "alight") continue;
    const fromCode = rows[i].station_code;
    if (!fromCode) continue;

    // 该次下车之后最近的「到达性事件」判定性质（见文件头注释）
    let j = -1;
    for (let k = i + 1; k < rows.length; k++) {
      const t = rows[k].event_type;
      if (t === "wait_start") {
        j = k;
        break;
      }
      if (t === "arrive" || t === "border_start" || t === "alight") break; // 终点下车 / 异常序列
    }
    if (j < 0) continue;
    const toCode = rows[j].station_code;
    if (!toCode) continue;

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

    out.push({ from: fromCode, to: toCode, minutes: raw - paused, fromAt: t0 });
  }
  return out;
}

/** 全量重算 transfer_walks（清表后按实测样本重灌）。**幂等、可重复运行**。 */
/**
 * ★ 人工设定的换乘步行时间（v1.2.2）
 *
 * 用途：给**没有实测样本**的换乘点兜底 —— 比全局常数 `TRANSFER_FALLBACK_MIN`
 * （统一 3.0 分）精确，因为每个换乘点的实际步行距离不同。
 *
 * ⚠️ 落库规则：**人工优先** —— 用 `ON CONFLICT DO UPDATE`，会**覆盖**同键的实测值 ✓
 *   理由：这些值是人工按站台布局/实测取整后明确设定的当前权威值。
 *
 * 数据来源：`LRT-UH` = 实测 2.9 分（n=9，2026-09-15）后取整为 3.0；
 *          `LRT-LOT` = 无实测，按站台布局人工估算。
 */
const MANUAL_TRANSFER_MIN: { from: string; to: string; minutes: number; note: string }[] = [
  { from: "LRT-UH", to: "LRT-UH", minutes: 3.0, note: "協和醫院站內換乘（石排灣線↔氹仔線）" },
  { from: "LRT-LOT", to: "LRT-LOT", minutes: 4.0, note: "蓮花站內換乘（氹仔線↔橫琴線）" },
];

export async function rebuildTransferWalks(
  pool: Pool,
  opts: { dry?: boolean } = {},
): Promise<TransferRebuildResult> {
  const dry = !!opts.dry;

  // 真实样本口径：未删除、非测试（与 walk_times / segment_stats 完全一致）
  const sessions = (
    await pool.query(`
    SELECT s.id
      FROM timer_sessions s
     WHERE s.deleted_at IS NULL
       AND NOT COALESCE(s.is_test, false)
       AND s.plan_id IS NOT NULL
     ORDER BY s.id
  `)
  ).rows as { id: number }[];

  // 一次取回全部会话事件再按 session_id 分组（勿逐会话查库，见 transferSamplesOf 注释）
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

  const samples: TransferSample[] = [];
  for (const s of sessions) {
    for (const g of transferSamplesOf(evBySession.get(s.id) ?? [])) {
      const ok = g.minutes >= MIN_MIN && g.minutes <= MAX_MIN;
      samples.push({
        from: g.from,
        to: g.to,
        minutes: ok ? g.minutes : NaN,
        date: macauDate(g.fromAt),
        sid: s.id,
        excluded: ok ? undefined : `间隔 ${g.minutes.toFixed(2)} 分（越界）`,
      });
    }
  }

  const valid = samples.filter((x) => !Number.isNaN(x.minutes));
  const dropped = samples
    .filter((x) => Number.isNaN(x.minutes))
    .map((d) => ({ sid: d.sid, from: d.from, to: d.to, reason: d.excluded ?? "" }));

  // 聚合：键 = 主码归一（见文件头注释）
  const agg = new Map<string, { s: TransferSample; vals: number[] }>();
  for (const x of valid) {
    const key = `${mainCodeOf(x.from)}|${mainCodeOf(x.to)}`;
    if (!agg.has(key)) agg.set(key, { s: x, vals: [] });
    agg.get(key)!.vals.push(x.minutes);
  }

  const rows: TransferRow[] = [];
  for (const { s, vals } of agg.values()) {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const latest = valid
      .filter((x) => mainCodeOf(x.from) === mainCodeOf(s.from) && mainCodeOf(x.to) === mainCodeOf(s.to))
      .map((x) => x.date)
      .sort()
      .at(-1)!;
    rows.push({ from: s.from, to: s.to, minutes: r1(avg), samples: vals.length, date: latest });
  }
  rows.sort(
    (a, b) =>
      a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
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

  // 事务 + UNNEST 批量写（同 walk_times 的理由：逐行 INSERT 在跨区域
  // Vercel→Supabase 场景下会把「行数 × 往返延迟」累积成总耗时并撞 maxDuration）
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM transfer_walks`);
    if (rows.length) {
      await client.query(
        `INSERT INTO transfer_walks (from_station, to_station, minutes, samples, source, measured_at)
         SELECT f, t, m, n, 'timer', d
           FROM UNNEST($1::text[], $2::text[], $3::numeric[], $4::int[], $5::date[])
                AS x(f, t, m, n, d)`,
        [
          rows.map((r) => r.from),
          rows.map((r) => r.to),
          rows.map((r) => r.minutes),
          rows.map((r) => r.samples),
          rows.map((r) => r.date),
        ],
      );
    }
    // ★ v1.2.2：人工换乘时间 —— **人工优先**（DO UPDATE ⇒ 覆盖同键的实测值）
    //   理由：这些值是人工按站台实际布局/实测取整后**明确设定**的当前权威值。
    //   ⚠️ 若日后要改回「实测优先」，把 DO UPDATE 改回 DO NOTHING 即可。
    if (MANUAL_TRANSFER_MIN.length) {
      await client.query(
        `INSERT INTO transfer_walks (from_station, to_station, minutes, samples, source, measured_at)
         SELECT f, t, m, 0, 'manual', NULL
           FROM UNNEST($1::text[], $2::text[], $3::numeric[]) AS x(f, t, m)
         ON CONFLICT (from_station, to_station)
         DO UPDATE SET minutes = EXCLUDED.minutes, samples = 0, source = 'manual', measured_at = NULL`,
        [
          MANUAL_TRANSFER_MIN.map((r) => r.from),
          MANUAL_TRANSFER_MIN.map((r) => r.to),
          MANUAL_TRANSFER_MIN.map((r) => r.minutes),
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
    await pool.query(`SELECT count(*)::int n, COALESCE(sum(samples),0)::int total FROM transfer_walks`)
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
