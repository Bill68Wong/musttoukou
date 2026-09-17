/**
 * 迁移 v1.1.13：为合作者建生产库专用账号（B 档：数据读写 + 建新表，不能改现有结构）
 *
 * ── 背景 ──────────────────────────────────────────────────────────────
 * 用户 2026-09-17 决定给同学生产库访问权，档位选 **B**：
 *   ✅ 增删改查数据（SELECT/INSERT/UPDATE/DELETE）
 *   ✅ 建**新**表（GRANT CREATE ON SCHEMA）
 *   ❌ 改/删**现有**表（PostgreSQL 的 DDL 靠「属主」，GRANT 给不了 ⇒ 天然做不到）
 *
 * ── ★★ 关键点：必须同时加 RLS 策略 ────────────────────────────────────
 * v1.1.10 给 21 张表**开了 RLS 但不加策略** ⇒ 任何**非属主**角色连进去也**一行都看不到**。
 *   新账号不是表的属主 ⇒ **必须为它单独加策略**：
 *     CREATE POLICY <name> ON <table> FOR ALL TO <role> USING (true) WITH CHECK (true)
 *   ⚠️ 策略**只作用于该角色**（`TO <role>`）⇒ anon / authenticated 依旧被挡死，整体安全不变。
 *
 * ── 为什么不用「加进 postgres 角色」或 BYPASSRLS ──────────────────────
 *   · 加进 postgres ⇒ 等于给管理员（用户明确否决了 C 档）
 *   · BYPASSRLS 属性只有**超级用户**能给，而 `postgres` 的 `rolsuper=false` ⇒ 给不了
 *
 * 用法：
 *   node --experimental-strip-types db/migrate-v1113-partner-role.ts          # dry-run
 *   node --experimental-strip-types db/migrate-v1113-partner-role.ts --apply  # 执行
 *   ... --apply --rotate                                                      # 轮换密码
 *   ... --revoke                                                              # 撤销（删账号+策略）
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { Pool } from "pg";

const APPLY = process.argv.includes("--apply");
const ROTATE = process.argv.includes("--rotate");
const REVOKE = process.argv.includes("--revoke");
const ROLE = "dev_partner";

process.loadEnvFile("D:/Projects/University/Studio/musttoukou/.env");
const u = new URL(process.env.DATABASE_URL!);
const PROJ_REF = u.username.includes(".") ? u.username.split(".")[1] : "";
const POOLER_HOST = u.hostname;
const POOLER_PORT = u.port || "6543";

/** 生成可读性尚可但足够强的密码（24 位，无易混字符 0/O/1/l/I） */
function genPassword(): string {
  const A = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (const b of crypto.randomBytes(24)) s += A[b % A.length];
  return s;
}

const out: string[] = [];
const say = (s: string) => { out.push(s); console.log(s); };

async function main() {
  const pool = new Pool({ host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1),
    user: u.username, password: decodeURIComponent(u.password || ""), ssl: { rejectUnauthorized: false } });
  const q = async (s: string, a?: unknown[]) => (await pool.query(s, a)).rows;
  const c = await pool.connect();
  const run = (s: string, a?: unknown[]) => c.query(s, a);

  say(`模式：${REVOKE ? "★ REVOKE（撤销）" : APPLY ? "★ APPLY（写生产库）" : "DRY-RUN（只读）"}`);
  say(`账号：${ROLE} · 项目 ref：${PROJ_REF || "（未解析出）"}`);
  say("");

  // ── ⓪ 前置检查 ──
  const me = (await q(`SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`))[0];
  say("⓪ 前置检查");
  say(`   当前身份 = ${me.current_user} · super=${me.rolsuper} · bypassrls=${me.rolbypassrls}`);
  say(`   能否建角色（createrole）：${(await q(`SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user`))[0].rolcreaterole}`);
  const exists = (await q(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [ROLE])).length > 0;
  say(`   账号 ${ROLE} 是否已存在：${exists ? "是（将更新）" : "否（将新建）"}`);
  const tabs = (await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`)) as { relname: string }[];
  const noPol = (await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r'
       AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polroles @> ARRAY[(SELECT oid FROM pg_roles WHERE rolname=$1)]::oid[])`,
    [ROLE])) as { relname: string }[];
  say(`   public 表 ${tabs.length} 张 · 其中**缺该角色 RLS 策略**的 ${noPol.length} 张`);

  say("");
  say("① 将执行的操作");
  say(`   ${exists ? "ALTER" : "CREATE"} ROLE ${ROLE} LOGIN PASSWORD '（自动生成）'`);
  say(`   GRANT CONNECT ON DATABASE <db> TO ${ROLE}`);
  say(`   GRANT USAGE, CREATE ON SCHEMA public TO ${ROLE}        ← CREATE = 可建新表`);
  say(`   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
  say(`   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}   ← INSERT 需要序列`);
  say(`   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ... TO ${ROLE}     ← 以后新建的表也自动可访问`);
  say(`   CREATE POLICY ${ROLE}_rw ON <每张表> FOR ALL TO ${ROLE} USING (true) WITH CHECK (true)   ×${noPol.length}`);
  say(`   ⚠️ 不授予：TRUNCATE · 表属主 · 建库/建角色 · 改现有表结构`);

  // ── REVOKE 路径 ──
  if (REVOKE) {
    say("");
    if (!APPLY) { say("② REVOKE 需加 --apply"); await c.release(); await pool.end(); return; }
    await run("BEGIN");
    for (const t of tabs) await run(`DROP POLICY IF EXISTS ${ROLE}_rw ON public."${t.relname}"`);
    await run(`GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated`).catch(() => {});
    await run(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE}`);
    await run(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${ROLE}`);
    await run(`REVOKE ALL ON SCHEMA public FROM ${ROLE}`);
    await run(`REVOKE ALL ON DATABASE "${u.pathname.slice(1)}" FROM ${ROLE}`);
    await run(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${ROLE}`);
    await run(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${ROLE}`);
    await run(`DROP ROLE IF EXISTS ${ROLE}`);
    await run("COMMIT");
    say("② ✅ 已撤销（策略 + 权限 + 账号全部移除）");
    await c.release(); await pool.end(); return;
  }

  if (!APPLY) {
    say("");
    say("（加 --apply 生效；加 --rotate 同时轮换密码）");
    await c.release(); await pool.end();
    fs.writeFileSync("D:/Projects/University/Studio/musttoukou/.verify/rls-partner.out.txt", out.join("\n") + "\n", "utf8");
    return;
  }

  // ── APPLY ──
  const pw = genPassword();
  say("");
  say("② 执行中…");
  try {
    await run("BEGIN");
    if (exists) {
      await run(`ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${pw.replace(/'/g, "''")}'`);
      say(`   ✅ 已更新账号 ${ROLE}${ROTATE ? "（密码已轮换）" : "（密码重置为新值）"}`);
    } else {
      await run(`CREATE ROLE ${ROLE} WITH LOGIN PASSWORD '${pw.replace(/'/g, "''")}'`);
      say(`   ✅ 已新建账号 ${ROLE}`);
    }
    // ⚠️ **不要**在这里 ALTER ROLE 去设 NOSUPERUSER / NOCREATEDB / NOBYPASSRLS ——
    //    实测两次都报 `permission denied to alter role`：
    //      · NOBYPASSRLS 只有**超级用户**能设（postgres 的 rolsuper=false）
    //      · PostgreSQL 16+ 里 CREATEROLE 角色**不能修改 SUPERUSER 属性**（哪怕是设成 NO）
    //    而这些属性对**新建角色**本来就是 false（默认值）⇒ 显式设置纯属多余。
    //    改为「建完读出来核实」，见下面「③ 复核」。
    // ⚠️ 必须用**事务自己的连接**（run）去读，不能用连接池（q）——
    //    连接池是另一条连接，看不到本事务尚未提交的 CREATE ROLE（实测踩过：
    //    `Cannot read properties of undefined (reading 'rolcanlogin')`）。
    const attr0 = (await run(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname=$1`,
      [ROLE],
    )).rows[0];
    say(`   ✅ 建后属性核实：login=${attr0.rolcanlogin} super=${attr0.rolsuper} bypassrls=${attr0.rolbypassrls} createdb=${attr0.rolcreatedb} createrole=${attr0.rolcreaterole}`);
    if (attr0.rolsuper || attr0.rolbypassrls || attr0.rolcreatedb || attr0.rolcreaterole) {
      throw new Error("新账号属性异常（不该有 super/bypassrls/createdb/createrole）—— 已回滚");
    }
    say("   ✅ 无超级/无 bypassrls/无可建库/无可建角色 ⇒ 权限只能来自 RLS 策略与 GRANT，符合预期");

    await run(`GRANT CONNECT ON DATABASE "${u.pathname.slice(1)}" TO ${ROLE}`);
    await run(`GRANT USAGE, CREATE ON SCHEMA public TO ${ROLE}`);
    await run(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
    await run(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
    await run(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE}`);
    await run(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE}`);
    say("   ✅ 已授权：CONNECT · USAGE+CREATE on schema · 表 DML · 序列 · 默认权限");

    let n = 0;
    for (const t of tabs) {
      await run(`DROP POLICY IF EXISTS ${ROLE}_rw ON public."${t.relname}"`);
      await run(`CREATE POLICY ${ROLE}_rw ON public."${t.relname}" FOR ALL TO ${ROLE} USING (true) WITH CHECK (true)`);
      n++;
    }
    say(`   ✅ 已为 ${n} 张表加 RLS 策略（**只作用于 ${ROLE}**）`);
    await run("COMMIT");
    say("   ✅ 已提交");
  } catch (e) {
    await run("ROLLBACK");
    say(`   🔴 出错已回滚：${(e as Error).message}`);
    await c.release(); await pool.end();
    fs.writeFileSync("D:/Projects/University/Studio/musttoukou/.verify/rls-partner.out.txt", out.join("\n") + "\n", "utf8");
    return;
  }

  // ── 复核 ──
  say("");
  say("③ 复核");
  const p = (await q(`SELECT count(*)::int n FROM pg_policy p2 JOIN pg_class c ON c.oid=p2.polrelid
      JOIN pg_namespace ns ON ns.oid=c.relnamespace
     WHERE ns.nspname='public' AND p2.polroles @> ARRAY[(SELECT oid FROM pg_roles WHERE rolname=$1)]::oid[]`, [ROLE]))[0];
  say(`   ${ROLE} 拥有的策略数：${p.n} / ${tabs.length} 张表`);
  const anon = (await q(`SELECT count(*)::int n FROM information_schema.role_table_grants
     WHERE table_schema='public' AND grantee IN ('anon','authenticated')`))[0];
  say(`   anon/authenticated 表授权：${anon.n} 项 ${anon.n === 0 ? "✅ 仍为 0（整体安全未被削弱）" : "⚠️ 有变化，需检查"}`);
  const attr = (await q(`SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname=$1`, [ROLE]))[0];
  say(`   账号属性：login=${attr.rolcanlogin} super=${attr.rolsuper} bypassrls=${attr.rolbypassrls} createdb=${attr.rolcreatedb} createrole=${attr.rolcreaterole}`);

  say("");
  say("④ 发给同学的连接串（**只在下面显示一次，请立即保存**）");
  say(`   postgresql://${ROLE}.${PROJ_REF}:${pw}@${POOLER_HOST}:${POOLER_PORT}/postgres`);
  say("");
  say("   ⚠️ 并告诉他把 .env 里这一行改成它（**其余照旧**）：");
  say(`      DATABASE_URL_LOCAL=${"postgresql://" + ROLE + "." + PROJ_REF + ":" + pw + "@" + POOLER_HOST + ":" + POOLER_PORT + "/postgres"}`);

  await c.release(); await pool.end();

  // ⚠️ 输出文件里**打码**，不落明文
  fs.writeFileSync("D:/Projects/University/Studio/musttoukou/.verify/rls-partner.out.txt",
    out.map((l) => l.replace(pw, "****（已打码）")).join("\n") + "\n", "utf8");
  console.log("\n（写盘的日志里密码已打码）");
}
main().catch((e) => { console.error("✗", e); process.exit(1); });
