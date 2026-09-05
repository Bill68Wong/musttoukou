/**
 * v0.13.0 增量迁移（db/migrate-v130.ts）
 * 用法：npm run db:migrate-v130 -- [local|cloud]
 *
 * 背景（2026-09-05 宿舍⇄關閘 10 卡 + 口岸建模修复）：
 *   - 新增 border place「guanqin 關閘（拱北口岸）」；bus routes 25/25AX/59；
 *     stations M1/13 關閘總站、M9/2·M9/3·M9/4 關閘廣場（分台）
 *   - 新增 home-guanqin-* / guanqin-home-* 共 10 张方案卡
 *   - 横琴 4 卡建模修复：显式口岸步行段 + cross_border 段加 label（口岸显示名）+ 回程首步即通关
 *   - 计时语义：通关（border_start→border_end 闭合区间）独立计时 → timer_sessions.border_minutes，
 *     不进入 total_minutes；cross_border 段口岸名 → plan_legs.border_label
 *
 * ⚠️ 本脚本绝不 TRUNCATE / DELETE 计时数据（timer_sessions/timer_events/wait_snapshots…）。
 * 只做：加列（幂等）+ 静态参照 upsert + 方案/分段 upsert（legs 按新 seq 集对齐）。
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
  /** v0.13.0 cross_border 段口岸显示名 */
  label?: string;
  alight_candidates?: string[];
}
interface PlanSeed {
  id: string;
  from: string;
  to: string;
  summary: string;
  is_active?: boolean;
  legs: LegSeed[];
  note?: string;
  board_candidates?: string[];
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
  places: { id: string; name: string; type: string }[];
  stations: StationSeed[];
  routes: { code: string; kind: string; company?: string; color?: string }[];
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
    console.log("\n── 1/4 加列（幂等）──");
    await q(`ALTER TABLE plan_legs ADD COLUMN IF NOT EXISTS border_label TEXT`);
    await q(`ALTER TABLE timer_sessions ADD COLUMN IF NOT EXISTS border_minutes NUMERIC(5,1)`);
    console.log("  ✅ plan_legs.border_label / timer_sessions.border_minutes 已就绪");

    // ---------- 2. places / routes / stations upsert ----------
    console.log("\n── 2/4 静态参照 upsert ──");

    // 2a. place：guanqin（border）；home/school/hengqin 应已存在，若缺一并补齐
    const placeIds = new Map<string, number>();
    for (const p of net.places) {
      const res = await q(
        `INSERT INTO places (slug, name, kind) VALUES ($1,$2,$3)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind
         RETURNING id`,
        [p.id, p.name, p.type],
      );
      placeIds.set(p.id, (res.rows[0] as { id: number }).id);
    }
    console.log(`  ✅ places upsert：${placeIds.size} 个（guanqin=${placeIds.has("guanqin") ? "✓" : "✗"}）`);

    // 2b. routes：25/25AX/59（含 company/color）
    const routeIds = new Map<string, number>();
    for (const r of net.routes) {
      const res = await q(
        `INSERT INTO routes (code, kind, company, color) VALUES ($1,$2,$3,$4)
         ON CONFLICT (code, kind) DO UPDATE SET company = EXCLUDED.company, color = EXCLUDED.color
         RETURNING id`,
        [r.code, r.kind, r.company ?? null, r.color ?? null],
      );
      routeIds.set(r.code, (res.rows[0] as { id: number }).id);
    }
    const newRoutes = net.routes.filter((r) => ["25", "25AX", "59"].includes(r.code));
    console.log(`  ✅ routes upsert：${routeIds.size} 条（本次新增 25/25AX/59=${newRoutes.length}）`);

    // 2c. stations：全量幂等 upsert（自愈补齐 M1/13、M9/2/3/4 等新站）
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
    console.log(`  ↳ stations 幂等 upsert：${stationUpsert} 行（含 M1/13、M9/2、M9/3、M9/4）`);

    // ---------- 3. 方案 upsert（不触碰计时表） ----------
    console.log("\n── 3/4 方案同步 ──");
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

      const exist = await q(`SELECT id FROM commute_plans WHERE plan_key = $1`, [p.id]);
      let planId: number;
      if (exist.rows.length === 0) {
        const ins = await q(
          `INSERT INTO commute_plans (plan_key, from_place, to_place, summary, is_active, note)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [p.id, fromPlaceId, toPlaceId, p.summary, isActive, p.note ?? null],
        );
        planId = (ins.rows[0] as { id: number }).id;
        inserted++;
      } else {
        planId = (exist.rows[0] as { id: number }).id;
        await q(
          `UPDATE commute_plans
           SET summary=$1, from_place=$2, to_place=$3, is_active=$4, note=$5
           WHERE id=$6`,
          [p.summary, fromPlaceId, toPlaceId, isActive, p.note ?? null, planId],
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

      // plan 顶层 board_candidates → 挂到该 plan 首个载具段（bus/lrt）行
      let firstVehicleSeq: number | null = null;
      const firstVehicle = p.legs.find((l) => l.kind === "bus" || l.kind === "lrt");
      if (firstVehicle) firstVehicleSeq = firstVehicle.seq;

      for (const leg of p.legs) {
        const atStation = resolveStation(leg.at);
        const isAnchor = leg.kind === "transfer" || leg.kind === "cross_border";
        const fromSt = isAnchor ? atStation : resolveStation(leg.from);
        const toSt = isAnchor ? atStation : resolveStation(leg.to);
        const single = leg.routes && leg.routes.length === 1 ? leg.routes[0] : null;
        const routeId = single ? (routeIds.get(single) ?? null) : null;
        const opts = leg.routes && leg.routes.length > 0 ? JSON.stringify(leg.routes) : null;

        const isVehicle = leg.kind === "bus" || leg.kind === "lrt";
        const boardCands =
          isVehicle && firstVehicleSeq === leg.seq && p.board_candidates?.length
            ? (p.board_candidates.map(resolveStation).filter(Boolean) as string[])
            : [];
        const alightCands = (leg.alight_candidates ?? [])
          .map(resolveStation)
          .filter(Boolean) as string[];
        const borderLabel =
          leg.kind === "cross_border" ? (leg.label ?? leg.at ?? null) : null;

        const ups = await q(
          `INSERT INTO plan_legs (plan_id, seq, leg_kind, route_id, route_options,
                                  from_station, to_station, minutes, note,
                                  border_label, board_candidates, alight_candidates)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (plan_id, seq) DO UPDATE SET
             leg_kind=EXCLUDED.leg_kind, route_id=EXCLUDED.route_id,
             route_options=EXCLUDED.route_options, from_station=EXCLUDED.from_station,
             to_station=EXCLUDED.to_station, minutes=EXCLUDED.minutes, note=EXCLUDED.note,
             border_label=EXCLUDED.border_label,
             board_candidates=EXCLUDED.board_candidates,
             alight_candidates=EXCLUDED.alight_candidates`,
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
            borderLabel,
            boardCands.length ? boardCands : null,
            alightCands.length ? alightCands : null,
          ],
        );
        if ((ups.rowCount ?? 0) > 1) legUpdated++;
        else legInserted++;
      }
    }
    console.log(`  方案：新增 ${inserted} / 更新 ${updated}`);
    console.log(`  分段：新增 ${legInserted} / 更新 ${legUpdated} / 删除 ${legDeleted}`);

    // ---------- 4. 校验 ----------
    console.log("\n── 4/4 校验 ──");

    // 4a. 列确认
    const colChk = await q(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE (table_name = 'plan_legs' AND column_name = 'border_label')
          OR (table_name = 'timer_sessions' AND column_name = 'border_minutes')`,
    );
    const colMap = new Set(
      (colChk.rows as { table_name: string; column_name: string }[]).map(
        (r) => `${r.table_name}.${r.column_name}`,
      ),
    );
    console.log(
      `  列：plan_legs.border_label=${colMap.has("plan_legs.border_label") ? "✓" : "✗"} | ` +
        `timer_sessions.border_minutes=${colMap.has("timer_sessions.border_minutes") ? "✓" : "✗"}`,
    );

    // 4b. 关键行盘点
    const { rows: stats } = await q(
      `SELECT
         (SELECT count(*)::int FROM places) AS places,
         (SELECT count(*)::int FROM routes WHERE kind='bus') AS bus_routes,
         (SELECT count(*)::int FROM commute_plans) AS plans,
         (SELECT count(*)::int FROM plan_legs WHERE leg_kind='cross_border') AS border_legs`,
    );
    const s = (stats[0] ?? {}) as {
      places: number;
      bus_routes: number;
      plans: number;
      border_legs: number;
    };
    console.log(
      `  汇总：places=${s.places} | 巴士线路=${s.bus_routes} | 方案=${s.plans} | cross_border 段=${s.border_legs}`,
    );

    const { rows: borderRows } = await q(
      `SELECT p.plan_key, l.seq, l.border_label
       FROM plan_legs l JOIN commute_plans p ON l.plan_id = p.id
       WHERE l.leg_kind = 'cross_border'
       ORDER BY p.plan_key, l.seq`,
    );
    for (const r of borderRows as { plan_key: string; seq: number; border_label: string | null }[]) {
      console.log(`    ${r.plan_key.padEnd(18)} leg${r.seq} border_label=${r.border_label ?? "(空)"}`);
    }

    const guanqinPlans = await q(
      `SELECT count(*)::int AS n FROM commute_plans
       WHERE plan_key LIKE 'home-guanqin-%' OR plan_key LIKE 'guanqin-home-%'`,
    );
    const n = (guanqinPlans.rows[0] as { n: number }).n;
    console.log(`  關閘方案卡：${n} 张（应为 10）`);
    if (n !== 10) {
      console.error("❌ 校验未通过：關閘方案数不等于 10");
      process.exitCode = 1;
    } else {
      console.log("✅ v0.13.0 迁移完成（计时数据未触碰）");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("❌ 迁移失败：", e.message);
  process.exit(1);
});
