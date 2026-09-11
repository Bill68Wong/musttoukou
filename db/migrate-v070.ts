/**
 * v0.7.0 增量迁移（db/migrate-v070.ts）
 * 用法：npm run db:migrate-v070 -- [local|cloud]
 *
 * 背景（2026-09-03 用户拍板，交通工具主题色 v0.7.0）：
 *   - routes 表新增 color 列：巴士=公司色（澳巴 #C26D32 / 新福利 #276299），轻轨=线路官方主题色
 *   - 巴士 company 归属修正为 DSAT 官方结果（51/51A/51B/26/26A/25B/25BS/102=新福利；50/56/701X/N6=澳巴）
 *   - 轻轨站点补全：官方编号（12-23/18A）与多语言名写入 commute-network.json；
 *     新增氹仔线中间站（19 東亞運）及备用全网络站（22 機場/23 氹仔碼頭）→ stations 幂等补齐
 *
 * ⚠️ 本脚本绝不 TRUNCATE / DELETE 计时数据（timer_sessions/timer_events/wait_snapshots…）。
 * 只做：加列（幂等）+ routes/stations 静态表 upsert。
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
  routes: { code: string; kind: string; company?: string; color?: string }[];
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
    // ---------- 1. 加列（幂等） ----------
    console.log("\n── 1/3 加列（幂等）──");
    await q(`ALTER TABLE routes ADD COLUMN IF NOT EXISTS color TEXT`);
    console.log("  ✅ routes.color 已就绪（巴士=公司色 / 轻轨=线路主题色）");

    // ---------- 2. stations 幂等 upsert（自愈，含新增轻轨站） ----------
    console.log("\n── 2/3 静态表 upsert ──");
    let stationUpsert = 0;
    for (const s of net.stations) {
      const code = stationCode(s);
      const res = await q(
        `INSERT INTO stations (code, name_tc, kind, dsat_synced, note)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (code) DO UPDATE SET name_tc = EXCLUDED.name_tc, note = EXCLUDED.note`,
        [code, s.name_tc, s.kind, s.code !== null, s.note ?? null],
      );
      stationUpsert += res.rowCount ?? 0;
    }
    console.log(`  ✅ stations upsert：${stationUpsert} 行（含 LRT-EAG 東亞運 / LRT-AP 機場 / LRT-TFT 氹仔碼頭）`);

    // ---------- 3. routes 归属 + 主题色 upsert ----------
    const routeRows = (await q(`SELECT id, code, kind FROM routes`)).rows as {
      id: number;
      code: string;
      kind: string;
    }[];
    const byKey = new Map(routeRows.map((r) => [`${r.kind}:${r.code}`, r.id]));
    let inserted = 0;
    let updated = 0;
    for (const r of net.routes) {
      const key = `${r.kind}:${r.code}`;
      const id = byKey.get(key);
      if (id === undefined) {
        const ins = await q(
          `INSERT INTO routes (code, kind, company, color) VALUES ($1,$2,$3,$4) RETURNING id`,
          [r.code, r.kind, r.company ?? null, r.color ?? null],
        );
        byKey.set(key, (ins.rows[0] as { id: number }).id);
        inserted++;
      } else {
        await q(`UPDATE routes SET company=$1, color=$2 WHERE id=$3`, [
          r.company ?? null,
          r.color ?? null,
          id,
        ]);
        updated++;
      }
    }
    console.log(`  ✅ routes 归属+主题色：新增 ${inserted} / 更新 ${updated}`);

    // ---------- 4. 校验 ----------
    console.log("\n── 3/3 校验 ──");
    const chk = (await q(`SELECT code, kind, company, color FROM routes ORDER BY kind, code`))
      .rows as { code: string; kind: string; company: string | null; color: string | null }[];
    for (const r of chk) {
      console.log(
        `  ${r.kind === "bus" ? "巴士" : "輕軌"} ${r.code.padEnd(12)} | ${(r.company ?? "—").padEnd(3)} | ${r.color ?? "—"}`,
      );
    }
    console.log("\n🎉 v0.7.0 增量迁移完成（计时数据未触碰）");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("❌ 迁移失败：", e.message);
  process.exit(1);
});
