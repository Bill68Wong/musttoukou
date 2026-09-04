/**
 * v0.10.0 增量迁移（db/migrate-v100.ts）
 * 用法：npm run db:migrate-v100 -- [local|cloud]
 *
 * 背景（2026-09-04 数据采集与数据库优化 Batch2）：
 *   A10 is_test 测试标记：
 *      - timer_sessions 加 is_test BOOLEAN NOT NULL DEFAULT false（测试模式运行自动写 true）
 *      - 回填：deleted_at 非空的会话（= 已被前端软删的测试/无效数据，103 条云端）→ is_test = true
 *        —— 真实样本 = deleted_at IS NULL 的会话（云端 5 条），一律 is_test = false 绝不触碰
 *      - 统计/记录/导出/首页样本数默认排除 is_test = true（提供「含测试」偏好开关）
 *   A8 事件幂等（tap_id）：
 *      - timer_events 加 tap_id TEXT（客户端每个关键打点一次生成、网络失败重试复用同 id）
 *      - 部分唯一索引 (session_id, tap_id) WHERE tap_id IS NOT NULL（多 NULL 不冲突，兼容旧客户端）
 *      - events API 幂等消费：同 (session_id, tap_id) 已存在 → 返回 dedup 不双写、missed 不重复 +1
 *
 * ⚠️ 安全断言：回填只写 deleted_at IS NOT NULL 的会话；deleted_at IS NULL 的真实会话保持 false。
 * 幂等：可重复执行（ADD COLUMN IF NOT EXISTS / 先 DROP 再 CREATE 索引）。
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
    // ---------- A10 is_test 列 + 回填 ----------
    console.log("\n── A10 timer_sessions.is_test ──");
    await q(`ALTER TABLE timer_sessions ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false`);
    // 真实会话（未删）前置断言：必须 0 条被误标（正常状态下回填前应无 is_test=true 的未删会话）
    const realBefore = (await q(
      `SELECT count(*)::int AS n FROM timer_sessions WHERE deleted_at IS NULL AND is_test = true`,
    )).rows[0] as { n: number };
    console.log(`  回填前：未删且 is_test=true 的会话数=${realBefore.n}（必须为 0）`);
    if (realBefore.n > 0) {
      throw new Error("❌ 存在未删会话已被标 is_test=true，拒绝继续（先人工核对）！");
    }
    const fill = await q(
      `UPDATE timer_sessions SET is_test = true WHERE deleted_at IS NOT NULL AND is_test = false`,
    );
    console.log(`  ✅ 软删会话回填 is_test=true：${fill.rowCount ?? 0} 行`);
    const sessStat = (await q(
      `SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS real_n,
              count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted_n,
              count(*) FILTER (WHERE is_test)::int AS test_n,
              count(*) FILTER (WHERE deleted_at IS NULL AND is_test)::int AS real_test_n
       FROM timer_sessions`,
    )).rows[0] as { real_n: number; deleted_n: number; test_n: number; real_test_n: number };
    console.log(
      `  会话分布：未删=${sessStat.real_n}（真实样本，全部 is_test=false）／软删=${sessStat.deleted_n}／is_test=true=${sessStat.test_n}／误标(未删+test)=${sessStat.real_test_n}`,
    );
    if (sessStat.real_test_n !== 0) {
      throw new Error("❌ 校验失败：存在未删会话被标为测试，真实样本被误伤！");
    }

    // ---------- A8 tap_id 列 + 唯一索引 ----------
    console.log("\n── A8 timer_events.tap_id 幂等 ──");
    await q(`ALTER TABLE timer_events ADD COLUMN IF NOT EXISTS tap_id TEXT`);
    await q(`DROP INDEX IF EXISTS uq_events_session_tap`);
    await q(
      `CREATE UNIQUE INDEX uq_events_session_tap
       ON timer_events (session_id, tap_id)
       WHERE tap_id IS NOT NULL`,
    );
    const evtStat = (await q(
      `SELECT count(*)::int AS n, count(tap_id)::int AS with_tap FROM timer_events`,
    )).rows[0] as { n: number; with_tap: number };
    console.log(`  ✅ 唯一索引 uq_events_session_tap 就绪；事件总数=${evtStat.n}，带 tap_id=${evtStat.with_tap}`);

    // ---------- 校验 ----------
    console.log("\n── 校验 ──");
    const kept = (await q(
      `SELECT count(*)::int AS n FROM timer_sessions WHERE deleted_at IS NULL AND NOT is_test`,
    )).rows[0] as { n: number };
    const wronglyTest = (await q(
      `SELECT count(*)::int AS n FROM timer_sessions WHERE deleted_at IS NULL AND is_test`,
    )).rows[0] as { n: number };
    console.log(`  真实样本(未删且非测试)数=${kept.n}（应保持为迁移前未删数）；误标=${wronglyTest.n}（应为 0）`);
    if (wronglyTest.n !== 0) {
      console.error("❌ 校验未通过：真实样本被误标");
      process.exitCode = 1;
    } else {
      console.log("✅ v0.10.0 迁移完成（真实样本未触碰）");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("❌ 迁移失败：", e.message);
  process.exit(1);
});
