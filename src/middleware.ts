import { NextRequest, NextResponse } from "next/server";

/**
 * 口令门中间件：校验 HttpOnly cookie
 * cookie 值即口令本身（HttpOnly 防止 JS 读取，HTTPS 传输，仅发往本站）
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 放行：登录页、登录接口、静态资源、定时任务
  if (
    pathname === "/login" ||
    pathname === "/api/auth" ||
    // v0.25.0：Vercel Cron 触发派生数据重算，走自身 Bearer 鉴权（不受口令门约束，
    // 否则 cron 请求会被这里拦成 401 → 重算静默失败）
    pathname === "/api/cron/rebuild" ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/icon.svg"
  ) {
    return NextResponse.next();
  }

  const password = process.env.ACCESS_PASSWORD;
  // 未配置口令 = 不启用口令门（开发模式）
  if (!password) return NextResponse.next();

  const cookie = req.cookies.get("mx_auth")?.value;
  if (cookie === password) return NextResponse.next();

  // API 返回 401，页面跳转登录
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
