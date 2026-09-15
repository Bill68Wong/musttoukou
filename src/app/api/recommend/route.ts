/**
 * GET /api/recommend —— 自动选线 JSON 接口（v1.0.0）
 *
 * 用途：① `/recommend` 页的「刷新」按钮（带 force=1 穿透 10s 缓存）
 *      ② 只读探针 / 性能压测（拿结构化 stats 核对桶数与 DSAT 调用数）
 *
 * 参数：`from` `to`（place slug：home / school / hengqin / gate）
 *      `zone`（B/C | N/O | R，默认 N/O）· `limit`（默认 5）· `force=1`（绕过缓存）
 *
 * ⚠️ `preferredRegion = "sin1"`：与 Supabase 主库（ap-southeast-1 新加坡）**同区**，
 *    把每次 DB 往返的跨区 RTT 抹掉 —— 这是「2 秒出 5 卡」的关键一环（见计划 §六 #8）。
 *
 * 鉴权：middleware 口令门覆盖本路径（非白名单）→ 需 `mx_auth` cookie。
 * 幂等只读：本接口不写任何表（DSAT 调用会记 `dsat_call_logs`，属正常记账）。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { recommend } from "@/lib/recommend/service";
import { DEFAULT_ZONE, SCHOOL_ZONES, type SchoolZone } from "@/lib/recommend/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
/** 预算 0.5~1.5s；留足余量（Hobby 上限 60s） */
export const maxDuration = 30;

const ZONE_VALUES = SCHOOL_ZONES.map((z) => z.value);

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from")?.trim();
  const to = sp.get("to")?.trim();
  if (!from || !to) {
    return NextResponse.json({ error: "缺少参数 from / to" }, { status: 400 });
  }

  const zoneParam = sp.get("zone")?.trim();
  const zone: SchoolZone = (ZONE_VALUES as string[]).includes(zoneParam ?? "")
    ? (zoneParam as SchoolZone)
    : DEFAULT_ZONE;

  const limitRaw = Number(sp.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(20, Math.trunc(limitRaw)) : 5;
  const force = sp.get("force") === "1" || sp.get("force") === "true";

  try {
    const r = await recommend(getPool(), { fromSlug: from, toSlug: to, zone, limit, force });
    return NextResponse.json(
      {
        ok: true,
        from: r.fromSlug,
        to: r.toSlug,
        zone: r.zone,
        cached: r.cached,
        generatedAt: new Date(r.generatedAt).toISOString(),
        count: r.cards.length,
        cards: r.cards,
        colors: r.colors,
        excluded: r.excluded,
        stats: r.stats,
      },
      // 结果本身有 10s 缓存，但**响应必须不缓存**（刷新语义由 force 控制）
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/recommend] 失败：", msg);
    return NextResponse.json({ ok: false, error: msg.slice(0, 500) }, { status: 500 });
  }
}
