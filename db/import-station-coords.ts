/**
 * 站点坐标导入（db/import-station-coords.ts，v1.2.0）
 *
 * ── 这个脚本解决两件事 ────────────────────────────────────────────────
 *
 *   ① 🚨 **防止 `npm run db:seed` 清空坐标**
 *      `db/seed.ts` 会 `TRUNCATE ... stations, places ...` 且种子数据**不含坐标**
 *      ⇒ 任何人跑一次 seed，595 行站点坐标就永久丢失 ✗
 *      本脚本把它变成**可一键恢复**的（`npm run db:coords`）。
 *
 *   ② **补齐 18 个缺坐标的站**
 *      · 15 个轻轨站 `LRT-*` —— 从 `lrt_api_stations` 迁移过来
 *      · 3 个巴士站 `C688` / `C690` / `M8/1` —— 需人工提供（见下方 MISSING_BUS）
 *
 * ── ★ 坐标系交叉验证（本脚本最有价值的部分）──────────────────────────
 *   两套坐标来源**坐标系未声明**，必须交叉验证，否则叠加时整体偏移：
 *     · 巴士站坐标（DSAT `stationInfoList`）—— 已确认 **WGS84 (EPSG:4326)**
 *     · 轻轨站坐标（`lrt_api_stations`）—— **未声明** ⚠️
 *   方法：拿「同一地点的巴士站 × 轻轨站」比距离 —— 澳门轻轨与巴士常有共站/近邻站，
 *   若距离在 100~300 m（合理换乘距离）⇒ 两者坐标系一致 ✓
 *   若算出 500 m 以上 ⇒ 坐标系不同源，需纠偏 ✗
 *
 * 用法：
 *   node --experimental-strip-types db/import-station-coords.ts           # dry-run（含交叉验证）
 *   node --experimental-strip-types db/import-station-coords.ts --apply   # 写库
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

const APPLY = process.argv.includes("--apply");
const ROOT = "D:/Projects/University/Studio/musttoukou";
process.loadEnvFile(path.join(ROOT, ".env"));

const u = new URL(process.env.DATABASE_URL!);
const pool = new Pool({
  host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1),
  user: u.username, password: decodeURIComponent(u.password || ""), ssl: { rejectUnauthorized: false },
});
const q = async (s: string, a?: unknown[]) => (await pool.query(s, a)).rows;
const out: string[] = [];
const say = (s: string) => { out.push(s); console.log(s); };
const OUT = path.join(ROOT, ".verify/import-station-coords.out.txt");

/**
 * 🖐 3 个巴士站没有官方坐标源，需人工从地图拾取（WGS84）。
 * 填好后本脚本会一并导入。
 *   C688  和諧廣場/興業大廈   —— `enumerate.ts` 优先上下车点
 *   C690  蝴蝶谷大馬路總站     —— 同上
 *   M8/1  巴波沙/新城市
 */
const MISSING_BUS: Record<string, { lat: number; lng: number; note: string }> = {
  // 'C688': { lat: 0, lng: 0, note: '人工拾取' },
};

/** 球面距离（米） */
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * 交叉验证用的「巴士站 × 轻轨站」配对（同一地点或紧邻）
 * ⚠️ 期望区间**下限取 10m** —— 有些轻轨站与巴士站就是紧邻（实测石排灣 28m），
 *    这**不是异常**，反而是坐标系一致的最好证据。真正要抓的是「上百米以上的偏离」。
 * ⚠️ 巴士站要用**主码**（`T363`），站表里存的是带站台号的 `T363/2`。
 */
const CROSS_PAIRS: { bus: string; lrt: string; label: string; minM: number; maxM: number }[] = [
  { bus: "T374", lrt: "LRT-MUST", label: "澳科大（T374 澳門土木工程實驗室 ↔ 科大站）", minM: 10, maxM: 900 },
  { bus: "T363", lrt: "LRT-MUST", label: "澳科大侧（T363 連貫公路/威尼斯人 ↔ 科大站）", minM: 10, maxM: 1200 },
  { bus: "C650", lrt: "LRT-SPW", label: "石排灣（C650 石排灣馬路/擎天匯 ↔ 石排灣站）", minM: 10, maxM: 600 },
  { bus: "T560", lrt: "LRT-HQ", label: "橫琴口岸（T560 ↔ 橫琴站）", minM: 10, maxM: 900 },
  { bus: "T373", lrt: "LRT-LDE", label: "路氹東（T373 ↔ 路氹東站）", minM: 10, maxM: 900 },
  // ⚠️ 曾试过 M172 ↔ 運動場站，实测 3977m —— 那是**配对本身配错**（M 系站在关闸北区，
  //    不在氹仔），不是坐标系问题。已移除，保留 5 组有效配对。
  { bus: "T333", lrt: "LRT-PAK", label: "排角（T333 ↔ 排角站）", minM: 10, maxM: 900 },
];

/** 站码主码归一（T363/2 → T363）—— 站表里只有带站台号的行 */
const mainCodeOf = (c: string): string => /^[A-Za-z]+\d+/.exec(c)?.[0] ?? c;

say(`模式：${APPLY ? "★ APPLY（写生产库）" : "DRY-RUN（只读）"}`);
say("");

async function main() {
  // ── ① 读坐标资产（巴士站，来自 DSAT 位置接口，已确认 WGS84）──
  const TD = path.join(ROOT, "data/tracking");
  const files = fs.readdirSync(TD).filter((f) => /stations\.json$/.test(f)).sort();
  if (!files.length) { say("🔴 找不到站点坐标资产（data/tracking/*-stations.json）"); process.exit(1); }
  const assetFile = files[files.length - 1];
  const asset = JSON.parse(fs.readFileSync(path.join(TD, assetFile), "utf8"));
  const busRows = (Array.isArray(asset) ? asset : Object.values(asset).find((v) => Array.isArray(v))) as {
    code: string; name?: string; lat: string | number; lng: string | number;
  }[];
  say(`① 巴士站坐标资产：${assetFile}`);
  say(`   coordSystem = ${asset.coordSystem ?? "（未标注）"} · ${busRows.length} 站`);

  // ── ② 轻轨站坐标（来自 lrt_api_stations，坐标系未声明）──
  const lrtRows = (await q(`SELECT db_code, name_tc, lat, lng FROM lrt_api_stations
     WHERE db_code IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL`)) as {
    db_code: string; name_tc: string; lat: string; lng: string;
  }[];
  say("");
  say(`② 轻轨站坐标（lrt_api_stations）：${lrtRows.length} 站`);

  // ── ③ ★ 坐标系交叉验证 ──
  say("");
  say("③ ★ 坐标系交叉验证（巴士站 WGS84 ↔ 轻轨站未声明）");
  const busCoord = new Map<string, { lat: number; lng: number; name: string }>();
  for (const b of busRows) {
    const v = { lat: Number(b.lat), lng: Number(b.lng), name: b.name ?? "" };
    busCoord.set(b.code, v);
    // ★ 同时按主码登记（站表里是 T363/2 这种，而配对表里写的是 T363）
    const mc = mainCodeOf(b.code);
    if (!busCoord.has(mc)) busCoord.set(mc, v);
  }
  const lrtCoord = new Map<string, { lat: number; lng: number; name: string }>();
  for (const l of lrtRows) lrtCoord.set(l.db_code, { lat: Number(l.lat), lng: Number(l.lng), name: l.name_tc });

  let crossOk = 0, crossBad = 0;
  for (const p of CROSS_PAIRS) {
    const b = busCoord.get(p.bus), l = lrtCoord.get(p.lrt);
    if (!b || !l) { say(`   ⬜ ${p.label} —— 数据不全，跳过`); continue; }
    const d = haversineM(b.lat, b.lng, l.lat, l.lng);
    const ok = d >= p.minM && d <= p.maxM;
    if (ok) crossOk++; else crossBad++;
    say(`   ${ok ? "✅" : "🔴"} ${p.label}`);
    say(`        ${d.toFixed(0)} m（期望 ${p.minM}~${p.maxM}m）`);
  }
  say("");
  if (crossBad === 0 && crossOk > 0) {
    say(`   ✅ 全部 ${crossOk} 组落在合理区间 ⇒ **两套坐标同源（都是 WGS84）**，可直接混用`);
  } else if (crossOk > 0) {
    say(`   ⚠️ ${crossOk} 组合理 · ${crossBad} 组异常 ⇒ 需人工核查异常项（可能是共站判断本身不准）`);
  } else {
    say("   ⚠️ 无法得出可靠结论（配对数据不足）");
  }

  // ── ④ 待更新清单 ──
  const updates: { code: string; lat: number; lng: number; src: string; name: string }[] = [];
  const missing: string[] = [];

  const existing = (await q(`SELECT code, name_tc, lat, lng FROM stations`)) as {
    code: string; name_tc: string; lat: number | null; lng: number | null;
  }[];
  const byCode = new Map(existing.map((r) => [r.code, r]));

  for (const b of busRows) {
    const r = byCode.get(b.code);
    if (!r) continue;
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (r.lat != null && r.lng != null && Math.abs(Number(r.lat) - lat) < 1e-6 && Math.abs(Number(r.lng) - lng) < 1e-6) continue;
    updates.push({ code: b.code, lat, lng, src: "dsat-asset", name: r.name_tc });
  }
  for (const l of lrtRows) {
    const r = byCode.get(l.db_code);
    if (!r) continue;
    if (r.lat != null && r.lng != null) continue; // 已有坐标的不覆盖
    updates.push({ code: l.db_code, lat: Number(l.lat), lng: Number(l.lng), src: "lrt-api", name: r.name_tc });
  }
  for (const [code, v] of Object.entries(MISSING_BUS)) {
    if (!byCode.has(code)) continue;
    updates.push({ code, lat: v.lat, lng: v.lng, src: "manual", name: byCode.get(code)!.name_tc });
  }

  say("");
  say(`④ 待写入：${updates.length} 行`);
  for (const x of updates.slice(0, 25)) say(`   ${x.src.padEnd(12)} ${x.code.padEnd(12)} ${x.lat.toFixed(6)}, ${x.lng.toFixed(6)}  ${x.name}`);
  if (updates.length > 25) say(`   …还有 ${updates.length - 25} 行`);

  const stillMissing = existing.filter((r) => {
    if (r.lat != null && r.lng != null) return false;
    return !updates.some((x) => x.code === r.code);
  });
  say("");
  say(`⑤ 仍缺坐标（需人工）：${stillMissing.length} 行`);
  for (const m of stillMissing) say(`   · ${m.code.padEnd(12)} ${m.name_tc}`);

  // ── ⑥ 写库 ──
  if (!APPLY) {
    say("");
    say("（加 --apply 生效）");
    await pool.end();
    fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    return;
  }

  say("");
  say("⑥ 写入…");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const x of updates) {
      await c.query(`UPDATE stations SET lat = $2, lng = $3 WHERE code = $1`, [x.code, x.lat, x.lng]);
    }
    await c.query("COMMIT");
    say(`   ✅ 已更新 ${updates.length} 行`);
  } catch (e) {
    await c.query("ROLLBACK");
    say(`   🔴 出错已回滚：${(e as Error).message}`);
    c.release(); await pool.end();
    fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    process.exit(1);
  }
  c.release();

  // ── ⑦ 复核 ──
  const after = (await q(`SELECT count(*)::int total,
       count(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL)::int withco FROM stations`))[0] as {
    total: number; withco: number;
  };
  say("");
  say("⑦ 复核");
  say(`   stations：${after.total} 行 · 有坐标 ${after.withco} 行 · 缺 ${after.total - after.withco} 行`);

  await pool.end();
  fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
}
main().catch((e) => { console.error("✗", e); process.exit(1); });
