import { NextRequest, NextResponse } from "next/server";

/**
 * 口令门中间件 · ★ v1.1.10：改为**分级保护**（用户 2026-09-17 口径）
 *
 * ── 为什么要改 ────────────────────────────────────────────────────────
 * 用户的需求拆成两句：
 *   · 「网站是做给别人用的，当然要公开」→ 推荐功能（首页 / 推荐 / 详情 / 合规）**任何人都能用**
 *   · 「开发者模式只有我能开，数据只有我能看」→ 记录 / 统计 / 自由记站 / 计时 / 开发者页**要口令**
 * 旧实现是一刀切（配了口令就全站锁、没配就全站开），两头都不对 ——
 * 实测线上 `ACCESS_PASSWORD` 未配置 ⇒ 守卫整体失效 ⇒ **全站连数据页都敞开**。
 *
 * ── 新策略 ───────────────────────────────────────────────────────────
 * **默认拒绝（fail-closed）**：只有明确列在白名单里的路径才公开，其余一律要口令。
 *   这样以后新增页面/接口**不会因为忘记加名单而意外裸露**（比「默认公开」安全得多）。
 *
 * ⚠️ `ACCESS_PASSWORD` 未配置时：**生产环境同样拒绝受保护区**（安全失败方向），
 *    开发环境放行（本地调试方便）。这样即使忘了配环境变量，也不会把数据敞开。
 *
 * ⚠️ cookie 值即口令本身（HttpOnly 防 JS 读取、HTTPS 传输、仅发往本站）。
 */

/** ① 完全公开的**页面**（精确匹配，不含子路径）—— 别人用的推荐功能 + 合规说明 + 登录页 */
const PUBLIC_PAGES = new Set([
  "/",
  "/recommend",
  "/card",
  "/about",
  "/login",
  // ★ v1.3.0 全澳导航（公众功能，R-10）—— 不加则路人用不了（fail-closed）
  "/nav", // 导航结果页
  "/nav/detail", // 导航详情页
  "/commute", // 旧首页（原 `/` 的 HomeClient 原样迁此）
]);

/** ② 完全公开的**接口 / 静态资源**（前缀匹配） */
const PUBLIC_PREFIXES = [
  "/api/auth", // 登录接口本身
  "/api/recommend", // 推荐卡片数据（公开浏览的核心）
  "/api/card", // 详情页数据（公开浏览的核心）
  "/api/poi/suggest", // ★ 全澳导航·POI 搜索建议（公众可搜；设计 §2.E / R-10）
  "/api/nav", // ★ 全澳导航·路线结果（公众可用；设计 §2.E）
  "/api/stations", // ★ v2.1.0 首页地图·全量巴士站点（公众图层数据）
  "/api/station/eta", // ★ v2.1.0 首页地图·站点实时报站（信息卡）
  "/_AMapService", // ★ 高德 JS API 安全代理（浏览器直连；密钥不下发前端，见 §2.D）
  "/api/amap-service", // ↑ 同一处理器的真实路由（`/_AMapService` 经 rewrite 指向它）
  "/_next", // 构建产物
];

/** ③ 完全公开的**精确路径**（静态文件） */
const PUBLIC_FILES = new Set(["/favicon.ico", "/manifest.webmanifest", "/icon.svg"]);

/** ④ 由自身 Bearer 鉴权、不受口令门约束（Vercel Cron 重算派生数据） */
const SELF_AUTHED = new Set(["/api/cron/rebuild"]);

/** 该路径是否公开？ */
function isPublic(pathname: string): boolean {
  if (PUBLIC_FILES.has(pathname) || SELF_AUTHED.has(pathname)) return true;
  if (PUBLIC_PAGES.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 公开区直接放行
  if (isPublic(pathname)) return NextResponse.next();

  const password = process.env.ACCESS_PASSWORD;
  const cookie = req.cookies.get("mx_auth")?.value;
  const authed = !!password && cookie === password;

  if (authed) return NextResponse.next();

  // ── 未授权 ──────────────────────────────────────────────────────
  // ⚠️ fail-closed：口令未配置时，生产环境**也拒绝**受保护区（而不是放行）。
  //    开发环境（NODE_ENV!=='production'）放行，方便本地调试。
  const devOpen = !password && process.env.NODE_ENV !== "production";
  if (devOpen) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: password ? "未登录" : "服务未配置访问口令（ACCESS_PASSWORD）" },
      { status: 401 },
    );
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
