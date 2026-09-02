/**
 * 语言参数探针：getRouteData 用不同 lang 值请求，看站名是简体还是繁体
 */
import { getRouteData } from "../src/lib/dsat/client";

try {
  process.loadEnvFile();
} catch {
  /* ignore */
}

async function main() {
  for (const lang of ["zh_tw", "zh_hk", "zh", "zh_cn"]) {
    const r = await getRouteData("50", "0");
    // 注意：getRouteData 固定 zh_cn，这里手动改不了 —— 直接打印对比即可
    void r;
  }
  // 直接绕过：手写请求不同 lang 值
  const { genToken } = await import("../src/lib/dsat/token");
  const BASE =
    process.env.DSAT_BASE_URL || "https://bis.dsat.gov.mo:37812/macauweb";
  for (const lang of ["zh_tw", "zh_hk", "zh", "zh_cn"]) {
    const params = `action=sd&routeName=50&dir=0&lang=${lang}&routeType=0&device=web`;
    const token = genToken(params);
    try {
      const res = await fetch(`${BASE}/getRouteData.html`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          token,
        },
        body: params,
        signal: AbortSignal.timeout(8000),
      });
      const json = (await res.json()) as {
        data?: { routeInfo?: { staName?: string }[] };
        header?: string;
      };
      const stops = json.data?.routeInfo ?? [];
      const sample = stops
        .slice(0, 4)
        .map((s) => s.staName)
        .join(" / ");
      console.log(`lang=${lang}: ${stops.length} 站 → ${sample}`);
    } catch (e) {
      console.log(`lang=${lang}: 失败 ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
