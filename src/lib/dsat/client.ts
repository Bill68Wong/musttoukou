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
import { after } from "next/server";
import { genToken } from "./token";
import { DSAT_UA } from "./ua";
import type { BusPositionsPayload, RouteDataPayload, DsatResult } from "./types";
import { guardDsatCall, logDsatCall } from "../risk";
import { RISK } from "../../config/risk";

const BASE = process.env.DSAT_BASE_URL || "https://bis.dsat.gov.mo:37812/macauweb";

export type DsatPurpose = "timer_grab" | "poll" | "sync" | "recommend";

/** 有序参数 → 请求体（token 放请求头，不进 body；参数顺序不可变） */
function buildBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/**
 * ★ v1.0.5：把记账从「本次请求内 await」改成「响应发出之后再补记」。
 *
 * 动机（线上实测倒逼）：推荐一次页面加载并发 9 次 DSAT 调用，原来每次调用结束都
 *   `await logDsatCall(...)`。函数执行在 iad1（美东）、主库在 ap-southeast-1（新加坡），
 *   单次记账往返 ≈230ms；9 次虽并发，仍把实时层整体拖长约 0.25s，
 *   而**用户真正要的只是班次数据**，记账属后台统计。
 *
 * 语义变化：
 *   · 响应不再等记账 → 用户更快拿到卡片；
 *   · `after()` 由 Vercel 的 waitUntil 托管，保证响应发出后回调仍执行完
 *     （不会像裸 fire-and-forget 那样被实例冻结吞掉）；
 *   · 记账失败依旧只 console.warn，绝不影响班次结果。
 *
 * 回退路径：非请求上下文（`db/sync-routes.ts` 这类脚本直接调用本模块）里
 *   `after()` 不可用会抛错 → 退化为直接调用。脚本进程会等 event loop 清空才退出，
 *   因此日志同样能写完。
 *
 * ⚠️ 副作用（可接受）：熔断判定读的 `dsat_call_logs` 会晚 0.2~0.3s 落库。
 *    判定逻辑是「最近 N 条是否全失败」，晚一点点不影响结论正确性。
 */
function scheduleLog(entry: Parameters<typeof logDsatCall>[0]): void {
  const run = () => {
    void logDsatCall(entry).catch(() => {});
  };
  try {
    after(run);
  } catch {
    run();
  }
}

/**
 * 统一 POST：先过风控守卫，超时即失败，结果记账
 *
 * ★ v1.0.0：`purpose='recommend'`（自动选线）两处特殊处理：
 *   ① **跳过熔断判定**（仍记账）—— 推荐一次页面加载 8~16 次调用，
 *      失败几次属正常波动，不能让它熔断计时器主流程（30 分钟静默）；
 *   ② 用 `RISK.recommend.timeoutMs`（1.5s）而非计时路径的 5s。
 */
async function dsatPost<T>(
  path: string,
  params: Record<string, string>,
  purpose: DsatPurpose,
  routeCode?: string,
): Promise<DsatResult<T>> {
  const isRecommend = purpose === "recommend";
  if (!isRecommend) {
    const verdict = await guardDsatCall();
    if (!verdict.allowed) {
      return {
        ok: false,
        error: `风控拦截（${verdict.reason}）：${verdict.detail}`,
        latencyMs: 0,
      };
    }
  }

  const body = buildBody(params);
  const token = genToken(body);
  const timeoutMs = isRecommend ? RISK.recommend.timeoutMs : RISK.timerGrab.timeoutMs;

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
        "User-Agent": DSAT_UA, // ★ 合规自证：可识别身份 + 用途（见 ./ua.ts 与 docs/数据来源合规备忘-20260914.md）
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
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
  // 记账（尽力而为）★ v1.0.5：改为响应后补记，不再阻塞本次请求
  scheduleLog({
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
): Promise<DsatResult<BusPositionsPayload>> {  return dsatPost<BusPositionsPayload>(
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
