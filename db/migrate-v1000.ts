/**
 * v1.0.0 数据迁移（db/migrate-v1000.ts）—— 幂等
 * 用法：npm run db:migrate-v1000 -- [local|cloud]
 *
 * 唯一变更：新建 `transfer_walks`（换乘步行时长派生表）。
 *
 * 为什么需要这张表：
 *   自动选线的换乘方案（例：石排灣 → 科大 = LRT-石排湾线@LRT-SPW → LRT-UH → LRT-氹仔线 → LRT-MUST）
 *   在总耗时里必须计入「下车站走到下一段上车站」的时间。此前该耗时**零打点零存储**：
 *   timer_events 里已有 alight（下车）与 wait_start（到站开始等车）两个真实打点，
 *   但从来没有人把它们之间的差值算出来落表 → 换乘方案只能拍一个常数（3 分钟）。
 *   本表把「alight → 紧随的 wait_start」实测间隔沉淀下来，让换乘耗时从估变成测。
 *
 * ★ 纯新增表，不改动任何既有表/列/行（对线上老路径零影响，可安全在生产先建）。
 * ★ 与 walk_times 的分工：walk_times 管「地点 ↔ 站」的手/脚路程；本表管「站 ↔ 站」的换乘路程。
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const target = (process.argv[2] ?? "cloud") as "local" | "cloud";
const dbUrl = target === "cloud" ? process.env.DATABASE_URL : (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);
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
const q = async (sql: string, args?: unknown[]) =>
  (await pool.query(sql, args)).rows as Record<string, unknown>[];

const DDL = `
CREATE TABLE IF NOT EXISTS transfer_walks (
    id           SERIAL PRIMARY KEY,
    from_station TEXT NOT NULL REFERENCES stations(code),  -- 下车站（实测原始站台码，如 T355/1）
    to_station   TEXT NOT NULL REFERENCES stations(code),  -- 换乘上车站（实测原始站台码）
    minutes      NUMERIC(5,1),              -- 实测均值；NULL = 尚未实测
    samples      INT NOT NULL DEFAULT 0,    -- 实测样本数（1~2 次也写入，靠此列体现可信度）
    source       TEXT NOT NULL DEFAULT 'timer',
    measured_at  DATE,                      -- 最近一次样本日期
    UNIQUE (from_station, to_station)
)`;

async function main() {
  console.log(`=== v1.0.0 迁移（${target}）`);

  const before = await q(
    `SELECT to_regclass('public.transfer_walks')::text AS t`,
  );
  const existed = before[0]?.t !== null && before[0]?.t !== undefined;
  console.log(`① transfer_walks 表：${existed ? "已存在（跳过建表）" : "不存在 → 创建"}`);

  await q(DDL);
  await q(`CREATE INDEX IF NOT EXISTS idx_transfer_walks_from ON transfer_walks(from_station)`);

  // 列自检：确认结构与读端契约一致（列名/类型不匹配时早报，别等到跑推荐才炸）
  const cols = await q(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'transfer_walks' ORDER BY ordinal_position`,
  );
  console.log("② 列结构：");
  for (const c of cols) {
    console.log(`   ${String(c.column_name).padEnd(14)} ${String(c.data_type).padEnd(18)} nullable=${c.is_nullable}`);
  }

  const n = await q(`SELECT count(*)::int AS n, COALESCE(sum(samples),0)::int AS total FROM transfer_walks`);
  console.log(`③ 现状：${n[0].n} 行 / ${n[0].total} 个样本`);
  console.log(`   （新表初始为空属正常 —— 派生由 npm run db:transferwalks 或每日 Cron 填充）`);

  console.log(`\n✅ v1.0.0 迁移完成（${target}）`);
  await pool.end();
}

main().catch((e) => {
  console.error("迁移失败：", e);
  process.exit(1);
});
