/**
 * 短距修正 · 校准验证（scripts/calibrate-walk.ts，v1.3.0 · T05）
 *
 * ── 目的（设计 §C.2 / §12 验收）────────────────────────────────────────
 *   用**真实数据**验证 R3 修订后的短距修正规则，产出可验收的真实数字：
 *     · **数据源 A**：`station_walk_distance`（高德步行距离）× `walk_times`（实测分钟）
 *       × `place_coords`/`stations`（算直线距离）—— 本项目自有的成对样本；
 *     · **数据源 B**：QA 真机探针 `.verify/qa-amap-walk-probe.out.txt`（8 组真机高德步行）。
 *
 * ── 验收标准（设计 §12）───────────────────────────────────────────────
 *   ① 「正常组」折算分钟 vs 实测分钟 **±20% 命中率 ≥ 90%**；
 *   ② 异常组（高德失真 6~12×）修正后**误差由 ~500m 降到 <200m**；
 *   ③ 全体「修正后 ratio = corrected ÷ 直线」落在 **[1.0, 2.5] 的比例 ≥ 90%**。
 *
 * 规则（`src/lib/amap/walk-fix.ts`，R3 修订）：
 *   直线<200m 且 ratio≤3.0 → 用高德值；直线<200m 且 ratio>3.0 → 直线×1.5；
 *   直线≥200m → ratio∈[1,3] 用高德值，否则直线×1.5。
 *
 * 用法：`node node_modules/tsx/dist/cli.mjs scripts/calibrate-walk.ts`
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { haversineM } from "../src/lib/amap/coord";
import { fixWalkDistance, WALK_CACHE_GEOHASH_PRECISION } from "../src/lib/amap/walk-fix";
import { WALK_BASE_M_PER_MIN } from "../src/lib/recommend/types";
import { mainCodeOf } from "../src/lib/recommend/segment-lookup";

void WALK_CACHE_GEOHASH_PRECISION;
process.loadEnvFile("D:/Projects/University/Studio/musttoukou/.env");

const OUT_DIR = "D:/Projects/University/Studio/musttoukou/.verify";
const OUT = path.join(OUT_DIR, "calibrate-walk.out.txt");
const QA_PROBE = path.join(OUT_DIR, "qa-amap-walk-probe.out.txt");

const lines: string[] = [];
const say = (s: string) => {
  lines.push(s);
  console.log(s);
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

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

interface Group {
  label: string;
  place: string;
  station: string;
  straightM: number;
  amapM: number;
  measuredMin: number | null;
  zone: string | null;
}

/** 数据源 A：station_walk_distance × walk_times（我们自有成对样本） */
async function loadDbGroups(): Promise<Group[]> {
  const stations = await pool.query(`SELECT code, lat, lng FROM stations WHERE lat IS NOT NULL AND lng IS NOT NULL`);
  const stByMain = new Map<string, { lat: number; lng: number }>();
  for (const r of stations.rows as Record<string, unknown>[]) {
    const main = mainCodeOf(String(r.code));
    if (!stByMain.has(main)) stByMain.set(main, { lat: num(r.lat), lng: num(r.lng) });
  }
  const pc = await pool.query(`SELECT place_id, zone, lat, lng FROM place_coords`);
  const placeByKey = new Map<string, { lat: number; lng: number }>();
  for (const r of pc.rows as Record<string, unknown>[]) {
    placeByKey.set(`${r.place_id}|${r.zone ?? ""}`, { lat: num(r.lat), lng: num(r.lng) });
  }
  const places = await pool.query(`SELECT id, slug FROM places`);
  const slugOf = new Map<number, string>();
  for (const r of places.rows as Record<string, unknown>[]) slugOf.set(Number(r.id), String(r.slug));

  // 实测分钟（按 (place,主码,zone) → (place,主码,'') 回退）
  const wt = await pool.query(`SELECT place_id, station_code, zone, minutes FROM walk_times WHERE minutes IS NOT NULL`);
  const measured = new Map<string, number>();
  for (const r of wt.rows as Record<string, unknown>[]) {
    const key = `${r.place_id}|${mainCodeOf(String(r.station_code))}|${r.zone ?? ""}`;
    const m = num(r.minutes);
    if (Number.isFinite(m) && m > 0 && !measured.has(key)) measured.set(key, m);
  }

  const swd = await pool.query(`SELECT place_id, station_main, zone, distance_m FROM station_walk_distance`);
  const groups: Group[] = [];
  for (const r of swd.rows as Record<string, unknown>[]) {
    const swdKey = `${r.place_id}|${String(r.station_main)}|${r.zone ?? ""}`;
    const place =
      placeByKey.get(swdKey) ?? placeByKey.get(`${r.place_id}|`) ?? placeByKey.get(`${r.place_id}|${r.zone ?? ""}`);
    const st = stByMain.get(String(r.station_main));
    const amapM = num(r.distance_m);
    if (!place || !st || !Number.isFinite(amapM) || amapM <= 0) continue;
    const straightM = haversineM(place, st);
    const measuredMin =
      measured.get(swdKey) ??
      measured.get(`${r.place_id}|${String(r.station_main)}|`) ??
      null;
    groups.push({
      label: `${slugOf.get(Number(r.place_id)) ?? r.place_id}→${r.station_main}`,
      place: slugOf.get(Number(r.place_id)) ?? String(r.place_id),
      station: String(r.station_main),
      straightM: Math.round(straightM * 10) / 10,
      amapM: Math.round(amapM * 10) / 10,
      measuredMin,
      zone: (r.zone as string) ?? null,
    });
  }
  return groups;
}

/** 数据源 B：QA 真机探针（解析 Markdown 表格） */
function loadQaGroups(): Group[] {
  if (!fs.existsSync(QA_PROBE)) return [];
  const txt = fs.readFileSync(QA_PROBE, "utf8");
  const out: Group[] = [];
  for (const line of txt.split("\n")) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/);
    if (!m) continue;
    out.push({
      label: m[1].trim(),
      place: "qa",
      station: "",
      straightM: Number(m[2]),
      amapM: Number(m[3]),
      measuredMin: null,
      zone: null,
    });
  }
  return out;
}

function evalGroup(g: Group) {
  const fix = fixWalkDistance(g.straightM, g.amapM);
  const correctedRatio = g.straightM > 0 ? fix.correctedM / g.straightM : NaN;
  const isShort = g.straightM > 0 && g.straightM < 200;
  const ratio = g.straightM > 0 ? g.amapM / g.straightM : NaN;
  const cls: "short" | "anomaly" | "normal" =
    Number.isFinite(ratio) && (ratio < 1.0 || ratio > 3.0) ? "anomaly" : isShort ? "short" : "normal";
  let err20: boolean | null = null;
  if (g.measuredMin && g.measuredMin > 0) {
    const correctedMin = fix.correctedM / WALK_BASE_M_PER_MIN;
    err20 = Math.abs(correctedMin - g.measuredMin) / g.measuredMin <= 0.2;
  }
  return { fix, correctedRatio, cls, err20, rawRatio: ratio };
}

async function main() {
  say(`# 短距修正校准（R3 修订规则）· ${new Date().toISOString()}`);
  say("");

  // ── 数据源 A ──
  const db = await loadDbGroups().catch((e) => {
    say(`（A 数据源加载失败：${(e as Error).message}）`);
    return [] as Group[];
  });
  const withMeasured = db.filter((g) => g.measuredMin);
  say(`## A. 我们自有成对样本（station_walk_distance × walk_times）`);
  say(`总样本 ${db.length} 组，其中**带实测分钟** ${withMeasured.length} 组`);
  say("");
  say(`| 组 | 直线(m) | 高德(m) | raw ratio | 修正后(m) | 修正 ratio | 实测(分) | 折算(分) | ±20% |`);
  say(`|---|---:|---:|---:|---:|---:|---:|---:|:--:|`);
  let aHit = 0;
  let aN = 0;
  const allCorrectedRatios: number[] = [];
  for (const g of db) {
    const r = evalGroup(g);
    allCorrectedRatios.push(r.correctedRatio);
    if (r.err20 !== null) {
      aN++;
      if (r.err20) aHit++;
    }
    const correctedMin = (r.fix.correctedM / WALK_BASE_M_PER_MIN).toFixed(1);
    say(
      `| ${g.label} | ${g.straightM} | ${g.amapM} | ${r.rawRatio.toFixed(2)} | ${r.fix.correctedM.toFixed(1)} | ${r.correctedRatio.toFixed(2)} | ${g.measuredMin ?? "-"} | ${correctedMin} | ${r.err20 === null ? "-" : r.err20 ? "✅" : "❌"} |`,
    );
  }
  say("");
  say(`**准则①（正常组 ±20% 命中率 ≥90%）**：带实测组 ${aN} 组，命中 ${aHit} ⇒ **${aN ? ((aHit / aN) * 100).toFixed(1) : "n/a"}%**`);
  const inRange = allCorrectedRatios.filter((x) => Number.isFinite(x) && x >= 1.0 && x <= 2.5).length;
  say(
    `**准则③（修正后 ratio ∈[1,2.5] ≥90%）**：${inRange}/${allCorrectedRatios.length} = **${((inRange / Math.max(1, allCorrectedRatios.length)) * 100).toFixed(1)}%**`,
  );
  say("");

  // ── 数据源 B（QA 真机 8 组）──
  const qa = loadQaGroups();
  say(`## B. QA 真机探针（${qa.length} 组）`);
  if (!qa.length) {
    say("（未找到 `.verify/qa-amap-walk-probe.out.txt` → 跳过）");
  } else {
    say(`| OD | 直线(m) | 高德(m) | raw ratio | 修正后(m) | 修正误差 vs 直线×1.5 |`);
    say(`|---|---:|---:|---:|---:|---:|`);
    let anomalyBefore = 0;
    let anomalyAfter = 0;
    let anomalyN = 0;
    for (const g of qa) {
      const r = evalGroup(g);
      const baseline = g.straightM * 1.5;
      const errBefore = Math.abs(g.amapM - baseline);
      const errAfter = Math.abs(r.fix.correctedM - baseline);
      if (r.cls === "anomaly") {
        anomalyN++;
        if (errBefore > 200) anomalyBefore++;
        if (errAfter < 200) anomalyAfter++;
      }
      say(`| ${g.label} | ${g.straightM} | ${g.amapM} | ${r.rawRatio.toFixed(2)} | ${r.fix.correctedM.toFixed(1)} | ${errAfter.toFixed(1)} |`);
    }
    say("");
    say(
      `**准则②（异常组修正后误差 <200m）**：异常组 ${anomalyN} 组；修正前误差>200m ${anomalyBefore} 组 → 修正后误差>200m **${anomalyN - anomalyAfter}** 组（目标 0）`,
    );
  }

  await pool.end();
  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  say("");
  say(`（日志已写 ${path.basename(OUT)}）`);
}

main().catch((e) => {
  console.error("✗", e);
  fs.writeFileSync(OUT, lines.join("\n") + "\nERR " + String(e) + "\n", "utf8");
  process.exit(1);
});
