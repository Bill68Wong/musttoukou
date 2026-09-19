/**
 * 站码映射 · 人工回写（scripts/apply-station-amap-map.ts，v1.3.0）
 *
 * ── 干什么 ────────────────────────────────────────────────────────────
 *   把人工在 `station-amap-map.csv` 里**填好/纠正**的「我们站码」回写 `station_amap_map`
 *   （设计 §B.3a④：**幂等**）。回写后该行 `verified_by_human=true` + `verified_at=now()`，
 *   主路径优先命中（§B.3a⑤）。
 *
 * ── 工作流（§B.3a④）──────────────────────────────────────────────────
 *   ① `db:rebuild-amap-map` 生成 CSV（自动产物）；
 *   ② 人工逐条确认/纠正/补漏（把主码填入「我们站码」列；可选填「人工备注」）；
 *   ③ 本脚本回写（默认 DRY-RUN，`--apply` 才写）。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/apply-station-amap-map.ts                 # dry-run
 *   node node_modules/tsx/dist/cli.mjs scripts/apply-station-amap-map.ts --apply          # 写库
 *   node node_modules/tsx/dist/cli.mjs scripts/apply-station-amap-map.ts --apply --file=X.csv
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

try {
  process.loadEnvFile("D:/Projects/University/Studio/musttoukou/.env");
} catch {
  /* .env 不存在 */
}

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
/** 默认跳过「待人工确认」仍为 ✔ 的行（= 尚未复核）；需要强制包含时才加此开关 */
const INCLUDE_FLAGGED = argv.includes("--include-flagged");
const fileArg = argv.find((a) => a.startsWith("--file="));
const CSV = fileArg
  ? fileArg.slice("--file=".length)
  : "D:/Projects/University/Studio/musttoukou/.verify/station-amap-map.csv";
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

const mainCodeOf = (code: string): string => /^[A-Za-z]+\d+/.exec(code.trim())?.[0] ?? code.trim();

/** 极简 CSV 解析（支持双引号转义与字段内逗号/换行） */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch === "\r") {
      /* skip */
    } else cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
}

interface Row {
  amapId: string;
  amapName: string;
  lng: number;
  lat: number;
  ourCode: string;
  ourName: string;
  /** 「待人工确认」原始标记（非空 = ✔ = 尚未复核） */
  flag: string;
  note: string;
}

function rowsFromCsv(rows: string[][]): { headers: string[]; data: Row[] } {
  const headers = rows[0] ?? [];
  const idx = (name: string) => headers.findIndex((h) => h.trim() === name);
  const iId = idx("高德站ID");
  const iName = idx("高德站名");
  const iCoord = idx("高德坐标(GCJ-02)");
  const iCode = idx("我们站码");
  const iOurName = idx("我们站名");
  const iFlag = idx("待人工确认");
  const iNote = idx("人工备注");
  const data: Row[] = [];
  for (const r of rows.slice(1)) {
    const coord = (r[iCoord] ?? "").split(",");
    const lng = Number(coord[0]);
    const lat = Number(coord[1]);
    data.push({
      amapId: (r[iId] ?? "").trim(),
      amapName: (r[iName] ?? "").trim(),
      lng,
      lat,
      ourCode: (iCode >= 0 ? r[iCode] ?? "" : "").trim(),
      ourName: (iOurName >= 0 ? r[iOurName] ?? "" : "").trim(),
      flag: (iFlag >= 0 ? r[iFlag] ?? "" : "").trim(),
      note: iNote >= 0 ? (r[iNote] ?? "").trim() : "",
    });
  }
  return { headers, data };
}

async function main() {
  say(`模式：${APPLY ? "★ APPLY（写库）" : "DRY-RUN（只读）"}`);
  say(`目标库：${u.hostname} / ${u.pathname.slice(1)}`);
  say(`CSV：${CSV}`);
  say("");

  if (!fs.existsSync(CSV)) {
    say(`🔴 找不到 CSV：${CSV}（先跑 db:rebuild-amap-map 生成）`);
    await pool.end();
    fs.writeFileSync(path.join(OUT_DIR, "apply-station-amap-map.out.txt"), out.join("\n") + "\n", "utf8");
    process.exit(1);
  }

  const rows = rowsFromCsv(parseCsv(fs.readFileSync(CSV, "utf8"))).data;
  const flagged = rows.filter((r) => r.flag !== "");
  const fillable = rows.filter((r) => r.ourCode !== "" && Number.isFinite(r.lng) && Number.isFinite(r.lat));
  // ★ 安全闸：默认**跳过仍带「待人工确认」标记**的行 —— 防止把「自动猜测」误当「人工已复核」写库。
  const toWrite = INCLUDE_FLAGGED ? fillable : fillable.filter((r) => r.flag === "");
  const skipped = fillable.length - toWrite.length;
  say(`① 解析 CSV：${rows.length} 行；「我们站码」非空 = ${fillable.length} 行`);
  say(`   其中「待人工确认」仍为 ✔（未复核）= ${skipped} 行 → ${INCLUDE_FLAGGED ? "**因 --include-flagged 仍将写入**" : "**跳过（不回写）**"}`);
  say(`   实际将回写 = ${toWrite.length} 行`);
  say(`   仍待人工确认（我们站码为空）：${rows.filter((r) => r.ourCode === "").length} 行`);
  if (skipped > 0 && !INCLUDE_FLAGGED) {
    say("   ⚠ 约定：确认某行无误请**清空该行「待人工确认」标记**（留空即视为已复核），再跑本脚本。");
  }

  // 名字查表（主码 → 繁体名）
  const nameRows = await pool.query(`SELECT code, name_tc FROM stations`);
  const nameByMain = new Map<string, string>();
  for (const r of nameRows.rows as Record<string, unknown>[]) {
    const code = String(r.code);
    const main = mainCodeOf(code);
    if (!nameByMain.has(main)) nameByMain.set(main, String(r.name_tc ?? ""));
  }

  // 校验我们站码是否存在
  const unknown: string[] = [];
  for (const r of toWrite) {
    const main = mainCodeOf(r.ourCode);
    if (!nameByMain.has(main)) unknown.push(r.ourCode);
  }
  if (unknown.length) say(`   ⚠ 未知站码（DB 无此主码）：${[...new Set(unknown)].join(", ")}`);

  say("");
  say("② 预览（前 20 条）");
  for (const r of toWrite.slice(0, 20)) {
    const main = mainCodeOf(r.ourCode);
    const nameTc = r.ourName || nameByMain.get(main) || "";
    say(`   ${r.amapName}（${r.lng.toFixed(5)},${r.lat.toFixed(5)}） → ${main} ${nameTc}${r.note ? `  [${r.note}]` : ""}`);
  }

  if (!APPLY) {
    say("");
    say("（DRY-RUN：未写库；加 --apply 生效）");
    await pool.end();
    fs.writeFileSync(path.join(OUT_DIR, "apply-station-amap-map.out.txt"), out.join("\n") + "\n", "utf8");
    return;
  }

  say("");
  say("③ 回写（幂等 upsert，verified_by_human=true）");
  const c = await pool.connect();
  let n = 0;
  try {
    await c.query("BEGIN");
    for (const r of toWrite) {
      const main = mainCodeOf(r.ourCode);
      const nameTc = r.ourName || nameByMain.get(main) || null;
      await c.query(
        `INSERT INTO station_amap_map
           (amap_station_id, amap_name, amap_lng, amap_lat, dsat_station_main, name_tc,
            match_method, name_match, confidence, verified_by_human, verified_at, verified_note)
         VALUES ($1,$2,$3,$4,$5,$6,'manual',TRUE,'high',TRUE, now(), $7)
         ON CONFLICT (amap_name, amap_lng, amap_lat) DO UPDATE SET
           amap_station_id   = EXCLUDED.amap_station_id,
           dsat_station_main = EXCLUDED.dsat_station_main,
           name_tc           = EXCLUDED.name_tc,
           match_method      = 'manual',
           confidence        = 'high',
           verified_by_human = TRUE,
           verified_at       = now(),
           verified_note     = EXCLUDED.verified_note,
           updated_at        = now()`,
        [r.amapId || null, r.amapName, r.lng, r.lat, main, nameTc, r.note || null],
      );
      n++;
    }
    await c.query("COMMIT");
    say(`   ✅ 回写 ${n} 行`);
  } catch (e) {
    await c.query("ROLLBACK");
    say(`   🔴 回写失败已回滚：${(e as Error).message}`);
    c.release();
    await pool.end();
    fs.writeFileSync(path.join(OUT_DIR, "apply-station-amap-map.out.txt"), out.join("\n") + "\n", "utf8");
    process.exit(1);
  }
  c.release();

  const stat = await pool.query(
    `SELECT count(*)::int total, count(*) FILTER (WHERE verified_by_human)::int verified,
            count(*) FILTER (WHERE dsat_station_main IS NULL)::int unmatched FROM station_amap_map`,
  );
  const s = stat.rows[0] as Record<string, number>;
  say(`   现状：共 ${s.total} 行 · 人工已确认 ${s.verified} · 未匹配 ${s.unmatched}`);

  await pool.end();
  fs.writeFileSync(path.join(OUT_DIR, "apply-station-amap-map.out.txt"), out.join("\n") + "\n", "utf8");
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
