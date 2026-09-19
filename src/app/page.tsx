/**
 * 首页 = 全澳导航搜索页（src/app/page.tsx，v1.3.0 · T04，重写）
 *
 * 新首页：**地图（上半屏）+ 搜索框（下方）**；旧首页（`HomeClient`）原样迁到 `/commute`。
 *   ① 页壳 + 骨架：SSR 直出（`NavShell` 立即渲染骨架/占位）；
 *   ② 地图占位：`NavMap` 自带 `aspect-ratio` 占位（防跳动）；
 *   ③ 地图 JS：懒加载（客户端 `loadAMap`），**不阻塞**页壳；
 *   ④ 地图失败 → 静态占位 + 重试，**搜索与出发照常**（§Q7）。
 * 路线结果在 `/nav`（点「出发」跳转）。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §2.E / §11.1
 */
import Link from "next/link";
import ComplianceBar from "@/components/nav/ComplianceBar";
import NavShell from "@/components/nav/NavShell";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";

/** 线路码 → 主题色（供搜索结果的「线路候选」行渲染 `.route-stack`，§11.6） */
async function loadRouteColors(): Promise<Record<string, string>> {
  try {
    const res = await getPool().query(`SELECT code, color FROM routes WHERE color IS NOT NULL`);
    const m: Record<string, string> = {};
    for (const r of res.rows as { code: string; color: string }[]) m[r.code] = r.color;
    return m;
  } catch {
    return {};
  }
}

export default async function Home() {
  // ★ JS Key 由服务端以 prop 传入（JS Key 本身可公开；安全密钥只在 /_AMapService 代理里）
  const jsKey = (process.env.AMAP_JS_KEY ?? "").trim();
  const colors = await loadRouteColors();

  return (
    <main className="page nav-home">
      <header className="nav-home__head">
        <h1 className="h-title">澳门出行</h1>
        <Link href="/commute" className="nav-home__legacy link-hit t-label">
          通勤计时（旧版）›
        </Link>
      </header>

      <NavShell jsKey={jsKey} colors={colors} />

      <ComplianceBar />
    </main>
  );
}
