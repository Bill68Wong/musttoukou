/**
 * CLI：高德步行距离抓取（scripts/rebuild-walk-distances.ts，v1.2.0）
 *
 * 薄壳，核心逻辑在 `src/lib/rebuild/walk-distances.ts`（同一份代码供 CLI 与 Cron 共用）。
 *
 * 用法：
 *   npm run db:walkdists                # 增量抓取（默认，稳态下几乎不发请求）
 *   npm run db:walkdists -- dry         # 只枚举+试算，不写库
 *   npm run db:walkdists -- force       # 忽略增量判断，全量重抓
 *   npm run db:walkdists -- dry force   # 全量试跑（不写库）
 *
 * ⚠️ 需要本地 .env 里有 `AMAP_KEY`（高德开放平台 → 控制台 → 应用管理 → 添加 Key，
 *    平台必须选「Web 服务」）。
 */
import { Pool } from "pg";
import { rebuildWalkDistances } from "../src/lib/rebuild/walk-distances";

process.loadEnvFile("D:/Projects/University/Studio/musttoukou/.env");

const args = process.argv.slice(2);
const dry = args.includes("dry");
const force = args.includes("force");

const u = new URL(process.env.DATABASE_URL!);
const pool = new Pool({
  host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1),
  user: u.username, password: decodeURIComponent(u.password || ""), ssl: { rejectUnauthorized: false },
});

function main() {
  console.log("════ DSAT → 高德 · 步行距离抓取 ════");
  console.log(`库：${u.hostname} / ${u.pathname.slice(1)}`);
  console.log(`模式：${dry ? "DRY（不写库）" : "APPLY（写库）"}${force ? " · FORCE（全量重抓）" : " · 增量"}`);
  console.log(`AMAP_KEY：${process.env.AMAP_KEY ? "已配置 ✓" : "🔴 未配置（会直接报错）"}`);
  console.log("");
}

main();

rebuildWalkDistances(pool, { dry, force })
  .then((r) => {
    console.log(`需求组：${r.needs} 组 · 本轮抓取：${r.fetched} 组 · 耗时 ${r.ms}ms${r.budgetExceeded ? "（⏱ 超预算提前停止）" : ""}`);
    console.log(`高德调用：${r.amap.calls} 次（成功 ${r.amap.ok} · 失败 ${r.amap.failed}）`);
    if (Object.keys(r.amap.infocodes).length) {
      console.log(`错误码分布：${Object.entries(r.amap.infocodes).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
    }
    console.log("");
    console.log("── 坐标系健康度 ──");
    console.log(`  ${r.health.verdict}（n=${r.health.n} · P90=${r.health.snapP90}m）`);
    console.log("");
    if (r.rows.length) {
      console.log("── 本轮写入的距离 ──");
      console.log("  地点               座别   站点      距离      吸附(起/末)");
      for (const x of r.rows.slice(0, 40)) {
        console.log(
          `  ${x.placeSlug.padEnd(18)} ${String(x.zone ?? "—").padEnd(6)} ${x.stationMain.padEnd(8)} ` +
            `${String(x.distanceM).padStart(6)} m  ${x.snapStartM}/${x.snapEndM} m`,
        );
      }
      if (r.rows.length > 40) console.log(`  …还有 ${r.rows.length - 40} 组`);
      console.log("");
    }
    if (r.skipped.length) {
      const byReason = new Map<string, number>();
      for (const s of r.skipped) {
        const k = s.reason.replace(/（.*$/, "（…）");
        byReason.set(k, (byReason.get(k) ?? 0) + 1);
      }
      console.log("── 跳过原因汇总 ──");
      for (const [k, v] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  ${v} 组：${k}`);
      // 缺坐标的明细值得单独看（要人工补）
      const missing = r.skipped.filter((s) => s.reason.includes("缺"));
      if (missing.length) {
        console.log("");
        console.log("── 缺坐标明细（需人工补）──");
        for (const m of missing.slice(0, 30)) console.log(`  · ${m.placeSlug} / ${m.stationMain}${m.zone ? " / " + m.zone : ""}`);
        if (missing.length > 30) console.log(`  …共 ${missing.length} 条`);
      }
    }
    return pool.end();
  })
  .catch((e) => {
    console.error("✗ 失败：", e instanceof Error ? e.message : e);
    return pool.end().then(() => process.exit(1));
  });
