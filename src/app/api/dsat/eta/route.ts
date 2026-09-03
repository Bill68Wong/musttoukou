import { NextRequest, NextResponse } from "next/server";
import { queryEta } from "@/lib/dsat/eta";

/**
 * GET /api/dsat/eta?station=T358&routes=26,51A&dir=0&dest=C688
 * 实时车距（薄封装，核心逻辑在 src/lib/dsat/eta.ts 与自动快照共用）
 * 30s 缓存已内置于 queryEta（按 站|线路|dir|dest 聚合）
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const station = sp.get("station")?.trim() ?? "";
  const routesParam = sp.get("routes")?.trim() ?? "";
  const dir = sp.get("dir")?.trim() || "0";
  const dest = sp.get("dest")?.trim() || "";

  if (!station || !routesParam) {
    return NextResponse.json({ error: "缺少 station 或 routes 参数" }, { status: 400 });
  }
  const routes = routesParam
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 3); // 最多 3 条
  if (routes.length === 0) {
    return NextResponse.json({ error: "routes 参数为空" }, { status: 400 });
  }

  const data = await queryEta(station, routes, dir, dest);
  return NextResponse.json(data);
}
