/**
 * revert【8】验证探针（scripts/probe-revert8.ts）
 *
 * 用法：npx tsx scripts/probe-revert8.ts
 *
 * 目的：为「撤销【8】needsWait 口径，恢复 v2.0.0「赶不上就整条剔除」原行为」提供**可复现证据**。
 *
 * ── 两部分 ────────────────────────────────────────────────────────────────
 *   A. **确定性断言（纯内存、无需数据库）**：用 dev 强制构造的 `BusLive` 直接喂 `modelOption`
 *      · A1 「首段赶不上」→ 必须 `return null` 且线路记入 `ctx.missed`（★ 这就是被撤销后的原行为）
 *      · A2 「首段能赶上 + 有后续班次」→ 卡正常产出，且 `ModeledOption.alts` 非空（后续车次机制）
 *   B. **真实返回片段（读数据库，走生产 `recommend()` 全链路）**：对 6 个真实 OD 各算一次，
 *      打印出卡数 / `missed` / `excluded`，并原样贴出一张卡的 `altBuses`（后续班次）。
 *      —— 证明 `altBuses` 在撤销后**照常工作**（它本就是「后续车次」的正式机制）。
 *
 * ⚠️ 纯只读：不写业务表（DSAT 实时调用会记 dsat_call_logs，属正常记账）。
 * ⚠️ `.ts` 脚本（项目铁律）；不新增任何依赖。
 */
import { getPool } from "@/lib/db";
import {
  buildTransferIndex,
  buildWalkIndex,
  modelOption,
  type ModelContext,
} from "@/lib/recommend/model";
import { buildSegmentIndex } from "@/lib/recommend/segment-lookup";
import { recommend } from "@/lib/recommend/service";
import type { BusArrival, BusLive, OptionSeed, RouteLive } from "@/lib/recommend/types";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 → 只跑 A 部分 */
}

/** 固定「现在」（2026-09-19 12:00 澳门时间 = 04:00 UTC）—— A 部分不依赖真实时刻 */
const NOW = Date.UTC(2026, 8, 19, 4, 0, 0);

let failures = 0;
function check(cond: boolean, label: string): void {
  console.log(`   ${cond ? "✓ PASS" : "✗ FAIL"}  ${label}`);
  if (!cond) failures += 1;
}

/** 一个最小的单段巴士方案（home → school，乘 25 路） */
const SEED: OptionSeed = {
  planId: 1,
  summary: "25 直达",
  fromSlug: "home",
  toSlug: "school",
  crossBorder: false,
  segments: [{ route: "25", kind: "bus", board: "B1", alight: "B2", hops: [["B1", "B2"]] }],
  transfers: [],
  key: "25@B1>B2",
};

/** 构造最小可用的 `ModelContext`（步行 / 段统计 / 换乘索引皆为空 → 各回退链走兜底层） */
function ctxWith(live: Map<string, RouteLive>): ModelContext {
  return {
    nowMs: NOW,
    segIdx: buildSegmentIndex([]),
    walkIdx: buildWalkIndex([]),
    transferIdx: buildTransferIndex([]),
    placeIds: {},
    nameOf: new Map<string, string>(),
    zone: null,
    live,
    excluded: [],
    missed: [],
    todayWeekday: 1,
  };
}

function arrival(loSec: number, stopsAway: number): BusArrival {
  return { stopsAway, atStation: "B1", status: "0", loSec, hiSec: loSec + 60, hopMin: [] };
}

/** A 部分：确定性断言 */
function partA(): void {
  console.log("\n═══ A. 确定性断言（dev 强制构造，无需数据库）═══");

  // ── A1：首段赶不上（车 10s 就到，但你还有 ~3 分步行）→ 必须整条剔除 ──
  //    兜底步行 3.0 分 ⇒ 冲刺档 requiredSec ≈ 79s > 10s ⇒ 五档全不满足 ⇒ pickBoardable = null
  const liveMiss = new Map<string, RouteLive>([
    [
      "25",
      {
        kind: "bus",
        route: "25",
        empty: false,
        nearest: arrival(10, 0),
        second: null,
        more: [],
      } satisfies BusLive,
    ],
  ]);
  const ctxMiss = ctxWith(liveMiss);
  const rMiss = modelOption(SEED, ctxMiss);
  console.log(`   · 首段赶不上：modelOption = ${rMiss === null ? "null" : "有卡"} · missed=[${ctxMiss.missed.join(",")}]`);
  check(rMiss === null, "赶不上 → modelOption 返回 null（整条剔除）");
  check(ctxMiss.missed.includes("25"), "赶不上的线路记入 ctx.missed（供诊断区分）");
  check(!ctxMiss.excluded.includes("25"), "★ 不计入 ctx.excluded（区分「没车」与「赶不上」）");

  // ── A2：首段能赶上（车 5 分后到）+ 有后续班次（10 分后）→ 卡产出 + alts 非空 ──
  const liveAlt = new Map<string, RouteLive>([
    [
      "25",
      {
        kind: "bus",
        route: "25",
        empty: false,
        nearest: arrival(300, 1),
        second: null,
        more: [arrival(600, 3)],
      } satisfies BusLive,
    ],
  ]);
  const ctxAlt = ctxWith(liveAlt);
  const rAlt = modelOption(SEED, ctxAlt);
  console.log(
    `   · 能赶上：modelOption = ${rAlt ? `有卡（totalMin ${rAlt.card.totalMin} · tier ${rAlt.card.rides[0]?.tier}）` : "null"}` +
      ` · alts=${rAlt ? rAlt.alts.length : 0}`,
  );
  check(rAlt !== null, "能赶上 → 正常出卡");
  check((rAlt?.alts.length ?? 0) === 1, "卡带出 1 条后续班次（`ModeledOption.alts`）");
  check(rAlt?.alts[0]?.tier === 5, "后续班次档位 = 5（10 分到，爬过去都能赶上）");
  check(!("needsWait" in ((rAlt?.card.rides[0] ?? {}) as object)), "★ RideLegView 已无 needsWait 字段（口径已移除）");
}

/** B 部分：真实返回片段（走生产 recommend 全链路） */
async function partB(): Promise<void> {
  console.log("\n═══ B. 真实返回片段（读数据库 · 生产 recommend() 全链路）═══");
  const ODS: { from: string; to: string }[] = [
    { from: "gate", to: "home" },
    { from: "home", to: "gate" },
    { from: "home", to: "school" },
    { from: "school", to: "home" },
    { from: "home", to: "hengqin" },
    { from: "hengqin", to: "home" },
  ];
  const pool = getPool();
  let snippetShown = false;
  try {
    for (const od of ODS) {
      const res = await recommend(pool, { fromSlug: od.from, toSlug: od.to, zone: "N/O", force: true });
      const altsCard = res.cards.find((c) => (c.altBuses?.length ?? 0) > 0);
      console.log(
        `\n   ${od.from}→${od.to}：出卡 ${res.cards.length} 张` +
          ` · missed=[${res.missed.join(",") || "-"}] · excluded=[${res.excluded.join(",") || "-"}]` +
          ` · 带后续班次的卡 ${res.cards.filter((c) => (c.altBuses?.length ?? 0) > 0).length} 张`,
      );
      for (const c of res.cards) {
        const chain = c.rides.map((r) => r.route).join("→");
        console.log(
          `      · #${c.planId} ${chain.padEnd(12)} 全程 ${c.totalMin} 分` +
            ` · 首段 tier=${c.rides[0]?.tier ?? "-"} · altBuses=${c.altBuses?.length ?? 0}`,
        );
      }
      if (!snippetShown && altsCard) {
        snippetShown = true;
        console.log(`   ★ 真实返回片段（${od.from}→${od.to} · ${altsCard.rides.map((r) => r.route).join("→")} 卡）：`);
        console.log(
          "   " +
            JSON.stringify(
              { route: altsCard.rides[0]?.route, altBuses: altsCard.altBuses },
              null,
              2,
            ).replace(/\n/g, "\n   "),
        );
      }
    }
  } finally {
    await pool.end();
  }
  if (!snippetShown) {
    console.log("\n   ⚠️ 本轮实时数据下暂无「带后续班次」的卡（altBuses 为空属正常：需同线有可赶的后续车）");
  }
}

async function main(): Promise<void> {
  partA();
  try {
    await partB();
  } catch (e) {
    console.log(`\n   ⚠️ B 部分（数据库）跳过：${(e as Error).message}`);
  }
  console.log(`\n═══ 结论：A 部分断言 ${failures === 0 ? "全部通过 ✓" : `有 ${failures} 项失败 ✗`} ═══`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
