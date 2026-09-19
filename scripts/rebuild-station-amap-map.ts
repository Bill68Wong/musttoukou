/**
 * 站码映射 · 自动生成 + 导出人工核对表（scripts/rebuild-station-amap-map.ts，v1.3.0）
 *
 * ── 干什么 ────────────────────────────────────────────────────────────
 *   ① 枚举**澳门高德公交/轻轨站**（`place/around`，type=150700|150500）；
 *   ② 用「**坐标法**（高德 GCJ-02 → gcj02ToWgs84 → 与我们 stations WGS84 最近邻 ≤60m）」
 *      + 「**名称法**（繁简归一 + 去「公交站/總站/站」后缀）」**双法交叉验证**；
 *   ③ 写入 `station_amap_map`（`verified_by_human=false`，等人工复核）；
 *   ④ 导出 **CSV + Markdown 双份**（固定列、按置信度升序、含「待人工确认」列）
 *      与两份**未匹配清单**（高德有我们无 / 我们有高德无）。
 *
 * ── 实测基线（可用作验收参考）────────────────────────────────────────
 *   探针4：自动坐标匹配率 **氹仔 94% / 澳科大 3km 82%**（调研 §6 坑#8 / 探针4）。
 *   ⇒ 本次自动产物必然有 **6~18% 需人工复核**，这是设计预期（§B.3a④）。
 *
 * 用法：
 *   # 只读：用已缓存的站表生成、打印/导出（不写库）—— 推荐先跑这个
 *   node node_modules/tsx/dist/cli.mjs scripts/rebuild-station-amap-map.ts --in=.verify/amap-stations.json
 *   # 在线抓取（受限流；--max-calls 控量）+ 导出 + 写库
 *   node node_modules/tsx/dist/cli.mjs scripts/rebuild-station-amap-map.ts --apply --max-calls=120
 *   # 局部验证（复现探针4 的映射率）：澳科大 3km
 *   node node_modules/tsx/dist/cli.mjs scripts/rebuild-station-amap-map.ts --seed=113.5669,22.1519 --radius=3000
 *
 * 产出：
 *   .verify/station-amap-map.csv / .md（人工核对表）
 *   .verify/station-amap-unmatched-amap.json（高德有、我们无）
 *   .verify/station-amap-unmatched-ours.json（我们有、高德无）
 *   .verify/amap-stations.json（在线抓取的原始站表，供 --in 复用）
 *   .verify/rebuild-station-amap-map.out.txt（全程日志）
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { gcj02ToWgs84, haversineM } from "../src/lib/amap/coord";
import { acquireWithWait, RATE_BUCKET } from "../src/lib/amap/rate-limit";
import { normalizeName } from "../src/lib/shared/normalize";

try {
  process.loadEnvFile("D:/Projects/University/Studio/musttoukou/.env");
} catch {
  /* .env 不存在 */
}

// ─────────────────────────── CLI ───────────────────────────
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const APPLY = has("--apply");
const IN_FILE = val("in");
const OUT_DIR = val("out") ?? "D:/Projects/University/Studio/musttoukou/.verify";
const MAX_CALLS = Number(val("max-calls") ?? "0") || 0;
const RADIUS_M = Number(val("radius") ?? "2500") || 2500;
const SEED_ARG = val("seed"); // "lng,lat"
const NEAR_M = 60; // 坐标匹配阈值（米）
const NEAR_HIGH_M = 30; // 高置信阈值（米）

const u = new URL(process.env.DATABASE_URL!);
const pool = new Pool({
  host: u.hostname,
  port: Number(u.port || 5432),
  database: u.pathname.slice(1),
  user: u.username,
  password: decodeURIComponent(u.password || ""),
  ssl: { rejectUnauthorized: false },
});

const out: string[] = [];
const say = (s: string) => {
  out.push(s);
  console.log(s);
};
const OUT_TXT = path.join(OUT_DIR, "rebuild-station-amap-map.out.txt");

// ─────────────────────────── 数据模型 ───────────────────────────

interface OurStation {
  code: string; // 原始（可能带 /n）
  main: string; // 主码
  nameTc: string;
  kind: string;
  lat: number;
  lng: number; // WGS84
}

interface AmapStation {
  id: string;
  name: string; // 简体
  lng: number; // GCJ-02
  lat: number;
  typecode: string;
}

interface Mapping {
  amapId: string;
  amapName: string;
  amapLng: number;
  amapLat: number;
  ourMain: string | null;
  ourNameTc: string | null;
  distM: number | null;
  nameMatch: boolean;
  method: "coord" | "name" | "both" | "unmatched";
  confidence: "high" | "medium" | "low";
}

const mainCodeOf = (code: string): string => /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

// ─────────────────────────── 载入我们站点 ───────────────────────────
async function loadOurStations(): Promise<OurStation[]> {
  const r = await pool.query(
    `SELECT code, name_tc, kind, lat, lng FROM stations WHERE lat IS NOT NULL AND lng IS NOT NULL`,
  );
  return (r.rows as Record<string, unknown>[]).map((row) => ({
    code: String(row.code),
    main: mainCodeOf(String(row.code)),
    nameTc: String(row.name_tc ?? ""),
    kind: String(row.kind ?? "bus"),
    lat: num(row.lat),
    lng: num(row.lng),
  }));
}

// ─────────────────────────── 抓取高德站 ───────────────────────────
/** 澳门粗略 bbox（半岛 + 氹仔 + 路环 + 珠澳口岸） */
const MACAU_BBOX = { minLng: 113.515, minLat: 22.095, maxLng: 113.61, maxLat: 22.23 };

/** 生成覆盖 bbox 的种子网格（步长按半径推导） */
function gridSeeds(step: number): { lng: number; lat: number }[] {
  const pts: { lng: number; lat: number }[] = [];
  for (let lng = MACAU_BBOX.minLng; lng <= MACAU_BBOX.maxLng; lng += step)
    for (let lat = MACAU_BBOX.minLat; lat <= MACAU_BBOX.maxLat; lat += step)
      pts.push({ lng: Math.round(lng * 1e6) / 1e6, lat: Math.round(lat * 1e6) / 1e6 });
  return pts;
}

async function fetchAround(
  seed: { lng: number; lat: number },
  radius: number,
  key: string,
): Promise<AmapStation[]> {
  const found: AmapStation[] = [];
  const offset = 25;
  for (let page = 1; page <= 10; page++) {
    const token = await acquireWithWait(RATE_BUCKET.search, 4_000);
    if (!token.ok) {
      say(`      ⚠ 取不到搜索令牌（限流），种子 ${seed.lng},${seed.lat} 第 ${page} 页跳过`);
      break;
    }
    const qs = new URLSearchParams({
      location: `${seed.lng.toFixed(6)},${seed.lat.toFixed(6)}`,
      types: "150700|150500",
      radius: String(radius),
      offset: String(offset),
      page: String(page),
      extensions: "all",
      key,
    });
    let json: { status?: string; info?: string; infocode?: string; pois?: Record<string, unknown>[] };
    try {
      const res = await fetch(`https://restapi.amap.com/v3/place/around?${qs}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      json = await res.json();
    } catch (e) {
      say(`      ⚠ 请求失败：${(e as Error).message}`);
      break;
    }
    if (json.status !== "1") {
      say(`      ⚠ 高德返回异常：${json.info}(${json.infocode})`);
      break;
    }
    const pois = json.pois ?? [];
    for (const p of pois) {
      const loc = String(p.location ?? "").split(",");
      const lng = Number(loc[0]);
      const lat = Number(loc[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      found.push({
        id: String(p.id ?? `${lng},${lat}`),
        name: String(p.name ?? ""),
        lng,
        lat,
        typecode: String(p.typecode ?? ""),
      });
    }
    if (pois.length < offset) break; // 该种子已翻到底
  }
  return found;
}

async function fetchAllAmapStations(): Promise<{ list: AmapStation[]; calls: number }> {
  const key = (process.env.AMAP_KEY ?? "").trim();
  if (!key) throw new Error("缺少 AMAP_KEY");

  let seeds: { lng: number; lat: number }[];
  if (SEED_ARG) {
    const [lng, lat] = SEED_ARG.split(",").map(Number);
    seeds = [{ lng, lat }];
  } else {
    seeds = gridSeeds(Math.max(0.01, RADIUS_M / 120000)); // ≈ 半径/120km 度（保守重叠）
  }
  say(`   种子点数：${seeds.length}（半径 ${RADIUS_M}m${SEED_ARG ? " · 单点模式" : ""}）`);

  const map = new Map<string, AmapStation>();
  let calls = 0;
  for (const s of seeds) {
    if (MAX_CALLS > 0 && calls >= MAX_CALLS) {
      say(`   ⏹ 已达 --max-calls=${MAX_CALLS}，停止抓取`);
      break;
    }
    const list = await fetchAround(s, RADIUS_M, key);
    calls += Math.ceil(list.length / 25) || 1;
    let added = 0;
    for (const st of list) if (!map.has(st.id)) { map.set(st.id, st); added++; }
    say(`   种子 ${s.lng.toFixed(4)},${s.lat.toFixed(4)} → 本批 ${list.length}（新增 ${added}，累计 ${map.size}）`);
  }
  return { list: [...map.values()], calls };
}

// ─────────────────────────── 映射计算 ───────────────────────────
function computeMappings(amapStations: AmapStation[], ourStations: OurStation[]): Mapping[] {
  // 名称索引（繁简归一 → 主码）
  const byName = new Map<string, OurStation>();
  for (const s of ourStations) {
    const k = normalizeName(s.nameTc);
    if (k && !byName.has(k)) byName.set(k, s);
  }

  const result: Mapping[] = [];
  for (const a of amapStations) {
    const wgs = gcj02ToWgs84({ lng: a.lng, lat: a.lat }); // 高德 GCJ → 我们 WGS
    // 最近邻（≤60m）
    let best: { s: OurStation; d: number } | null = null;
    for (const s of ourStations) {
      const d = haversineM(wgs, { lng: s.lng, lat: s.lat });
      if (d <= NEAR_M && (!best || d < best.d)) best = { s, d };
    }
    const nmKey = normalizeName(a.name);
    const nameHit = byName.get(nmKey) ?? null;
    const nameMatch = !!nameHit;

    let ourMain: string | null = null;
    let ourNameTc: string | null = null;
    let distM: number | null = null;
    let method: Mapping["method"] = "unmatched";
    let confidence: Mapping["confidence"] = "low";

    if (best && nameHit && best.s.main === nameHit.main) {
      // 双法一致 → 高置信
      ourMain = best.s.main;
      ourNameTc = best.s.nameTc;
      distM = Math.round(best.d * 10) / 10;
      method = "both";
      confidence = "high";
    } else if (best) {
      // 仅坐标命中
      ourMain = best.s.main;
      ourNameTc = best.s.nameTc;
      distM = Math.round(best.d * 10) / 10;
      method = "coord";
      confidence = nameMatch ? "high" : best.d <= NEAR_HIGH_M ? "medium" : "medium";
    } else if (nameHit) {
      // 仅名称命中（高德坐标偏出 60m：可能改名/新建/坐标漂移）→ 中置信、必审
      ourMain = nameHit.main;
      ourNameTc = nameHit.nameTc;
      distM = null;
      method = "name";
      confidence = "medium";
    }

    result.push({
      amapId: a.id,
      amapName: a.name,
      amapLng: a.lng,
      amapLat: a.lat,
      ourMain,
      ourNameTc,
      distM,
      nameMatch,
      method,
      confidence,
    });
  }

  // 排序：置信度升序（最可疑的排最前），同档按最近邻距离升序
  const rank = { low: 0, medium: 1, high: 2 } as const;
  result.sort((x, y) => {
    const r = rank[x.confidence] - rank[y.confidence];
    if (r !== 0) return r;
    return (x.distM ?? 1e9) - (y.distM ?? 1e9);
  });
  return result;
}

// ─────────────────────────── 导出 ───────────────────────────
const HEADERS = [
  "高德站ID",
  "高德站名",
  "高德坐标(GCJ-02)",
  "我们站码",
  "我们站名",
  "最近邻距离(m)",
  "名称匹配",
  "置信度",
  "待人工确认",
];

function csvCell(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportTables(mappings: Mapping[], ourStations: OurStation[], amapStations: AmapStation[]): void {
  const rows = mappings.map((m) => [
    m.amapId,
    m.amapName,
    `${m.amapLng.toFixed(5)},${m.amapLat.toFixed(5)}`,
    m.ourMain ?? "",
    m.ourNameTc ?? "",
    m.distM ?? "",
    m.nameMatch ? "是" : "否",
    m.confidence === "high" ? "高" : m.confidence === "medium" ? "中" : "低",
    m.confidence === "high" && m.method === "both" ? "" : "✔",
  ]);

  // CSV
  const csv = [HEADERS.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n";
  fs.writeFileSync(path.join(OUT_DIR, "station-amap-map.csv"), csv, "utf8");

  // Markdown
  const md: string[] = [];
  md.push("# 高德站 ↔ 我们站码 映射核对表");
  md.push("");
  md.push(`> 自动生成（坐标 ≤${NEAR_M}m + 繁简名交叉验证）。**按置信度升序**，\`待人工确认\` 列筛出需人工看的行。`);
  md.push(`> 回写步骤：① 在 \`我们站码\` 列填入/纠正主码；② **确认无误后清空该行 \`待人工确认\` 标记**（留空 = 已复核）；③ 跑 \`db:apply-amap-map\` 回写（幂等）。`);
  md.push(`> ⚠️ 未清空 \`待人工确认\` 的行**不会被回写**（防止把自动猜测误当人工复核）。`);
  md.push("");
  const matched = mappings.filter((m) => m.ourMain).length;
  md.push(
    `- 高德站 ${mappings.length} 个；已自动匹配 ${matched}（${((matched / Math.max(1, mappings.length)) * 100).toFixed(1)}%）；待人工确认 ${rows.filter((r) => r[8] === "✔").length}`,
  );
  md.push("");
  md.push(`| ${HEADERS.join(" | ")} |`);
  md.push(`| ${HEADERS.map(() => "---").join(" | ")} |`);
  for (const r of rows) md.push(`| ${r.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`);
  fs.writeFileSync(path.join(OUT_DIR, "station-amap-map.md"), md.join("\n") + "\n", "utf8");

  // 未匹配清单
  const noOur = mappings.filter((m) => !m.ourMain).map((m) => ({ amapId: m.amapId, amapName: m.amapName, lng: m.amapLng, lat: m.amapLat }));
  const matchedMain = new Set(mappings.filter((m) => m.ourMain).map((m) => m.ourMain as string));
  const ourUnmatched = ourStations
    .filter((s) => !matchedMain.has(s.main))
    .map((s) => ({ code: s.code, main: s.main, nameTc: s.nameTc, kind: s.kind, lng: s.lng, lat: s.lat }));
  fs.writeFileSync(path.join(OUT_DIR, "station-amap-unmatched-amap.json"), JSON.stringify(noOur, null, 2), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "station-amap-unmatched-ours.json"), JSON.stringify(ourUnmatched, null, 2), "utf8");

  say(`   导出：station-amap-map.csv / .md`);
  say(`   未匹配：高德有我们无 ${noOur.length}；我们有高德无 ${ourUnmatched.length}（按主码）`);
  say(`   高德站数 ${amapStations.length} / 我们站（主码去重）${new Set(ourStations.map((s) => s.main)).size}`);
}

// ─────────────────────────── 写库 ───────────────────────────
async function writeDb(mappings: Mapping[]): Promise<void> {
  const c = await pool.connect();
  let n = 0;
  try {
    await c.query("BEGIN");
    for (const m of mappings) {
      await c.query(
        `INSERT INTO station_amap_map
           (amap_station_id, amap_name, amap_lng, amap_lat, dsat_station_main, name_tc,
            match_method, match_dist_m, name_match, confidence, verified_by_human)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE)
         ON CONFLICT (amap_name, amap_lng, amap_lat) DO UPDATE SET
           amap_station_id   = EXCLUDED.amap_station_id,
           dsat_station_main = EXCLUDED.dsat_station_main,
           name_tc           = EXCLUDED.name_tc,
           match_method      = EXCLUDED.match_method,
           match_dist_m      = EXCLUDED.match_dist_m,
           name_match        = EXCLUDED.name_match,
           confidence        = EXCLUDED.confidence,
           updated_at        = now()`,
        [
          m.amapId,
          m.amapName,
          m.amapLng,
          m.amapLat,
          m.ourMain,
          m.ourNameTc,
          m.method,
          m.distM,
          m.nameMatch,
          m.confidence,
        ],
      );
      n++;
    }
    await c.query("COMMIT");
    say(`   ✅ 写库 station_amap_map：${n} 行（verified_by_human 一律 false，等人工复核）`);
  } catch (e) {
    await c.query("ROLLBACK");
    say(`   🔴 写库失败已回滚：${(e as Error).message}`);
    throw e;
  } finally {
    c.release();
  }
}

// ─────────────────────────── 主流程 ───────────────────────────
async function main() {
  say(`模式：${APPLY ? "★ APPLY（写库）" : "DRY-RUN（只导出，不写库）"}`);
  say(`目标库：${u.hostname} / ${u.pathname.slice(1)}`);
  say("");

  const ourStationsAll = await loadOurStations();
  // 单点模式（--seed）：把「我们站点」也收窄到该半径内，使导出表 / 未匹配清单 / 映射率
  // 都聚焦同一区域（否则反向清单会把全澳未覆盖的站都算进来，误导）。
  let ourStations = ourStationsAll;
  if (SEED_ARG) {
    const [slng, slat] = SEED_ARG.split(",").map(Number);
    ourStations = ourStationsAll.filter(
      (s) => haversineM({ lng: slng, lat: slat }, { lng: s.lng, lat: s.lat }) <= RADIUS_M + 100,
    );
    say(`① 载入我们站点：全澳 ${ourStationsAll.length} 行；单点模式收窄到半径 ${RADIUS_M}m 内 ${ourStations.length} 行`);
  } else {
    say(`① 载入我们站点：${ourStations.length} 行（${new Set(ourStations.map((s) => s.main)).size} 个主码）`);
  }

  // 高德站来源：--in 文件 或 在线抓取
  let amapStations: AmapStation[];
  let calls = 0;
  if (IN_FILE) {
    const raw = JSON.parse(fs.readFileSync(IN_FILE, "utf8")) as AmapStation[];
    amapStations = raw;
    say(`② 高德站来源：文件 ${IN_FILE}（${amapStations.length} 个）`);
  } else {
    say("② 在线抓取高德站（place/around，受限流）…");
    const r = await fetchAllAmapStations();
    amapStations = r.list;
    calls = r.calls;
    say(`   抓取完成：${amapStations.length} 个（约 ${calls} 次调用）`);
    const dump = path.join(OUT_DIR, "amap-stations.json");
    fs.writeFileSync(dump, JSON.stringify(amapStations, null, 2), "utf8");
    say(`   已缓存原始站表：${dump}（可用 --in 复用）`);
  }

  say("");
  say("③ 计算映射（坐标 ≤60m + 繁简名交叉验证）");
  const mappings = computeMappings(amapStations, ourStations);
  const matched = mappings.filter((m) => m.ourMain);
  const needReview = mappings.filter((m) => !(m.confidence === "high" && m.method === "both"));
  say(`   高德站 ${mappings.length}：匹配 ${matched.length}（${((matched.length / Math.max(1, mappings.length)) * 100).toFixed(1)}%）· 待人工确认 ${needReview.length}`);

  // 局部映射率（复现探针4）：统计「我们（区域内）主码」被匹配的比例
  if (SEED_ARG) {
    const [slng, slat] = SEED_ARG.split(",").map(Number);
    const inRegionMains = new Set(ourStations.map((s) => s.main));
    const matchedMain = new Set(matched.map((m) => m.ourMain as string));
    const regionMatchedMains = new Set(ourStations.filter((s) => matchedMain.has(s.main)).map((s) => s.main));
    say(
      `   ★ 局部映射率（种子 ${slng},${slat} 半径 ${RADIUS_M}m）：${regionMatchedMains.size}/${inRegionMains.size} = ${(
        (regionMatchedMains.size / Math.max(1, inRegionMains.size)) * 100
      ).toFixed(1)}%（对照探针4 基线 82~94%）`,
    );
  }

  say("");
  say("④ 导出人工核对表");
  exportTables(mappings, ourStations, amapStations);

  if (APPLY) {
    say("");
    say("⑤ 写库");
    await writeDb(mappings);
  } else {
    say("");
    say("（DRY-RUN：未写库；加 --apply 生效）");
  }

  await pool.end();
  fs.writeFileSync(OUT_TXT, out.join("\n") + "\n", "utf8");
  say("");
  say(`（日志已写 ${path.basename(OUT_TXT)}）`);
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
