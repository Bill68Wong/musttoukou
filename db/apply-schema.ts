/**
 * 建表脚本执行器（db/apply-schema.ts）
 * 用法：
 *   npm run db:schema -- local   # 应用到本地 PostgreSQL（DATABASE_URL_LOCAL）
 *   npm run db:schema -- cloud   # 应用到 Supabase 云库（DATABASE_URL）
 *   npm run db:schema            # 用 DATABASE_URL_LOCAL，没有则用 DATABASE_URL
 */
import { readFileSync } from "fs";
import { join } from "path";
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
  console.error(
    "❌ 未找到连接串：请在 .env 中配置 DATABASE_URL / DATABASE_URL_LOCAL（参照 .env.example）",
  );
  process.exit(1);
}

const masked = connStr.replace(/:[^:@/]+@/, ":****@");
console.log(`目标库：${masked}`);

async function main() {
  const pool = new Pool({
    connectionString: connStr,
    max: 1,
    ssl: (connStr as string).includes("supabase")
      ? { rejectUnauthorized: false }
      : undefined,
  });
  const sql = readFileSync(join(import.meta.dirname, "schema.sql"), "utf8");
  try {
    await pool.query(sql);
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    console.log(`✅ 建表完成，共 ${rows.length} 张表：`);
    console.log("   " + rows.map((r) => r.table_name).join(", "));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("❌ 建表失败：", e.message);
  process.exit(1);
});
