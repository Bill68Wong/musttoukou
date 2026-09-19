/**
 * 本地地名别名库 · 冷启动（scripts/seed-poi-aliases.ts，v1.3.0）
 *
 * ── 干什么 ────────────────────────────────────────────────────────────
 *   向 `poi_aliases` 灌入「**0 配额**命中」所需的别名（设计 §2.A / §G3）：
 *     · **站点名**（613 站；含繁体原名 + 繁简归一 + 去后缀形态）；
 *     · **线路名**（95 条；线路码）；
 *     · **预设地点**（擎天匯 / 澳科大 / 横琴口岸 / 关闸 —— 来自 places + place_coords）；
 *     · **校园叫法 / 口岸口语 / 轻轨缩写（lrt·轻轨——★高德搜不到）/ 葡文地名**（人工策划）。
 *
 *   ★ 坐标系：别名坐标一律 **GCJ-02**（确认后直接作 `transit.destination`）。
 *     我们库（WGS84）经 `wgs84ToGcj02()` 转换后入库。
 *
 * ── 归一化（§6.2 / R5）────────────────────────────────────────────────
 *   `alias_norm` = 繁→简 + 去空白（`normalizeQuery`）。另对站名额外生成「去交通后缀」
 *   形态（`normalizeName`），以支持「关闸」匹配「關閘總站」。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/seed-poi-aliases.ts            # DRY-RUN
 *   node node_modules/tsx/dist/cli.mjs scripts/seed-poi-aliases.ts --apply    # 写库（幂等）
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { wgs84ToGcj02 } from "../src/lib/amap/coord";
import { normalizeName, normalizeQuery } from "../src/lib/shared/normalize";

try {
  process.loadEnvFile("D:/Projects/University/Studio/musttoukou/.env");
} catch {
  /* .env 不存在 */
}

const APPLY = process.argv.includes("--apply");
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

interface AliasRow {
  aliasNorm: string;
  aliasRaw: string;
  targetKind: string;
  targetCode: string;
  nameTc: string;
  lng: number | null;
  lat: number | null;
  weight: number;
  source: string;
}

const mainCodeOf = (code: string): string => /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function main() {
  say(`模式：${APPLY ? "★ APPLY（写库）" : "DRY-RUN（只读）"}`);
  say(`目标库：${u.hostname} / ${u.pathname.slice(1)}`);
  say("");

  const rows: AliasRow[] = [];
  const seen = new Set<string>();
  const push = (r: AliasRow) => {
    if (!r.aliasNorm || !r.nameTc) return;
    const key = `${r.aliasNorm}|${r.targetKind}|${r.targetCode}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(r);
  };

  // ── ① 站点 ──
  const st = await pool.query(`SELECT code, name_tc, kind, lat, lng FROM stations`);
  let stCount = 0;
  for (const raw of st.rows as Record<string, unknown>[]) {
    const code = String(raw.code);
    const nameTc = String(raw.name_tc ?? "");
    const kind = String(raw.kind ?? "bus");
    const wgs = { lat: num(raw.lat), lng: num(raw.lng) };
    const gcj = wgs.lat !== null && wgs.lng !== null ? wgs84ToGcj02({ lat: wgs.lat, lng: wgs.lng }) : null;
    const targetKind = kind === "lrt" ? "lrt_station" : "station";
    // 繁体原名（全名）
    push({
      aliasNorm: normalizeQuery(nameTc),
      aliasRaw: nameTc,
      targetKind,
      targetCode: code,
      nameTc,
      lng: gcj?.lng ?? null,
      lat: gcj?.lat ?? null,
      weight: 1.0,
      source: "station",
    });
    // 去后缀形态（「關閘總站」→「关闸」）
    const core = normalizeName(nameTc);
    if (core && core !== normalizeQuery(nameTc)) {
      push({
        aliasNorm: core,
        aliasRaw: `${nameTc}（去后缀）`,
        targetKind,
        targetCode: code,
        nameTc,
        lng: gcj?.lng ?? null,
        lat: gcj?.lat ?? null,
        weight: 0.9,
        source: "station",
      });
    }
    // 站码本身
    push({
      aliasNorm: normalizeQuery(code),
      aliasRaw: code,
      targetKind,
      targetCode: code,
      nameTc,
      lng: gcj?.lng ?? null,
      lat: gcj?.lat ?? null,
      weight: 1.1,
      source: "station",
    });
    stCount++;
  }
  say(`① 站点 ${stCount} 个 → 别名候选 ${rows.length}`);

  // ── ② 线路 ──
  const beforeRoutes = rows.length;
  const rt = await pool.query(`SELECT code, kind FROM routes ORDER BY code`);
  for (const raw of rt.rows as Record<string, unknown>[]) {
    const code = String(raw.code);
    push({
      aliasNorm: normalizeQuery(code),
      aliasRaw: code,
      targetKind: "route",
      targetCode: code,
      nameTc: code,
      lng: null,
      lat: null,
      weight: 0.6,
      source: "route",
    });
  }
  say(`② 线路 ${rt.rows.length} 条 → 新增别名 ${rows.length - beforeRoutes}`);

  // ── ③ 预设地点（places + place_coords）──
  const beforePlaces = rows.length;
  const places = await pool.query(`SELECT id, slug, name FROM places WHERE is_active`);
  const coords = await pool.query(`SELECT place_id, zone, lat, lng FROM place_coords`);
  const coordByPlace = new Map<number, { lat: number; lng: number }[]>();
  for (const raw of coords.rows as Record<string, unknown>[]) {
    const pid = Number(raw.place_id);
    const arr = coordByPlace.get(pid) ?? [];
    const lat = num(raw.lat);
    const lng = num(raw.lng);
    if (lat !== null && lng !== null) arr.push({ lat, lng });
    coordByPlace.set(pid, arr);
  }
  const PLACE_ALIASES: Record<string, string[]> = {
    home: ["擎天汇", "擎天匯", "擎天", "T8", "擎天汇T8", "家", "宿舍"],
    school: ["澳科大", "科大", "澳门科技大学", "澳門科技大學", "MUST", "澳门科大", "澳科大宿舍", "澳科大校区"],
    hengqin: ["横琴", "橫琴", "横琴口岸", "橫琴口岸", "横琴站", "橫琴站", "澳门大学横琴"],
    gate: ["关闸", "關閘", "拱北", "拱北口岸", "关闸口岸", "關閘口岸"],
  };
  for (const raw of places.rows as Record<string, unknown>[]) {
    const slug = String(raw.slug);
    const nameTc = String(raw.name ?? "");
    const list = coordByPlace.get(Number(raw.id)) ?? [];
    // 取第一个坐标作为代表（澳科大取首个 zone；仅用于别名命中给点，精度足够）
    const rep = list[0] ?? null;
    const gcj = rep ? wgs84ToGcj02(rep) : null;
    const aliases = PLACE_ALIASES[slug] ?? [];
    for (const a of aliases) {
      push({
        aliasNorm: normalizeQuery(a),
        aliasRaw: a,
        targetKind: "place",
        targetCode: slug,
        nameTc,
        lng: gcj?.lng ?? null,
        lat: gcj?.lat ?? null,
        weight: 1.2,
        source: "campus",
      });
    }
    // 官方名本身
    push({
      aliasNorm: normalizeQuery(nameTc),
      aliasRaw: nameTc,
      targetKind: "place",
      targetCode: slug,
      nameTc,
      lng: gcj?.lng ?? null,
      lat: gcj?.lat ?? null,
      weight: 1.3,
      source: "campus",
    });
  }
  say(`③ 预设地点 ${places.rows.length} 个 → 新增别名 ${rows.length - beforePlaces}`);

  // ── ④ 人工策划：轻轨缩写 / 葡文 / 常见 POI ──
  const beforeExtra = rows.length;
  const LRT_NETWORK = ["轻轨", "輕軌", "lrt", "澳门轻轨", "澳門輕軌", "轻轨澳门", "氹仔线", "氹仔線"];
  for (const a of LRT_NETWORK)
    push({
      aliasNorm: normalizeQuery(a),
      aliasRaw: a,
      targetKind: "poi",
      targetCode: "LRT",
      nameTc: "澳門輕軌",
      lng: null,
      lat: null,
      weight: 0.8,
      source: "lrt",
    });
  // 轻轨各线 → 对应 route code
  const LRT_LINES: Record<string, string[]> = {
    "LRT-氹仔线": ["氹仔线", "氹仔線", "taipa line"],
    "LRT-石排湾线": ["石排湾线", "石排灣線", "coloane line"],
    "LRT-横琴线": ["横琴线", "橫琴線", "hengqin line"],
  };
  for (const [code, list] of Object.entries(LRT_LINES))
    for (const a of list)
      push({
        aliasNorm: normalizeQuery(a),
        aliasRaw: a,
        targetKind: "route",
        targetCode: code,
        nameTc: code,
        lng: null,
        lat: null,
        weight: 0.85,
        source: "lrt",
      });
  // 葡文 / 英文地名（游客常用；坐标为 null → 首次使用由高德确认）
  const PT_NAMES: { alias: string; nameTc: string }[] = [
    { alias: "Macau", nameTc: "澳門" },
    { alias: "Macao", nameTc: "澳門" },
    { alias: "Taipa", nameTc: "氹仔" },
    { alias: "Cotai", nameTc: "路氹城" },
    { alias: "Coloane", nameTc: "路環" },
    { alias: "Largo do Senado", nameTc: "議事亭前地" },
    { alias: "Barra", nameTc: "媽閣" },
    { alias: "Macau International Airport", nameTc: "澳門國際機場" },
    { alias: "Aeroporto", nameTc: "機場" },
    { alias: "Border Gate", nameTc: "關閘" },
  ];
  for (const p of PT_NAMES)
    push({
      aliasNorm: normalizeQuery(p.alias),
      aliasRaw: p.alias,
      targetKind: "poi",
      targetCode: "",
      nameTc: p.nameTc,
      lng: null,
      lat: null,
      weight: 0.7,
      source: "pt",
    });
  // 常见本地 POI / 口岸口语（召回增强；坐标 null）
  const COMMON: string[] = [
    "威尼斯人",
    "巴黎人",
    "伦敦人",
    "倫敦人",
    "新葡京",
    "永利皇宫",
    "永利",
    "银河",
    "銀河",
    "新濠天地",
    "新濠影汇",
    "美高梅",
    "大三巴",
    "大三巴牌坊",
    "议事亭前地",
    "官也街",
    "妈阁庙",
    "澳門旅遊塔",
    "澳门旅游塔",
    "氹仔码头",
    "澳门机场",
    "澳门大学",
    "澳门理工大学",
    "澳门城市大学",
    "筷子基",
    "沙梨头",
    "红街市",
    "观音堂",
    "路环市区",
    "黑沙海滩",
  ];
  for (const a of COMMON)
    push({
      aliasNorm: normalizeQuery(a),
      aliasRaw: a,
      targetKind: "poi",
      targetCode: "",
      nameTc: a,
      lng: null,
      lat: null,
      weight: 0.5,
      source: "manual",
    });
  say(`④ 人工策划（轻轨/葡文/常见 POI）→ 新增别名 ${rows.length - beforeExtra}`);

  // ── 统计 ──
  const bySource = new Map<string, number>();
  const byKind = new Map<string, number>();
  for (const r of rows) {
    bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
    byKind.set(r.targetKind, (byKind.get(r.targetKind) ?? 0) + 1);
  }
  say("");
  say(`合计别名（去重后）：${rows.length}`);
  say(`  按来源：${[...bySource.entries()].map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  say(`  按类型：${[...byKind.entries()].map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  const noCoord = rows.filter((r) => r.lng === null).length;
  say(`  无坐标（首次使用需高德确认）：${noCoord}`);

  if (!APPLY) {
    say("");
    say("（DRY-RUN：未写库；加 --apply 生效）");
    await pool.end();
    fs.writeFileSync(path.join(OUT_DIR, "seed-poi-aliases.out.txt"), out.join("\n") + "\n", "utf8");
    return;
  }

  say("");
  say("⑤ 写库（幂等 upsert）");
  const c = await pool.connect();
  let n = 0;
  try {
    await c.query("BEGIN");
    for (const r of rows) {
      await c.query(
        `INSERT INTO poi_aliases
           (alias_norm, alias_raw, target_kind, target_code, name_tc, lng, lat, weight, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (alias_norm, target_kind, target_code) DO UPDATE SET
           alias_raw = EXCLUDED.alias_raw,
           name_tc   = EXCLUDED.name_tc,
           lng       = EXCLUDED.lng,
           lat       = EXCLUDED.lat,
           weight    = EXCLUDED.weight,
           source    = EXCLUDED.source`,
        [r.aliasNorm, r.aliasRaw, r.targetKind, r.targetCode, r.nameTc, r.lng, r.lat, r.weight, r.source],
      );
      n++;
    }
    await c.query("COMMIT");
    say(`   ✅ 写入 poi_aliases：${n} 行`);
  } catch (e) {
    await c.query("ROLLBACK");
    say(`   🔴 写库失败已回滚：${(e as Error).message}`);
    c.release();
    await pool.end();
    fs.writeFileSync(path.join(OUT_DIR, "seed-poi-aliases.out.txt"), out.join("\n") + "\n", "utf8");
    process.exit(1);
  }
  c.release();

  const total = (await pool.query(`SELECT count(*)::int n FROM poi_aliases`)).rows[0] as Record<string, number>;
  say(`   现状：poi_aliases 共 ${total.n} 行`);

  await pool.end();
  fs.writeFileSync(path.join(OUT_DIR, "seed-poi-aliases.out.txt"), out.join("\n") + "\n", "utf8");
  void mainCodeOf;
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
