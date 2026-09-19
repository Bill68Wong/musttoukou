/**
 * 方案摘要简繁归一（scripts/normalize-plan-summaries.ts，v2.0.0）
 *
 * ── 背景与判断 ────────────────────────────────────────────────────────
 *   `commute_plans.summary` 是**展示给用户的方案标题**，渲染点 5 处：
 *     `HomeClient`（进行中会话条）· `StatsClient` · `RoutePlanList` · `TimerWizard` · `FinishForm`。
 *   ⇒ 判定为 **(a) 用户文案** ⇒ 其中的**普通行文**应简体化 ✓
 *   ⚠️ 但摘要里**混着站名**（金峰南岸/和諧廣場/協和醫院…）—— 站名**必须保留繁体** ✓
 *   ⇒ 故**只做「整词替换」**，绝不逐字替换（逐字会把站名一起改坏）✗
 *
 * ── 下游依赖已核实（可安全改）─────────────────────────────────────────
 *   · 采样重建 `lib/rebuild/walk-times.ts`（v0.28.0）**不再解析摘要文本** ——
 *     改用 `board_candidates/alight_candidates/route_meta` ⇒ 改摘要**不影响重建** ✓
 *   · `stats/page.tsx` 只用正则剥「`^[^ ]+\s+`（线路前缀）」与「`｜.*`（尾巴）」
 *     ⇒ 与字形无关 ✓
 *
 * ── 映射表（**整词**，幂等）────────────────────────────────────────────
 *   到站後任選 → 到站后任选   ·  動態下車 → 动态下车   ·  輕軌 → 轻轨
 *   (換) → (换)              ·  併入 → 并入         ·  上車 → 上车
 *   （已核对：**没有任何站名包含这些整词** ⇒ 不会误改站名。）
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/normalize-plan-summaries.ts            # DRY-RUN
 *   node node_modules/tsx/dist/cli.mjs scripts/normalize-plan-summaries.ts --apply    # 写库
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

process.loadEnvFile("D:/Projects/University/Studio/musttoukou/.env");

const APPLY = process.argv.includes("--apply");
const OUT = "D:/Projects/University/Studio/musttoukou/.verify/normalize-summaries.out.txt";

/** 整词映射（顺序无关，互不重叠） */
const TOKEN_MAP: [string, string][] = [
  ["到站後任選", "到站后任选"],
  ["動態下車", "动态下车"],
  ["輕軌", "轻轨"],
  ["(換)", "(换)"],
  ["併入", "并入"],
  ["上車", "上车"],
];

const norm = (s: string): string => {
  let out = s;
  for (const [a, b] of TOKEN_MAP) out = out.split(a).join(b);
  return out;
};

const u = new URL(process.env.DATABASE_URL!);
const pool = new Pool({
  host: u.hostname,
  port: Number(u.port || 5432),
  database: u.pathname.slice(1),
  user: u.username,
  password: decodeURIComponent(u.password || ""),
  ssl: { rejectUnauthorized: false },
});

(async () => {
  const lines: string[] = [];
  const say = (s: string) => {
    lines.push(s);
    console.log(s);
  };
  say(`模式：${APPLY ? "★ APPLY（写库）" : "DRY-RUN（只打印）"}`);
  say("");

  const rows = (await pool.query(`SELECT id, summary FROM commute_plans ORDER BY id`)).rows as {
    id: number;
    summary: string;
  }[];

  const changed: { id: number; from: string; to: string }[] = [];
  for (const r of rows) {
    const to = norm(r.summary);
    if (to !== r.summary) changed.push({ id: r.id, from: r.summary, to });
  }

  say(`共 ${rows.length} 个方案 · 需改 ${changed.length} 个（幂等：再跑一次应为 0）`);
  say("");
  say("改前 / 改后：");
  for (const c of changed) {
    say(`  #${c.id}`);
    say(`    - ${c.from}`);
    say(`    + ${c.to}`);
  }

  if (APPLY) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (const ch of changed) {
        await c.query(`UPDATE commute_plans SET summary = $1 WHERE id = $2 AND summary = $3`, [
          ch.to,
          ch.id,
          ch.from,
        ]);
      }
      await c.query("COMMIT");
      say("");
      say(`✅ 写入 ${changed.length} 行`);
    } catch (e) {
      await c.query("ROLLBACK");
      say(`🔴 失败已回滚：${(e as Error).message}`);
      c.release();
      await pool.end();
      fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
      process.exit(1);
    }
    c.release();
    // 幂等复核
    const again = (await pool.query(`SELECT id, summary FROM commute_plans ORDER BY id`)).rows as {
      id: number;
      summary: string;
    }[];
    const left = again.filter((r) => norm(r.summary) !== r.summary).length;
    say(`幂等复核：再算一次仍需改 ${left} 行（期望 0）`);
  } else {
    say("");
    say("（DRY-RUN：未写库；加 --apply 生效）");
  }

  await pool.end();
  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  void path;
})().catch((e) => {
  fs.writeFileSync(OUT, `ERR ${String(e)}\n`, "utf8");
  process.exit(1);
});
