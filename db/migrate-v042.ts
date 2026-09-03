/**
 * v0.4.2 增量迁移（db/migrate-v042.ts）
 * 用法：npm run db:migrate-v042 -- [local|cloud]
 *
 * 背景（多段方案 E2E 暴露的 bug）：wait_snapshots 幂等唯一索引只按 (session_id, source)
 * 分键，多段方案（如 home-hengqin-1）第二段在另一上车站的 wait_start 触发 auto_wait_start
 * 时，与第一段同 source 的行冲突 → ON CONFLICT DO NOTHING 被丢弃，第二段车距永久缺失。
 *
 * 本脚本做三件事（⚠️ 绝不动计时数据本身，只动结构）：
 *   1. wait_snapshots 加 station_code 列（幂等）
 *   2. 从 timer_events 回填既有自动记录行的上车站（depart↔auto_depart / wait_start↔auto_wait_start，
 *      取该会话最早一条带站的事件，多段遗留会话也只会命中第一段——正是当时落库的那一段）
 *   3. 重建唯一索引为 (session_id, source, station_code)，同一自动时刻可在不同上车站各记一条
 *
 * DDL 全部包在一个事务里，DANGER 窗口内（DROP→CREATE 之间）不会有并发写绕过约束。
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ---------- 1. 加列 ----------
    console.log("\n── 1/3 加列（幂等）──");
    await client.query(`ALTER TABLE wait_snapshots ADD COLUMN IF NOT EXISTS station_code TEXT`);
    console.log("  ✅ wait_snapshots.station_code 已就绪");

    // ---------- 2. 回填既有自动记录的上车站（best-effort） ----------
    console.log("\n── 2/3 回填既有自动记录 station_code ──");
    const backfill = await client.query(
      `UPDATE wait_snapshots ws
       SET station_code = sub.station_code
       FROM (
         SELECT ws2.id AS ws_id,
                (SELECT te.station_code
                 FROM timer_events te
                 WHERE te.session_id = ws2.session_id
                   AND te.event_type = CASE ws2.source
                       WHEN 'auto_depart' THEN 'depart'
                       WHEN 'auto_wait_start' THEN 'wait_start'
                     END
                   AND te.station_code IS NOT NULL
                 ORDER BY te.seq
                 LIMIT 1) AS station_code
         FROM wait_snapshots ws2
         WHERE ws2.source IN ('auto_depart', 'auto_wait_start')
           AND ws2.station_code IS NULL
       ) sub
       WHERE ws.id = sub.ws_id AND sub.station_code IS NOT NULL`,
    );
    console.log(`  ✅ 回填 ${backfill.rowCount ?? 0} 行`);

    // ---------- 3. 重建唯一索引（(session_id, source) → (session_id, source, station_code)） ----------
    console.log("\n── 3/3 重建幂等唯一索引 ──");
    await client.query(`DROP INDEX IF EXISTS uq_wait_snap_auto_once`);
    await client.query(
      `CREATE UNIQUE INDEX uq_wait_snap_auto_once
         ON wait_snapshots (session_id, source, station_code)
         WHERE source IN ('auto_depart', 'auto_wait_start')`,
    );
    console.log("  ✅ 新索引 (session_id, source, station_code) 已生效");

    await client.query("COMMIT");

    // ---------- 校验（⚠️ 走同一 client：pool max:1 时连接被占用，pool.query 会永久排队） ----------
    const summary = await client.query(
      `SELECT source,
              count(*)::int AS total,
              count(station_code)::int AS with_station
       FROM wait_snapshots
       WHERE source IN ('auto_depart', 'auto_wait_start')
       GROUP BY source ORDER BY source`,
    );
    console.log("\n── 校验 ──");
    for (const r of summary.rows as { source: string; total: number; with_station: number }[]) {
      console.log(`  ${r.source.padEnd(16)} 共 ${r.total} 条 · 已带站 ${r.with_station}`);
    }
    const idx = await client.query(
      `SELECT indexdef FROM pg_indexes
       WHERE indexname = 'uq_wait_snap_auto_once'`,
    );
    console.log(`  ${(idx.rows[0] as { indexdef: string }).indexdef}`);
    console.log("\n🎉 v0.4.2 迁移完成（计时数据未触碰）");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("❌ 迁移失败：", e.message);
  process.exit(1);
});
