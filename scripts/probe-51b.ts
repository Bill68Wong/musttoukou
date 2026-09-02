/** 51B 线路站序探针 */
import { getRouteData } from "../src/lib/dsat/client";

try {
  process.loadEnvFile();
} catch {
  /* ignore */
}

const KEY = ["T358", "T373/2", "C688", "C690", "C651", "C652", "C653", "C691"];

async function main() {
  for (const dir of ["0", "1"]) {
    const r = await getRouteData("51B", dir);
    const stops = r.data?.routeInfo;
    if (!r.ok || !stops?.length) {
      console.log(`51B dir=${dir}: 无数据（${r.error ?? "空"}）`);
      continue;
    }
    console.log(`51B dir=${dir}: ${stops.length} 站`);
    stops.forEach((s, i) => {
      const mark = KEY.includes(s.staCode ?? "") ? " ←★" : "";
      if (mark || i < 3 || i > stops.length - 4) {
        console.log(`  #${i + 1} ${s.staCode} ${s.staName}${mark}`);
      }
    });
    await new Promise((res) => setTimeout(res, 700));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
