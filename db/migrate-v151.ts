/**
 * v0.15.1 增量迁移（db/migrate-v151.ts）
 * 用法：npm run db:migrate-v151 -- [local|cloud]
 *
 * 归一 wait_snapshots 自动快照幂等索引到 schema 真相（2 值谓词）：
 *   本地影子库曾被并行会话改写为 4 值谓词（含 auto_lrt_depart/auto_lrt_wait_start），
 *   与现役代码（auto-snapshot / events 均用 source IN ('auto_depart','auto_wait_start')）
 *   的 ON CONFLICT 不匹配 → 本地巴士 auto 快照一直静默失败（50x 被 catch 吞掉）。
 *   本迁移 DROP 后按 schema.sql 规范重建，两端一致。幂等可重复执行。
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
  console.error("❌ 未找到连接串：请先在 .env 配置");
  process.exit(1);
}
console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);

async function main() {
  const pool = new Pool({ connectionString: connStr });
  try {
    await pool.query(`DROP INDEX IF EXISTS uq_wait_snap_auto_once`);
    await pool.query(`
      CREATE UNIQUE INDEX uq_wait_snap_auto_once
        ON wait_snapshots (session_id, source, station_code)
        WHERE source IN ('auto_depart', 'auto_wait_start')`);
    console.log("✅ uq_wait_snap_auto_once 已归一（2 值谓词，与 schema.sql / 现役代码一致）");
    const chk = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename='wait_snapshots' AND indexname='uq_wait_snap_auto_once'`,
    );
    console.log(chk.rows[0]);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ 迁移失败：", (err as Error).message);
  process.exit(1);
});
