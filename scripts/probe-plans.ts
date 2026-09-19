/** 只读：列出在用通勤方案（按 from→to 归组），核对哪些方向有候选 */
import { getPool } from "@/lib/db";

try {
  process.loadEnvFile();
} catch {
  /* ignore */
}

async function main() {
  const pool = getPool();
  const r = await pool.query(
    `SELECT pf.slug AS f, pt.slug AS t, count(*) AS n
       FROM commute_plans p
       JOIN places pf ON pf.id = p.from_place
       JOIN places pt ON pt.id = p.to_place
      WHERE p.is_active
      GROUP BY 1,2 ORDER BY 1,2`,
  );
  console.log("from→to 方案数：");
  for (const row of r.rows as { f: string; t: string; n: string }[]) {
    console.log(`  ${row.f} → ${row.t} : ${row.n}`);
  }
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
