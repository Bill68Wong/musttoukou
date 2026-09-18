/**
 * ⚠️⚠️ 跑本脚本前必读：**它会清空 stations 表，而种子数据不含坐标**
 *
 *   `TRUNCATE ... stations, places ...` 会让 **610 行站点坐标永久丢失**，
 *   而种子插入语句只写 code/name/kind —— 不含 lat/lng。
 *
 *   跑完之后必须补一步恢复坐标：
 *       npm run db:coords
 *
 *   （v1.2.0 起坐标导入已正式化为 db/import-station-coords.ts，可一键恢复；
 *     在那之前恢复脚本躺在 .verify/ 里、没有 npm 入口，极容易踩坑。）
 */
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
  note?: string;
}
interface LegSeed {
  seq: number;
  kind: string;
  routes?: string[];
  from?: string; // "place:home" | "station:C653"
  to?: string;
  at?: string; // transfer/cross_border 的位置
  note?: string;
  /** v0.13.0 cross_border 段口岸显示名（'橫琴口岸' / '關閘（拱北口岸）'） */
  label?: string;
  /** 动态下车候选（bus 回宿舍），末位 = 强制终点 */
  alight_candidates?: string[];
  /** v0.17.0：合并卡每线路差异化 { "50": { to, board?, alight? } } */
  routeMeta?: Record<string, { to?: string; board?: string[]; alight?: string[] }>;
}
interface PlanSeed {
  id: string;
  from: string;
  to: string;
  summary: string;
  is_active?: boolean;
  legs: LegSeed[];
  note?: string;
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

const net = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "data", "commute-network.json"), "utf8"),
) as {
  places: { id: string; name: string; type: string }[];
  stations: StationSeed[];
  routes: { code: string; kind: string; company?: string; color?: string }[];
  lrtLineStops: { code: string; dirs: Record<string, string[]> }[];
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
    // v0.24.0：不再清空 walk_times —— 该表只存实测值，由 npm run db:walktimes 维护，
    // 导入静态母本不应将其抹掉
    await q(`TRUNCATE plan_legs, commute_plans, route_stations, routes, stations, places
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

    // 3. walk_times：v0.24.0 起不在此导入
    //    （手工估算值已全面剔除；实测值由 npm run db:walktimes 从计时数据回写）

    // 4. routes
    const routeIds = new Map<string, number>();
    for (const r of net.routes) {
      const res = await q(
        `INSERT INTO routes (code, kind, company, color) VALUES ($1,$2,$3,$4) RETURNING id`,
        [r.code, r.kind, r.company ?? null, r.color ?? null],
      );
      routeIds.set(r.code, (res.rows[0] as { id: number }).id);
    }
    console.log(`✅ routes：${net.routes.length} 条（含主题色）`);

    // 4.5 轻轨站序（route_stations 仅 LRT 静态三线；巴士站序由 DSAT 同步脚本维护）
    let lrtStopCount = 0;
    for (const line of net.lrtLineStops ?? []) {
      const routeId = routeIds.get(line.code);
      if (!routeId) continue;
      for (const [dir, stops] of Object.entries(line.dirs)) {
        let seq = 0;
        for (const code of stops) {
          await q(
            `INSERT INTO route_stations (route_id, dsat_dir, seq, station_code)
             VALUES ($1,$2,$3,$4)`,
            [routeId, dir, ++seq, code],
          );
          lrtStopCount++;
        }
      }
    }
    console.log(`✅ route_stations（LRT 站序）：${lrtStopCount} 行`);

    // 5. plans + legs
    let legCount = 0;
    for (const p of net.plans) {
      const res = await q(
        `INSERT INTO commute_plans (plan_key, from_place, to_place, summary, is_active, note)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          p.id,
          placeIds.get(p.from),
          placeIds.get(p.to),
          p.summary,
          p.is_active !== false,
          p.note ?? null,
        ],
      );
      const planId = (res.rows[0] as { id: number }).id;

      // plan 顶层 board_candidates → 挂到该 plan 首个载具段（bus/lrt）行
      const firstVehicleSeq = p.legs.find((l) => l.kind === "bus" || l.kind === "lrt")?.seq ?? null;

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

        const isVehicle = leg.kind === "bus" || leg.kind === "lrt";
        const boardCands =
          isVehicle && firstVehicleSeq === leg.seq && p.board_candidates?.length
            ? (p.board_candidates.map(resolveStation).filter(Boolean) as string[])
            : [];
        const alightCands = (leg.alight_candidates ?? [])
          .map(resolveStation)
          .filter(Boolean) as string[];

        await q(
          `INSERT INTO plan_legs (plan_id, seq, leg_kind, route_id, route_options,
                                  from_station, to_station, note,
                                  border_label, board_candidates, alight_candidates, route_meta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
            leg.note ?? null,
            leg.kind === "cross_border" ? (leg.label ?? null) : null,
            boardCands.length ? boardCands : null,
            alightCands.length ? alightCands : null,
            // v0.17.0：合并卡的每线路差异化（routeMeta）——站码已是最终码，无需 resolve
            leg.routeMeta && Object.keys(leg.routeMeta).length
              ? JSON.stringify(leg.routeMeta)
              : null,
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
