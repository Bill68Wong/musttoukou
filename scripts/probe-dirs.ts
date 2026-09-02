/**
 * 方向值探针（scripts/probe-dirs.ts）
 * 1) 从线路列表接口拿每条线路的 direction 字段
 * 2) 对样例线路逐个试 dir=0/1/2/3，看哪边返回站序
 * 用法：npx tsx scripts/probe-dirs.ts
 */
import { getRouteAndCompanyList, getRouteData, getBusPositions } from "../src/lib/dsat/client";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const OUR_ROUTES = ["26", "50", "51", "51A", "26A", "56", "25B", "25BS", "102", "701X", "N6"];

async function main() {
  console.log("=== 1) 线路列表里的 direction 字段 ===");
  const list = await getRouteAndCompanyList();
  console.log("原始响应前 500 字符：", JSON.stringify(list.data).slice(0, 500));
  if (!list.ok) {
    console.error("❌ 线路列表失败：", list.error);
    process.exit(1);
  }
  const arr = Array.isArray(list.data)
    ? list.data
    : ((list.data as unknown as { routeList?: { routeName: string; direction: string }[] })
        ?.routeList ?? []);
  const rows = arr.filter(
    (r) => OUR_ROUTES.includes((r as { routeName?: string }).routeName ?? ""),
  );
  console.log(`命中 ${rows.length} 条：`);
  const byRoute = new Map<string, string[]>();
  for (const r of rows as { routeName: string; direction: string }[]) {
    byRoute.set(r.routeName, [...(byRoute.get(r.routeName) ?? []), r.direction]);
  }
  for (const [code, dirs] of byRoute) {
    console.log(`  ${code}: 方向值 = [${dirs.join(", ")}]`);
  }

  console.log("\n=== 2) 全部线路逐 dir 试探 ===");
  const summary: string[] = [];
  for (const code of OUR_ROUTES) {
    const working: string[] = [];
    for (const dir of ["0", "1", "2", "3"]) {
      const r = await getRouteData(code, dir);
      const stops = (r.data as { routeInfo?: unknown[] } | undefined)?.routeInfo;
      const n = Array.isArray(stops) ? stops.length : 0;
      if (r.ok && n > 0) working.push(`${dir}(${n}站)`);
      await new Promise((res) => setTimeout(res, 500));
    }
    summary.push(`  ${code}: 有效方向 = ${working.length ? working.join(", ") : "无"}`);
  }
  console.log(summary.join("\n"));

  console.log("\n=== 3) 实时车辆接口 dir 试探（25B 双向 / 26 循环）===");
  for (const [code, dir] of [
    ["25B", "0"],
    ["25B", "1"],
    ["26", "0"],
  ] as const) {
    const r = await getBusPositions(code, dir, "sync");
    const info = (r.data as { routeInfo?: { busInfo?: unknown[] }[] } | undefined)
      ?.routeInfo?.[0]?.busInfo;
    console.log(
      `${code} dir=${dir}: ${r.ok ? `ok, ${Array.isArray(info) ? info.length : 0} 辆在线` : `失败(${r.error ?? "?"})`}`,
      Array.isArray(info) && info.length
        ? ` 样例: ${JSON.stringify(info[0]).slice(0, 160)}`
        : "",
    );
    await new Promise((res) => setTimeout(res, 800));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
