/**
 * v0.22.0 数据迁移（db/migrate-v220.ts）—— 幂等
 * 用法：npm run db:migrate-v220 -- [local|cloud]
 *
 * segment_stats 增加 arrive_kind 档位列：
 *   stop —— 起点站是「停靠」（station_arrive / stop_arrive）
 *           该段时长 = 停站时间 + 行驶时间 = 乘客感知的实际到站间隔
 *   pass —— 起点站是「甩站」（station_pass / stop_pass）
 *           车没停，该段时长最接近纯行驶时间（乘客点按钮时车正经过站台，时刻真实）
 *   all  —— 两者合并，样本不足时兜底
 *
 * 背景：甩站的时刻是真实可用的时间数据（车经过站台那一刻），此前被与
 * 「忘记打卡」（station_skip / stop_skip，无真实时刻）混为一谈而丢弃。
 * 两档一减即可反推停站耗时（实测 26 路 T380→T379：停靠出发 0.9 分 vs 甩站出发 0.5 分
 * → 停站约 0.4 分）。
 *
 * 唯一约束从 (route, from, to, weekday, time_bucket) 扩为含 arrive_kind。
 * 幂等：列与约束均先探测后建，重复运行无副作用。
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const target = (process.argv[2] ?? "local") as "local" | "cloud";
const dbUrl = target === "cloud" ? process.env.DATABASE_URL : process.env.DATABASE_URL_LOCAL;
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

async function main() {
  const before = await q(
    `SELECT count(*)::int n FROM information_schema.columns
      WHERE table_name = 'segment_stats' AND column_name = 'arrive_kind'`,
  );
  console.log(`① segment_stats 现状：${(await q(`SELECT count(*)::int n FROM segment_stats`))[0].n} 行`);

  // —— ① 加列 ——
  if ((before[0].n as number) > 0) {
    console.log("② arrive_kind 列已存在 → 跳过");
  } else {
    await pool.query(
      `ALTER TABLE segment_stats ADD COLUMN arrive_kind TEXT NOT NULL DEFAULT 'all'`,
    );
    console.log("② 已新增 arrive_kind 列（NOT NULL DEFAULT 'all'）");
  }
  await pool.query(
    `COMMENT ON COLUMN segment_stats.arrive_kind IS
     '起点站的到站类型：stop=停靠（段含停站时间）| pass=甩站（≈纯行驶）| all=合并兜底'`,
  ).catch(() => {});

  // —— ② 唯一约束改造：去掉旧约束，建含 arrive_kind 的新约束 ——
  const old = await q(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'segment_stats'::regclass AND contype = 'u'
        AND pg_get_constraintdef(oid) LIKE '%route_code%from_station%to_station%weekday%time_bucket%'
        AND pg_get_constraintdef(oid) NOT LIKE '%arrive_kind%'`,
  );
  for (const r of old) {
    await pool.query(`ALTER TABLE segment_stats DROP CONSTRAINT "${r.conname}"`);
    console.log(`③ 已移除旧唯一约束 ${r.conname}`);
  }
  const neu = await q(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'segment_stats'::regclass AND contype = 'u'
        AND pg_get_constraintdef(oid) LIKE '%arrive_kind%'`,
  );
  if (!neu.length) {
    await pool.query(
      `ALTER TABLE segment_stats
         ADD CONSTRAINT segment_stats_uniq
         UNIQUE (route_code, from_station, to_station, weekday, time_bucket, arrive_kind)`,
    );
    console.log("③ 已建立新唯一约束 segment_stats_uniq（含 arrive_kind）");
  } else {
    console.log(`③ 新唯一约束已存在（${neu.map((r) => r.conname).join(", ")}）→ 跳过`);
  }
  if (!old.length && !neu.length) console.log("③ 约束无需变更");

  // —— ③ 索引：按 (route_code, arrive_kind) 查询友好 ——
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_segment_stats_route_kind
       ON segment_stats (route_code, arrive_kind)`,
  );
  console.log("④ 索引 idx_segment_stats_route_kind 就绪");

  // —— ④ 核对 ——
  const cols = await q(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_name = 'segment_stats'
      ORDER BY ordinal_position`,
  );
  console.log("\n核对 · segment_stats 列：");
  for (const c of cols)
    console.log(
      `   ${String(c.column_name).padEnd(14)} ${String(c.data_type).padEnd(18)} null=${c.is_nullable} def=${c.column_default ?? "-"}`,
    );
  const cons = await q(
    `SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint
      WHERE conrelid = 'segment_stats'::regclass ORDER BY contype`,
  );
  console.log("\n核对 · 约束：");
  for (const c of cons) console.log(`   ${c.conname}: ${c.def}`);
  const dist = await q(
    `SELECT arrive_kind, count(*)::int n, coalesce(sum(samples),0)::int s
       FROM segment_stats GROUP BY arrive_kind ORDER BY arrive_kind`,
  );
  console.log("\n核对 · 分档数据（迁移前应全为 all 或为空）：");
  if (!dist.length) console.log("   表为空");
  for (const d of dist) console.log(`   ${d.arrive_kind}: ${d.n} 行 / ${d.s} 条样本`);

  console.log(`\n✅ v0.22.0 迁移完成（${target}）`);
  await pool.end();
}

main().catch((e) => {
  console.error("迁移失败：", e);
  process.exit(1);
});
