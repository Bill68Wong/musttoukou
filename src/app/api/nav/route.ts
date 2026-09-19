/**
 * GET /api/nav —— 全澳导航 JSON 接口（v1.3.0 提案 · T03）
 *
 * 输入：起点/终点的 **GCJ-02** 坐标（`fromLng,fromLat,toLng,toLat`），可带展示名与类型。
 * 输出：与旧版 `/api/recommend` **同构**的 `cards`（`RecommendCard[]`）→ T04 直接复用渲染。
 *
 * ★ 坐标系（铁律）：**传入坐标必须已是 GCJ-02**（用户 GPS 在定位层转好 / POI 来自高德）。
 *   本接口**不做** WGS84 转换（内部只在「本地图枚举的近站比较」时把 GCJ→WGS 用于比对）。
 *
 * 参数：
 *   `fromLng` `fromLat` `toLng` `toLat`（必填，GCJ-02）
 *   `fromLabel` `toLabel`（选填，展示名）· `fromKind` `toKind`（gps|poi|station|place）
 *   `fromCode` `toCode`（选填，如 place slug：home/school/hengqin/gate）
 *   `zone`（B/C|N/O|R）· `limit`（默认 5）· `nocache=1`（绕过 `transit_cache`）
 *
 * 鉴权：`/api/nav` 在 middleware 白名单（`PUBLIC_PREFIXES`，见 T04）。
 * 幂等：只写 `transit_cache`（缓存，属正常）、`dsat_call_logs`（记账，属正常）。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { planNav } from "@/lib/nav/nav-service";
import type { NavPoint, NavPointKind } from "@/lib/nav/types";
import { SCHOOL_ZONES, type SchoolZone } from "@/lib/recommend/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const maxDuration = 30;

const ZONE_VALUES = SCHOOL_ZONES.map((z) => z.value);
const KIND_VALUES: NavPointKind[] = ["gps", "poi", "station", "place"];

function numOf(sp: URLSearchParams, key: string): number | null {
  const v = Number(sp.get(key));
  return Number.isFinite(v) ? v : null;
}

function pointOf(sp: URLSearchParams, side: "from" | "to"): NavPoint | null {
  const lng = numOf(sp, `${side}Lng`);
  const lat = numOf(sp, `${side}Lat`);
  if (lng === null || lat === null) return null;
  const kindRaw = sp.get(`${side}Kind`)?.trim() ?? "";
  const kind: NavPointKind = (KIND_VALUES as string[]).includes(kindRaw) ? (kindRaw as NavPointKind) : "poi";
  return {
    kind,
    label: sp.get(`${side}Label`)?.trim() || (kind === "gps" ? "我的位置" : `${side === "from" ? "起點" : "終點"}`),
    lng,
    lat,
    code: sp.get(`${side}Code`)?.trim() || undefined,
  };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const origin = pointOf(sp, "from");
  const dest = pointOf(sp, "to");
  if (!origin || !dest) {
    return NextResponse.json(
      { ok: false, error: "缺少或非法坐标：需 fromLng/fromLat/toLng/toLat（GCJ-02）" },
      { status: 400 },
    );
  }

  const zoneParam = sp.get("zone")?.trim();
  const zone: SchoolZone | null = (ZONE_VALUES as string[]).includes(zoneParam ?? "")
    ? (zoneParam as SchoolZone)
    : null;

  const limitRaw = Number(sp.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(20, Math.trunc(limitRaw)) : 5;
  const noCache = sp.get("nocache") === "1" || sp.get("nocache") === "true";

  try {
    const r = await planNav(getPool(), { origin, dest, zone, limit, noCache });
    return NextResponse.json(
      {
        ok: true,
        fromSlug: r.fromSlug,
        toSlug: r.toSlug,
        degraded: r.degraded,
        emptyReason: r.emptyReason ?? null,
        generatedAt: new Date(r.generatedAt).toISOString(),
        count: r.cards.length,
        cards: r.cards,
        colors: r.colors,
        excluded: r.excluded,
        missed: r.missed,
        provenance: r.provenance,
        stats: r.stats,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/nav] 失败：", msg);
    return NextResponse.json({ ok: false, error: msg.slice(0, 500) }, { status: 500 });
  }
}
