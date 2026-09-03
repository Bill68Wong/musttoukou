/**
 * v0.4.0 增量迁移（db/migrate-v040.ts）
 * 用法：npm run db:migrate-v040 -- [local|cloud]
 *
 * ⚠️ 本脚本绝不 TRUNCATE / DELETE 计时数据（timer_sessions/timer_events/wait_snapshots…）。
 * 只做两类事：
 *   1. 加列（幂等 ALTER TABLE … ADD COLUMN IF NOT EXISTS）：
 *      - commute_plans.compare_routes JSONB（反事实对比线路组）
 *      - timer_sessions.from_zone / to_zone TEXT（学校分区 B/C | N/O | R）
 *      - bus_snapshots.session_id / stage / ref_station / stops_away（车队快照归属）
 *   2. 将 data/commute-network.json 的 plans 同步进 commute_plans/plan_legs
 *      （upsert；旧合并卡 school-home-2/3 置 is_active=false 保留历史；新增 4 张独立卡）
 *
 * 对照 db/seed.ts —— seed 用 TRUNCATE CASCADE，生产绝不可跑；本脚本为生产安全替代。
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
interface LegSeed {
  seq: number;
  kind: string;
  routes?: string[];
  from?: string;
  to?: string;
  at?: string;
  minutes: number | null;
  note?: string;
}
interface PlanSeed {
  id: string;
  from: string;
  to: string;
  summary: string;
  is_active?: boolean;
  legs: LegSeed[];
  note?: string;
  compare_routes?: string[];
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
  places: { id: string }[];
  stations: StationSeed[];
  routes: { code: string; kind: string }[];
  plans: PlanSeed[];
};

/** 与 seed 相同的站引用解析：编号或繁体名 → stations.code（含 X- 前缀规则） */
const stationCode = (s: StationSeed): string => s.code ?? `X-${s.name_tc}`;
const resolveStation = (v?: string): string | null => {
  if (!v) return null;
  const raw = v.startsWith("station:") ? v.slice(8) : v;
  const found = net.stations.find((s) => stationCode(s) === raw || s.name_tc === raw);
  return found ? stationCode(found) : null;
};

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
    const ddl: [string, string][] = [
      ["commute_plans", `ALTER TABLE commute_plans ADD COLUMN IF NOT EXISTS compare_routes JSONB`],
      ["timer_sessions", `ALTER TABLE timer_sessions ADD COLUMN IF NOT EXISTS from_zone TEXT`],
      ["timer_sessions", `ALTER TABLE timer_sessions ADD COLUMN IF NOT EXISTS to_zone TEXT`],
      ["bus_snapshots", `ALTER TABLE bus_snapshots ADD COLUMN IF NOT EXISTS session_id INT`],
      ["bus_snapshots", `ALTER TABLE bus_snapshots ADD COLUMN IF NOT EXISTS stage TEXT`],
      ["bus_snapshots", `ALTER TABLE bus_snapshots ADD COLUMN IF NOT EXISTS ref_station TEXT`],
      ["bus_snapshots", `ALTER TABLE bus_snapshots ADD COLUMN IF NOT EXISTS stops_away SMALLINT`],
    ];
    for (const [tbl, sql] of ddl) {
      await q(sql);
      console.log(`  ✅ ${tbl} 加列完成`);
    }
    await q(
      `CREATE INDEX IF NOT EXISTS idx_bus_snap_session ON bus_snapshots (session_id, stage)`,
    );
    console.log("  ✅ idx_bus_snap_session");

    // ---------- 2. 载入静态参照 ----------
    const placeIds = new Map<string, number>();
    const { rows: placeRows } = await q(`SELECT id, slug FROM places`);
    for (const r of placeRows as { id: number; slug: string }[]) placeIds.set(r.slug, r.id);
    if (placeRows.length === 0) throw new Error("places 表为空？请先跑 db:seed 初始化静态表");

    const routeIds = new Map<string, number>();
    const { rows: routeRows } = await q(`SELECT id, code FROM routes`);
    for (const r of routeRows as { id: number; code: string }[]) routeIds.set(r.code, r.id);

    // ---------- 3. 方案 upsert（不触碰计时表） ----------
    console.log("\n── 2/3 方案同步 ──");
    let inserted = 0;
    let updated = 0;
    let legInserted = 0;
    let legUpdated = 0;
    let legDeleted = 0;

    for (const p of net.plans) {
      const fromPlaceId = placeIds.get(p.from) ?? null;
      const toPlaceId = placeIds.get(p.to) ?? null;
      if (!fromPlaceId || !toPlaceId) {
        console.log(`  ⚠️ ${p.id}：place 映射缺失（${p.from}→${p.to}），跳过`);
        continue;
      }
      const isActive = p.is_active !== false;
      const compareJson = p.compare_routes?.length ? JSON.stringify(p.compare_routes) : null;

      const exist = await q(`SELECT id FROM commute_plans WHERE plan_key = $1`, [p.id]);
      let planId: number;
      if (exist.rows.length === 0) {
        const ins = await q(
          `INSERT INTO commute_plans (plan_key, from_place, to_place, summary, is_active, note, compare_routes)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [p.id, fromPlaceId, toPlaceId, p.summary, isActive, p.note ?? null, compareJson],
        );
        planId = (ins.rows[0] as { id: number }).id;
        inserted++;
      } else {
        planId = (exist.rows[0] as { id: number }).id;
        await q(
          `UPDATE commute_plans
           SET summary=$1, from_place=$2, to_place=$3, is_active=$4, note=$5, compare_routes=$6
           WHERE id=$7`,
          [p.summary, fromPlaceId, toPlaceId, isActive, p.note ?? null, compareJson, planId],
        );
        updated++;
      }

      // legs：新 JSON 中没有的旧 seq 删除（仅限该方案自身的静态段）
      const newSeqs = p.legs.map((l) => l.seq);
      const del = await q(
        `DELETE FROM plan_legs WHERE plan_id=$1 AND NOT (seq = ANY($2::int[]))`,
        [planId, newSeqs],
      );
      legDeleted += del.rowCount ?? 0;

      for (const leg of p.legs) {
        const atStation = resolveStation(leg.at);
        const isAnchor = leg.kind === "transfer" || leg.kind === "cross_border";
        const fromSt = isAnchor ? atStation : resolveStation(leg.from);
        const toSt = isAnchor ? atStation : resolveStation(leg.to);
        const single = leg.routes && leg.routes.length === 1 ? leg.routes[0] : null;
        const routeId = single ? (routeIds.get(single) ?? null) : null;
        const opts = leg.routes && leg.routes.length > 0 ? JSON.stringify(leg.routes) : null;

        const ups = await q(
          `INSERT INTO plan_legs (plan_id, seq, leg_kind, route_id, route_options,
                                  from_station, to_station, minutes, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (plan_id, seq) DO UPDATE SET
             leg_kind=EXCLUDED.leg_kind, route_id=EXCLUDED.route_id,
             route_options=EXCLUDED.route_options, from_station=EXCLUDED.from_station,
             to_station=EXCLUDED.to_station, minutes=EXCLUDED.minutes, note=EXCLUDED.note`,
          [
            planId,
            leg.seq,
            leg.kind,
            routeId,
            opts,
            fromSt,
            toSt,
            leg.minutes,
            leg.note ?? null,
          ],
        );
        if ((ups.rowCount ?? 0) > 1) legUpdated++;
        else legInserted++;
      }
    }
    console.log(`  方案：新增 ${inserted} / 更新 ${updated}`);
    console.log(`  分段：新增 ${legInserted} / 更新 ${legUpdated} / 删除 ${legDeleted}`);

    // ---------- 4. 校验 ----------
    console.log("\n── 3/3 校验 ──");
    const plans = await q(
      `SELECT plan_key, summary, is_active, compare_routes FROM commute_plans ORDER BY plan_key`,
    );
    for (const r of plans.rows as {
      plan_key: string;
      summary: string;
      is_active: boolean;
      compare_routes: string[] | null;
    }[]) {
      console.log(
        `  ${r.is_active ? "●" : "○"} ${r.plan_key.padEnd(20)} | ${r.summary.padEnd(44)} | compare=${
          r.compare_routes ? JSON.stringify(r.compare_routes) : "—"
        }`,
      );
    }
    const cols = await q(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name IN ('commute_plans','timer_sessions','bus_snapshots')
         AND column_name IN ('compare_routes','from_zone','to_zone','session_id','stage','ref_station','stops_away')`,
    );
    console.log(`  新列确认：${(cols.rows as { column_name: string }[]).map((c) => c.column_name).join(", ")}`);

    const c651 = await q(`SELECT count(*)::int AS n FROM route_stations WHERE station_code='C651'`);
    console.log(
      `  ⚠️ C651 站序覆盖：${(c651.rows[0] as { n: number }).n} 条（预期 0 —— home-school-5/7 为已知坏点，仅记录）`,
    );
    console.log("\n🎉 v0.4.0 增量迁移完成（计时数据未触碰）");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("❌ 迁移失败：", e.message);
  process.exit(1);
});
