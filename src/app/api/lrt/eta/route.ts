/**
 * GET /api/lrt/eta —— 轻轨时刻表报站（本地算，v0.15.0 · v1.0.0 起为薄封装）
 * 参数：station(本库站码 LRT-xxx) & route(本库线路码 LRT-氹仔线…) & dest(目的地站码，可省)
 *       dir(本段方向 '0'|'1'，dest 可推导时省略)
 * 逻辑：核心已抽取到 `src/lib/lrt/next-departures.ts`（v1.0.0 自动选线复用同一实现，
 *       **口径零变更**：返回前 2 班、空态枚举、班别判定全部保持原样）。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { queryLrtDepartures } from "@/lib/lrt/next-departures";

export const preferredRegion = "sin1";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const res = await queryLrtDepartures(getPool(), {
    station: sp.get("station") ?? "",
    route: sp.get("route") ?? "",
    dest: sp.get("dest"),
    dir: sp.get("dir"),
    take: 2,
  });

  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error }, { status: res.status });
  }
  return NextResponse.json(res);
}
