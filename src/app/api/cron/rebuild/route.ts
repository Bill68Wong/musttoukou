/**
 * GET/POST /api/cron/rebuild —— 派生数据定时重算（v0.25.0，v1.0.0 加第三步）
 *
 * 背景：segment_stats（站间时长）、walk_times（步行时长）、transfer_walks（换乘步行）是从原始样本
 * （timer_events / free_ride_events）算出的**派生表**，此前只能手动跑
 * `npm run db:segments` / `db:walktimes` / `db:transferwalks` 才会更新 —— 新样本进来后
 * 派生值会停留在上次运行命令的时刻。本路由把重算自动化，由 Vercel Cron
 * 每日触发（见 vercel.json），保证派生数据跟着样本走。
 *
 * 实现要点：直接 import src/lib/rebuild/* 的共享函数，**不** execFile 调 .ts 脚本。
 *   原因：① tsx 在 devDependencies，Vercel 生产构建不装；
 *        ② Serverless 只打包被 import 的模块，.ts 脚本文件不会进函数产物。
 *   连库用 src/lib/db 的 getPool()（生产自动指向 DATABASE_URL = Supabase）。
 *
 * 鉴权：Vercel Cron 请求带 `Authorization: Bearer $CRON_SECRET`。
 *   配了 CRON_SECRET → 必须匹配；未配 → 仅在非 production 放行（本地调试）。
 *   （middleware 已把本路径加入白名单，不走口令门，见 src/middleware.ts）
 *
 * 安全：重算本身幂等（清表后全量重算）；仍加内存锁避免重叠执行，
 *   并按顺序串行三个重算（都读 timer_events，串行避免连接竞争）。
 *
 * 幂等：可重复调用。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { rebuildSegmentStats } from "@/lib/rebuild/segment-stats";
import { rebuildTransferWalks } from "@/lib/rebuild/transfer-walks";
import { rebuildWalkTimes } from "@/lib/rebuild/walk-times";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Vercel Hobby 计划函数上限 60s；三个重算当前合计数秒，数据长大后仍有余量 */
export const maxDuration = 60;

/** 进程内互斥：同实例并发请求直接拒绝，不排队（避免雪崩）。
 *  ⚠️ 用「时间戳 + 过期」而非布尔：若某次执行被 maxDuration 掐断或进程被回收，
 *  finally 不会执行 —— 布尔锁会永久卡在 true 让端点彻底失联（v0.25.0 实测踩到）。
 *  超过 STALE_MS 视为陈旧锁，自动放行。 */
let runningSince = 0;
const STALE_MS = 5 * 60_000;
const isLocked = () => runningSince !== 0 && Date.now() - runningSince < STALE_MS;

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  summary: Record<string, unknown>;
  err?: string;
}

/** 鉴权：Vercel Cron 带 Bearer CRON_SECRET */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // 未配密钥：仅本地 debug 放行，生产环境拒绝（防公开触发）
    return process.env.NODE_ENV !== "production";
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth === `Bearer ${secret}`) return true;
  // 兼容手动触发（带上 ?key=）
  return req.nextUrl.searchParams.get("key") === secret;
}

/** 跑一个重算步骤，吞掉异常转为 ok=false（不中断另一步骤） */
async function step(
  name: string,
  fn: () => Promise<Record<string, unknown>>,
): Promise<StepResult> {
  const t0 = Date.now();
  try {
    const summary = await fn();
    return { name, ok: true, ms: Date.now() - t0, summary };
  } catch (e) {
    return {
      name,
      ok: false,
      ms: Date.now() - t0,
      summary: {},
      err: String(e instanceof Error ? e.message : e).slice(0, 1000),
    };
  }
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }
  if (isLocked()) {
    return NextResponse.json({ error: "上一次重算仍在进行", running: true }, { status: 409 });
  }

  runningSince = Date.now();
  const t0 = Date.now();
  try {
    const pool = getPool();
    const results: StepResult[] = [];

    // 顺序执行：三者都读 timer_events，串行可避免 DB 连接竞争
    results.push(
      await step("segment_stats", async () => {
        const r = await rebuildSegmentStats(pool);
        return {
          sessions: r.sessions,
          rides: r.rides,
          samples: r.samples,
          written: r.inserted,
          pairs: r.pairs.length,
        };
      }),
    );
    results.push(
      await step("walk_times", async () => {
        const r = await rebuildWalkTimes(pool);
        return {
          scanned: r.scanned,
          collected: r.collected,
          valid: r.valid,
          inserted: r.inserted,
          totalSamples: r.totalSamples,
        };
      }),
    );
    // v1.0.0 第三步：换乘步行（alight → wait_start）—— 供自动选线的换乘方案计时
    results.push(
      await step("transfer_walks", async () => {
        const r = await rebuildTransferWalks(pool);
        return {
          scanned: r.scanned,
          collected: r.collected,
          valid: r.valid,
          inserted: r.inserted,
          totalSamples: r.totalSamples,
        };
      }),
    );

    const allOk = results.every((r) => r.ok);
    return NextResponse.json(
      {
        ok: allOk,
        totalMs: Date.now() - t0,
        results,
      },
      { status: allOk ? 200 : 500 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 1000) },
      { status: 500 },
    );
  } finally {
    runningSince = 0;
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
