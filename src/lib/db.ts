/**
 * 数据库连接（src/lib/db.ts）
 * 连接串来自 .env：本地开发用 DATABASE_URL_LOCAL，云端生产用 DATABASE_URL
 * 惰性初始化：导入本模块不建立连接，首次使用才连（便于无数据库环境下跑纯接口测试）
 */
import { Pool } from "pg";

const globalForDb = globalThis as unknown as { pgPool?: Pool };

/** 解析连接串（按环境优先级）；可能为 undefined（未配置） */
function resolveConnStr(): string | undefined {
  return (
    (process.env.NODE_ENV === "production"
      ? process.env.DATABASE_URL
      : process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL) || undefined
  );
}

/** 获取连接池单例；未配置连接串时抛出可读错误 */
export function getPool(): Pool {
  if (globalForDb.pgPool) return globalForDb.pgPool;

  const connStr = resolveConnStr();
  if (!connStr) {
    throw new Error(
      "缺少数据库连接串：请在 .env 中配置 DATABASE_URL / DATABASE_URL_LOCAL（参照 .env.example）",
    );
  }
  const pool = new Pool({
    connectionString: connStr,
    max: 5,
    ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  globalForDb.pgPool = pool;
  return pool;
}

/** 便捷查询 */
export async function query<T = unknown>(
  text: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const res = await getPool().query(text, params);
  return { rows: res.rows as T[], rowCount: res.rowCount };
}

export default getPool;
