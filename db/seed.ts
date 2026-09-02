/**
 * 种子数据导入（db/seed.ts）：data/commute-network.json → 数据库
 * 用法与建表相同：npm run db:seed -- [local|cloud]
 *
 * 规则：
 *  - 无官方编号的站点用临时编号 X-<名称>（待 DSAT 核对后替换）
 *  - 幂等：导入前清空六张静态表（TRUNCATE CASCADE），不影响计时数据
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
  from?: string; // "place:home" | "station:C653"
  to?: string;
  at?: string; // transfer/cross_border 的位置
  minutes: number | null;
  note?: string;
}
interface PlanSeed {
  id: string;
  from: string;
  to: string;
  summary: string;
  legs: LegSeed[];
  note?: string;
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

const net = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "data", "commute-network.json"), "utf8"),
) as {
  places: { id: string; name: string; type: string }[];
  stations: StationSeed[];
  routes: { code: string; kind: string; company?: string }[];
  plans: PlanSeed[];
};

/** 无编号站点 → X-名称 临时编号 */
const stationCode = (s: StationSeed): string => s.code ?? `X-${s.name_tc}`;

async function main() {
  const pool = new Pool({
    connectionString: connStr,
    max: 1,
    ssl: (connStr as string).includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  const q = pool.query.bind(pool);

  try {
    await q(`TRUNCATE plan_legs, commute_plans, route_stations, walk_times, routes, stations, places
             RESTART IDENTITY CASCADE`);

    // 1. places
    const placeIds = new Map<string, number>();
    for (const p of net.places) {
      const r = await q(
        `INSERT INTO places (slug, name, kind) VALUES ($1,$2,$3) RETURNING id`,
        [p.id, p.name, p.type],
      );
      placeIds.set(p.id, (r.rows[0] as { id: number }).id);
    }
    console.log(`✅ places：${net.places.length} 条`);

    // 2. stations（含临时编号）
    for (const s of net.stations) {
      await q(
        `INSERT INTO stations (code, name_tc, kind, dsat_synced, note)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (code) DO UPDATE SET name_tc = EXCLUDED.name_tc, note = EXCLUDED.note`,
        [
          stationCode(s),
          s.name_tc,
          s.kind,
          s.code !== null, // 有真实编号视为已核对
          s.note ?? null,
        ],
      );
    }
    console.log(`✅ stations：${net.stations.length} 条`);

    // 3. walk_times（只导非空实测值）
    let walkCount = 0;
    for (const s of net.stations) {
      for (const [placeSlug, minutes] of Object.entries(s.walk)) {
        if (minutes === null || minutes === undefined) continue;
        await q(
          `INSERT INTO walk_times (place_id, station_code, minutes, source, measured_at)
           VALUES ($1,$2,$3,'manual','2026-09-01')`,
          [placeIds.get(placeSlug), stationCode(s), minutes],
        );
        walkCount++;
      }
    }
    console.log(`✅ walk_times：${walkCount} 条实测值`);

    // 4. routes
    const routeIds = new Map<string, number>();
    for (const r of net.routes) {
      const res = await q(
        `INSERT INTO routes (code, kind, company) VALUES ($1,$2,$3) RETURNING id`,
        [r.code, r.kind, r.company ?? null],
      );
      routeIds.set(r.code, (res.rows[0] as { id: number }).id);
    }
    console.log(`✅ routes：${net.routes.length} 条`);

    // 5. plans + legs
    let legCount = 0;
    for (const p of net.plans) {
      const res = await q(
        `INSERT INTO commute_plans (plan_key, from_place, to_place, summary, note)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [p.id, placeIds.get(p.from), placeIds.get(p.to), p.summary, p.note ?? null],
      );
      const planId = (res.rows[0] as { id: number }).id;

      for (const leg of p.legs) {
        const ref = (v?: string): string | null => {
          if (!v) return null;
          if (v.startsWith("station:")) return v.slice(8); // 已是编号（含 X- 前缀按名称查）
          return null;
        };
        // 站点引用可能是真实编号（C653）也可能是名称（路氹東/新濠天地）
        const resolveStation = (v?: string): string | null => {
          if (!v) return null;
          const raw = v.startsWith("station:") ? v.slice(8) : v;
          const found = net.stations.find(
            (s) => stationCode(s) === raw || s.name_tc === raw,
          );
          return found ? stationCode(found) : null;
        };
        const atStation = resolveStation(leg.at);

        await q(
          `INSERT INTO plan_legs (plan_id, seq, leg_kind, route_id, route_options,
                                  from_station, to_station, minutes, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            planId,
            leg.seq,
            leg.kind,
            leg.routes && leg.routes.length === 1 ? routeIds.get(leg.routes[0]) : null,
            leg.routes && leg.routes.length > 0 ? JSON.stringify(leg.routes) : null,
            leg.kind === "transfer" || leg.kind === "cross_border"
              ? atStation
              : resolveStation(leg.from),
            leg.kind === "transfer" || leg.kind === "cross_border"
              ? atStation
              : resolveStation(leg.to),
            leg.minutes,
            leg.note ?? null,
          ],
        );
        legCount++;
      }
    }
    console.log(`✅ commute_plans：${net.plans.length} 条；plan_legs：${legCount} 条`);
    console.log("\n🎉 种子导入完成");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("❌ 种子导入失败：", e.message);
  process.exit(1);
});
