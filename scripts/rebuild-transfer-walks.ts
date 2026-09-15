/**
 * 换乘步行时长重建（CLI 薄壳，scripts/rebuild-transfer-walks.ts）
 * 用法：npm run db:transferwalks -- [local|cloud] [--dry]
 *
 * 核心逻辑在 src/lib/rebuild/transfer-walks.ts（共享层）—— 同一份代码同时供
 * 本 CLI 与 GET /api/cron/rebuild（Vercel Cron 每日自动重算）使用。
 * 抽取原因：Serverless 函数只打包被 import 的模块，无法 execFile 调 .ts 脚本，
 * 因此必须把逻辑放进 src/lib 才能被路由复用。
 *
 * 口径细节（alight → wait_start、扣等车段、清洗、主码归一）见共享层文件头注释。
 */
import { Pool } from "pg";
import { rebuildTransferWalks } from "../src/lib/rebuild/transfer-walks";

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

async function main() {
  console.log(`=== 换乘步行时长重建（${target}${dry ? " · DRY RUN" : ""}）`);

  const r = await rebuildTransferWalks(pool, { dry });

  console.log(`扫描会话：${r.scanned} 条`);
  console.log(`\n采集到样本：${r.collected}（有效 ${r.valid} / 剔除 ${r.dropped.length}）`);
  for (const d of r.dropped)
    console.log(`   ✗ 剔除 s${d.sid} ${d.from} → ${d.to} —— ${d.reason}`);

  console.log(`\n聚合结果（${r.rows.length} 行）：`);
  for (const x of r.rows)
    console.log(
      `   ${x.from.padEnd(10)} → ${x.to.padEnd(10)} ${String(x.minutes).padStart(5)} 分  n=${x.samples}  ${x.date}`,
    );

  if (dry) {
    console.log("\n（--dry）未写库");
  } else {
    console.log(`\n✅ 已写入 transfer_walks：${r.inserted} 行 / 累计 ${r.totalSamples} 个样本（${target}）`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error("重建失败：", e);
  process.exit(1);
});
