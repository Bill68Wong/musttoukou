/**
 * 步行缓存 · 离线预热（scripts/warm-walk-cache.ts，v1.3.0）
 *
 * ── 干什么 / 为什么 ──────────────────────────────────────────────────
 *   ★ **请求期绝不调用高德 walking**（`client.ts` 硬规则①；QA P0-1）——
 *     所有步行几何**只能离线预热**进 `walk_cache`。
 *   本脚本预热两类步行（供**降级路径**：高德 transit 不可用时出卡，§B.6）：
 *     · **kind='walk'**：`place_coords`（擎天匯/澳科大各座/横琴/关闸）→ **≤700m 邻近站**；
 *     · **kind='transfer'**：站 ↔ 站（**≤300m**，不同主码）换乘步行。
 *
 * ── 键与修正 ──────────────────────────────────────────────────────────
 *   · 缓存键 = **geohash-7 对**（≈150m，QA P1-2）——`walkCacheKey()`；
 *   · 落库同时存 `straight_m` / `ratio` / `corrected_m`（**短距修正后**，§C.2）——
 *     降级出卡直接读 `corrected_m ÷ 84`，口径与主路径一致。
 *   · 失败 → 入 `walk_miss_queue`（async 补算）。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/warm-walk-cache.ts                       # DRY-RUN（只统计计划）
 *   node node_modules/tsx/dist/cli.mjs scripts/warm-walk-cache.ts --apply --limit=30     # 真跑（控调用量）
 *   node node_modules/tsx/dist/cli.mjs scripts/warm-walk-cache.ts --apply --kind=walk --limit=0   # 全部 walk
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { haversineM, wgs84ToGcj02 } from "../src/lib/amap/coord";
import { walkRouteGcj } from "../src/lib/amap/client";
import { fixWalkDistance, walkCacheKey, encodeGeohash } from "../src/lib/amap/walk-fix";

try {
  process.loadEnvFile("D:/Projects/University/Studio/musttoukou/.env");
} catch {
  /* .env 不存在 */
}

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (n: string) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : undefined;
};
const APPLY = has("--apply");
const LIMIT = Number(val("limit") ?? "0") || 0; // 0 = 不限
const KIND = (val("kind") ?? "all") as "all" | "walk" | "transfer";
const WALK_RADIUS_M = Number(val("radius") ?? "700") || 700;
const TRANSFER_RADIUS_M = Number(val("transfer-radius") ?? "300") || 300;
const OUT_DIR = "D:/Projects/University/Studio/musttoukou/.verify";

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

const mainCodeOf = (code: string): string => /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

interface Pt {
  lng: number;
  lat: number;
}
interface Pair {
  kind: "walk" | "transfer";
  from: Pt; // GCJ-02
  to: Pt; // GCJ-02
  label: string;
}

async function buildPairs(): Promise<Pair[]> {
  // 站点（主码去重，取首个有坐标的行）
  const stRows = await pool.query(`SELECT code, name_tc, lat, lng FROM stations WHERE lat IS NOT NULL AND lng IS NOT NULL`);
  const stationsByMain = new Map<string, { main: string; nameTc: string; gcj: Pt; wgs: Pt }>();
  const stations: { main: string; nameTc: string; gcj: Pt; wgs: Pt }[] = [];
  for (const raw of stRows.rows as Record<string, unknown>[]) {
    const main = mainCodeOf(String(raw.code));
    const wgs = { lng: num(raw.lng), lat: num(raw.lat) };
    const gcj = wgs84ToGcj02(wgs);
    const rec = { main, nameTc: String(raw.name_tc ?? ""), gcj, wgs };
    stations.push(rec);
    if (!stationsByMain.has(main)) stationsByMain.set(main, rec);
  }

  // 地点坐标
  const plRows = await pool.query(
    `SELECT pc.lat, pc.lng, p.slug, p.name FROM place_coords pc JOIN places p ON p.id = pc.place_id`,
  );

  const pairs: Pair[] = [];

  // ① place → 邻近站（≤ radius）
  for (const raw of plRows.rows as Record<string, unknown>[]) {
    const wgs = { lng: num(raw.lng), lat: num(raw.lat) };
    const gcj = wgs84ToGcj02(wgs);
    const near: { rec: (typeof stations)[number]; d: number }[] = [];
    for (const s of stations) {
      const d = haversineM(wgs, s.wgs);
      if (d <= WALK_RADIUS_M) near.push({ rec: s, d });
    }
    near.sort((a, b) => a.d - b.d);
    for (const n of near) {
      pairs.push({
        kind: "walk",
        from: gcj,
        to: n.rec.gcj,
        label: `${String(raw.slug)}⇒${n.rec.main} ${n.rec.nameTc} (${Math.round(n.d)}m)`,
      });
    }
  }

  // ② 站 ↔ 站换乘（≤ radius，不同主码）
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      if (stations[i].main === stations[j].main) continue;
      const d = haversineM(stations[i].wgs, stations[j].wgs);
      if (d <= TRANSFER_RADIUS_M) {
        pairs.push({
          kind: "transfer",
          from: stations[i].gcj,
          to: stations[j].gcj,
          label: `${stations[i].main}→${stations[j].main} (${Math.round(d)}m)`,
        });
      }
    }
  }

  return pairs;
}

async function main() {
  say(`模式：${APPLY ? "★ APPLY（写库 + 真实调用）" : "DRY-RUN（只统计计划）"}`);
  say(`目标库：${u.hostname} / ${u.pathname.slice(1)}`);
  say(`范围：kind=${KIND} · walk 半径 ${WALK_RADIUS_M}m · transfer 半径 ${TRANSFER_RADIUS_M}m${LIMIT ? ` · limit=${LIMIT}` : ""}`);
  say("");

  const all = await buildPairs();
  let pairs = all;
  if (KIND !== "all") pairs = pairs.filter((p) => p.kind === KIND);
  const walkN = pairs.filter((p) => p.kind === "walk").length;
  const trN = pairs.filter((p) => p.kind === "transfer").length;
  say(`① 计划：共 ${pairs.length} 对（walk ${walkN} / transfer ${trN}）`);

  // 已缓存（跳过）
  const cached = new Set<string>();
  const cacheRows = await pool.query(`SELECT cache_key FROM walk_cache`);
  for (const raw of cacheRows.rows as Record<string, unknown>[]) cached.add(String(raw.cache_key));
  const todo = pairs.filter((p) => !cached.has(walkCacheKey(p.from, p.to)));
  say(`   已缓存 ${pairs.length - todo.length} · 待抓 ${todo.length}`);

  if (!APPLY) {
    say("");
    say("（DRY-RUN：未调用高德；加 --apply 生效，并用 --limit=N 控调用量）");
    say("");
    say("  预览（前 10 对）：");
    for (const p of todo.slice(0, 10)) say(`   [${p.kind}] ${p.label}`);
    await pool.end();
    fs.writeFileSync(path.join(OUT_DIR, "warm-walk-cache.out.txt"), out.join("\n") + "\n", "utf8");
    return;
  }

  const target = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;
  say("");
  say(`② 抓取（walkRouteGcj，离线；共 ${target.length} 次）…`);

  let ok = 0;
  let failed = 0;
  const c = await pool.connect();
  try {
    for (const [i, p] of target.entries()) {
      const straightM = haversineM(p.from, p.to);
      const r = await walkRouteGcj(p.from, p.to);
      const key = walkCacheKey(p.from, p.to);
      if (r.ok) {
        const fix = fixWalkDistance(straightM, r.distanceM, p.kind);
        await c.query(
          `INSERT INTO walk_cache
             (cache_key, kind, from_key, to_key, from_lng, from_lat, to_lng, to_lat,
              distance_m, duration_s, straight_m, ratio, corrected_m, source, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'amap', now())
           ON CONFLICT (cache_key) DO UPDATE SET
             distance_m  = EXCLUDED.distance_m,
             duration_s  = EXCLUDED.duration_s,
             straight_m  = EXCLUDED.straight_m,
             ratio       = EXCLUDED.ratio,
             corrected_m = EXCLUDED.corrected_m,
             fetched_at  = now()`,
          [
            key,
            p.kind,
            walkCacheKey(p.from, p.from).split(">")[0],
            walkCacheKey(p.to, p.to).split(">")[0],
            p.from.lng,
            p.from.lat,
            p.to.lng,
            p.to.lat,
            r.distanceM,
            r.durationS,
            Math.round(straightM * 10) / 10,
            fix.ratio !== null ? Math.round(fix.ratio * 1000) / 1000 : null,
            fix.correctedM,
          ],
        );
        ok++;
      } else {
        failed++;
        await c.query(
          `INSERT INTO walk_miss_queue
             (cache_key, kind, from_lng, from_lat, to_lng, to_lat, straight_m, reason, status, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending', now())
           ON CONFLICT (cache_key) DO UPDATE SET
             reason = EXCLUDED.reason, updated_at = now()`,
          [key, p.kind, p.from.lng, p.from.lat, p.to.lng, p.to.lat, Math.round(straightM * 10) / 10, r.error],
        );
      }
      if ((i + 1) % 20 === 0) say(`   … ${i + 1}/${target.length}（ok ${ok} / 失败 ${failed}）`);
    }
  } finally {
    c.release();
  }

  say(`   ✅ 完成：写 walk_cache ${ok} · 失败入队 ${failed}`);
  const t = await pool.query(`SELECT count(*)::int n FROM walk_cache`);
  const m = await pool.query(`SELECT count(*)::int n FROM walk_miss_queue WHERE status='pending'`);
  say(`   现状：walk_cache ${(t.rows[0] as Record<string, number>).n} 行 · walk_miss_queue(pending) ${(m.rows[0] as Record<string, number>).n} 行`);

  await pool.end();
  fs.writeFileSync(path.join(OUT_DIR, "warm-walk-cache.out.txt"), out.join("\n") + "\n", "utf8");
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
