/**
 * v0.24.0 数据迁移（db/migrate-v0240.ts）—— 幂等
 * 用法：npm run db:migrate-v0240 -- [local|cloud]
 *
 * 目标：剔除项目初期的手工步行估算值，全面改用实测数据；澳科大 B/C、N/O、R
 * 三座严格区分为独立目的地/出发地。
 *
 * 改动：
 *   ① 清空 plan_legs.minutes（walk 段与 transfer 段的手工估算值）
 *      —— 同场换乘判定改为「站码相同 + 非轻轨前缀」，不再依赖 minutes=0 标记位
 *   ② 清空 walk_times（10 行全为 source='manual'，由 scripts/rebuild-walk-times.ts 重灌实测）
 *   ③ walk_times 增加 zone 列（NULL=不分校区 | 'B/C' | 'N/O' | 'R'，仅澳科大 place 有意义）
 *   ④ walk_times 增加 samples 列（实测样本数，1~2 次也写入，靠此列体现可信度）
 *   ⑤ walk_times.source 默认值 'manual' → 'timer'
 *   ⑥ 唯一约束 (place_id, station_code) → (place_id, station_code, zone)
 *
 * 幂等：清空天然幂等；列与约束均先探测后建，重复运行无副作用。
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
  console.log(`=== v0.24.0 迁移（${target}）`);

  // —— ① 清空 plan_legs.minutes（walk + transfer 的手工估算值）——
  const beforeLegs = await q(
    `SELECT count(*)::int n FROM plan_legs WHERE minutes IS NOT NULL`,
  );
  console.log(`① plan_legs.minutes 非空现状：${beforeLegs[0].n} 条`);
  const upd = await pool.query(
    `UPDATE plan_legs SET minutes = NULL
      WHERE leg_kind IN ('walk','transfer') AND minutes IS NOT NULL`,
  );
  console.log(`① 已清空 ${upd.rowCount} 条（walk + transfer 段）`);

  // —— ② 清空 walk_times（全部为手工值）——
  const beforeWalk = await q(`SELECT count(*)::int n FROM walk_times`);
  console.log(`② walk_times 现状：${beforeWalk[0].n} 行`);
  const del = await pool.query(`DELETE FROM walk_times`);
  console.log(`② 已清空 ${del.rowCount} 行（由 db:walktimes 重灌实测）`);

  // —— ③ 加 zone 列 ——
  const hasZone = await q(
    `SELECT count(*)::int n FROM information_schema.columns
      WHERE table_name = 'walk_times' AND column_name = 'zone'`,
  );
  if ((hasZone[0].n as number) > 0) {
    console.log("③ zone 列已存在 → 跳过");
  } else {
    await pool.query(`ALTER TABLE walk_times ADD COLUMN zone TEXT`);
    console.log("③ 已新增 zone 列");
  }
  await pool.query(
    `COMMENT ON COLUMN walk_times.zone IS
     '澳科大校区：B/C | N/O | R；非澳科大 place 为 NULL（不分校区）'`,
  ).catch(() => {});

  // —— ④ 加 samples 列 ——
  const hasSamples = await q(
    `SELECT count(*)::int n FROM information_schema.columns
      WHERE table_name = 'walk_times' AND column_name = 'samples'`,
  );
  if ((hasSamples[0].n as number) > 0) {
    console.log("④ samples 列已存在 → 跳过");
  } else {
    await pool.query(`ALTER TABLE walk_times ADD COLUMN samples INT NOT NULL DEFAULT 0`);
    console.log("④ 已新增 samples 列（NOT NULL DEFAULT 0）");
  }
  await pool.query(
    `COMMENT ON COLUMN walk_times.samples IS
     '实测样本数（1~2 次也写入，靠此列体现可信度）'`,
  ).catch(() => {});

  // —— ⑤ source 默认值 manual → timer ——
  await pool.query(`ALTER TABLE walk_times ALTER COLUMN source SET DEFAULT 'timer'`);
  console.log("⑤ walk_times.source 默认值已改为 'timer'");

  // —— ⑥ 唯一约束改造：加 zone ——
  const old = await q(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'walk_times'::regclass AND contype = 'u'
        AND pg_get_constraintdef(oid) LIKE '%place_id%station_code%'
        AND pg_get_constraintdef(oid) NOT LIKE '%zone%'`,
  );
  for (const r of old) {
    await pool.query(`ALTER TABLE walk_times DROP CONSTRAINT "${r.conname}"`);
    console.log(`⑥ 已移除旧唯一约束 ${r.conname}`);
  }
  const neu = await q(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'walk_times'::regclass AND contype = 'u'
        AND pg_get_constraintdef(oid) LIKE '%zone%'`,
  );
  if (!neu.length) {
    await pool.query(
      `ALTER TABLE walk_times
         ADD CONSTRAINT walk_times_uniq UNIQUE (place_id, station_code, zone)`,
    );
    console.log("⑥ 已建立新唯一约束 walk_times_uniq（含 zone）");
  } else {
    console.log(`⑥ 新唯一约束已存在（${neu.map((r) => r.conname).join(", ")}）→ 跳过`);
  }

  // —— ⑦ 核对 ——
  const cols = await q(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_name = 'walk_times'
      ORDER BY ordinal_position`,
  );
  console.log("\n核对 · walk_times 列：");
  for (const c of cols)
    console.log(
      `   ${String(c.column_name).padEnd(14)} ${String(c.data_type).padEnd(18)} null=${c.is_nullable} def=${c.column_default ?? "-"}`,
    );

  const cons = await q(
    `SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint
      WHERE conrelid = 'walk_times'::regclass ORDER BY contype`,
  );
  console.log("\n核对 · 约束：");
  for (const c of cons) console.log(`   ${c.conname}: ${c.def}`);

  const chk = await q(`
    SELECT
      (SELECT count(*)::int FROM walk_times) AS walk_rows,
      (SELECT count(*)::int FROM plan_legs WHERE minutes IS NOT NULL) AS leg_minutes
  `);
  console.log("\n核对 · 数据：");
  console.log(`   walk_times 行数：${chk[0].walk_rows}（期望 0）`);
  console.log(`   plan_legs.minutes 非空：${chk[0].leg_minutes}（期望 0）`);

  console.log(`\n✅ v0.24.0 迁移完成（${target}）`);
  await pool.end();
}

main().catch((e) => {
  console.error("迁移失败：", e);
  process.exit(1);
});
