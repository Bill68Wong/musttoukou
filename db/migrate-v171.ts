/**
 * v0.17.1 迁移（db/migrate-v171.ts）
 * 用法：npm run db:migrate-v171 -- [local|cloud]
 *
 * 背景（用户 2026-09-08 拍板）：轻轨站名去掉尾部「站」字，要求数据库同步改——
 * 「下一站：科大」而非「科大站」（报站文案统一的一部分）。
 *
 * 本迁移做三件事（全部幂等）：
 *   ① stations.name_tc：kind='lrt' 去尾部「站」字（15 站：媽閣/海洋/馬會/運動場/
 *      排角/路氹西/石排灣/協和醫院/東亞運/路氹東/科大/機場/氹仔碼頭/蓮花/橫琴）
 *   ② commute_plans.summary：含 LRT 站名 token 去站字（历史会话无 summary 列，
 *      展示实时 JOIN 本表 → 一处更新全局生效；「蓮花站」不会误伤 bus 站「蓮花路停車場」）
 *   ③ 清理用户 2026-09-08 晚手动开的测试会话（is_test=true 且未软删）
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

/** summary 去站字 token（先长后短：碼頭/東亞運等长名在前防嵌套误伤） */
const TOKENS = [
  "氹仔碼頭站",
  "協和醫院站",
  "石排灣站",
  "路氹東站",
  "東亞運站",
  "運動場站",
  "路氹西站",
  "科大站",
  "橫琴站",
  "蓮花站",
  "海洋站",
  "馬會站",
  "排角站",
  "媽閣站",
  "機場站",
];

async function main() {
  // ① stations 去站字
  const st = await q(
    `UPDATE stations SET name_tc = regexp_replace(name_tc, '站$', '')
      WHERE kind = 'lrt' AND name_tc LIKE '%站'
      RETURNING code, name_tc`,
  );
  console.log(`① LRT 站名去站字 ${st.length} 个：${st.map((r) => `${r.code}=${r.name_tc}`).join(", ")}`);

  // ② plans.summary 去站字（token 替换，幂等：无 token 时 UPDATE 数 0）
  const plans = await q(`SELECT id, plan_key, summary FROM commute_plans WHERE summary LIKE '%站%'`);
  let upd = 0;
  for (const p of plans) {
    let sm = String(p.summary);
    const before = sm;
    for (const t of TOKENS) sm = sm.split(t).join(t.slice(0, -1));
    if (sm !== before) {
      await q(`UPDATE commute_plans SET summary = $2 WHERE id = $1`, [p.id, sm]);
      upd++;
      console.log(`② ${p.plan_key} summary → ${sm}`);
    }
  }
  if (!upd) console.log("② summary 无待改项（幂等）");

  // ③ 清理用户 2026-09-08 晚手动开的测试会话（187-190 区间 + 更早未清测试会话统一扫一遍）
  const del = await q(
    `UPDATE timer_sessions SET deleted_at = now()
      WHERE is_test AND deleted_at IS NULL AND id >= 187
      RETURNING id`,
  );
  console.log(`③ 清理测试会话 ${del.length} 条：${del.map((r) => r.id).join(",") || "(无)"}`);

  // 核对输出
  const remain = await q(
    `SELECT code, name_tc FROM stations WHERE kind='lrt' AND name_tc LIKE '%站'`,
  );
  console.log(remain.length ? `⚠️  仍有带站 LRT：${JSON.stringify(remain)}` : "LRT 站名全部无尾「站」");

  console.log(`\n✅ v0.17.1 迁移完成（${target}）`);
  await pool.end();
}

main().catch((e) => {
  console.error("迁移失败：", e);
  process.exit(1);
});
