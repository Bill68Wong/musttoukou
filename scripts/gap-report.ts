/**
 * 时间样本缺口清单（按方向）—— scripts/gap-report.ts
 * 用法：npm run db:gaps -- [local|cloud] [--from=home] [--to=school] [--min=2]
 *
 * 回答「这条通勤线还缺哪些时间样本」。覆盖三类时间样本：
 *   A. 乘车段：segment_stats 的邻接站对时长（按候选线路的站序展开）
 *   B. 步行段：walk_times 的 place ↔ 站点 步行时长（含 zone 子维度）
 *   C. 换乘段：plan_legs 里的 transfer 腿（站内换乘耗时）
 * 并标注每段的「跨线路共享数」——同一邻接站对被 N 条线共用，
 * 补一次即服务 N 条线（本项目核心采集方法论）。
 * 纯只读，不写库。
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const target = (process.argv[2] ?? "local") as "local" | "cloud";
const argOf = (k: string, d: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const FROM = argOf("from", "home");
const TO = argOf("to", "school");
const MIN = Number(argOf("min", "2"));

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

const PLACE_SHORT: Record<string, string> = {
  home: "擎天匯",
  school: "澳科大",
  hengqin: "橫琴口岸",
  gate: "關閘（拱北口岸）",
};

const mainCode = (c: string) => /^[A-Za-z]+\d+/.exec(c)?.[0] ?? c;
const stripCode = (s: string) => s.replace(/^[A-Za-z]+\d+(?:\/\d+)?\s+/, "");

/** 三段式站码匹配 → 所有命中下标（循环线首尾同码返回多个） */
function idxsOf(stops: string[], t: string): number[] {
  const hit = (fn: (s: string) => boolean) => stops.map((s, i) => (fn(s) ? i : -1)).filter((i) => i >= 0);
  const exact = hit((s) => s === t);
  if (exact.length) return exact;
  const mid = hit((s) => s.startsWith(t + "/"));
  if (mid.length) return mid;
  const rev = hit((s) => t.startsWith(s + "/"));
  if (rev.length) return rev;
  const p = mainCode(t);
  return hit((s) => mainCode(s) === p);
}

async function main() {
  // ① 地点
  const places = await q(`SELECT id, slug, name FROM places`);
  const placeId = new Map<string, number>();
  const placeName = new Map<number, string>();
  for (const p of places) {
    placeId.set(p.slug as string, p.id as number);
    // 优先用页面短名（与首页/统计页一致），否则退回库内 name
    placeName.set(p.id as number, PLACE_SHORT[p.slug as string] ?? (p.name as string) ?? (p.slug as string));
  }
  const fromId = placeId.get(FROM);
  const toId = placeId.get(TO);
  if (!fromId || !toId) throw new Error(`未找到 place slug：${FROM} / ${TO}`);

  // ② 站序索引 + 邻接对共享数
  const rs = await q(
    `SELECT r.code AS route, rs.dsat_dir, rs.seq, rs.station_code, st.name_tc
       FROM route_stations rs
       JOIN routes r ON r.id = rs.route_id
       LEFT JOIN stations st ON st.code = rs.station_code
      ORDER BY r.code, rs.dsat_dir, rs.seq`,
  );
  const dirStops = new Map<string, string[]>();
  const nameOf = new Map<string, string>();
  /** 邻接对（主码）→ 含该对的线路集合 */
  const pairRoutes = new Map<string, Set<string>>();
  {
    // 先按 route|dir 收集（保持一个方向一条站序）
    const perDir = new Map<string, string[]>();
    for (const r of rs) {
      const k = `${r.route}|${r.dsat_dir}`;
      if (!perDir.has(k)) perDir.set(k, []);
      perDir.get(k)!.push(r.station_code as string);
      if (r.name_tc) nameOf.set(r.station_code as string, r.name_tc as string);
    }
    for (const [k, stops] of perDir) {
      const route = k.split("|")[0];
      dirStops.set(k, stops);
      for (let i = 0; i + 1 < stops.length; i++) {
        const pk = `${mainCode(stops[i])}→${mainCode(stops[i + 1])}`;
        if (!pairRoutes.has(pk)) pairRoutes.set(pk, new Set());
        pairRoutes.get(pk)!.add(route);
      }
    }
  }
  const shareCount = (a: string, b: string) =>
    (pairRoutes.get(`${mainCode(a)}→${mainCode(b)}`) ?? new Set<string>()).size;

  // ③ 样本数（兜底行）
  const stats = await q(
    `SELECT route_code, from_station, to_station, samples FROM segment_stats
      WHERE weekday = -1 AND time_bucket = 'all' AND arrive_kind = 'all'`,
  );
  const sampleOf = new Map<string, number>();
  for (const s of stats) sampleOf.set(`${s.route_code}|${s.from_station}|${s.to_station}`, s.samples as number);
  const lookup = (route: string, from: string, to: string): number => {
    const d = sampleOf.get(`${route}|${from}|${to}`);
    if (d !== undefined) return d;
    for (const [k, v] of sampleOf) {
      const [r, f, t] = k.split("|");
      if (r === route && mainCode(f) === mainCode(from) && mainCode(t) === mainCode(to)) return v;
    }
    return 0;
  };

  /** 线路 + from→to → 相邻段列表（选顺向 + 环距最近解） */
  function segmentsOf(route: string, from: string, to: string): [string, string][] | null {
    const dirs = [...dirStops.keys()].filter((k) => k.startsWith(route + "|")).map((k) => k.split("|")[1]);
    let best: [string, string][] | null = null;
    for (const d of dirs) {
      const stops = dirStops.get(`${route}|${d}`)!;
      const fis = idxsOf(stops, from);
      const tis = idxsOf(stops, to);
      if (!fis.length || !tis.length) continue;
      let bp: { i: number; j: number } | null = null;
      for (const i of fis) for (const j of tis) if (j > i && (!bp || j - i < bp.j - bp.i)) bp = { i, j };
      if (!bp) continue;
      const segs: [string, string][] = [];
      for (let k = bp.i; k < bp.j; k++) segs.push([stops[k], stops[k + 1]]);
      if (!best || segs.length > best.length) best = segs;
    }
    return best;
  }

  // ④ 本方向方案 + 腿
  const plans = await q(
    `SELECT p.id, p.plan_key, p.summary, p.is_active
       FROM commute_plans p
      WHERE p.from_place = $1 AND p.to_place = $2
      ORDER BY p.id`,
    [fromId, toId],
  );
  const pids = plans.map((p) => p.id as number);
  const legs = pids.length
    ? await q(
        `SELECT plan_id, seq, leg_kind, from_station, to_station, route_options, route_meta
           FROM plan_legs WHERE plan_id = ANY($1::int[]) ORDER BY plan_id, seq`,
        [pids],
      )
    : [];
  const legsOf = new Map<number, Record<string, unknown>[]>();
  for (const l of legs) {
    if (!legsOf.has(l.plan_id as number)) legsOf.set(l.plan_id as number, []);
    legsOf.get(l.plan_id as number)!.push(l);
  }

  // ⑤ 步行样本现状
  const walks = await q(
    `SELECT place_id, station_code, zone, minutes, samples FROM walk_times ORDER BY place_id, station_code, zone`,
  );
  const walkRows = new Map<string, { zone: string | null; minutes: number; samples: number }[]>();
  for (const w of walks) {
    const k = `${w.place_id}|${mainCode(w.station_code as string)}`;
    if (!walkRows.has(k)) walkRows.set(k, []);
    walkRows.get(k)!.push({
      zone: (w.zone as string) ?? null,
      minutes: Number(w.minutes),
      samples: w.samples as number,
    });
  }

  const ft = `${PLACE_SHORT[FROM] ?? FROM} → ${PLACE_SHORT[TO] ?? TO}`;
  console.log(`\n${"=".repeat(18)} ${ft} 时间样本缺口（目标 ≥${MIN} 次）${"=".repeat(18)}`);
  console.log(`库：${target} ｜ 方案 ${plans.length} 个（active ${plans.filter((p) => p.is_active).length}）\n`);

  // 汇总容器
  type Gap = { route: string; from: string; to: string; n: number; share: number; plans: Set<number> };
  const gapAgg = new Map<string, Gap>();
  let segTotal = 0;
  let segOk = 0;
  const walkNeed = new Map<string, { place: number; station: string; plans: Set<number> }>();
  const transferNeed: { plan: number; station: string; note: string }[] = [];

  console.log("── A. 乘车段（segment_stats 邻接站对）──");
  for (const plan of plans) {
    const ls = legsOf.get(plan.id as number) ?? [];
    const veh = ls.filter((l) => l.leg_kind === "bus" || l.leg_kind === "lrt");
    const tag = plan.is_active ? "[active]" : "[inactive]";
    const lines: string[] = [];
    for (const l of veh) {
      const opts = l.route_options ? (JSON.parse(l.route_options as string) as string[]) : [];
      const meta = (l.route_meta ?? null) as Record<string, { board?: string[]; to?: string }> | null;
      for (const route of opts) {
        const m = meta?.[route];
        const fSt = m?.board?.[0] ?? (l.from_station as string | null);
        const tSt = m?.to ?? (l.to_station as string | null);
        if (!fSt || !tSt) {
          lines.push(`   ⚠ ${String(route).padEnd(14)} 站码缺失（from=${fSt} to=${tSt}）`);
          continue;
        }
        const segs = segmentsOf(route as string, fSt, tSt);
        if (!segs) {
          lines.push(`   ⚠ ${String(route).padEnd(14)} ${fSt} → ${tSt}  站序中解不出`);
          continue;
        }
        let ok = 0;
        const gaps: string[] = [];
        const seen = new Set<string>();
        for (const [a, b] of segs) {
          const kk = `${mainCode(a)}→${mainCode(b)}`;
          if (seen.has(kk)) continue;
          seen.add(kk);
          segTotal++;
          const n = lookup(route as string, a, b);
          if (n >= MIN) {
            ok++;
            segOk++;
          } else {
            gaps.push(`${a}→${b}(样本${n},共享${shareCount(a, b)}线)`);
            const gk = `${route}|${a}|${b}`;
            if (!gapAgg.has(gk))
              gapAgg.set(gk, { route: route as string, from: a, to: b, n, share: shareCount(a, b), plans: new Set() });
            gapAgg.get(gk)!.plans.add(plan.id as number);
          }
        }
        const tot = ok + gaps.length;
        const flag = gaps.length === 0 ? "✅" : ok === 0 ? "🔴" : "🟡";
        lines.push(`   ${flag} ${String(route).padEnd(14)} ${fSt} → ${tSt}  覆盖 ${ok}/${tot} 段`);
        if (gaps.length) lines.push(`        缺：${gaps.join("  ")}`);
      }
    }
    if (lines.length) {
      console.log(`◆ ${plan.plan_key} ${tag}  ${plan.summary}`);
      console.log(lines.join("\n"));
    }
  }

  // B. 步行段
  console.log("\n── B. 步行段（walk_times：place ↔ 站点）──");
  for (const plan of plans) {
    const ls = legsOf.get(plan.id as number) ?? [];
    for (const l of ls) {
      if (l.leg_kind !== "walk") continue;
      const seqs = ls.map((x) => x.seq as number);
      const isStart = (l.seq as number) === Math.min(...seqs);
      const isEnd = (l.seq as number) === Math.max(...seqs);
      // 起点步行 = seq 最小 walk 的 to_station（place = from）；到点步行 = seq 最大 walk 的 from_station（place = to）
      if (isStart && l.to_station) {
        const k = `${fromId}|${mainCode(l.to_station as string)}`;
        if (!walkNeed.has(k))
          walkNeed.set(k, { place: fromId, station: l.to_station as string, plans: new Set() });
        walkNeed.get(k)!.plans.add(plan.id as number);
      } else if (isEnd && l.from_station) {
        const k = `${toId}|${mainCode(l.from_station as string)}`;
        if (!walkNeed.has(k))
          walkNeed.set(k, { place: toId, station: l.from_station as string, plans: new Set() });
        walkNeed.get(k)!.plans.add(plan.id as number);
      }
    }
  }
  let walkOk = 0;
  const walkGaps: { place: number; station: string; plans: number[] }[] = [];
  for (const [k, w] of [...walkNeed.entries()].sort()) {
    const rows = walkRows.get(k);
    const nm = stripCode(nameOf.get(w.station) ?? "");
    if (rows?.length) {
      const lowN = rows.every((r) => r.samples < MIN);
      if (lowN) {
        walkGaps.push({ place: w.place, station: w.station, plans: [...w.plans] });
        console.log(
          `   🟡 ${placeName.get(w.place)} · ${w.station}${nm ? " " + nm : ""}  —— ` +
            rows.map((r) => `${r.zone ?? "-"} ${r.minutes}分 n=${r.samples}`).join(" · ") +
            `   （plan ${[...w.plans].join(",")}）`,
        );
      } else {
        walkOk++;
        console.log(
          `   ✅ ${placeName.get(w.place)} · ${w.station}${nm ? " " + nm : ""}  —— ` +
            rows.map((r) => `${r.zone ?? "-"} ${r.minutes}分 n=${r.samples}`).join(" · "),
        );
      }
    } else {
      walkGaps.push({ place: w.place, station: w.station, plans: [...w.plans] });
      console.log(
        `   ❌ ${placeName.get(w.place)} · ${w.station}${nm ? " " + nm : ""}  缺样本   （plan ${[...w.plans].join(",")}）`,
      );
    }
  }

  // C. 换乘段
  console.log("\n── C. 换乘段（plan_legs 的 transfer 腿）──");
  for (const plan of plans) {
    const ls = legsOf.get(plan.id as number) ?? [];
    const tr = ls.filter((l) => l.leg_kind === "transfer");
    if (!tr.length) continue;
    for (const l of tr) {
      const st = (l.from_station as string) ?? "-";
      transferNeed.push({ plan: plan.id as number, station: st, note: `${st} 站内换乘` });
      console.log(`   ${plan.is_active ? "🔴" : "⚪"} ${plan.plan_key}  ${st} 站内换乘   （plan ${plan.id}）`);
    }
  }
  if (!transferNeed.length) console.log("   （本方向无换乘腿）");

  // D. 汇总
  const zeroGaps = [...gapAgg.values()].filter((g) => g.n === 0);
  const lowGaps = [...gapAgg.values()].filter((g) => g.n > 0 && g.n < MIN);
  console.log(`\n${"─".repeat(20)} D. 汇总 ${"─".repeat(20)}`);
  console.log(
    `乘车段：按方案累加 需 ${segTotal} 段 / 已足 ${segOk} 段 / 缺 ${segTotal - segOk} 段；` +
      `去重后唯一缺口 ${gapAgg.size} 段（0 样本 ${zeroGaps.length} · 样本不足 ${lowGaps.length}）`,
  );
  console.log(`步行段：需 ${walkNeed.size} 组，已足 ${walkOk} 组，缺 ${walkGaps.length} 组`);
  console.log(`换乘段：${transferNeed.length} 处`);

  // 待补乘车段总表（按共享数降序 = 收益优先级）
  const gapList = [...gapAgg.values()].sort((a, b) => b.share - a.share || a.n - b.n);
  console.log(`\n── 待补乘车段（按「共享线路数」降序 = 补一次收益最大）──`);
  for (const g of gapList) {
    const nm = stripCode(nameOf.get(g.to) ?? "");
    console.log(
      `   [${String(g.route).padEnd(13)}] ${g.from} → ${g.to}${nm ? " " + nm : ""}   样本${g.n}  共享${g.share}线   (plan ${[...g.plans].join(",")})`,
    );
  }

  await pool.end();
}

main().catch((e) => {
  console.error("缺口报告失败：", e);
  process.exit(1);
});
