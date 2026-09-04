/**
 * v0.9.0 增量迁移（db/migrate-v090.ts）
 * 用法：npm run db:migrate-v090 -- [local|cloud]
 *
 * 背景（2026-09-04 数据卫生批 Batch1）：
 *   A2 school 改名：places.name「澳科大 N座（圖書館大樓）」→「澳科大」
 *      （三组座 B/C|N/O|R 由 from_zone/to_zone 表达，名称不再锚单楼）
 *   A3 wait_snapshots manual 全清 + 防无站重复：
 *      - 云端 21 行 / 本地 3 行 manual（均为软删测试会话产物：1 bus 遗留 + 无站重复 + LRT 测试分钟）
 *      - 只删「挂在软删会话下」的 manual 行；挂在未删会话（真实样本）的行绝不动
 *      - 补部分唯一索引：无 station_code 的 manual minutes 同会话仅 1 条
 *   A6 bus_snapshots 卫生：
 *      - 清孤儿行（本地 279 条指向已物理删除会话；云端 0）
 *      - 补外键 fk_bus_snapshots_session（ON DELETE CASCADE，与 timer_events 同语义）
 *
 * ⚠️ 安全断言：任何清理都不触碰 deleted_at IS NULL 的会话（真实样本，目前云端 5 条）。
 * 幂等：重复执行安全（删无可删、索引/约束 IF NOT EXISTS 风格）。
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const target = process.argv[2] as "local" | "cloud" | undefined;
const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? process.env.DATABASE_URL_LOCAL
      : (process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL);

if (!connStr) {
  console.error("❌ 未找到连接串：请先在 .env 配置（参照 .env.example）");
  process.exit(1);
}
const masked = connStr.replace(/:[^:@/]+@/, ":****@");
console.log(`目标库：${masked}`);

async function main() {
  const pool = new Pool({
    connectionString: connStr,
    max: 1,
    ssl: (connStr as string).includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  const q = pool.query.bind(pool);

  try {
    // ---------- A2 school 改名 ----------
    console.log("\n── A2 places.school 改名 ──");
    const rn = await q(
      `UPDATE places SET name = '澳科大' WHERE slug = 'school' AND kind = 'school' AND name <> '澳科大'`,
    );
    const places = (await q(`SELECT id, slug, name, kind FROM places ORDER BY id`)).rows as {
      id: number;
      slug: string;
      name: string;
      kind: string;
    }[];
    for (const p of places) console.log(`  ${p.id} | ${p.slug} | ${p.name} | ${p.kind}`);
    console.log(`  ✅ school 改名影响 ${rn.rowCount ?? 0} 行`);

    // ---------- A3 manual 清理（只删软删会话下的 manual） ----------
    console.log("\n── A3 wait_snapshots manual 清理 ──");
    const realBefore = (await q(
      `SELECT count(*)::int AS n FROM wait_snapshots w JOIN timer_sessions s ON s.id = w.session_id WHERE w.source = 'manual' AND s.deleted_at IS NULL`,
    )).rows[0] as { n: number };
    const manTotal = (await q(`SELECT count(*)::int AS n FROM wait_snapshots WHERE source = 'manual'`))
      .rows[0] as { n: number };
    console.log(`  manual 总行数=${manTotal.n}，其中挂真实会话(未删)=${realBefore.n}（必须为 0）`);
    if (realBefore.n > 0) {
      throw new Error("❌ 存在挂在真实会话下的 manual 行，拒绝清理！");
    }
    const del = await q(
      `DELETE FROM wait_snapshots w USING timer_sessions s
       WHERE w.session_id = s.id AND w.source = 'manual' AND s.deleted_at IS NOT NULL`,
    );
    const manAfter = (await q(`SELECT count(*)::int AS n FROM wait_snapshots WHERE source = 'manual'`))
      .rows[0] as { n: number };
    console.log(`  ✅ 删除软删会话 manual：${del.rowCount ?? 0} 行；剩余 manual=${manAfter.n}（应为 0）`);

    // 无站 manual minutes 部分唯一索引（同会话仅 1 条）
    await q(`DROP INDEX IF EXISTS uq_wait_snap_manual_min_nostation`);
    await q(
      `CREATE UNIQUE INDEX uq_wait_snap_manual_min_nostation
       ON wait_snapshots (session_id)
       WHERE source = 'manual' AND value_kind = 'minutes' AND station_code IS NULL`,
    );
    console.log("  ✅ 无站 manual minutes 去重索引 uq_wait_snap_manual_min_nostation 就绪");

    // ---------- A6 bus_snapshots 孤儿清理 + 外键 ----------
    console.log("\n── A6 bus_snapshots 孤儿清理 + 外键 ──");
    const orphanDel = await q(
      `DELETE FROM bus_snapshots b USING (SELECT b2.id FROM bus_snapshots b2 LEFT JOIN timer_sessions s ON s.id = b2.session_id WHERE b2.session_id IS NOT NULL AND s.id IS NULL) o WHERE b.id = o.id`,
    );
    console.log(`  ✅ 孤儿快照清理：${orphanDel.rowCount ?? 0} 行`);
    await q(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bus_snapshots_session') THEN
          ALTER TABLE bus_snapshots
            ADD CONSTRAINT fk_bus_snapshots_session
            FOREIGN KEY (session_id) REFERENCES timer_sessions(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `);
    const fk = (await q(
      `SELECT conname FROM pg_constraint WHERE conname = 'fk_bus_snapshots_session'`,
    )).rows as { conname: string }[];
    console.log(`  ✅ 外键 fk_bus_snapshots_session：${fk.length > 0 ? "已生效" : "缺失!"}`);

    // ---------- 校验 ----------
    console.log("\n── 校验 ──");
    const kept = (await q(
      `SELECT count(*)::int AS n FROM timer_sessions WHERE deleted_at IS NULL`,
    )).rows[0] as { n: number };
    const manLeft = (await q(`SELECT count(*)::int AS n FROM wait_snapshots WHERE source = 'manual'`))
      .rows[0] as { n: number };
    const orphanLeft = (await q(
      `SELECT count(*)::int AS n FROM bus_snapshots b LEFT JOIN timer_sessions s ON s.id = b.session_id WHERE b.session_id IS NOT NULL AND s.id IS NULL`,
    )).rows[0] as { n: number };
    console.log(`  真实会话(未删)数=${kept.n}（不变）；manual 剩余=${manLeft.n}；孤儿快照剩余=${orphanLeft.n}`);
    if (manLeft.n !== 0 || orphanLeft.n !== 0) {
      console.error("❌ 校验未通过");
      process.exitCode = 1;
    } else {
      console.log("✅ v0.9.0 迁移完成（真实样本未触碰）");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("❌ 迁移失败：", e.message);
  process.exit(1);
});
