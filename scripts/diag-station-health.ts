/**
 * 站序数据体检（scripts/diag-station-health.ts）
 * 调研任务 #67：route_stations / stations 完整性体检
 * 检查项：① 每线路 dir 覆盖与行数 ② LRT 34 行是否保留 ③ 幽灵站码（站序引用了不存在的站）
 *         ④ 重复 seq / seq 空洞 ⑤ 核心线首末站抽查 ⑥ stations 表占位码 X- ⑦ json 与库对照
 * 用法：npx tsx scripts/diag-station-health.ts [local|cloud]
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
      ? (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL)
      : ((process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL) || process.env.DATABASE_URL);
if (!connStr) {
  console.error("❌ 未找到连接串");
  process.exit(1);
}
const masked = connStr.replace(/:[^:@/]+@/, ":****@");
console.log(`目标库：${masked}\n`);

const pool = new Pool({
  connectionString: connStr,
  max: 1,
  ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
});

const net = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "data", "commute-network.json"), "utf8"),
) as {
  routes: { code: string; kind: string; name?: string }[];
};

async function q(sql: string, params?: unknown[]) {
  return (await pool.query(sql, params as never[])).rows;
}

async function main() {
  // ① 每线路 dir 覆盖与行数（含 LRT）
  const perRoute = await q(`
    SELECT r.code, r.kind, rs.dsat_dir, COUNT(*) AS n,
           MIN(rs.seq) AS min_seq, MAX(rs.seq) AS max_seq
    FROM routes r
    LEFT JOIN route_stations rs ON rs.route_id = r.id
    GROUP BY r.code, r.kind, rs.dsat_dir
    ORDER BY r.kind, r.code, rs.dsat_dir`);
  console.log("══ ① 每线路 dir 覆盖与行数 ══");
  let busTotal = 0, lrtTotal = 0;
  for (const row of perRoute) {
    if (row.n === null) {
      console.log(`  ${row.kind==='bus'?'🚌':'🚈'} ${row.code.padEnd(8)} (${row.kind})  ⚠️ 无任何站序`);
      continue;
    }
    if (row.kind === "bus") busTotal += +row.n; else lrtTotal += +row.n;
    const dirLabel = row.dsat_dir === "0" ? "正向" : row.dsat_dir === "1" ? "回程" : `dir=${row.dsat_dir}`;
    console.log(`  ${row.kind==='bus'?'🚌':'🚈'} ${row.code.padEnd(8)} ${dirLabel.padEnd(5)} seq=${String(row.min_seq).padStart(3)}..${String(row.max_seq).padStart(3)}  ${row.n} 站`);
  }
  console.log(`  —— 合计：bus ${busTotal} 行 + lrt ${lrtTotal} 行（预期 471 + 34）`);

  // ② 站点表总览
  const st = await q(`SELECT kind, COUNT(*) n, SUM((code LIKE 'X-%')::int) AS placeholder
                      FROM stations GROUP BY kind ORDER BY kind`);
  console.log("\n══ stations 表总览 ══");
  for (const row of st) console.log(`  ${row.kind}: ${row.n} 个（占位码 X-: ${row.placeholder}）`);

  // ③ 幽灵站码：站序引用 stations 不存在的
  const ghost = await q(`
    SELECT DISTINCT rs.station_code, rs.route_id, r.code
    FROM route_stations rs JOIN routes r ON r.id = rs.route_id
    LEFT JOIN stations s ON s.code = rs.station_code
    WHERE s.code IS NULL`);
  console.log(`\n══ ③ 幽灵站码（route_stations 引用缺失站）══  ${ghost.length ? "" : "✅ 无"}`);
  for (const g of ghost) console.log(`  ⚠️ ${g.station_code}（route ${g.code}）`);

  // ④a 同 (route_id, dsat_dir, seq) 重复
  const dup = await q(`
    SELECT rs.route_id, r.code, rs.dsat_dir, rs.seq, COUNT(*) n
    FROM route_stations rs JOIN routes r ON r.id = rs.route_id
    GROUP BY rs.route_id, r.code, rs.dsat_dir, rs.seq HAVING COUNT(*) > 1
    ORDER BY r.code, rs.dsat_dir, rs.seq`);
  console.log(`\n══ ④a 同线同dir同seq重复 ══  ${dup.length ? "" : "✅ 无"}`);
  for (const d of dup) console.log(`  ⚠️ ${d.code} dir=${d.dsat_dir} seq=${d.seq} ×${d.n}`);

  // ④b seq 空洞（连续站序应 1..N 无缺号）
  const holes = await q(`
    WITH rec AS (
      SELECT r.code, rs.dsat_dir, rs.seq,
             LAG(rs.seq) OVER (PARTITION BY r.id, rs.dsat_dir ORDER BY rs.seq) AS prev
      FROM route_stations rs JOIN routes r ON r.id = rs.route_id
    )
    SELECT DISTINCT code, dsat_dir, prev, seq FROM rec
    WHERE prev IS NOT NULL AND seq <> prev + 1 ORDER BY code, dsat_dir, prev`);
  console.log(`\n══ ④b seq 空洞（前值+1≠当前）══  ${holes.length ? "" : "✅ 无"}`);
  for (const h of holes) console.log(`  ⚠️ ${h.code} dir=${h.dsat_dir} 缺 seq ${h.prev + 1}（${h.prev}→${h.seq}）`);

  // ⑤ 核心线路首末站与用户关注站抽查
  const focus = ["26", "50", "51", "51A", "51B", "25B", "MT1", "N6", "701X", "56", "25BS", "102"];
  console.log("\n══ ⑤ 核心线首末站抽查 ══");
  for (const code of focus) {
    const rows = await q(`
      SELECT rs.dsat_dir, rs.seq, rs.station_code, s.name_tc
      FROM route_stations rs
      JOIN routes r ON r.id = rs.route_id AND r.code = $1
      JOIN stations s ON s.code = rs.station_code
      ORDER BY rs.dsat_dir, rs.seq`, [code]);
    if (!rows.length) { console.log(`  ${code}: ⚠️ 无站序`); continue; }
    const byDir = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!byDir.has(r.dsat_dir)) byDir.set(r.dsat_dir, []);
      byDir.get(r.dsat_dir)!.push(r);
    }
    for (const [dir, stops] of byDir) {
      const first = stops[0], last = stops[stops.length - 1];
      console.log(`  ${code} dir=${dir} ${stops.length}站  首:${first.seq}=${first.station_code} ${first.name_tc}  末:${last.seq}=${last.station_code} ${last.name_tc}`);
    }
  }

  // ⑥ 特别抽检：科大相关站码在各线的存在与 seq（T358/T373/T560/C690/C689/T363）
  const uniStations = ["T358", "T373", "T560", "C690", "C689", "T363", "M95"];
  console.log("\n══ ⑥ 科大/宿舍相关站码出现位置 ══");
  for (const sc of uniStations) {
    const rows = await q(`
      SELECT r.code, rs.dsat_dir, rs.seq FROM route_stations rs
      JOIN routes r ON r.id = rs.route_id
      WHERE rs.station_code = $1 ORDER BY r.code, rs.dsat_dir, rs.seq`, [sc]);
    const pos = rows.map((x) => `${x.code}/d${x.dsat_dir}@${x.seq}`).join("  ") || "❌ 不存在";
    console.log(`  ${sc}: ${pos}`);
  }

  // ⑦ json routes 与库对照
  console.log("\n══ ⑦ commute-network.json 与库对照 ══");
  for (const r of net.routes) {
    const db = await q(`SELECT id FROM routes WHERE code = $1 AND kind = $2`, [r.code, r.kind]);
    if (!db.length) console.log(`  ⚠️ json 有库无: ${r.code} (${r.kind})`);
  }
  const dbRoutes = await q(`SELECT code, kind FROM routes ORDER BY kind, code`);
  const jsonKeys = new Set(net.routes.map((r) => `${r.kind}:${r.code}`));
  for (const r of dbRoutes) {
    if (!jsonKeys.has(`${r.kind}:${r.code}`)) console.log(`  ℹ️ 库有 json 无: ${r.code} (${r.kind})`);
  }
  console.log("  ✅ 对照完成（上方无 ⚠️ 即一致）");

  await pool.end();
}

main().catch(async (e) => {
  console.error("❌", e.message);
  process.exit(1);
});
