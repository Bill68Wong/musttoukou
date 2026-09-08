/**
 * v0.17.0 迁移（db/migrate-v170.ts）
 * 用法：npm run db:migrate-v170 -- [local|cloud]
 *
 * 背景：同一目的地卡片内「相同起点」的路线合并成一张卡（主人 2026-09-07 需求）。
 * 合并后单段 route_options 含多条线路，各线路的下车站/上车台/下车候选不同，
 * 新增 plan_legs.route_meta（JSONB）描述「每条线路自己的差异」：
 *   { "<线路码>": { to?, board?, alight? } }
 *
 * 本迁移做三件事（全部幂等）：
 *   ① plan_legs 加 route_meta JSONB 列
 *   ② 6 张主卡改写 route_options / route_meta / summary（首项=原主线路，保历史样本口径）
 *   ③ 停用被吞并的 12 张卡（is_active=false，不删除，历史会话仍可回看）
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

type RouteMeta = { to?: string; board?: string[]; alight?: string[] };
type MergeSpec = {
  planKey: string;
  summary: string;
  /** 合并后的线路顺序（首项=默认，须等于原主卡线路以保历史 session 口径） */
  routes: string[];
  meta: Record<string, RouteMeta>;
  /** 被吞并、需停用的卡 */
  deactivate: string[];
};

const MERGES: MergeSpec[] = [
  {
    planKey: "home-school-1",
    summary: "C653 金峰南岸/金譽峰 → 澳科大｜50/26/26A/25 到站後任選",
    routes: ["50", "26", "26A", "25"],
    meta: {
      "50": { to: "T400" },
      "26": { to: "T374" },
      "26A": { to: "T367", alight: ["T363/1", "T367"] },
      "25": { to: "T363/2" },
    },
    deactivate: ["home-school-2", "home-school-3", "home-school-25"],
  },
  {
    planKey: "home-school-4",
    summary: "蝴蝶谷大馬路總站/和諧廣場 → 澳科大｜51/51A/51B/25AX 到站後任選",
    routes: ["51", "51A", "51B", "25AX"],
    meta: {
      "51": { board: ["C690/3", "C689/2"], to: "T429" },
      "51A": { board: ["C690/1", "C689/2"], to: "T374" },
      "51B": { board: ["C690/2", "C689/2"], to: "T363/1" },
      "25AX": { board: ["C690/2", "C689/2"], to: "T363/2" },
    },
    deactivate: ["home-school-6", "home-school-10", "home-school-25ax"],
  },
  {
    planKey: "school-home-1",
    summary: "T373/2 偉龍/科技大學 → 擎天匯｜26/51A/51B 到站後任選",
    routes: ["26", "51A", "51B"],
    meta: {
      "26": { to: "C652" },
      "51A": { to: "C690/1", alight: ["C688/2", "C690/1"] },
      "51B": { to: "C690/2", alight: ["C688/2", "C690/2"] },
    },
    deactivate: ["school-home-2-51a", "school-home-2-51b"],
  },
  {
    planKey: "home-guanqin-59",
    summary: "C653 金峰南岸/金譽峰 → 關閘｜59/25 到站後任選",
    routes: ["59", "25"],
    meta: {
      "59": { to: "M9/2" },
      "25": { to: "M1/13" },
    },
    deactivate: ["home-guanqin-25"],
  },
  {
    planKey: "home-guanqin-51",
    summary: "蝴蝶谷大馬路總站/和諧廣場 → 關閘廣場｜51/51B/25AX 到站後任選",
    routes: ["51", "51B", "25AX"],
    meta: {
      "51": { board: ["C690/3", "C689/2"], to: "M9/4" },
      "51B": { board: ["C690/2", "C689/2"], to: "M9/4" },
      "25AX": { board: ["C690/2", "C689/2"], to: "M9/3" },
    },
    deactivate: ["home-guanqin-51b", "home-guanqin-25ax"],
  },
  {
    planKey: "guanqin-home-51",
    summary: "M9/4 關閘廣場 → 擎天匯｜51/51B 到站後任選",
    routes: ["51", "51B"],
    meta: {
      "51": { to: "C690/3", alight: ["C688/2", "C690/3"] },
      "51B": { to: "C690/2", alight: ["C688/2", "C690/2"] },
    },
    deactivate: ["guanqin-home-51b"],
  },
];

async function main() {
  // ① 加列
  await q(`ALTER TABLE plan_legs ADD COLUMN IF NOT EXISTS route_meta JSONB`);
  console.log("① plan_legs.route_meta 列就绪");

  // ② 改写主卡首个载具段
  for (const m of MERGES) {
    const plan = await q(`SELECT id, summary FROM commute_plans WHERE plan_key = $1`, [m.planKey]);
    if (!plan.length) {
      console.log(`⚠️  主卡 ${m.planKey} 不存在，跳过`);
      continue;
    }
    const planId = Number(plan[0].id);
    const leg = await q(
      `SELECT id FROM plan_legs
        WHERE plan_id = $1 AND leg_kind IN ('bus','lrt') ORDER BY seq LIMIT 1`,
      [planId],
    );
    if (!leg.length) {
      console.log(`⚠️  主卡 ${m.planKey} 无载具段，跳过`);
      continue;
    }
    await q(
      `UPDATE plan_legs
          SET route_options = $2::text, route_meta = $3::jsonb
        WHERE id = $1`,
      [leg[0].id, JSON.stringify(m.routes), JSON.stringify(m.meta)],
    );
    await q(`UPDATE commute_plans SET summary = $2 WHERE id = $1`, [planId, m.summary]);
    console.log(`② ${m.planKey} → route_options=[${m.routes.join(",")}]  route_meta=${Object.keys(m.meta).length} 条`);
  }

  // ③ 停用被吞并的卡
  for (const m of MERGES) {
    const res = await q(
      `UPDATE commute_plans SET is_active = false
        WHERE plan_key = ANY($1::text[]) AND is_active = true
        RETURNING plan_key`,
      [m.deactivate],
    );
    if (res.length) console.log(`③ 停用 ${res.length} 张：${res.map((r) => r.plan_key).join(", ")}`);
  }

  // 校验输出
  const active = await q(
    `SELECT p.plan_key,
            (SELECT string_agg(pl.route_options, ' | ' ORDER BY pl.seq)
               FROM plan_legs pl WHERE pl.plan_id = p.id AND pl.leg_kind IN ('bus','lrt')) AS routes
       FROM commute_plans p WHERE p.is_active ORDER BY p.id`,
  );
  console.log(`\n当前启用卡片 ${active.length} 张：`);
  for (const a of active) console.log(`  ${a.plan_key}  ${a.routes ?? ""}`);

  console.log(`\n✅ v0.17.0 迁移完成（${target}）`);
  await pool.end();
}

main().catch((e) => {
  console.error("迁移失败：", e);
  process.exit(1);
});
