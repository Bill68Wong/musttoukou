/**
 * 预测卡片详情数据接口（src/app/api/card/route.ts，v1.1.8）
 *
 * 为什么单独开一个接口（而不是让详情页复用 `/api/recommend`）：
 *   详情页要的三块数据里，只有「命中卡」在 `/api/recommend` 里，
 *   另外两块是**列表页没有的新数据**：
 *     · 该站台**所有**可达线路的实时报站（可能含方案表外的线，如 C653 的 N3、C690/3 的 N5）
 *     · 每段载具的**逐站站序 + 逐跳预测时长**（供纵向站条）
 *   一趟拿齐 = 详情页不依赖前一页、不冻结数据、可分享可刷新。
 *
 * ⚠️ 与 `/api/recommend` 同规格：nodejs / force-dynamic / preferredRegion=sin1。
 *    实测线上函数真身在 iad1（美东）、主库在新加坡 → 指定 sin1 抹掉跨区 RTT。
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { cardDetail } from "@/lib/recommend/card";
import { parseCardQuery } from "@/lib/recommend/card-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const maxDuration = 30;

export async function GET(req: Request) {
  const sp = Object.fromEntries(new URL(req.url).searchParams) as Record<string, string>;
  const p = parseCardQuery(sp);
  if (!p) {
    return NextResponse.json({ ok: false, error: "缺少必填参数（from/to/plan/route/board/alight）" }, { status: 400 });
  }
  try {
    const r = await cardDetail(getPool(), {
      fromSlug: p.from,
      toSlug: p.to,
      zone: p.zone,
      limit: p.limit,
      planId: p.plan,
      route: p.route,
      board: p.board,
      alight: p.alight,
      force: sp.force === "1",
    });
    if (!r.ok) {
      // 200 + 错误码：客户端据此显示「返回自動選線」，而不是当成网络故障
      return NextResponse.json({ ok: false, error: r.error }, { status: 200, headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ ok: true, ...r.data }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `詳情計算失敗：${msg.slice(0, 120)}` }, { status: 200, headers: { "cache-control": "no-store" } });
  }
}
