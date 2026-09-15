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
    // ★ v1.0.2：4 → 12。`loadStatics` 一次性并行发 11 条查询，而原上限 5 会让它们**分两波建连**：
    //   线上函数执行在 iad1（美东）、主库在 ap-southeast-1（新加坡），每次冷启动建连 ~1.1s
    //   ⇒ 两波合计 ≈ 2.3s（线上实测 staticMs=2335ms）→ 首屏必然破 2 秒门槛。
    //   生产连的是 Supabase **Transaction Pooler（6543 / pgbouncer）**，提高上限是安全的
    //   —— pgbouncer 复用后端连接，并不会真的开 12 条到 Postgres。
    //   （v1.0.1 曾把桶并发提到 12，但静态层这条串行波次一直没治，故 v1.0.2 补上。）
    max: 12,
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
