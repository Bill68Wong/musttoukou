/**
 * 迁移 v1.1.10：Supabase 安全加固 —— 给 public 全部表装行级门禁 + 收掉 anon 的钥匙
 *
 * ── 起因（Supabase 告警 + 实测复核）────────────────────────────────────
 *   Supabase 提示「RLS Disabled in Public」。实测复核确认告警属实且更严重：
 *     · public 下 **21 张表 RLS 全关**
 *     · `anon` / `authenticated` 对每张表都有 **SELECT/INSERT/UPDATE/DELETE/TRUNCATE**（294 项授权）
 *     · 事务内 `SET LOCAL ROLE anon` 实测：能读到 timer_sessions 250 行、ride_crowd 48 行，
 *       且 DELETE 通过权限检查
 *   影响面：只要 anon key 泄露（Supabase 把它当公开信息，本来就发给浏览器用），
 *          任何人都能绕开应用直连 REST 接口读走数据、甚至清空整表。
 *
 * ── 本迁移做三件事 ────────────────────────────────────────────────────
 *   ① 给 public 所有表 **开启 RLS**（**不加任何策略** → 默认全员看不见）
 *   ② **收回** anon / authenticated 的表 / 序列 / 函数权限
 *   ③ **改默认授权**：以后新建的表也不再自动发给 anon（否则下次迁移又裸露）
 *
 * ── 为什么不会弄坏应用（已实测验证）──────────────────────────────────
 *   应用是用 `postgres` 身份连库的，而该角色 **`rolbypassrls = true`**（且是全部表的属主）
 *   ⇒ 开启 RLS 对应用**零影响**（实验：开 RLS 后 anon 读 0 行、postgres 照常读 48 行）。
 *   `service_role` 的授权**保留**（Supabase 服务端工具链可能用到）。
 *
 * 用法：
 *   node --experimental-strip-types db/migrate-v1110-rls.ts           # dry-run
 *   node --experimental-strip-types db/migrate-v1110-rls.ts --apply   # 执行
 */
import fs from "node:fs";
import { Pool } from "pg";

const APPLY = process.argv.includes("--apply");
process.loadEnvFile("D:/Projects/University/Studio/musttoukou/.env");
const u = new URL(process.env.DATABASE_URL!);
const pool = new Pool({
  host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1),
  user: u.username, password: decodeURIComponent(u.password || ""), ssl: { rejectUnauthorized: false },
});
const q = async (s: string, a?: unknown[]) => (await pool.query(s, a)).rows;
const out: string[] = [];
const say = (s: string) => { out.push(s); console.log(s); };

say(`模式：${APPLY ? "★ APPLY（写生产库）" : "DRY-RUN（只读）"}`);
say("");

async function main() {
  // ── ⓪ 前置：确认应用身份能绕过 RLS（否则开 RLS 会弄坏应用）──
  const pgRole = (await q(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`))[0];
  say("⓪ 安全前提检查");
  say(`   应用身份 = ${pgRole.rolname} · super=${pgRole.rolsuper} · bypassrls=${pgRole.rolbypassrls}`);
  if (!pgRole.rolbypassrls && !pgRole.rolsuper) {
    say("   🔴 该角色既不 bypassrls 也不是超级用户 → **开启 RLS 会让应用读不到数据**，禁止继续！");
    fs.writeFileSync("D:/Projects/University/Studio/musttoukou/.verify/rls-migrate.out.txt", out.join("\n") + "\n", "utf8");
    await pool.end();
    process.exit(1);
  }
  say("   ✅ 该角色 bypassrls=true ⇒ 开启 RLS 对应用零影响");
  say("");

  // ── ① 待处理的表 ──
  const tabs = (await q(
    `SELECT c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`)) as { relname: string; relrowsecurity: boolean; owner: string }[];
  const needRls = tabs.filter((t) => !t.relrowsecurity);
  say(`① 表：共 ${tabs.length} 张 · 待开 RLS ${needRls.length} 张${needRls.length ? "：" + needRls.map((t) => t.relname).join(" ") : "（已全部开启）"}`);

  // ── ② anon/authenticated 现有授权 ──
  const grants = (await q(
    `SELECT grantee, count(*)::int n FROM information_schema.role_table_grants
      WHERE table_schema='public' AND grantee IN ('anon','authenticated')
      GROUP BY grantee ORDER BY grantee`)) as { grantee: string; n: number }[];
  say(`② 待收回授权：${grants.length ? grants.map((g) => `${g.grantee} ${g.n} 项`).join(" · ") : "（无）"}`);

  // ── ③ 默认授权（决定以后新建表会不会又自动发给 anon）──
  say("");
  say("③ 默认授权现状（pg_default_acl）—— 决定以后新建表会不会又自动裸露");
  const dacl = (await q(
    `SELECT pg_get_userbyid(d.defaclrole) AS grantor, n.nspname, d.defaclobjtype AS objtype, d.defaclacl::text AS acl
       FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace`)) as { grantor: string; nspname: string | null; objtype: string; acl: string }[];
  for (const d of dacl) say(`   ${d.grantor} · ${d.nspname ?? "(全局)"} · ${d.objtype} → ${d.acl}`);
  if (!dacl.length) say("   （无默认授权条目）");

  // ── ④ 执行 ──
  say("");
  if (!APPLY) {
    say("④ 将执行（DRY-RUN 未执行）：");
    say(`   · ALTER TABLE public.<每张表> ENABLE ROW LEVEL SECURITY;   ×${needRls.length}`);
    say("   · REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;");
    say("   · REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;");
    say("   · REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;");
    say("   · ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;");
    say("   · ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;");
    say("");
    say("（加 --apply 生效）");
  } else {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      say("④ 执行中…");
      let n = 0;
      for (const t of needRls) {
        await client.query(`ALTER TABLE public."${t.relname}" ENABLE ROW LEVEL SECURITY`);
        n++;
      }
      say(`   ✅ 已开启 RLS：${n} 张表`);
      for (const sql of [
        "REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated",
        "REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated",
        "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated",
      ]) {
        await client.query(sql);
        say(`   ✅ ${sql.slice(0, 88)}…`);
      }
      await client.query("COMMIT");
      say("   ✅ 已提交");
    } catch (e) {
      await client.query("ROLLBACK");
      say(`   🔴 出错已回滚：${(e as Error).message}`);
    } finally {
      client.release();
    }
  }

  // ── ⑤ 复核 ──
  say("");
  say("⑤ 复核");
  const after = (await q(
    `SELECT count(*)::int total, count(*) FILTER (WHERE relrowsecurity)::int rls
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r'`))[0];
  say(`   public 表 ${after.total} 张 · RLS 已开启 ${after.rls} 张`);
  const g2 = (await q(
    `SELECT grantee, count(*)::int n FROM information_schema.role_table_grants
      WHERE table_schema='public' AND grantee IN ('anon','authenticated')
      GROUP BY grantee ORDER BY grantee`)) as { grantee: string; n: number }[];
  say(`   anon/authenticated 剩余表授权：${g2.length ? g2.map((g) => `${g.grantee} ${g.n} 项`).join(" · ") : "**0 项 ✅**"}`);
  const d2 = (await q(
    `SELECT pg_get_userbyid(d.defaclrole) AS grantor, n.nspname, d.defaclobjtype AS objtype, d.defaclacl::text AS acl
       FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace`)) as { grantor: string; nspname: string | null; objtype: string; acl: string }[];
  say("   默认授权现状：");
  for (const d of d2) say(`     ${d.grantor} · ${d.nspname ?? "(全局)"} · ${d.objtype} → ${d.acl}`);

  await pool.end();
  fs.writeFileSync("D:/Projects/University/Studio/musttoukou/.verify/rls-migrate.out.txt", out.join("\n") + "\n", "utf8");
  process.exit(0);

}


main().catch((e) => { console.error("✗", e); process.exit(1); });
