/**
 * v0.6.0 增量迁移（db/migrate-v060.ts）
 * 用法：npm run db:migrate-v060 -- [local|cloud]
 *
 * 背景（51/51A/51B 动态上下车改造）：
 *   - 去学校：51 系每线一张卡，上车点可在 board_candidates 中选（C690/x 总站 或 C689/2）
 *   - 回宿舍：动态下车，bus 段可途经 C688/2 或到 C690/x 总站收尾（alight_candidates 末位=强制终点）
 *
 * ⚠️ 本脚本绝不 TRUNCATE / DELETE 计时数据（timer_sessions/timer_events/wait_snapshots…）。
 * 只做两类事：
 *   1. 加列（幂等 ALTER TABLE … ADD COLUMN IF NOT EXISTS）：
 *      - plan_legs.board_candidates  TEXT[]（bus 段可选上车站，首项=默认；挂「首个载具段」）
 *      - plan_legs.alight_candidates  TEXT[]（bus 段可选下车点，末位=强制终点，与 to_station 一致）
 *   2. 将 data/commute-network.json 的 plans/legs 增量同步（upsert）：
 *      - plan 顶层 board_candidates → 写入该 plan 首个载具段的 plan_legs.board_candidates
 *      - leg 顶层 alight_candidates → 写入对应 plan_legs 行
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
  /** 动态下车候选（bus 回宿舍），末位 = 强制终点 */
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
  compare_routes?: string[];
  /** 可选上车站（去学校 51 系卡），首项 = 默认展示 */
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
    console.log("\n── 1/3 加列 + 索引（幂等）──");
    await q(`ALTER TABLE plan_legs ADD COLUMN IF NOT EXISTS board_candidates TEXT[]`);
    await q(`ALTER TABLE plan_legs ADD COLUMN IF NOT EXISTS alight_candidates TEXT[]`);
    // 云端早期库可能还缺 commute_plans.compare_routes（v0.5+/stats 排序用）
    await q(`ALTER TABLE commute_plans ADD COLUMN IF NOT EXISTS compare_routes JSONB`);
    console.log("  ✅ plan_legs.board_candidates / alight_candidates 已就绪");
    console.log("  ✅ commute_plans.compare_routes 已就绪");

    // 轻轨手动分钟单次幂等：同一会话同一上车站只保留一条（改选=覆盖原值）。
    // 历史 manual 分钟行 station_code 为 NULL → 不满足谓词，不受影响（不会因重复键建索引失败）。
    await q(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_wait_snap_manual_min_once
         ON wait_snapshots (session_id, station_code)
         WHERE source = 'manual' AND value_kind = 'minutes' AND station_code IS NOT NULL`,
    );
    console.log("  ✅ uq_wait_snap_manual_min_once（轻轨分钟改选覆盖）");

    // ---------- 2. 载入静态参照 ----------
    const placeIds = new Map<string, number>();
    const { rows: placeRows } = await q(`SELECT id, slug FROM places`);
    for (const r of placeRows as { id: number; slug: string }[]) placeIds.set(r.slug, r.id);
    if (placeRows.length === 0) throw new Error("places 表为空？请先跑 db:seed 初始化静态表");

    const routeIds = new Map<string, number>();
    const { rows: routeRows } = await q(`SELECT id, code FROM routes`);
    for (const r of routeRows as { id: number; code: string }[]) routeIds.set(r.code, r.id);

    // ---------- 2.5 站点幂等 upsert（自愈）----------
    // 51 系动态上下车引入了分台码（C688/2、C690/1..3、C689/2、T363/1）与旧「无分台写法」
    // 并存；若这些 stations 行缺失，前端站名/路线站序会断。此处按 JSON 静默补齐（不改计时表）。
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
    console.log(`  ↳ stations 幂等 upsert：${stationUpsert} 行（首次插入计 1，已存在更新也计 1）`);

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

        // 该行的候选列：alight_candidates 直接来自 leg；board_candidates 只有首个载具段取 plan 顶层
        const isVehicle = leg.kind === "bus" || leg.kind === "lrt";
        const boardCands =
          isVehicle && firstVehicleSeq === leg.seq && p.board_candidates?.length
            ? p.board_candidates.map(resolveStation).filter(Boolean) as string[]
            : [];
        const alightCands = (leg.alight_candidates ?? [])
          .map(resolveStation)
          .filter(Boolean) as string[];

        const ups = await q(
          `INSERT INTO plan_legs (plan_id, seq, leg_kind, route_id, route_options,
                                  from_station, to_station, minutes, note,
                                  board_candidates, alight_candidates)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (plan_id, seq) DO UPDATE SET
             leg_kind=EXCLUDED.leg_kind, route_id=EXCLUDED.route_id,
             route_options=EXCLUDED.route_options, from_station=EXCLUDED.from_station,
             to_station=EXCLUDED.to_station, minutes=EXCLUDED.minutes, note=EXCLUDED.note,
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
    console.log("\n── 3/3 校验 ──");
    const cands = await q(
      `SELECT p.plan_key, l.seq, l.leg_kind, l.board_candidates, l.alight_candidates, l.to_station
       FROM plan_legs l JOIN commute_plans p ON l.plan_id = p.id
       WHERE l.board_candidates IS NOT NULL OR l.alight_candidates IS NOT NULL
       ORDER BY p.plan_key, l.seq`,
    );
    for (const r of cands.rows as {
      plan_key: string;
      seq: number;
      leg_kind: string;
      board_candidates: string[] | null;
      alight_candidates: string[] | null;
      to_station: string | null;
    }[]) {
      console.log(
        `  ${r.plan_key.padEnd(18)} leg${r.seq}(${r.leg_kind}) | board=${r.board_candidates ? JSON.stringify(r.board_candidates) : "—"} | alight=${r.alight_candidates ? JSON.stringify(r.alight_candidates) : "—"} | to=${r.to_station ?? "—"}`,
      );
    }
    console.log("\n🎉 v0.6.0 增量迁移完成（计时数据未触碰）");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("❌ 迁移失败：", e.message);
  process.exit(1);
});
