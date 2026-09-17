/**
 * v0.20.0 数据迁移（db/migrate-v200.ts）—— 幂等
 * 用法：npm run db:migrate-v200 -- [local|cloud]
 *
 * ① 关闸 place slug 正名：guanqin → gate（「關閘」英文名 Border Gate；早期拼音 guanqin 拼错，「闸」非 qin）
 *    同步改 10 个 plan_key（home-guanqin-* / guanqin-home-* → …gate…）
 * ② 关闸→擎天汇合并（用户 v0.20.0 第 9 条）：把 51/51B 合并卡扩展为四线同台合并卡
 *    25AX@M9/3、51@M9/4、51B@M9/4、59@M9/2（各线站台由 route_meta.board 区分），
 *    停用旧的 59 卡与 25AX 卡；旧卡样本迁移到合并卡
 * ③ 历史样本迁移：挂在已停用卡上的 5 份真实样本迁到对应启用卡
 *    （home-guanqin-25→home-gate-59 合并卡、home-school-3→home-school-1、
 *     school-home-2-51a/51b→school-home-1），避免统计页（只统计 is_active 卡）漏样本
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const target = (process.argv[2] ?? "cloud") as "local" | "cloud";
const dbUrl = target === "cloud" ? process.env.DATABASE_URL : (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);
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
  // ============ ① place slug 修正 ============
  const pl = await q(`UPDATE places SET slug = 'gate' WHERE slug = 'guanqin' RETURNING id`);
  console.log(`① places slug：${pl.length ? "guanqin → gate ✓" : "（已是 gate，跳过）"}`);
  const pk = await q(
    `UPDATE commute_plans
        SET plan_key = replace(replace(plan_key, 'home-guanqin-', 'home-gate-'), 'guanqin-home-', 'gate-home-')
      WHERE plan_key LIKE '%guanqin%'
      RETURNING plan_key`,
  );
  console.log(`   plan_key 改名 ${pk.length} 个${pk.length ? "：" + pk.map((r) => r.plan_key).join(", ") : ""}`);

  // ============ ② 关闸→擎天汇合并（四线同台） ============
  const merge = await q(`SELECT id FROM commute_plans WHERE plan_key = 'gate-home-51'`);
  if (!merge.length) {
    console.log("② 关闸合并：未找到 gate-home-51，跳过");
  } else {
    const planId = merge[0].id as number;
    // ②-a bus 段：route_options 四线 + route_meta（各线 to/alight/board）
    const bus = await q(
      `SELECT id FROM plan_legs WHERE plan_id = $1 AND leg_kind = 'bus' ORDER BY seq LIMIT 1`,
      [planId],
    );
    if (bus.length) {
      const routes = ["25AX", "51", "51B", "59"]; // 自然排序（默认线路 = 首项 25AX）
      const meta = {
        "25AX": { to: "C690/2", alight: ["C688/2", "C690/2"], board: ["M9/3"] },
        "51": { to: "C690/3", alight: ["C688/2", "C690/3"], board: ["M9/4"] },
        "51B": { to: "C690/2", alight: ["C688/2", "C690/2"], board: ["M9/4"] },
        "59": { to: "C652", alight: ["C651", "C652"], board: ["M9/2"] },
      };
      await q(
        `UPDATE plan_legs SET route_options = $2::text, route_meta = $3::jsonb WHERE id = $1`,
        [bus[0].id, JSON.stringify(routes), JSON.stringify(meta)],
      );
      console.log(`② bus 段已合并为 ${routes.join("/")}（各线站台由 route_meta.board 区分）`);
    }
    // ②-b 步行段目标站 = 默认线路的 board 台（M9/3，25AX）
    const walk = await q(
      `SELECT id, to_station FROM plan_legs
        WHERE plan_id = $1 AND leg_kind = 'walk' AND to_station LIKE 'M9%'
        ORDER BY seq LIMIT 1`,
      [planId],
    );
    if (walk.length && walk[0].to_station !== "M9/3") {
      await q(`UPDATE plan_legs SET to_station = 'M9/3' WHERE id = $1`, [walk[0].id]);
      console.log(`   步行段目标站 ${walk[0].to_station} → M9/3（默认线路 25AX 的上车台）`);
    }
    // ②-c summary 与旧卡停用
    await q(
      `UPDATE commute_plans SET summary = $2 WHERE id = $1`,
      [planId, "M9 關閘廣場 → 擎天匯｜25AX/51/51B/59 到站後任選"],
    );
    const off = await q(
      `UPDATE commute_plans SET is_active = false
        WHERE plan_key IN ('gate-home-59', 'gate-home-25ax') AND is_active
        RETURNING plan_key`,
    );
    console.log(`   停用旧卡：${off.map((r) => r.plan_key).join(", ") || "（已停用）"}`);
  }

  // ============ ③ 历史样本迁移（停用卡 → 对应启用卡） ============
  const moves: [string, string][] = [
    ["gate-home-59", "gate-home-51"], // 关闸回程 59 → 四线合并卡
    ["home-gate-25", "home-gate-59"], // 去关闸 25 → 59/25 合并卡
    ["home-school-3", "home-school-1"], // 26A → C653 四线合并卡
    ["school-home-2-51a", "school-home-1"], // 51A → 26/51A/51B 合并卡
    ["school-home-2-51b", "school-home-1"], // 51B → 26/51A/51B 合并卡
  ];
  for (const [fromKey, toKey] of moves) {
    const r = await q(
      `UPDATE timer_sessions s
          SET plan_id = tp.id
         FROM commute_plans fp, commute_plans tp
        WHERE s.plan_id = fp.id AND fp.plan_key = $1 AND tp.plan_key = $2
          AND s.deleted_at IS NULL
        RETURNING s.id`,
      [fromKey, toKey],
    );
    if (r.length) {
      console.log(`③ 样本迁移 ${fromKey} → ${toKey}：${r.length} 份（sid=${r.map((x) => x.id).join(",")}）`);
    }
  }

  // ============ 核对 ============
  const left = await q(
    `SELECT cp.plan_key, cp.is_active, count(s.id)::int AS n
       FROM commute_plans cp
       LEFT JOIN timer_sessions s ON s.plan_id = cp.id AND s.deleted_at IS NULL
          AND NOT COALESCE(s.is_test, false)
      WHERE NOT cp.is_active
      GROUP BY cp.plan_key, cp.is_active
      HAVING count(s.id) > 0`,
  );
  console.log("\n核对：停用卡上仍有真实样本的情况：");
  if (!left.length) console.log("  无 ✓（所有样本都在启用卡上，统计不会漏）");
  for (const r of left) console.log(`  ⚠️ ${r.plan_key} 仍有 ${r.n} 份`);

  const guan = await q(
    `SELECT cp.plan_key, cp.is_active, cp.summary,
            (SELECT string_agg(DISTINCT ro, ',')
               FROM plan_legs l
               CROSS JOIN LATERAL jsonb_array_elements_text(
                 CASE WHEN l.route_options IS NULL OR l.route_options = '' THEN '[]'::jsonb
                      ELSE l.route_options::jsonb END) AS ro
              WHERE l.plan_id = cp.id) AS routes
       FROM commute_plans cp
      WHERE cp.plan_key LIKE '%gate%'
      ORDER BY cp.plan_key`,
  );
  console.log("\n关闸相关卡：");
  for (const r of guan)
    console.log(
      `  ${r.is_active ? "启用" : "停用"} ${r.plan_key} [${r.routes ?? "-"}] | ${r.summary}`,
    );

  console.log(`\n✅ v0.20.0 迁移完成（${target}）`);
  await pool.end();
}

main().catch((e) => {
  console.error("迁移失败：", e);
  process.exit(1);
});
