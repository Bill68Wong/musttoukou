/**
 * 站名重同步抽查（scripts/check-station-sync.ts）
 * 用法：tsx scripts/check-station-sync.ts [local|cloud]
 * 抽查关键站站名 + 全量巴士站计数，供 C 节留档。
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
  console.error("❌ 未找到连接串");
  process.exit(1);
}

const pool = new Pool({
  connectionString: connStr,
  max: 1,
  ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  const codes = [
    "T358",
    "T373/1",
    "T373/2",
    "C652",
    "C688",
    "C690",
    "C653",
    "T374",
    "T417",
    "T429",
    "T400",
    "T367",
    "T355/2",
    "T560/4",
    "C651",
    "C691",
  ];
  const r = await pool.query(
    `SELECT code, name_tc, dsat_synced FROM stations WHERE code = ANY($1) ORDER BY code`,
    [codes],
  );
  for (const row of r.rows as { code: string; name_tc: string; dsat_synced: boolean }[]) {
    console.log(`${row.code.padEnd(8)} ${row.name_tc}  synced=${row.dsat_synced}`);
  }
  const c = await pool.query(
    `SELECT count(*) FILTER (WHERE dsat_synced) AS synced,
            count(*) AS total,
            count(*) FILTER (WHERE kind = 'bus') AS bus
     FROM stations`,
  );
  console.log("stats:", JSON.stringify(c.rows[0]));

  // 全部已同步巴士站写一份清单到 /tmp 供抽查留档
  const all = await pool.query(
    `SELECT code, name_tc FROM stations WHERE kind = 'bus' AND dsat_synced ORDER BY code`,
  );
  const fs = await import("fs");
  fs.writeFileSync(
    "/tmp/stations-synced.txt",
    (all.rows as { code: string; name_tc: string }[])
      .map((x) => `${x.code}\t${x.name_tc}`)
      .join("\n"),
    "utf8",
  );
  console.log("bus_synced_total=", (all.rows as unknown[]).length, "(清单已存 /tmp/stations-synced.txt)");
  await pool.end();
}

main().catch((e) => {
  console.error("❌ 抽查失败：", e.message);
  process.exit(1);
});
