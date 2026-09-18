/**
 * 站间时长「原始样本」入库（CLI，scripts/import-segment-samples.ts）
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/import-segment-samples.ts            # dry-run（只统计）
 *   node node_modules/tsx/dist/cli.mjs scripts/import-segment-samples.ts --apply    # 写库
 *   ... --runs=N         只导入最近 N 轮（默认全部）
 *   ... --from-file=路径  只导入某个 derived.json
 *   ... --keep=N         滚动窗口保留轮数（默认 30；track 只留最近 N 轮，timer 永不删）
 *   ... --no-timer       跳过手动实测（source='timer'）导入
 *   # 或 npm run db:segsamples -- [--apply] [...]（npm script 只负责转发参数）
 *
 * 核心逻辑在 src/lib/rebuild/segment-samples.ts（共享层，供 CLI 与（预留）Cron 复用）。
 * 本文件仅负责：连库、解析参数、调共享函数、打印人类可读报告。
 *
 * **可重复运行**（幂等：唯一约束 + ON CONFLICT DO NOTHING）。
 */
import { Pool } from "pg";
import { importSegmentSamples } from "../src/lib/rebuild/segment-samples";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : "true";
};

const apply = process.argv.includes("--apply");
const runsArg = arg("runs");
const runs = runsArg ? Number(runsArg) : undefined;
const keepArg = arg("keep");
const keepRuns = keepArg ? Number(keepArg) : 30;
const fromFile = arg("from-file") ?? undefined;
const noTimer = process.argv.includes("--no-timer");

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("未找到 DATABASE_URL（.env）");
const u = new URL(dbUrl);
const pool = new Pool({
  host: u.hostname,
  port: Number(u.port || 5432),
  database: u.pathname.slice(1),
  user: u.username,
  password: decodeURIComponent(u.password || ""),
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const dry = !apply;
  console.log(`════ 站间时长原始样本入库 · ${dry ? "DRY-RUN（只统计，不写库）" : "★ APPLY（写生产库）"} ════`);
  console.log(`目标库：${u.hostname} / ${u.pathname.slice(1)}`);
  if (dry) console.log("（加 --apply 才真正写库）");
  console.log("");

  const r = await importSegmentSamples(pool, {
    dry,
    runs,
    fromFile,
    keepRuns,
    timer: !noTimer,
    log: (s) => console.log(s),
  });

  console.log("");
  console.log("── 逐轮导入明细（按观测时间新→旧）──");
  console.log(`  ${"轮次 run_label".padEnd(22)} ${"读到".padStart(8)} ${"入库".padStart(8)} ${"跳过(重复)".padStart(11)}`);
  for (const s of r.runs) {
    console.log(`  ${s.runLabel.padEnd(22)} ${String(s.read).padStart(8)} ${String(s.inserted).padStart(8)} ${String(s.skipped).padStart(11)}`);
  }
  if (r.timer.read || r.timer.inserted) {
    console.log(`  ${r.timer.runLabel.padEnd(22)} ${String(r.timer.read).padStart(8)} ${String(r.timer.inserted).padStart(8)} ${String(r.timer.skipped).padStart(11)}`);
  }

  console.log("");
  console.log("── 合计 ──");
  console.log(`  读入 ${r.totals.read} · 入库 ${r.totals.inserted} · 跳过（重复）${r.totals.skipped}`);
  console.log(`  滚动窗口：保留最近 ${r.keepRuns} 轮 track；本次${dry ? "预计" : "实际"}删除 ${r.windowDeleted} 行（timer 永不删）`);

  console.log("");
  console.log("── 库现状（segment_samples）──");
  console.log(`  总行数：${r.db.total}`);
  console.log(`  按 source：${Object.entries(r.db.bySource).map(([k, v]) => `${k}=${v}`).join("  ") || "—"}`);
  console.log(`  按 run_label（前 5 轮，按行数）：`);
  for (const [label, n] of r.db.topRuns) console.log(`     ${label.padEnd(22)} ${n}`);

  if (dry) console.log("\n[dry-run] 未写库。确认数字合理后加 --apply。");

  await pool.end();
}

main().catch((e) => {
  console.error("入库失败：", e);
  process.exit(1);
});
