/**
 * v0.11.0 增量迁移（db/migrate-v110.ts）
 * 用法：npm run db:migrate-v110 -- [local|cloud]
 *
 * 背景（2026-09-04 数据采集与数据库优化 Batch3 B2）：
 *   fleet-snapshot 已升级为 OD 派生（同 from_place/to_place 各方案首个巴士段主线路+各自上车站，
 *   见 src/lib/dsat/fleet-snapshot.ts），commute_plans.compare_routes 冗余来源消除 → 删列。
 *   - 只删列，不触碰任何行数据；历史 migrate 脚本保留不动（幂等已跑）。
 *   - schema.sql / db/seed.ts / data/commute-network.json 同步移除该字段（种子源对齐）。
 *
 * 幂等：列存在才删（DO $$ ... IF EXISTS 无法用于 ALTER COLUMN，用 information_schema 判断）。
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const target = process.argv[2] as "local" | "cloud" | undefined;
const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? process.env.DATABASE_URL_LOCAL
      : (process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL);

if (!connStr) {
  console.error("❌ 未找到连接串：请先在 .env 配置（参照 .env.example）");
  process.exit(1);
}
const masked = connStr.replace(/:[^:@/]+@/, ":****@");
console.log(`目标库：${masked}`);

async function main() {
  const pool = new Pool({
    connectionString: connStr,
    max: 1,
    ssl: (connStr as string).includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  const q = pool.query.bind(pool);

  try {
    console.log("\n── B2 commute_plans.compare_routes 删列 ──");
    const exists = (await q(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'commute_plans' AND column_name = 'compare_routes'`,
    )).rowCount ?? 0;
    if (exists > 0) {
      await q(`ALTER TABLE commute_plans DROP COLUMN compare_routes`);
      console.log("  ✅ compare_routes 列已删除");
    } else {
      console.log("  ℹ️ compare_routes 列不存在（已删或从未存在），跳过");
    }

    // 校验：列确认消失
    const after = (await q(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'commute_plans' AND column_name = 'compare_routes'`,
    )).rows[0] as { n: number };
    const plans = (await q(
      `SELECT id, plan_key, summary FROM commute_plans WHERE is_active ORDER BY id`,
    )).rows as { id: number; plan_key: string; summary: string }[];
    console.log(`  校验：compare_routes 残留列数=${after.n}（应为 0）；active 方案=${plans.length} 张（未触碰）`);
    if (after.n !== 0) {
      console.error("❌ 校验未通过：列仍存在");
      process.exitCode = 1;
    } else {
      console.log("✅ v0.11.0 迁移完成（compare_routes 已移除，方案数据未变）");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("❌ 迁移失败：", e.message);
  process.exit(1);
});
