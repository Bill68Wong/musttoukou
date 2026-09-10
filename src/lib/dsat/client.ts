/**
 * DSAT 客户端（src/lib/dsat/client.ts）
 * 所有对 DSAT 的请求必须经此模块：统一签名、超时、熔断、日限、记账。
 * 任何组件不得绕过本模块直接 fetch DSAT。
 *
 * 接口细节见 docs/DSAT巴士接口调研.md：
 *  - POST {base}/getRouteData.html        线路站点序列
 *  - POST {base}/routestation/bus         实时车辆
 *  - POST {base}/getRouteAndCompanyList.html  全部线路
 */
import { genToken } from "./token";
import type { BusPositionsPayload, RouteDataPayload, DsatResult } from "./types";
import { guardDsatCall, logDsatCall } from "../risk";
import { RISK } from "../../config/risk";

const BASE = process.env.DSAT_BASE_URL || "https://bis.dsat.gov.mo:37812/macauweb";

export type DsatPurpose = "timer_grab" | "poll" | "sync";

/** 有序参数 → 请求体（token 放请求头，不进 body；参数顺序不可变） */
function buildBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/** 统一 POST：先过风控守卫，超时即失败，结果记账 */
async function dsatPost<T>(
  path: string,
  params: Record<string, string>,
  purpose: DsatPurpose,
  routeCode?: string,
): Promise<DsatResult<T>> {
  const verdict = await guardDsatCall();
  if (!verdict.allowed) {
    return {
      ok: false,
      error: `风控拦截（${verdict.reason}）：${verdict.detail}`,
      latencyMs: 0,
    };
  }

  const body = buildBody(params);
  const token = genToken(body);

  const started = Date.now();
  let ok = false;
  let httpStatus: number | undefined;
  let error: string | undefined;
  let parsed: unknown;

  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        token, // ★ token 走请求头（与官方前端一致）
      },
      body,
      signal: AbortSignal.timeout(RISK.timerGrab.timeoutMs),
      cache: "no-store",
    });
    httpStatus = res.status;
    if (!res.ok) {
      error = `HTTP ${res.status}`;
    } else {
      const text = await res.text();
      try {
        const json = JSON.parse(text) as { data?: unknown; header?: string };
        if (json && typeof json === "object" && "header" in json) {
          // 信封结构：{ data: 载荷, header: 状态码 }
          if (json.header === "1200") {
            error = `接口拒绝（header 1200：token 失效或签名不匹配）`;
          } else {
            parsed = json.data;
            ok = true;
          }
        } else {
          parsed = json;
          ok = true;
        }
      } catch {
        error = `非 JSON 响应（前100字符）：${text.slice(0, 100)}`;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const latencyMs = Date.now() - started;
  // 记账（尽力而为）
  await logDsatCall({
    purpose,
    route_code: routeCode,
    ok,
    http_status: httpStatus,
    error,
    latency_ms: latencyMs,
  });

  if (!ok) return { ok: false, error, httpStatus, latencyMs };
  return { ok: true, data: parsed as T, latencyMs };
}

/**
 * 查某线路当前在线车辆（计时器打点时抓取用）
 * dir/routeType：方向值见 sync-routes.ts（双方向 0/1，循环线仅 0）；lang 固定 zh_tw 繁体
 */
export function getBusPositions(
  routeName: string,
  dir: string,
  purpose: DsatPurpose = "timer_grab",
): Promise<DsatResult<BusPositionsPayload>> {
  return dsatPost<BusPositionsPayload>(
    "/routestation/bus",
    { action: "dy", routeName, dir, lang: "zh_tw", routeType: dir, device: "web" },
    purpose,
    routeName,
  );
}

/** 查线路站点序列 */
export function getRouteData(
  routeName: string,
  dir: string,
): Promise<DsatResult<RouteDataPayload>> {
  return dsatPost<RouteDataPayload>(
    "/getRouteData.html",
    { action: "sd", routeName, dir, lang: "zh_tw", routeType: dir, device: "web" },
    "sync",
    routeName,
  );
}

/** 全部线路+公司清单 */
export function getRouteAndCompanyList(): Promise<
  DsatResult<{
    /** 公司列表（色名 Blue/Orange → 名称） */
    companyList?: { color?: string; name?: string }[];
    /** 全量线路（routeName=线路码；direction=2 为循环线标记；color=公司色名） */
    routeList?: { routeName?: string; color?: string; direction?: string; routeChange?: string }[];
  }>
> {
  return dsatPost("/getRouteAndCompanyList.html", { lang: "zh_tw", device: "web" }, "sync");
}
