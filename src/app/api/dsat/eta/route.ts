import { NextRequest, NextResponse } from "next/server";
import { queryEta } from "@/lib/dsat/eta";

/** 就近部署：Supabase 新加坡池化器 → sin1 */
export const preferredRegion = "sin1";

/**
 * GET /api/dsat/eta?station=T358&routes=26,51A&dir=0&dest=C688[&force=1]
 * 实时车距（薄封装，核心逻辑在 src/lib/dsat/eta.ts 与自动快照共用）
 * 5s 缓存已内置于 queryEta（按 站|线路|dir|dest 聚合；v0.8.1 10s → 5s）
 * force=1：系统打点（depart/wait_start/alight）绕过缓存直查并回写；手动刷新不带
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const station = sp.get("station")?.trim() ?? "";
  const routesParam = sp.get("routes")?.trim() ?? "";
  const dir = sp.get("dir")?.trim() || "0";
  const dest = sp.get("dest")?.trim() || "";
  const force = sp.get("force") === "1";

  if (!station || !routesParam) {
    return NextResponse.json({ error: "缺少 station 或 routes 参数" }, { status: 400 });
  }
  const routes = routesParam
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 6); // 最多 6 条（与 queryEta/fleet-snapshot 上限一致；横琴 6 线方案不再截断）
  if (routes.length === 0) {
    return NextResponse.json({ error: "routes 参数为空" }, { status: 400 });
  }

  const data = await queryEta(station, routes, dir, dest, force);
  return NextResponse.json(data);
}
