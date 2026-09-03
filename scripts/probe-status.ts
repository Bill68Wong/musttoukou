/**
 * 车辆 status 字段探针（scripts/probe-status.ts）
 * 目的：搞清 BusPosition.status（'0'/'1'）与 speed 的语义——进站/停站 vs 行驶中
 * 用法：npx tsx scripts/probe-status.ts [routeName dir]
 * ⚠️ speed 不可靠（2026-09-03 实测反馈：待发车可能残留非空速度），仅作观察
 */
import { getBusPositions } from "../src/lib/dsat/client";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const route = process.argv[2] ?? "N6";
const dir = process.argv[3] ?? "0";

async function main() {
  const res = await getBusPositions(route, dir, "poll");
  if (!res.ok || !res.data?.routeInfo) {
    console.log("❌ 失败：", res.error);
    process.exit(1);
  }
  console.log(`=== ${route} dir=${dir} 返回 ${res.data.routeInfo.length} 个站条目 ===`);
  let busCount = 0;
  res.data.routeInfo.forEach((st, idx) => {
    if (!st.busInfo?.length) return;
    for (const b of st.busInfo) {
      busCount++;
      console.log(
        `  站[${idx}]=${st.staCode}  车牌=${b.busPlate ?? "?"}  status=${b.status ?? "?"}  speed=${b.speed ?? "?"}  客流=${b.passengerFlow ?? "?"}`,
      );
    }
  });
  if (busCount === 0) console.log("  （当前无在线车辆）");
  console.log(`共 ${busCount} 辆在线`);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
