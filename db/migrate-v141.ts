/**
 * v0.14.1 增量迁移（db/migrate-v141.ts）
 * 用法：npm run db:migrate-v141 -- [local|cloud]
 *
 * 背景（2026-09-06 主人反馈）：
 *   - home-hengqin-1（擎天匯→橫琴，26 換乘卡）不新增卡 —— 第一程候選本就含 26/50，
 *     仅将卡片名（summary）改为「26/50路→…」体现两线可选
 *   - 蓮花路停車場换乘点说明：T355/1 与 T355/2 两站台同场相邻、跨台不计步行
 *   - 本迁移只更新文案与注释（幂等 UPDATE），不动 legs/计时数据。
 *
 * ⚠️ 同 v130：绝不 TRUNCATE / DELETE 计时数据。
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
  console.error("❌ 未找到连接串：请先在 .env 配置（参照 .env.example）");
  process.exit(1);
}
const masked = connStr.replace(/:[^:@/]+@/, ":****@");
console.log(`目标库：${masked}`);

const net = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "data", "commute-network.json"), "utf8"),
) as {
  plans: {
    id: string;
    summary: string;
    note?: string;
    legs: { seq: number; note?: string }[];
  }[];
};

const plan = net.plans.find((p) => p.id === "home-hengqin-1");
if (!plan) {
  console.error("❌ data/commute-network.json 缺少 home-hengqin-1");
  process.exit(1);
}
// 仅同步文案涉及的两个分段（seq2 巴士段 note、seq3 换乘段 note）
const legNotes = new Map(plan.legs.filter((l) => l.note).map((l) => [l.seq, l.note]));

async function main() {
  if (!plan) {
    console.error("❌ data/commute-network.json 缺少 home-hengqin-1");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: connStr });
  try {
    const planRes = await pool.query(
      `UPDATE commute_plans
       SET summary = $1, note = COALESCE($2, note)
       WHERE plan_key = $3`,
      [plan.summary, plan.note ?? null, plan.id],
    );
    console.log(`commute_plans.home-hengqin-1 updated: ${planRes.rowCount}`);

    const pid = await pool.query(`SELECT id FROM commute_plans WHERE plan_key = $1`, [plan.id]);
    if (pid.rowCount === 0) {
      console.log("⚠️ 该卡不存在于目标库（尚未 seed？），跳过 legs note 同步");
      return;
    }
    const planId = (pid.rows[0] as { id: number }).id;
    for (const [seq, note] of legNotes) {
      const r = await pool.query(`UPDATE plan_legs SET note = $1 WHERE plan_id = $2 AND seq = $3`, [
        note,
        planId,
        seq,
      ]);
      console.log(`  leg seq${seq} note updated: ${r.rowCount}`);
    }
    console.log("✅ v0.14.1 文案迁移完成");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ 迁移失败：", (err as Error).message);
  process.exit(1);
});
