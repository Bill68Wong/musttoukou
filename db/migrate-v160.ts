/**
 * v0.16.0 增量迁移（db/migrate-v160.ts）
 * 用法：npm run db:migrate-v160 -- [local|cloud]
 *
 * 背景（2026-09-06 主人拍板 v0.16.0 乘车逐站按钮三段式 + 方案卡调整）：
 *   - 乘车 UI 改为「普通站=记站/甩站｜可选下车站=下车/记站/甩站｜终点=下车」
 *     （前端 TimerWizard 三段式已改；本迁移只同步方案卡数据，使 alight_candidates
 *      命中的可选站/终点与新 UI 语义一致）
 *   - home-school-3（26A 去学校）：bus leg 加 alight_candidates ["T363/1","T367"]
 *     —— 26A dir1 站序 C653→T363/1(威尼斯人,先到)→T367(望德聖母灣,末位)，
 *       威尼斯人可选下车（三键），望德聖母灣=原 to_station 末位（只下车）
 *   - 轻轨合并（逻辑同巴士）：home-school-9（去学校）氹仔线段加
 *     alight_candidates ["LRT-LDE","LRT-MUST"]（路氹東可选下 / 科大站末位强制下）；
 *     home-school-8（原路氹東终点卡）停用；school-home-7（回宿舍）氹仔线上车
 *     候选加 plan 顶层 board_candidates ["LRT-MUST","LRT-LDE"]（科大站默认 /
 *     路氹東可选）；school-home-6（原路氹東上车卡）停用
 *   - 新增去学校卡：home-school-25（25 路 C653 金峰南岸→T363/2 威尼斯人）、
 *     home-school-25ax（25AX C690/2 或 C689/2→T363/2 威尼斯人）
 *   - 51B（home-school-10）终点已是 T363/1 威尼斯人、站序无 T367 → 保持不动
 *     （主人 2026-09-06 确认）
 *
 * ⚠️ 本脚本绝不动计时表（timer_sessions/timer_events/wait_snapshots…），
 * 只做静态参照幂等 upsert + 方案/分段按 JSON 权威源对齐（新增补插、变更覆盖、
 * is_active=false 停用）。可重复执行。
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

/** 与 seed/v130 相同的站引用解析：编号或繁体名 → stations.code（含 X- 前缀规则） */
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
    // ---------- 1. places / routes / stations 幂等 upsert（自愈补齐 T363/2 等） ----------
    console.log("\n── 1/3 静态参照 upsert ──");
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
    console.log(`  ✅ places：${placeIds.size} 个`);

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
    console.log(`  ✅ routes：${routeIds.size} 条`);

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
    console.log(`  ✅ stations 幂等 upsert：${stationUpsert} 行（含 T363/2 等）`);

    // ---------- 2. 方案全量对齐（与 JSON 权威源一致；停用卡置 is_active=false） ----------
    console.log("\n── 2/3 方案对齐 ──");
    let inserted = 0;
    let updated = 0;
    let legInserted = 0;
    let legUpdated = 0;
    let legDeleted = 0;
    for (const p of net.plans) {
      const fromPlaceId = placeIds.get(p.from) ?? null;
      const toPlaceId = placeIds.get(p.to) ?? null;
      if (!fromPlaceId || !toPlaceId) continue;
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
          `UPDATE commute_plans SET summary=$1, from_place=$2, to_place=$3,
             is_active=$4, note=$5 WHERE id=$6`,
          [p.summary, fromPlaceId, toPlaceId, isActive, p.note ?? null, planId],
        );
        updated++;
      }

      // legs 对齐：新 JSON 中没有的旧 seq 删除（仅该方案自身静态段；计时表不动）
      const newSeqs = p.legs.map((l) => l.seq);
      const del = await q(
        `DELETE FROM plan_legs WHERE plan_id=$1 AND NOT (seq = ANY($2::int[]))`,
        [planId, newSeqs],
      );
      legDeleted += del.rowCount ?? 0;

      // plan 顶层 board_candidates → 挂到该 plan 首个载具段（bus/lrt）行
      const firstVehicle = p.legs.find((l) => l.kind === "bus" || l.kind === "lrt");
      const firstVehicleSeq = firstVehicle ? firstVehicle.seq : null;

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
        const borderLabel = leg.kind === "cross_border" ? (leg.label ?? leg.at ?? null) : null;

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

    // ---------- 3. v0.16.0 专属校验 ----------
    console.log("\n── 3/3 v0.16.0 校验 ──");
    const keys = [
      "home-school-3",
      "home-school-9",
      "home-school-25",
      "home-school-25ax",
      "home-school-8",
      "school-home-7",
      "school-home-6",
    ];
    const { rows } = await q(
      `SELECT p.plan_key, p.is_active, p.summary, l.seq, l.leg_kind,
              l.from_station AS frm, l.to_station AS to, l.board_candidates, l.alight_candidates
       FROM commute_plans p
       LEFT JOIN plan_legs l ON l.plan_id = p.id
       WHERE p.plan_key = ANY($1)
       ORDER BY p.plan_key, l.seq`,
      [keys],
    );
    const byPlan = new Map<string, (typeof rows)[number][]>();
    for (const r of rows as typeof rows) {
      if (!byPlan.has(r.plan_key)) byPlan.set(r.plan_key, []);
      byPlan.get(r.plan_key)!.push(r);
    }
    for (const [k, legs] of byPlan) {
      const first = legs[0];
      console.log(
        `\n${k} | active=${first.is_active} | ${first.summary}`,
      );
      for (const l of legs) {
        if (!l.seq) continue;
        console.log(
          `  seq${l.seq} ${l.leg_kind.padEnd(5)} ${l.frm ?? ""} -> ${l.to ?? ""}` +
            `${l.board_candidates ? ` board=${JSON.stringify(l.board_candidates)}` : ""}` +
            `${l.alight_candidates ? ` alight=${JSON.stringify(l.alight_candidates)}` : ""}`,
        );
      }
    }

    // 断言：三段式关键卡必须带正确的候选
    const { rows: hs3Rows } = await q(
      `SELECT alight_candidates FROM plan_legs l JOIN commute_plans p ON l.plan_id=p.id
       WHERE p.plan_key='home-school-3' AND l.leg_kind='bus'`,
    );
    const hs3 = hs3Rows as { alight_candidates: string[] | null }[];
    const a3 = hs3[0]?.alight_candidates;
    const { rows: hs9Rows } = await q(
      `SELECT alight_candidates FROM plan_legs l JOIN commute_plans p ON l.plan_id=p.id
       WHERE p.plan_key='home-school-9' AND l.leg_kind='lrt' AND l.seq=4`,
    );
    const hs9 = hs9Rows as { alight_candidates: string[] | null }[];
    const a9 = hs9[0]?.alight_candidates;
    const ok3 = JSON.stringify(a3) === JSON.stringify(["T363/1", "T367"]);
    const ok9 = JSON.stringify(a9) === JSON.stringify(["LRT-LDE", "LRT-MUST"]);
    console.log(
      `\n三段式候选：home-school-3=${ok3 ? "✓" : "✗"} (${JSON.stringify(a3)}) | ` +
        `home-school-9=${ok9 ? "✓" : "✗"} (${JSON.stringify(a9)})`,
    );
    if (ok3 && ok9) {
      console.log("✅ v0.16.0 迁移完成（计时数据未触碰）");
    } else {
      console.error("❌ 校验未通过：alight_candidates 与预期不符");
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("❌ 迁移失败：", (e as Error).message);
  process.exit(1);
});
