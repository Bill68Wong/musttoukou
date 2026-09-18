/**
 * 站间时长「原始样本」入库（共享层，v1.3.0）
 *
 * 从 CLI 脚本 scripts/import-segment-samples.ts 抽取的核心逻辑，接受 pool 的纯函数，
 * 与项目既有 rebuild 逻辑同构（共享层 + CLI 两层），以便日后供 Vercel Cron 复用：
 *   · CLI：npm run db:segsamples [-- --apply]
 *   · （预留）API：/api/cron/* 定时把当天采集产物入库
 *
 * ── 两条数据源 → 同一张表 `segment_samples` ────────────────────────────
 *   ① `source='track'` 自动采集：读 `data/tracking/*-derived.json` 顶层的 `rawDepartSamples`
 *      （唯一的原始样本数组；`rawArriveSamples` 本期为 0，跳过）。
 *      字段映射：route→route_code · dir(字符串)→dir(smallint) · plate→plate · from→from_main ·
 *      to→to_main · fromSta→from_station · toSta→to_station · fromIdx→from_idx · minutes→minutes ·
 *      t(毫秒)→observed_at · kind→arrive_kind · 文件名(label)→run_label。
 *      ★ weekday / time_bucket 由 observed_at 按**澳门时区**推算 —— **复用**
 *        segment-stats.ts 导出的 `macauParts` / `bucketOf`，不另起一套口径。
 *   ② `source='timer'` 手动实测：由 segment-stats.ts 的事件路径（timer_sessions + timer_events）
 *      产出的原始段样本，口径与之**完全一致**；run_label 固定 'timer'，dir/plate/from_idx 为 NULL。
 *
 * ── 幂等 ──────────────────────────────────────────────────────────────
 *   唯一约束 + `ON CONFLICT DO NOTHING`（重复导入同一轮/同一样本不会翻倍）。
 *
 * ── 批量写 + 事务 ──────────────────────────────────────────────────────
 *   逐行 INSERT 在「跨区域 Vercel→Supabase」场景下会把「行数 × 往返延迟」累积成总耗时并撞
 *   maxDuration（详见 src/lib/rebuild/transfer-walks.ts:249 与 segment-stats.ts:544 的注释），
 *   故一律 `UNNEST` 一次多行、整体包在 `BEGIN/COMMIT` 里。
 *
 * ── 滚动窗口 ──────────────────────────────────────────────────────────
 *   写完后删除「不属于最近 keepRuns 轮」的 `source='track'` 行；`source='timer'` **永不删除**。
 */
import fs from "node:fs";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { rebuildSegmentStats, bucketOf, macauParts, mainCode } from "./segment-stats";

/** 一条待入库的原始样本（与 segment_samples 列对齐） */
export interface SegmentSampleRow {
  run_label: string;
  route_code: string;
  dir: number | null;
  plate: string | null;
  from_main: string;
  to_main: string;
  from_station: string;
  to_station: string;
  from_idx: number | null;
  minutes: number;
  /** ★ 计时口径（'depart' | 'arrive'），**不是** segment_stats 的 stop/pass */
  arrive_kind: string;
  source: "track" | "timer";
  observed_at: Date;
  weekday: number;
  time_bucket: string;
}

/** 单轮导入统计 */
export interface RunStat {
  runLabel: string;
  read: number;
  inserted: number;
  skipped: number;
}

export interface ImportResult {
  dry: boolean;
  /** 逐轮（track 文件）统计，按观测时间从新到旧 */
  runs: RunStat[];
  /** 手动实测导入统计（单批） */
  timer: RunStat;
  totals: { read: number; inserted: number; skipped: number };
  /** 滚动窗口删除的行数 */
  windowDeleted: number;
  /** 说明：未传 --apply 时 windowDeleted 为「将要删除」的估算 */
  keepRuns: number;
  db: {
    total: number;
    bySource: Record<string, number>;
    topRuns: [string, number][];
  };
}

export interface ImportOpts {
  /** true = 只统计不写库（默认 CLI 行为） */
  dry?: boolean;
  /** 只导入最近 N 轮 track（默认全部） */
  runs?: number;
  /** 单文件导入（覆盖目录扫描） */
  fromFile?: string;
  /** 采集产物目录（默认 <cwd>/data/tracking） */
  dataDir?: string;
  /** 滚动窗口保留轮数（默认 30；<=0 表示不清理） */
  keepRuns?: number;
  /** 是否导入手动实测 timer（默认 true） */
  timer?: boolean;
  /** 日志回调 */
  log?: (s: string) => void;
}

const DEFAULT_DATA_DIR = () => path.resolve(process.cwd(), "data/tracking");

/**
 * 读取单个 derived.json，解析出 track 原始样本 + 该轮最大观测时刻（用于排序/滚动窗口）。
 *
 * ★ run_label 取 **JSON 顶层的 `label` 字段**，不是文件名 ✗ —— 因为文件名规则并不统一：
 *   多数是 `YYYYMMDD-HHMMSS`（15 字符，如 `20260918-213415`），但 `r10-day-1646` /
 *   `r11-day-1724` / `r12-day-1800` / `selftest-e` 这些轮次**不是时间戳格式**。
 *   而 JSON 里的 `label` 由派生器（track-derive.mjs）写入、与产物一一对应，最稳。
 *   （文件名去 `-derived.json` 后缀仅作**兜底**，正常情况下不会用到。）
 */
function readTrackFile(file: string): { label: string; rows: SegmentSampleRow[]; maxT: number } {
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as {
    label?: string;
    rawDepartSamples?: Record<string, unknown>[];
  };
  const label = String(j.label ?? path.basename(file).replace(/-derived\.json$/, ""));
  const raw = Array.isArray(j.rawDepartSamples) ? j.rawDepartSamples : [];
  const rows: SegmentSampleRow[] = [];
  let maxT = -Infinity;
  for (const s of raw) {
    const t = Number(s.t);
    if (!Number.isFinite(t)) continue; // 缺时刻的样本无法分层，丢弃（采集产物中不应出现）
    const d = new Date(t);
    const mp = macauParts(d);
    if (t > maxT) maxT = t;
    rows.push({
      run_label: label,
      route_code: String(s.route),
      dir: s.dir === null || s.dir === undefined ? null : Number(s.dir),
      plate: s.plate === null || s.plate === undefined ? null : String(s.plate),
      from_main: String(s.from),
      to_main: String(s.to),
      from_station: String(s.fromSta),
      to_station: String(s.toSta),
      from_idx: s.fromIdx === null || s.fromIdx === undefined ? null : Number(s.fromIdx),
      minutes: Number(s.minutes),
      arrive_kind: String(s.kind ?? "depart"),
      source: "track",
      observed_at: d,
      weekday: mp.weekday,
      time_bucket: bucketOf(mp.hour),
    });
  }
  return { label, rows, maxT: Number.isFinite(maxT) ? maxT : -Infinity };
}

/** 列出采集产物文件（排除位置分片；derived.json 才是样本产物） */
function listDerivedFiles(dataDir: string, fromFile?: string): string[] {
  if (fromFile) {
    const f = path.resolve(fromFile);
    if (!fs.existsSync(f)) throw new Error(`--from-file 不存在：${f}`);
    return [f];
  }
  if (!fs.existsSync(dataDir)) throw new Error(`采集产物目录不存在：${dataDir}`);
  return fs
    .readdirSync(dataDir)
    .filter((f) => f.endsWith("-derived.json"))
    .sort()
    .map((f) => path.join(dataDir, f));
}

/** 由事件路径产出的**手动实测**段样本（口径与 segment-stats.ts 完全一致） */
async function collectTimerRows(pool: Pool): Promise<SegmentSampleRow[]> {
  const r = await rebuildSegmentStats(pool, { dry: true });
  return r.rawSamples
    .filter((s) => s.source === "timer")
    .map((s) => ({
      run_label: "timer",
      route_code: s.route,
      dir: null, // 手动实测：方向可为 NULL
      plate: null,
      from_main: mainCode(s.from),
      to_main: mainCode(s.to),
      from_station: s.from,
      to_station: s.to,
      from_idx: null,
      minutes: s.minutes,
      arrive_kind: "depart", // 事件路径即「离开口径」（见 segment-stats.ts 文件头定案）
      source: "timer" as const,
      observed_at: new Date(s.t),
      weekday: s.weekday,
      time_bucket: s.bucket,
    }));
}

/** UNNEST 批量 UPSERT（ON CONFLICT DO NOTHING）；返回实际插入行数 */
async function insertBatch(client: PoolClient, rows: SegmentSampleRow[]): Promise<number> {
  if (!rows.length) return 0;
  const res = await client.query(
    `INSERT INTO segment_samples
       (run_label, route_code, dir, plate, from_main, to_main, from_station, to_station,
        from_idx, minutes, arrive_kind, source, observed_at, weekday, time_bucket)
     SELECT run_label, route_code, dir, plate, from_main, to_main, from_station, to_station,
            from_idx, minutes, arrive_kind, source, observed_at, weekday, time_bucket
       FROM UNNEST($1::text[], $2::text[], $3::smallint[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::smallint[], $10::numeric[], $11::text[], $12::text[],
                   $13::timestamptz[], $14::smallint[], $15::text[])
            AS x(run_label, route_code, dir, plate, from_main, to_main, from_station, to_station,
                 from_idx, minutes, arrive_kind, source, observed_at, weekday, time_bucket)
     ON CONFLICT (run_label, source, route_code, dir, plate, from_station, to_station, observed_at)
     DO NOTHING
     RETURNING 1`,
    [
      rows.map((r) => r.run_label),
      rows.map((r) => r.route_code),
      rows.map((r) => r.dir),
      rows.map((r) => r.plate),
      rows.map((r) => r.from_main),
      rows.map((r) => r.to_main),
      rows.map((r) => r.from_station),
      rows.map((r) => r.to_station),
      rows.map((r) => r.from_idx),
      rows.map((r) => r.minutes),
      rows.map((r) => r.arrive_kind),
      rows.map((r) => r.source),
      rows.map((r) => r.observed_at),
      rows.map((r) => r.weekday),
      rows.map((r) => r.time_bucket),
    ],
  );
  return res.rowCount ?? 0;
}

/** 滚动窗口清理结果 */
export interface TrimResult {
  /** 本次删除的行数 */
  deleted: number;
  /** 删除后剩余 track 行数 */
  remaining: number;
  /** 删除后剩余 track 轮数 */
  remainingRuns: number;
}

/**
 * 滚动窗口清理（★ 可复用：CLI 与 Vercel Cron 共用）：
 * 只保留最近 `keepRuns` 轮 `source='track'` 的原始样本，删除更老的轮次；
 * `source='timer'`（手动实测）**永不删除** ✗。
 *
 * 幂等（可重复调用）；独立事务；返回 {deleted, remaining, remainingRuns} 供调用方打印。
 * 若 keepRuns<=0 表示不清理（仅回报现状）。
 *
 * @param pool 连接池
 * @param keepRuns 保留的最近轮数（默认 30）
 */
export async function trimSegmentSampleWindow(pool: Pool, keepRuns = 30): Promise<TrimResult> {
  const stat = async () =>
    (
      await pool.query(
        `SELECT count(*)::int AS n, count(DISTINCT run_label)::int AS runs
           FROM segment_samples WHERE source='track'`,
      )
    ).rows[0] as { n: number; runs: number };

  let deleted = 0;
  if (keepRuns > 0) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // 保留集 = 观测时刻最新的 keepRuns 个轮次（按每轮 max(observed_at) 排序）
      const keep = await client.query(
        `SELECT run_label FROM (
            SELECT run_label, max(observed_at) AS m FROM segment_samples
             WHERE source = 'track' GROUP BY run_label
          ) s ORDER BY m DESC LIMIT $1`,
        [keepRuns],
      );
      const labels = keep.rows.map((r: { run_label: string }) => r.run_label);
      if (labels.length) {
        const del = await client.query(
          `DELETE FROM segment_samples WHERE source = 'track' AND run_label <> ALL($1::text[])`,
          [labels],
        );
        deleted = del.rowCount ?? 0;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      client.release();
      throw e;
    }
    client.release();
  }
  const s = await stat();
  return { deleted, remaining: Number(s.n), remainingRuns: Number(s.runs) };
}

/**
 * 把采集/手动原始样本导入 `segment_samples`。
 *
 * @param pool 生产库连接池
 * @param opts 见 ImportOpts（dry 默认 false，调用方应显式控制）
 * @returns 逐轮统计 + 总览
 */
export async function importSegmentSamples(pool: Pool, opts: ImportOpts = {}): Promise<ImportResult> {
  const dry = !!opts.dry;
  const keepRuns = opts.keepRuns ?? 30;
  const withTimer = opts.timer !== false;
  const log = opts.log ?? (() => {});

  // ── ① 收集 track 原始样本（按轮聚合，记录每轮最大观测时刻用于排序）──
  const files = listDerivedFiles(opts.dataDir ?? DEFAULT_DATA_DIR(), opts.fromFile);
  interface RunBucket { label: string; rows: SegmentSampleRow[]; maxT: number }
  let buckets: RunBucket[] = files.map((f) => {
    const { label, rows, maxT } = readTrackFile(f);
    return { label, rows, maxT };
  });
  // 只取最近 N 轮（按观测时刻新→旧）
  buckets.sort((a, b) => b.maxT - a.maxT);
  const allRuns = buckets.length;
  if (opts.runs && opts.runs > 0) buckets = buckets.slice(0, opts.runs);

  const trackTotal = buckets.reduce((a, b) => a + b.rows.length, 0);
  log(`📂 采集产物：${files.length} 个文件 · ${allRuns} 轮 · 本次导入最近 ${buckets.length} 轮 · track 原始样本 ${trackTotal} 条`);

  // ── ② 收集 timer 原始样本 ──
  const timerRows = withTimer ? await collectTimerRows(pool) : [];
  log(`📂 手动实测：timer 原始样本 ${timerRows.length} 条`);

  const runs: RunStat[] = buckets.map((b) => ({
    runLabel: b.label,
    read: b.rows.length,
    inserted: 0,
    skipped: 0,
  }));
  const timerStat: RunStat = { runLabel: "timer", read: timerRows.length, inserted: 0, skipped: 0 };

  let windowDeleted = 0;
  const totals = { read: trackTotal + timerRows.length, inserted: 0, skipped: 0 };

  // ── ③ 写库（dry 时只统计「将插入的读入量」）──
  if (!dry) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        const ins = await insertBatch(client, b.rows);
        runs[i].inserted = ins;
        runs[i].skipped = b.rows.length - ins;
      }
      if (timerRows.length) {
        const ins = await insertBatch(client, timerRows);
        timerStat.inserted = ins;
        timerStat.skipped = timerRows.length - ins;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      client.release();
      throw e;
    }
    client.release();
    // ★ 滚动窗口：入库后**独立事务**清理（与插入解耦，便于 Cron 单独复用同一函数）
    const tr = await trimSegmentSampleWindow(pool, keepRuns);
    windowDeleted = tr.deleted;
  } else {
    // dry：按「库内该轮/该源已存在多少」预估将插入 / 将跳过（唯一约束命中即跳过）
    const ex = await pool.query(
      `SELECT source, run_label, count(*)::int AS n FROM segment_samples GROUP BY source, run_label`,
    );
    const have = new Map<string, number>();
    for (const r of ex.rows as { source: string; run_label: string; n: number }[])
      have.set(`${r.source}|${r.run_label}`, r.n);
    for (const stat of runs) {
      const already = have.get(`track|${stat.runLabel}`) ?? 0;
      stat.skipped = Math.min(stat.read, already);
      stat.inserted = stat.read - stat.skipped;
    }
    const timerAlready = have.get("timer|timer") ?? 0;
    timerStat.skipped = Math.min(timerStat.read, timerAlready);
    timerStat.inserted = timerStat.read - timerStat.skipped;
    // 滚动窗口预估：库内 track 轮数 + 本次新增轮数 − keepRuns
    const trackRuns = (await pool.query(
      `SELECT count(DISTINCT run_label)::int AS n FROM segment_samples WHERE source='track'`,
    )).rows[0]?.n ?? 0;
    const newRuns = buckets.filter((b) => !have.has(`track|${b.label}`)).length;
    windowDeleted = keepRuns > 0 ? Math.max(0, Number(trackRuns) + newRuns - keepRuns) : 0;
  }

  for (const stat of runs) {
    totals.inserted += stat.inserted;
    totals.skipped += stat.skipped;
  }
  totals.inserted += timerStat.inserted;
  totals.skipped += timerStat.skipped;

  // ── ④ 总览（写库后 / dry 均以库现状为准）──
  const totalRow = await pool.query(`SELECT count(*)::int AS n FROM segment_samples`);
  const srcRows = await pool.query(`SELECT source, count(*)::int AS n FROM segment_samples GROUP BY source`);
  const runRows = await pool.query(
    `SELECT run_label, count(*)::int AS n FROM segment_samples
      WHERE source='track' GROUP BY run_label ORDER BY n DESC, run_label LIMIT 5`,
  );
  const bySource: Record<string, number> = {};
  for (const r of srcRows.rows as { source: string; n: number }[]) bySource[r.source] = r.n;

  return {
    dry,
    runs,
    timer: timerStat,
    totals,
    windowDeleted,
    keepRuns,
    db: {
      total: Number(totalRow.rows[0]?.n ?? 0),
      bySource,
      topRuns: (runRows.rows as { run_label: string; n: number }[]).map((r) => [r.run_label, r.n]),
    },
  };
}
