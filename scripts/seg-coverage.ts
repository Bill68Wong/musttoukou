/**
 * 采集覆盖率 / 缺口清单（scripts/seg-coverage.ts）
 * 用法：npm run db:coverage -- [local|cloud] [--min=2]
 *
 * 把每个通勤方案（commute_plans × plan_legs）的巴士/轻轨段，按候选线路的站序
 * 逐段展开成「相邻站对」，再对齐 segment_stats 的样本数，输出：
 *   A. 按方向 × 方案的分线覆盖概览（缺 X/Y 段）
 *   B. 去重后的待补段总表（按线路归并，标注当前样本数）
 *
 * 用途：数据收集阶段用来回答「下次出门跑哪趟、打哪些点能补最多缺口」。
 * 纯只读，不写库。
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const target = (process.argv[2] ?? "cloud") as "local" | "cloud";
const minArg = process.argv.find((a) => a.startsWith("--min="));
const MIN = minArg ? Number(minArg.split("=")[1]) : 2;
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

const PLACE_SHORT: Record<string, string> = {
  home: "擎天匯",
  school: "澳科大",
  hengqin: "橫琴口岸",
  gate: "關閘（拱北口岸）",
};
const PAIR_ORDER = ["school", "hengqin", "gate"];

const mainCode = (c: string) => /^[A-Za-z]+\d+/.exec(c)?.[0] ?? c;
const stripCode = (s: string) => s.replace(/^[A-Za-z]+\d+(?:\/\d+)?\s+/, "");

/** 三段式站码匹配 → 返回所有命中的下标（循环线首尾同码会返回 2 个） */
function idxsOf(stops: string[], target: string): number[] {
  const hit = (fn: (s: string) => boolean) => stops.map((s, i) => (fn(s) ? i : -1)).filter((i) => i >= 0);
  const exact = hit((s) => s === target);
  if (exact.length) return exact;
  const mid = hit((s) => s.startsWith(target + "/"));
  if (mid.length) return mid;
  const rev = hit((s) => target.startsWith(s + "/"));
  if (rev.length) return rev;
  const p = mainCode(target);
  return hit((s) => mainCode(s) === p);
}

async function main() {
  // ① 方案 + 段
  const plans = await q(
    `SELECT p.id, p.summary, pf.slug AS from_slug, pt.slug AS to_slug
       FROM commute_plans p
       JOIN places pf ON pf.id = p.from_place
       JOIN places pt ON pt.id = p.to_place
      ORDER BY p.id`,
  );
  const legs = await q(
    `SELECT plan_id, seq, leg_kind, route_options, from_station, to_station, route_meta
       FROM plan_legs ORDER BY plan_id, seq`,
  );
  // ② 站序
  const rs = await q(
    `SELECT r.code AS route, rs.dsat_dir, rs.seq, rs.station_code, st.name_tc
       FROM route_stations rs
       JOIN routes r ON r.id = rs.route_id
       LEFT JOIN stations st ON st.code = rs.station_code
      ORDER BY r.code, rs.dsat_dir, rs.seq`,
  );
  const dirStops = new Map<string, string[]>(); // route|dir -> codes[]
  const nameOf = new Map<string, string>();
  for (const r of rs) {
    const key = `${r.route}|${r.dsat_dir}`;
    if (!dirStops.has(key)) dirStops.set(key, []);
    dirStops.get(key)!.push(r.station_code as string);
    if (r.name_tc) nameOf.set(r.station_code as string, r.name_tc as string);
  }
  // ③ 样本数
  const stats = await q(
    `SELECT route_code, from_station, to_station, samples FROM segment_stats
      WHERE weekday = -1 AND time_bucket = 'all' AND arrive_kind = 'all'`,
  );
  const sampleOf = new Map<string, number>();
  for (const s of stats) {
    // 双向可查：主码归一化后建索引（segment 里存的是站序原始码）
    sampleOf.set(`${s.route_code}|${s.from_station}|${s.to_station}`, s.samples as number);
  }
  const lookup = (route: string, from: string, to: string): number => {
    const direct = sampleOf.get(`${route}|${from}|${to}`);
    if (direct !== undefined) return direct;
    // 主码回退（方案侧可能只写主码，或站序侧带后缀）
    for (const [k, v] of sampleOf) {
      const [r, f, t] = k.split("|");
      if (r === route && mainCode(f) === mainCode(from) && mainCode(t) === mainCode(to)) return v;
    }
    return 0;
  };

  /** 对某条线路、某 from→to，取段列表（选能顺向解出的方向 + 环距最近的解） */
  function segmentsOf(route: string, from: string, to: string): { stops: string[]; segs: [string, string][] } | null {
    const dirs = [...dirStops.keys()].filter((k) => k.startsWith(route + "|")).map((k) => k.split("|")[1]);
    let best: { stops: string[]; segs: [string, string][] } | null = null;
    for (const d of dirs) {
      const stops = dirStops.get(`${route}|${d}`)!;
      const fis = idxsOf(stops, from);
      const tis = idxsOf(stops, to);
      if (!fis.length || !tis.length) continue;
      // 枚举 from/to 的全部命中解，取「沿行驶方向环距最近」的那个
      // （循环线首尾同码：C690/3 在 seq 1 和 20，从 T417 出发应取 seq 20 那圈）
      let bestPair: { i: number; j: number } | null = null;
      for (const i of fis) {
        for (const j of tis) {
          if (j <= i) continue;
          if (!bestPair || j - i < bestPair.j - bestPair.i) bestPair = { i, j };
        }
      }
      if (!bestPair) continue;
      const segs: [string, string][] = [];
      for (let k = bestPair.i; k < bestPair.j; k++) segs.push([stops[k], stops[k + 1]]);
      if (!best || segs.length > best.segs.length) best = { stops, segs };
    }
    return best;
  }

  const legsByPlan = new Map<number, Record<string, unknown>[]>();
  for (const l of legs) {
    if (!legsByPlan.has(l.plan_id as number)) legsByPlan.set(l.plan_id as number, []);
    legsByPlan.get(l.plan_id as number)!.push(l);
  }

  const gapAgg = new Map<string, { route: string; from: string; to: string; n: number; plans: Set<number> }>();

  console.log(`\n========== 段覆盖率 / 缺口清单（${target}，目标 ≥${MIN} 次样本）==========`);
  console.log(`样本源：segment_stats 兜底行（weekday=-1 / bucket=all / kind=all）\n`);

  /** 每个 (from_slug,to_slug) 方向 → plans */
  const byPair = new Map<string, number[]>();
  for (const p of plans) {
    const key = `${p.from_slug}→${p.to_slug}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key)!.push(p.id as number);
  }

  const order = ["home→school", "school→home", "home→hengqin", "hengqin→home", "home→gate", "gate→home"];
  const keys = [...byPair.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  for (const key of keys) {
    const [from, to] = key.split("→");
    console.log(`──────────────── ${PLACE_SHORT[from] ?? from} → ${PLACE_SHORT[to] ?? to} ────────────────`);
    for (const pid of byPair.get(key)!) {
      const plan = plans.find((p) => p.id === pid)!;
      const ls = legsByPlan.get(pid) ?? [];
      const veh = ls.filter((l) => l.leg_kind === "bus" || l.leg_kind === "lrt");
      if (!veh.length) continue;
      console.log(`◆ plan ${pid}  ${plan.summary}`);
      for (const l of veh) {
        const opts = l.route_options ? (JSON.parse(l.route_options as string) as string[]) : [];
        const meta = (l.route_meta ?? null) as Record<string, { board?: string[]; to?: string; alight?: string[] }> | null;
        for (const route of opts) {
          const m = meta?.[route];
          const fromSt = m?.board?.[0] ?? (l.from_station as string | null);
          const toSt = m?.to ?? (l.to_station as string | null);
          if (!fromSt || !toSt) {
            console.log(`    ${route.padEnd(14)} ⚠ 站码缺失（from=${fromSt} to=${toSt}）`);
            continue;
          }
          const r = segmentsOf(route as string, fromSt, toSt);
          if (!r) {
            console.log(`    ${route.padEnd(14)} ${fromSt} → ${toSt}   ⚠ 站序中解不出（检查方向/站码）`);
            continue;
          }
          let covered = 0;
          const gaps: string[] = [];
          const seen = new Set<string>();
          for (const [a, b] of r.segs) {
            const kk = `${mainCode(a)}→${mainCode(b)}`;
            if (seen.has(kk)) continue;
            seen.add(kk);
            const n = lookup(route as string, a, b);
            if (n >= MIN) covered++;
            else gaps.push(`${a}→${b}(${n})`);
            if (n < MIN) {
              const gk = `${route as string}|${a}|${b}`;
              if (!gapAgg.has(gk)) gapAgg.set(gk, { route: route as string, from: a, to: b, n, plans: new Set() });
              gapAgg.get(gk)!.plans.add(pid);
            }
          }
          const total = covered + gaps.length;
          const flag = gaps.length === 0 ? "✅" : covered === 0 ? "🔴" : "🟡";
          console.log(`    ${flag} ${route.padEnd(14)} ${fromSt} → ${toSt}  覆盖 ${covered}/${total} 段`);
          if (gaps.length) console.log(`         缺：${gaps.join("  ")}`);
        }
      }
    }
    console.log("");
  }

  // B. 去重待补总表（按线路归并）
  const byRoute = new Map<string, { from: string; to: string; n: number; plans: Set<number> }[]>();
  for (const g of gapAgg.values()) {
    if (!byRoute.has(g.route)) byRoute.set(g.route, []);
    byRoute.get(g.route)!.push({ from: g.from, to: g.to, n: g.n, plans: g.plans });
  }
  console.log(`========== 待补段总表（共 ${gapAgg.size} 段，按线路归并）==========`);
  const routesSorted = [...byRoute.keys()].sort();
  for (const r of routesSorted) {
    const list = byRoute.get(r)!.sort((a, b) => a.n - b.n);
    console.log(`\n[${r}] 缺 ${list.length} 段`);
    for (const g of list) {
      const nm = stripCode(nameOf.get(g.to) ?? "");
      console.log(`   ${g.from} → ${g.to}${nm ? " " + nm : ""}   样本 ${g.n}   （plan ${[...g.plans].join(",")}）`);
    }
  }

  // C. 已跑过的线路（供排期参考）
  const ran = await q(
    `SELECT route_code, count(*) AS n, max(started_at) AS last
       FROM timer_sessions WHERE deleted_at IS NULL AND NOT COALESCE(is_test,false) AND route_code IS NOT NULL
      GROUP BY route_code ORDER BY n DESC`,
  );
  console.log(`\n========== 已实测线路（会话数）==========`);
  console.log("  " + ran.map((r) => `${r.route_code}(${r.n})`).join("  "));

  await pool.end();
}

main().catch((e) => {
  console.error("覆盖率统计失败：", e);
  process.exit(1);
});
