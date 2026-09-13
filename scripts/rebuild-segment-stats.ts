/**
 * 站间时长统计重建（scripts/rebuild-segment-stats.ts）
 * 用法：npm run db:segments -- [local|cloud] [--dry]
 *
 * 核心逻辑在 src/lib/rebuild/segment-stats.ts（v0.25.0 抽取，
 * 供 CLI 与 /api/cron/rebuild 共用，避免两套口径漂移）。
 * 本文件仅负责：连库、调共享函数、打印人类可读报告。
 *
 * **可重复运行**（派生表，每次清空后重算）。口径细节见共享模块顶部注释。
 */
import { Pool } from "pg";
import { rebuildSegmentStats, segAvg } from "../src/lib/rebuild/segment-stats";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const dry = process.argv.includes("--dry");
const target = ((process.argv[2] ?? "local") as "local" | "cloud");
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
  const r = await rebuildSegmentStats(pool, { dry });
  const { stats } = r;

  if (dry) console.log(`[--dry] 跳过写入（${target}）`);
  console.log(`✅ segment_stats ${dry ? "（未写入）" : "已重算"}（${target}）`);
  console.log(`   源：通勤计时 ${r.sessions} 会话 + 自由记站 ${r.rides} 行程 → 段样本 ${r.samples}`);
  console.log(`   来源分布：timer ${r.bySource.timer} · free ${r.bySource.free}`);
  console.log(`   头段 ${stats.head} · 末段 ${stats.tail} · 方向重判 ${stats.redirect} 个行程`);
  console.log(
    `   丢弃：同站不同台 ${stats.sameStation} · 0 分钟重复点击 ${stats.zeroGap} · ` +
      `站码未匹配 ${stats.unmatched} · 跨站（中间漏打/忘打卡） ${stats.cross} · 反向 ${stats.reverse}`,
  );
  console.log(
    `   档位：stop（起点停靠，含停站）${r.byKind.stop} · pass（起点甩站，≈纯行驶）${r.byKind.pass}`,
  );
  console.log(`   写入 ${r.written} 行（分层 ${r.layered} + 兜底）`);

  console.log("   按线路：", r.routeCount.map(([k, v]) => `${k}(${v})`).join(" "));

  // 停站耗时反推：同一 (route, from, to) 同时有 stop 与 pass 样本
  console.log(`\n   可反推停站耗时的区间（同时有停靠/甩站样本）：${r.pairs.length} 个`);
  for (const p of r.pairs)
    console.log(
      `     ${p.key}  停靠 ${segAvg(p.stop)} 分（${p.stop.length}） − 甩站 ${segAvg(p.pass)} 分（${p.pass.length}） ≈ 停站 ${(
        Math.round((segAvg(p.stop) - segAvg(p.pass)) * 10) / 10
      )} 分`,
    );

  console.log(`\n   有 ≥2 次样本的区间 ${r.rep.length} 个，前 10：`);
  for (const p of r.rep.slice(0, 10)) {
    const all = [...p.stop, ...p.pass];
    console.log(
      `     ${p.key}  共 ${all.length} 次: ${all.join(" / ")}  均值 ${segAvg(all)}  停靠 ${p.stop.length} / 甩站 ${p.pass.length}`,
    );
  }

  await pool.end();
}

main().catch((e) => {
  console.error("重建失败：", e);
  process.exit(1);
});
