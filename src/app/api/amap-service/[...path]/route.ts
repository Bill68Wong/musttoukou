/**
 * 高德 JS API 安全代理（src/app/api/amap-service/[...path]/route.ts，v1.3.0 · T04）
 *
 * ── 公开 URL 是 `/_AMapService/*` ─────────────────────────────────────
 *   Next App Router **不路由「下划线开头」的文件夹**（私有文件夹），故处理器放在
 *   `/api/amap-service`，由 `next.config.ts` 的 rewrite 把 `/_AMapService/:path*`
 *   映射过来（见该文件注释）。
 *
 * ── 为什么需要它（设计 §2.D）──────────────────────────────────────────
 *   高德 JS API 2.0 的安全密钥（`jscode`）**绝不能下发到浏览器**。做法：
 *     · 浏览器设 `window._AMapSecurityConfig = { serviceHost: '<origin>/_AMapService' }`
 *       （**只含 host，不含密钥**）；
 *     · 高德 JS 的所有服务请求改打本代理；本代理在服务端**追加 `key` + `jscode`** 后转发；
 *     · 返回 JSON 原样回传。
 *
 * ── 安全 ──────────────────────────────────────────────────────────────
 *   · **路径白名单**：只允许 `/v3/*`、`/v5/*`（高德 Web 服务前缀），其余 404；
 *   · **来源校验（轻量）**：浏览器请求须带同源 `Origin`/`Referer`（无头服务端调用一律拒）；
 *   · 只读转发（不缓存、不落库）。
 *
 * ⚠️ 缺 `AMAP_JS_SECURITY_CODE` 时仍可转发（仅带 key）——地图可能报
 *    `INVALID_USER_SCODE`（待产品补安全密钥）；此时**不影响**其余功能（地图是显示层增强）。
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const maxDuration = 15;

const UPSTREAM = "https://restapi.amap.com";
/** 允许转发的路径前缀（高德 Web 服务） */
const ALLOWED_PREFIXES = ["/v3/", "/v5/"];
const TIMEOUT_MS = 8_000;

function jsonResp(body: unknown, status = 200): NextResponse {
  return new NextResponse(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }): Promise<NextResponse> {
  const { path } = await ctx.params;
  const seg = `/${(path ?? []).join("/")}`;
  if (!ALLOWED_PREFIXES.some((p) => `${seg}/`.startsWith(p))) {
    return jsonResp({ status: "0", info: "path not allowed", infocode: "NA" }, 404);
  }

  // ── 来源校验（轻量）：浏览器请求须带同源 Origin/Referer ──
  const host = req.headers.get("host") ?? "";
  const origin = req.headers.get("origin") ?? "";
  const referer = req.headers.get("referer") ?? "";
  const sameOrigin =
    (!origin && !referer) || (!!host && (origin.includes(host) || referer.includes(host)));
  if (!sameOrigin) {
    return jsonResp({ status: "0", info: "forbidden", infocode: "NA" }, 403);
  }

  const key = (process.env.AMAP_JS_KEY ?? "").trim();
  if (!key) {
    return jsonResp({ status: "0", info: "AMAP_JS_KEY 未配置", infocode: "10005" }, 200);
  }

  const url = new URL(req.url);
  const target = new URL(`${UPSTREAM}${seg}`);
  url.searchParams.forEach((v, k) => {
    if (k === "jscode" || k === "key") return; // 由服务端重新注入，防止前端伪造
    target.searchParams.set(k, v);
  });
  target.searchParams.set("key", key);
  const jscode = (process.env.AMAP_JS_SECURITY_CODE ?? "").trim();
  if (jscode) target.searchParams.set("jscode", jscode);

  try {
    const res = await fetch(target, {
      method: req.method === "POST" ? "POST" : "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    return jsonResp(text, res.status);
  } catch (e) {
    return jsonResp({ status: "0", info: `proxy error: ${(e as Error).message}`, infocode: "NA" }, 200);
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  return handle(req, ctx);
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  return handle(req, ctx);
}
