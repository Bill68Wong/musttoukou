/**
 * 离线影子对照 · 补漏候选产出（scripts/shadow-diff.ts，v1.3.0 · T05）
 *
 * ── 干什么（设计 §B.5 / §F / §G4）──────────────────────────────────────
 *   对**采样 OD** 同时跑：
 *     · **高德 transit**（`fetchTransitPlans`，`AlternativeRoute=10` → 解析 + 桥接）；
 *     · **本地图枚举**（`searchStationPaths`，有界 BFS 换乘 ≤2）；
 *   然后 **diff** 两边的「线路组合键（key）」，把结果写入 `shadow_diff_report`：
 *     · `extra_paths`  —— ★ **我们有、高德没有的组合**（`StationPath[]`，供请求期直接复用，
 *        免重跑图搜索；这是「补漏交付」的数据来源）；
 *     · `missed_paths` —— 高德有、本地没枚举出的（**漏线率**的来源）；
 *     · `miss_rate`    —— `|高德独有| ÷ |高德全部|`；**>10% 告警**（本地枚举不完整的信号）。
 *
 * ── ★ 为什么要它 + 之后要把 `allowInlineLocal` 关掉 ─────────────────────
 *   设计 §B.5 要求「本地方案**离线先算**、请求期只查 `shadow_diff_report`」。
 *   `nav-service.ts` 目前 `allowInlineLocal=true`（临时态）。**本脚本跑完灌数后**，
 *   已把 `allowInlineLocal` **默认改为 false** ⇒ 请求期不再跑图搜索，只读本表 ✓
 *
 * ── 用法 ───────────────────────────────────────────────────────────────
 *   node node_modules/tsx/dist/cli.mjs scripts/shadow-diff.ts                 # DRY-RUN（默认 5 个 OD）
 *   node node_modules/tsx/dist/cli.mjs scripts/shadow-diff.ts --apply --limit=8
 *   node … --ods=home>school,school>home   # 自定义 OD（place slug 对）
 *
 * ⚠️ 小样本优先：设计建议「先小配额/白名单 OD 灰度 + 人工抽检」——默认只跑 5 个 OD。
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { gcj02ToWgs84, wgs84ToGcj02 } from "../src/lib/amap/coord";
import { fetchTransitPlans } from "../src/lib/amap/transit";
import { searchStationPaths, type GeoStation, type StationPath } from "../src/lib/nav/graph-search";
import { loadStationMap } from "../src/lib/nav/map-stations";
import { parseAndBridge } from "../src/lib/nav/parse-amap-plan";
import { odCoordKey } from "../src/lib/amap/transit";
import { loadStatics } from "../src/lib/recommend/query";
import { mainCodeOf } from "../src/lib/recommend/segment-lookup";
import type { AmapTransitRawResponse } from "../src/lib/amap/transit";

process.loadEnvFile("D:/Projects/University/Studio/musttoukou/.env");

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (n: string) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : undefined;
};
const APPLY = has("--apply");
const LIMIT = Number(val("limit") ?? "32") || 32;
const OD_ARG = val("ods"); // "home>school,school>home"
/** 本地枚举的近站数 K（默认 8，同 R1 设计）；调大可降低漏线率（诊断用） */
const K = Number(val("k") ?? "8") || 8;
/**
 * ★ P1-1 修复：本地枚举的**候选上限**（原硬编码 80 ⇒ **32/32 OD 全部触顶** ⇒ 漏线率虚高/失真 ✗）。
 * 抬到 2000 并**统计触顶率**；否则指标本身不可信。
 */
const CAP = Number(val("cap") ?? "2000") || 2000;

const OUT_DIR = "D:/Projects/University/Studio/musttoukou/.verify";
const OUT = path.join(OUT_DIR, "shadow-diff.out.txt");
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

const MAIN = (c: string) => mainCodeOf(c);
/**
 * ★ **组合键 = 线路链**（如 `25` / `25→N5`）。
 *   ⚠️ 为何不用站台级精确键：本地图枚举会对**同一线路链**产出**多个上/下车站变体**
 *   （最近 8 站两两组合），而高德只给一个 ⇒ 精确键几乎永不相等 ⇒ 漏线率虚高（实测 82%）。
 *   设计所谓「漏掉的**组合**」指的是**线路链** ⇒ 用线路链做 diff 才是正确粒度。
 */
const chainKeyOf = (p: StationPath) => p.rides.map((r) => r.route).join("→");

async function main() {
  say(`模式：${APPLY ? "★ APPLY（写库）" : "DRY-RUN（只打印）"}`);
  say(`目标库：${u.hostname} / ${u.pathname.slice(1)}`);
  say("");

  const st = await loadStatics(pool);
  const map = await loadStationMap(pool);
  const validRoutes = new Set<string>(st.routeIdx.dirsOf.keys());
  const bridgeCtx = { map, validRoutes, routeIdx: st.routeIdx };

  // 站点地理（主码去重 WGS）
  const stRes = await pool.query(`SELECT code, lat, lng FROM stations WHERE lat IS NOT NULL AND lng IS NOT NULL`);
  const seen = new Set<string>();
  const geo: GeoStation[] = [];
  /** ★ 热门站台（供 OD 采样：地点 × 热门站）—— 坐标为 **GCJ-02** */
  const HOT_MAINS = ["M1", "T363", "C653", "T374", "LRT-MUST", "T400", "C690", "T355"];
  const hotByMain = new Map<string, { lng: number; lat: number }>();
  for (const r of stRes.rows as Record<string, unknown>[]) {
    const m = MAIN(String(r.code));
    if (!seen.has(m)) {
      seen.add(m);
      geo.push({ main: m, lat: Number(r.lat), lng: Number(r.lng) });
      if (HOT_MAINS.includes(m) && !hotByMain.has(m)) {
        hotByMain.set(m, wgs84ToGcj02({ lat: Number(r.lat), lng: Number(r.lng) }));
      }
    }
  }

  // 地点坐标（WGS → GCJ）
  const pcRes = await pool.query(
    `SELECT p.slug, pc.zone, pc.lat, pc.lng FROM place_coords pc JOIN places p ON p.id = pc.place_id`,
  );
  const placeBySlug = new Map<string, { lng: number; lat: number }>();
  for (const r of pcRes.rows as Record<string, unknown>[]) {
    const slug = String(r.slug);
    if (placeBySlug.has(slug)) continue;
    const g = wgs84ToGcj02({ lat: Number(r.lat), lng: Number(r.lng) });
    placeBySlug.set(slug, g);
  }

  // ── OD 采样：默认「地点×地点」+「地点×热门站（双向）」→ ≥30 个 ──
  let odList: string[];
  if (OD_ARG) {
    odList = OD_ARG.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    const slugs = [...placeBySlug.keys()];
    const pairs: string[] = [];
    for (const a of slugs) for (const b of slugs) if (a !== b) pairs.push(`${a}>${b}`);
    for (const a of slugs)
      for (const m of [...hotByMain.keys()]) {
        pairs.push(`${a}>@${m}`);
        pairs.push(`@${m}>${a}`);
      }
    odList = pairs;
  }
  odList = odList.slice(0, LIMIT);
  /** `@M1` → 热门站坐标；`home` → 地点坐标 */
  const coordsOf = (tok: string) =>
    tok.startsWith("@") ? hotByMain.get(tok.slice(1)) : placeBySlug.get(tok);

  say(`采样 OD：${odList.length} 个 · k=${K} · cap=${CAP}`);
  say("");

  interface ReportRow {
    odKey: string;
    label: string;
    amapPlanCnt: number;
    localPlanCnt: number;
    missedPaths: { chain: string }[];
    extraPaths: StationPath[];
    missRate: number;
  }
  const rows: ReportRow[] = [];
  let alertCount = 0;
  /** ★ 触顶 OD 数（本地候选达到 cap）——指标可信度的关键 */
  let hitCap = 0;

  for (const od of odList) {
    const [fromTok, toTok] = od.split(">");
    const origin = coordsOf(fromTok);
    const dest = coordsOf(toTok);
    if (!origin || !dest) {
      say(`  ⚠ ${od}：坐标缺失 → 跳过`);
      continue;
    }

    // ── 高德 ──
    const tr = await fetchTransitPlans(origin, dest, { nowMs: Date.now() });
    let amapChains = new Set<string>();
    let amapCnt = 0;
    if (tr.ok) {
      const parsed = parseAndBridge({ status: "1", route: { transits: tr.raw } } as AmapTransitRawResponse, origin, dest, bridgeCtx);
      amapCnt = parsed.seeds.length;
      amapChains = new Set(parsed.seeds.map((s) => s.legs.map((l) => l.mappedRoute ?? "__amap_").join("→")));
    }

    // ── 本地图枚举 ──
    const localPaths = searchStationPaths(
      st.routeIdx,
      geo,
      gcj02ToWgs84(origin),
      gcj02ToWgs84(dest),
      { maxCandidates: CAP, k: K },
    );
    if (localPaths.length >= CAP) hitCap++;
    const localChains = new Set(localPaths.map(chainKeyOf));

    // ★ 补漏（本地独有组合）：按线路链去重，每条链取首个代表；上限 20（防单 OD 灌爆）
    const extraByChain = new Map<string, StationPath>();
    for (const p of localPaths) {
      const ck = chainKeyOf(p);
      if (amapChains.has(ck)) continue;
      if (!extraByChain.has(ck)) extraByChain.set(ck, p);
      if (extraByChain.size >= 20) break;
    }
    const extra = [...extraByChain.values()];
    const missed = [...amapChains].filter((k) => !localChains.has(k));
    const missRate = amapChains.size > 0 ? missed.length / amapChains.size : 0;
    if (missRate > 0.1) alertCount++;

    const odKey = odCoordKey(origin, dest);
    rows.push({
      odKey,
      label: od,
      amapPlanCnt: amapCnt,
      localPlanCnt: localPaths.length,
      missedPaths: missed.map((k) => ({ chain: k })),
      extraPaths: extra,
      missRate,
    });

    say(
      `  ${od.padEnd(16)} 高德 ${amapCnt} 方案（组合 ${amapChains.size}） · 本地 ${localPaths.length} 路径（组合 ${localChains.size}） · 补漏(本地独有组合) ${extra.length} · 漏线 ${missed.length}（${(missRate * 100).toFixed(1)}%${missRate > 0.1 ? " 🔴>10%" : ""}）`,
    );
    if (extra.length) {
      say(`      ↳ 补漏组合：${extra.slice(0, 5).map((e) => e.rides.map((r) => r.route).join("→")).join(" · ")}`);
    }
  }

  say("");
  const nz = rows.filter((r) => r.amapPlanCnt > 0);
  const avgMiss = nz.length ? nz.reduce((s, r) => s + r.missRate, 0) / nz.length : 0;
  say(`汇总：采样 ${rows.length} 个 OD（其中高德有方案 ${nz.length} 个）· 平均漏线率 **${(avgMiss * 100).toFixed(1)}%** · 超 10% 告警 ${alertCount} 个`);
  say(`★ 触顶率（本地候选达到 cap=${CAP}）：**${rows.length ? ((hitCap / rows.length) * 100).toFixed(1) : "0"}%**（${hitCap}/${rows.length}）${hitCap > 0 ? " ⚠️ 触顶 ⇒ 漏线率**仍偏高（度量偏乐观）**，需再抬 cap" : " ✓ 无触顶 ⇒ 指标可信"}`);
  say(`补漏候选（extra_paths）合计 **${rows.reduce((s, r) => s + r.extraPaths.length, 0)}** 条`);

  if (!APPLY) {
    say("");
    say("（DRY-RUN：未写库；加 --apply 生效。设计建议**先小样本抽检**再扩大）");
  } else {
    say("");
    const c = await pool.connect();
    let written = 0;
    try {
      await c.query("BEGIN");
      for (const r of rows) {
        // ★ 快照语义：同 OD 只保留最新一行（表无 UNIQUE(od_key)，见设计 §2.F DDL）
        //   先删旧行再插 —— 避免多次运行堆积同一 OD 的历史行；`nav-service` 读「最新一行」。
        await c.query(`DELETE FROM shadow_diff_report WHERE od_key = $1`, [r.odKey]);
        await c.query(
          `INSERT INTO shadow_diff_report
             (od_key, amap_plan_cnt, local_plan_cnt, missed_paths, extra_paths, extra_recompute, miss_rate, created_at)
           VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,NULL,$6, now())`,
          [
            r.odKey,
            r.amapPlanCnt,
            r.localPlanCnt,
            JSON.stringify(r.missedPaths),
            JSON.stringify(r.extraPaths),
            r.missRate,
          ],
        );
        written++;
      }
      await c.query("COMMIT");
      say(`   ✅ 写入 shadow_diff_report：${written} 行`);
    } catch (e) {
      await c.query("ROLLBACK");
      say(`   🔴 写库失败已回滚：${(e as Error).message}`);
      c.release();
      await pool.end();
      fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
      process.exit(1);
    }
    c.release();
    const cnt = await pool.query(`SELECT count(*)::int n, count(*) FILTER (WHERE extra_paths IS NOT NULL)::int with_extra FROM shadow_diff_report`);
    const row = cnt.rows[0] as Record<string, number>;
    say(`   现状：shadow_diff_report 共 ${row.n} 行（含 extra_paths 的 ${row.with_extra} 行）`);
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
