import { NextRequest, NextResponse } from "next/server";
import { freeStopsOf } from "@/lib/free-ride";

/** GET /api/free/stops?route=&dir= —— 某线路某方向的完整站序 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const route = req.nextUrl.searchParams.get("route")?.trim() ?? "";
    const dir = req.nextUrl.searchParams.get("dir")?.trim() || "0";
    if (!route) return NextResponse.json({ ok: false, error: "缺少 route" }, { status: 400 });
    const stops = await freeStopsOf(route, dir);
    return NextResponse.json({ ok: true, stops });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
