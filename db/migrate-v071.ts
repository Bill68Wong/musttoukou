/**
 * v0.8.0 增量迁移（db/migrate-v071.ts）
 * 用法：npm run db:migrate-v071 -- [local|cloud]
 *
 * 背景（2026-09-04 用户反馈：轻轨乘车无「下一站/途经站」、无法像巴士一样记录停站时间）：
 *   - 根因 1：route_stations 表此前只有巴士站序（DSAT 同步），轻轨三线 0 行
 *   - 根因 2：/api/timer/[id] 组装站序时硬编码 r.kind='bus'，把轻轨过滤掉（代码层另行修复）
 *   - 数据：补氹仔线 12 媽閣~17 路氹西 六站（stations 字典），并按官方站序
 *     （mlm.com.mo 核实）写入三线 lrtLineStops → route_stations：
 *       氹仔线 dir0=編號遞增向（媽閣→氹仔碼頭 13 站）、dir1 反向；
 *       石排灣線 協和醫院⇄石排灣（2 站）；橫琴線 蓮花⇄橫琴（2 站）
 *
 * ⚠️ 本脚本绝不 TRUNCATE / DELETE 计时数据。只做：stations upsert + LRT route_stations 重建（幂等）。
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

interface StationSeed {
  code: string | null;
  kind: "bus" | "lrt";
  name_tc: string;
  walk: Record<string, number | null>;
  note?: string;
}
interface LrtLineStop {
  code: string;
  dirs: Record<string, string[]>;
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

const net = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "data", "commute-network.json"), "utf8"),
) as {
  stations: StationSeed[];
  lrtLineStops: LrtLineStop[];
};

const stationCode = (s: StationSeed): string => s.code ?? `X-${s.name_tc}`;

async function main() {
  const pool = new Pool({
    connectionString: connStr,
    max: 1,
    ssl: (connStr as string).includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  const q = pool.query.bind(pool);

  try {
    // ---------- 1. 轻轨 stations 幂等 upsert（含 12 媽閣~17 路氹西 新站） ----------
    console.log("\n── 1/3 轻轨 stations upsert ──");
    const lrtStations = net.stations.filter((s) => s.kind === "lrt");
    let stationUpsert = 0;
    for (const s of lrtStations) {
      const code = stationCode(s);
      const res = await q(
        `INSERT INTO stations (code, name_tc, kind, dsat_synced, note)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (code) DO UPDATE SET name_tc = EXCLUDED.name_tc, note = EXCLUDED.note`,
        [code, s.name_tc, s.kind, s.code !== null, s.note ?? null],
      );
      stationUpsert += res.rowCount ?? 0;
    }
    console.log(`  ✅ stations upsert：${stationUpsert} 行（轻轨 ${lrtStations.length} 站）`);

    // ---------- 2. LRT route_stations 重建（幂等：先删 LRT 三线旧行再插） ----------
    console.log("\n── 2/3 LRT route_stations 站序重建 ──");
    const routeRows = (await q(`SELECT id, code, kind FROM routes`)).rows as {
      id: number;
      code: string;
      kind: string;
    }[];
    const idOf = new Map(routeRows.map((r) => [`${r.kind}:${r.code}`, r.id]));
    const lrtRouteIds = routeRows.filter((r) => r.kind === "lrt").map((r) => r.id);
    const delRes = await q(
      `DELETE FROM route_stations WHERE route_id = ANY($1::int[])`,
      [lrtRouteIds],
    );
    console.log(`  🗑 清除旧 LRT 站序：${delRes.rowCount ?? 0} 行`);

    let inserted = 0;
    const lineSummary: string[] = [];
    for (const line of net.lrtLineStops) {
      const routeId = idOf.get(`lrt:${line.code}`);
      if (!routeId) {
        console.log(`  ⚠️ 跳过未注册线路：${line.code}`);
        continue;
      }
      const stopsSeen = new Set<string>();
      for (const [dir, stops] of Object.entries(line.dirs)) {
        let seq = 0;
        for (const code of stops) {
          if (stopsSeen.has(`${dir}:${code}`)) continue; // 同方向内不重复
          stopsSeen.add(`${dir}:${code}`);
          await q(
            `INSERT INTO route_stations (route_id, dsat_dir, seq, station_code)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (route_id, dsat_dir, seq) DO UPDATE SET station_code = EXCLUDED.station_code`,
            [routeId, dir, ++seq, code],
          );
          inserted++;
        }
      }
      lineSummary.push(`${line.code} ${Object.entries(line.dirs).map(([d, s]) => `dir${d}=${s.length}站`).join(" / ")}`);
    }
    console.log(`  ✅ LRT 站序写入：${inserted} 行（${lineSummary.join("；")}）`);

    // ---------- 3. 校验 ----------
    console.log("\n── 3/3 校验 ──");
    const chk = (await q(
      `SELECT r.code, rs.dsat_dir, count(*)::int AS n,
              string_agg(rs.station_code, '→' ORDER BY rs.seq) AS seq
       FROM route_stations rs
       JOIN routes r ON rs.route_id = r.id
       WHERE r.kind = 'lrt'
       GROUP BY r.code, rs.dsat_dir ORDER BY r.code, rs.dsat_dir`,
    )).rows as { code: string; dsat_dir: string; n: number; seq: string }[];
    for (const c of chk) {
      console.log(`  ${c.code.padEnd(12)} dir${c.dsat_dir} | ${c.n} 站 | ${c.seq}`);
    }
    // 校验每条 lrtLineStops 里引用的站都存在于 stations
    const miss = await q(
      `SELECT DISTINCT rs.station_code AS c FROM route_stations rs
       JOIN routes r ON rs.route_id = r.id
       WHERE r.kind = 'lrt' AND NOT EXISTS (SELECT 1 FROM stations s WHERE s.code = rs.station_code)`,
    );
    if ((miss.rows as { c: string }[]).length > 0) {
      console.error(`  ❌ 存在未注册站码：${(miss.rows as { c: string }[]).map((r) => r.c).join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log("  ✅ 所有站码均已注册");
    }
    console.log("\n🎉 v0.8.0 增量迁移完成（计时数据未触碰）");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("❌ 迁移失败：", e.message);
  process.exit(1);
});
