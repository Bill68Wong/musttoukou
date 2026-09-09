import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { freeDirsOf } from "@/lib/free-ride";
import { sortRouteOptions } from "@/lib/timer-flow";

/** GET /api/free/options —— 全部可乘线路（bus + lrt，含颜色与方向） */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const pool = getPool();
    const res = await pool.query(
      `SELECT code, kind, color FROM routes WHERE is_active ORDER BY kind, code`,
    );
    const routes = res.rows as { code: string; kind: string; color: string | null }[];
    const out: {
      code: string;
      kind: string;
      color: string | null;
      dirs: { dir: string; label: string }[];
    }[] = [];
    for (const r of routes) {
      out.push({ code: r.code, kind: r.kind, color: r.color, dirs: await freeDirsOf(r.code, r.kind) });
    }
    // 展示顺序统一：轻轨在前 + 巴士自然排序（与全站一致）
    const order = sortRouteOptions(out.map((r) => r.code));
    out.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
    return NextResponse.json({ ok: true, routes: out });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
