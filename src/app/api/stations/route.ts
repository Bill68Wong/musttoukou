/**
 * GET /api/stations —— 全量**巴士站点**列表（v2.1.0 · 首页地图站点图层）
 *
 * ── 定位（产品口径 2026-09-19）─────────────────────────────────────────
 *   首页地图在**放大到阈值后**显示屏幕内的巴士站。前端一次性拉全量站点并缓存，
 *   移动/缩放时只在**本地**做视野裁剪 —— 交互过程中**零请求** ⇒ 完全不卡。
 *
 * ── 输出 ──────────────────────────────────────────────────────────────
 *   `{ stations: { code(主码), name(繁体), lat, lng }[] }`
 *   · 只取**巴士站**（`kind='bus'`）；**轻轨不标**（产品口径）。
 *   · 按【主码】去重（同站多站台 `M9/2·M9/3` 合成一个圆点）。
 *
 * ── ★ 坐标系铁律（§0-5）───────────────────────────────────────────────
 *   库内 `stations` 是 **WGS84**（DSAT 原始），高德地图要 **GCJ-02** ⇒ 在服务端
 *   用 `wgs84ToGcj02()` 转换后再返回（前端**不再**转换）。澳门适用 GCJ-02，已实测（coord.ts）。
 *
 * ── 缓存 ──────────────────────────────────────────────────────────────
 *   站点静态、低频变更 ⇒ 响应头 `s-maxage=3600`（CDN/边缘缓存 1h）。
 *
 * 幂等：只读，无副作用。
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { wgs84ToGcj02 } from "@/lib/amap/coord";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";

/** 就近部署：Supabase 新加坡池化器 → sin1；pg 需要 Node 运行时；请求期动态执行 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const maxDuration = 15;

interface StationPoint {
  /** 我们库【主码】（已去站台后缀） */
  code: string;
  /** 站名（繁体官方原文） */
  name: string;
  /** 经度（**GCJ-02**，高德地图可直接用） */
  lng: number;
  /** 纬度（GCJ-02） */
  lat: number;
}

export async function GET() {
  try {
    const pool = getPool();
    const res = await pool.query(
      `SELECT code, name_tc, lat, lng
         FROM stations
        WHERE kind = 'bus' AND lat IS NOT NULL AND lng IS NOT NULL`,
    );

    // 按【主码】去重（同站多站台合成一个点）；保留首个非空站名。
    const byMain = new Map<string, StationPoint>();
    for (const r of res.rows as Record<string, unknown>[]) {
      const rawCode = String(r.code ?? "");
      if (!rawCode) continue;
      const main = mainCodeOf(rawCode);
      const lat = Number(r.lat);
      const lng = Number(r.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const prev = byMain.get(main);
      const name = String(r.name_tc ?? "") || prev?.name || "";
      // ★ WGS84 → GCJ-02（前端直接喂高德地图，不再转换）
      const gcj = wgs84ToGcj02({ lat, lng });
      byMain.set(main, { code: main, name, lng: gcj.lng, lat: gcj.lat });
    }

    const stations = [...byMain.values()].sort((a, b) => a.code.localeCompare(b.code));
    return NextResponse.json(
      { stations },
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/stations] 失败：", msg);
    return NextResponse.json({ stations: [], error: msg.slice(0, 300) }, { status: 500 });
  }
}
