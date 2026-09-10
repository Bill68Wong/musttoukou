/**
 * 全网络线路站点同步（db/sync-all-routes.ts，v0.21.0）
 * 从 DSAT getRouteAndCompanyList 拉取**全部巴士线路**（澳门全网络，约 92 条）
 * → upsert routes（公司默认色）→ 逐线拉两个方向站序 → route_stations + stations 补录
 *
 * 用途：自由记站扩展至全澳门所有线路（通勤 15 线之外的线路也能选择、实测站间时长）。
 * 用法：npm run db:sync-all -- [local|cloud]
 * 说明：幂等可重复执行；仅清/重建**巴士**站序（轻轨站序由 migrate-v071 维护，不碰）；
 *       已有线路 id 不变（plan_legs 引用安全）。
 */
import { Pool } from "pg";
import { getRouteAndCompanyList, getRouteData } from "../src/lib/dsat/client";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

/** 公司默认主题色（与现有 15 线一致；DSAT 只给 Blue/Orange 两色名） */
const COMPANY_COLOR: Record<string, { name: string; color: string }> = {
  Blue: { name: "新福利", color: "#276299" },
  Orange: { name: "澳巴", color: "#C26D32" },
};
const BUS_DIRS = ["0", "1"]; // 循环线 dir=1 无数据会自动跳过

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const target = process.argv[2] as "local" | "cloud" | undefined;
  const connStr =
    target === "cloud"
      ? process.env.DATABASE_URL
      : target === "local"
        ? process.env.DATABASE_URL_LOCAL
        : (process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL);
  if (!connStr) {
    console.error("❌ 未找到连接串：请先在 .env 配置");
    process.exit(1);
  }
  console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);

  const listRes = await getRouteAndCompanyList();
  const routeList = listRes.data?.routeList ?? [];
  if (!listRes.ok || !routeList.length) {
    console.error("❌ 无法获取 DSAT 线路列表：", listRes.error ?? "空");
    process.exit(1);
  }
  console.log(`DSAT 全量线路：${routeList.length} 条`);

  const pool = new Pool({
    connectionString: connStr,
    max: 1,
    ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });

  // 仅重建巴士站序（轻轨 LRT-* 不动）
  await pool.query(
    `DELETE FROM route_stations rs USING routes r
      WHERE rs.route_id = r.id AND r.kind = 'bus'`,
  );

  let newRoutes = 0;
  let okRoutes = 0;
  let totalStops = 0;
  const failures: string[] = [];

  for (const item of routeList) {
    const code = String(item.routeName ?? "").trim();
    if (!code) continue;
    const comp = COMPANY_COLOR[String(item.color ?? "")] ?? { name: "其他", color: "#5B6470" };

    // ① upsert 线路（UNIQUE(code, kind)；已存在的不动 id）
    const up = await pool.query(
      `INSERT INTO routes (code, kind, company, color, is_active)
       VALUES ($1, 'bus', $2, $3, true)
       ON CONFLICT (code, kind) DO UPDATE SET company = EXCLUDED.company, color = EXCLUDED.color
       RETURNING id, (xmax = 0) AS inserted`,
      [code, comp.name, comp.color],
    );
    const routeId = (up.rows[0] as { id: number; inserted: boolean }).id;
    if ((up.rows[0] as { inserted: boolean }).inserted) newRoutes++;

    // ② 逐方向拉站序
    let got = 0;
    for (const dir of BUS_DIRS) {
      const r = await getRouteData(code, dir);
      const stops = r.data?.routeInfo;
      if (!r.ok || !stops?.length) continue;
      let seq = 0;
      for (const st of stops) {
        if (!st.staCode) continue;
        await pool.query(
          `INSERT INTO stations (code, name_tc, kind, dsat_synced)
           VALUES ($1, $2, 'bus', true)
           ON CONFLICT (code) DO UPDATE SET name_tc = EXCLUDED.name_tc, dsat_synced = true`,
          [st.staCode, st.staName ?? st.staCode],
        );
        seq++;
        await pool.query(
          `INSERT INTO route_stations (route_id, dsat_dir, seq, station_code)
           VALUES ($1, $2, $3, $4)`,
          [routeId, dir, seq, st.staCode],
        );
      }
      got += seq;
      await sleep(350);
    }
    if (got > 0) {
      okRoutes++;
      totalStops += got;
      console.log(`✅ ${code}（${comp.name}）：${got} 站序`);
    } else {
      failures.push(code);
      console.log(`⏭ ${code}：无站序数据`);
    }
    await sleep(250);
  }

  const stat = await pool.query(
    `SELECT (SELECT count(*)::int FROM routes WHERE kind='bus') AS n_routes,
            (SELECT count(*)::int FROM stations WHERE kind='bus') AS n_stations,
            (SELECT count(*)::int FROM route_stations) AS n_rs`,
  );
  console.log(`\n🎉 同步完成：成功 ${okRoutes}/${routeList.length} 条（新增 ${newRoutes} 条线路）；
    站序 +${totalStops} 行${failures.length ? `；无数据线路：${failures.join(",")}` : ""}`);
  console.log(
    `库内现状：bus 线路 ${stat.rows[0].n_routes} 条 · bus 站点 ${stat.rows[0].n_stations} 个 · route_stations ${stat.rows[0].n_rs} 行`,
  );
  await pool.end();
}

main().catch((e) => {
  console.error("❌ 同步失败：", (e as Error).message);
  process.exit(1);
});
