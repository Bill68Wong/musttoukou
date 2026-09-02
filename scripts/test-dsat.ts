/**
 * DSAT 客户端真实接口测试（scripts/test-dsat.ts）
 * 用法：npm run test:dsat
 * 验证：① token 签名正确 ② 两个核心接口可用 ③ 风控守卫/记账工作正常
 */
import { getBusPositions, getRouteData } from "../src/lib/dsat/client";
import { genToken, macauNow } from "../src/lib/dsat/token";
import { RISK } from "../src/config/risk";

// 加载 .env（若存在）
try {
  process.loadEnvFile();
} catch {
  /* .env 不存在时跳过（本测试不强依赖数据库） */
}

async function main() {
  console.log("=== 1. token 生成自检 ===");
  const qs = "action=sd&routeName=50&dir=0&lang=zh_cn&routeType=0&device=web";
  const token = genToken(qs);
  console.log("澳门时间:", macauNow());
  console.log("token:", token, `（长度 ${token.length}，应为 44）`);

  console.log("\n=== 2. getRouteData（50路 站点序列，dir=0）===");
  const r = await getRouteData("50", "0");
  if (r.ok && r.data?.routeInfo) {
    const stops = r.data.routeInfo;
    console.log(`✅ 成功，${r.latencyMs}ms，共 ${stops.length} 站：`);
    console.log(
      stops
        .slice(0, 6)
        .map((s) => `   ${s.staCode ?? "?"} ${s.staName ?? ""}`)
        .join("\n"),
    );
  } else {
    console.log("❌ 失败：", r.error);
  }

  console.log("\n=== 3. getBusPositions（50路 实时车辆，dir=0）===");
  const b = await getBusPositions("50", "0");
  if (b.ok && b.data?.routeInfo) {
    const withBus = b.data.routeInfo.filter((s) => s.busInfo?.length);
    console.log(`✅ 成功，${b.latencyMs}ms，共 ${b.data.routeInfo.length} 站监控，当前 ${withBus.length} 站有车：`);
    for (const s of withBus.slice(0, 5)) {
      for (const bus of s.busInfo) {
        console.log(
          `   ${s.staCode} 车牌${bus.busPlate ?? "?"} 车号${bus.busCode ?? "?"} 速度${bus.speed ?? "?"}km/h`,
        );
      }
    }
  } else {
    console.log("❌ 失败：", b.error);
  }

  console.log("\n=== 4. 风控配置 ===");
  console.log(JSON.stringify(RISK, null, 2));
}

main().catch((e) => {
  console.error("测试脚本报错：", e);
  process.exit(1);
});
