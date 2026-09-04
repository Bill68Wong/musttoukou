/**
 * 线路站点同步（db/sync-routes.ts）
 * 从 DSAT getRouteData 拉取每条巴士线路两个方向的站点序列 → route_stations
 * 用途：① 计时器推导乘车方向（dsat_dir）② 车辆位置→剩余站数推算 ③「下一站」提示
 *
 * 用法：npm run db:sync-routes -- [local|cloud]
 * 说明：轻轨线路 DSAT 无此接口，route_stations 暂只同步巴士；轻轨站序后续手动补
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { getRouteData } from "../src/lib/dsat/client";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

// 实测（2026-09-02 探针）：双方向线路（51A/26A/25B/102）回程为 dir=1；
// 其余线路（26/50/51/56/25BS/701X/N6）为循环线，仅 dir=0 一套站序。
// dir=2 是 routeList 里的「循环线」标记，不是回程方向。
const BUS_DIRS = ["0", "1"];

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
  const masked = connStr.replace(/:[^:@/]+@/, ":****@");
  console.log(`目标库：${masked}`);
  const pool = new Pool({
    connectionString: connStr,
    max: 1,
    ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });

  const net = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "data", "commute-network.json"), "utf8"),
  ) as { routes: { code: string; kind: string }[] };
  const busRoutes = net.routes.filter((r) => r.kind === "bus");

  // v0.8.1 修复 E：DELETE 仅清巴士线路站序（route_stations 现混存巴士 471 行 + 轻轨 LRT 34 行，
  // 轻轨无 DSAT 接口、由 db/migrate-v071.ts 幂等补录）。原全表 DELETE 会把轻轨站序一并清掉且不会补回。
  await pool.query(
    `DELETE FROM route_stations rs
     USING routes r
     WHERE rs.route_id = r.id AND r.kind = 'bus'`,
  );

  let total = 0;
  for (const route of busRoutes) {
    const routeRes = await pool.query(
      `SELECT id FROM routes WHERE code = $1 AND kind = 'bus'`,
      [route.code],
    );
    const routeId = (routeRes.rows[0] as { id: number } | undefined)?.id;
    if (!routeId) {
      console.log(`⏭ ${route.code}：routes 表中不存在，跳过`);
      continue;
    }

    for (const dir of BUS_DIRS) {
      const r = await getRouteData(route.code, dir);
      const stops = r.data?.routeInfo;
      if (!r.ok || !stops?.length) {
        console.log(`⏭ ${route.code} dir=${dir}：无数据（${r.error ?? "空"}）`);
        continue;
      }
      let seq = 0;
      for (const st of stops) {
        if (!st.staCode) continue;
        // 站点表里没有的站自动补录（如 M268 等途经站）
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
      total += seq;
      console.log(`✅ ${route.code} dir=${dir}：${seq} 站`);
      await sleep(600); // 温柔一点：线路之间间隔 600ms
    }
  }
  console.log(`\n🎉 同步完成：${busRoutes.length} 条线路共 ${total} 条站序记录`);
  await pool.end();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(async (e) => {
  console.error("❌ 同步失败：", e.message);
  process.exit(1);
});
