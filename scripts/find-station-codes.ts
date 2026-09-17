/**
 * 站号补全（scripts/find-station-codes.ts）
 * 在已同步的 stations 表里为「编号待补」站点找真实 DSAT 站号
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* ignore */
}

const TARGETS = [
  { hint: "路氹東/新濠天地", patterns: ["新濠天地", "路氹東"] },
  { hint: "機場大馬路/科大醫院", patterns: ["科大醫院"] },
  { hint: "望德聖母灣馬路/連貫公路", patterns: ["連貫公路", "望德聖母灣"] },
  { hint: "蓮花路停車場", patterns: ["蓮花路", "蓮花"] },
  { hint: "橫琴澳方口岸", patterns: ["橫琴", "口岸"] },
  { hint: "樂居大馬路/居雅大廈", patterns: ["居雅", "樂居"] },
  { hint: "和諧廣場/樂群樓（C651 待核）", patterns: ["樂群樓"] },
];

async function main() {
  const pool = new Pool({
    connectionString: (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL) || process.env.DATABASE_URL,
    max: 1,
  });
  for (const t of TARGETS) {
    const rows = (
      await pool.query(
        `SELECT code, name_tc FROM stations
         WHERE kind = 'bus' AND (${t.patterns.map((_, i) => `name_tc LIKE '%' || $${i + 1} || '%'`).join(" OR ")})
         ORDER BY code`,
        t.patterns,
      )
    ).rows as { code: string; name_tc: string }[];
    console.log(`\n【${t.hint}】`);
    if (rows.length === 0) console.log("  （未找到）");
    for (const r of rows.slice(0, 8)) console.log(`  ${r.code}  ${r.name_tc}`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
