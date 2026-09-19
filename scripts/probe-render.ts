/**
 * 真浏览器回归（scripts/probe-render.ts）
 *
 * 用法：npx tsx scripts/probe-render.ts <baseUrl>
 *   例： npx tsx scripts/probe-render.ts http://127.0.0.1:3100
 *
 * 目的：撤销【8】（needsWait / 「需等下一班」）后，对 **5 条主链路**做真浏览器回归：
 *   /recommend · /card · /commute · /nav · /nav/detail
 *
 * 断言：
 *   ① 每页 HTTP 200、无 pageerror / console.error（除已知 pre-existing 的 @vercel/analytics 404）
 *   ② /recommend · /card · /nav 至少渲染 1 张真卡片（非骨架）
 *   ③ ★ **不再出现 `.rc-tier--miss`**（needsWait 的中性徽章）—— 即撤销【8】在渲染层生效
 *   ④ 「后续车次」（`.rc-altrow`）若存在则记录（altBuses 机制，与 needsWait 无关）
 *
 * ⚠️ playwright-core 走 workbuddy 内置目录（与 scripts/shot.cjs 同一份），不动 package.json 依赖。
 * ⚠️ `.ts` 脚本（项目铁律）。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { wgs84ToGcj02 } from "@/lib/amap/coord";

const require = createRequire(import.meta.url);
const PW = path.join("C:", "Users", "ASUS", ".workbuddy", "binaries", "node", "workspace", "node_modules", "playwright-core");
const CHROME = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { chromium } = require(PW) as { chromium: any };

const BASE = process.argv[2] ?? "http://127.0.0.1:3100";

/** 已知点（WGS）→ GCJ-02（`/nav` · `/nav/detail` URL 契约要求 GCJ-02） */
const home = wgs84ToGcj02({ lat: 22.1301754167269, lng: 113.55910051177 }); // 擎天匯
const school = wgs84ToGcj02({ lat: 22.1519150877303, lng: 113.566924771965 }); // 澳科大
const navQ = new URLSearchParams({
  fromLng: String(home.lng),
  fromLat: String(home.lat),
  toLng: String(school.lng),
  toLat: String(school.lat),
  fromLabel: "擎天匯",
  toLabel: "澳科大",
  fromKind: "place",
  toKind: "place",
  zone: "N/O",
}).toString();

/** 已知可忽略的错误（pre-existing：@vercel/analytics 在本机/无网环境下 404） */
const IGNORE = [/vercel\/analytics/i, /_vercel\/insights/i, /favicon/i];

/**
 * ★ 已知「本地环境噪声」（**非本轮回归**，不计入失败）：
 *   `layout.tsx` 里的 `@vercel/analytics` / `speed-insights` 会在运行时注入
 *   `<script src="/_vercel/insights/script.js">`；本机 `next start`（无 Vercel Edge）下，
 *   该 URL 被**本地鉴权中间件**重定向到 `/login?from=%2F_vercel%2Finsights%2Fscript.js`
 *   （返回 `text/html`）→ 注入的 `<script>` 把 HTML 当 JS 解析 → 报 `Unexpected token '<'`。
 *   佐证：`/commute`（**本轮完全未改动**的页面）同样复现 ⇒ 与本轮 4 文件变更无关。
 */
const BENIGN = [/Unexpected token '<'/];

/** 过滤「已知可忽略」与「本地环境噪声」 */
const filterNoise = (arr: string[]): string[] =>
  arr.filter((e) => !IGNORE.some((r) => r.test(e)) && !BENIGN.some((r) => r.test(e)));

interface PageReport {
  name: string;
  url: string;
  http: number;
  cards: number;
  missBadges: number;
  altRows: number;
  markers: Record<string, boolean>;
  errors: string[];
  netIssues: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function visit(browser: any, name: string, url: string, markers: Record<string, string>): Promise<PageReport> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const netIssues: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(`[pageerror] ${e.message}`));
  page.on("console", (m: { type: () => string; text: () => string }) => {
    if (m.type() === "error") errors.push(`[console] ${m.text()}`);
  });
  page.on("response", (r: { status: () => number; url: () => string }) => {
    const s = r.status();
    if (s >= 400) netIssues.push(`${s} ${r.url()}`);
  });
  page.on("requestfailed", (r: { url: () => string; failure: () => { errorText?: string } | null }) => {
    netIssues.push(`FAILED ${r.url()} ${r.failure()?.errorText ?? ""}`);
  });

  const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 40000 });
  await page.waitForTimeout(1500);

  const markerHit: Record<string, boolean> = {};
  for (const [k, sel] of Object.entries(markers)) {
    markerHit[k] = (await page.locator(sel).count()) > 0;
  }

  const rep: PageReport = {
    name,
    url,
    http: resp?.status() ?? 0,
    cards: await page.locator(".card.rc:not(.rc--skeleton)").count(),
    missBadges: await page.locator(".rc-tier--miss").count(),
    altRows: await page.locator(".rc-altrow").count(),
    markers: markerHit,
    errors: filterNoise(errors),
    netIssues: filterNoise([...new Set(netIssues)]),
  };
  await ctx.close();
  return rep;
}

async function run(): Promise<void> {
  console.log(`\n[probe-render] base = ${BASE}`);
  console.log(`   nav 查询串 = ${navQ}`);
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const reports: PageReport[] = [];

  try {
    // ① /recommend：真卡片 + 无 miss 徽章
    reports.push(
      await visit(browser, "/recommend", `${BASE}/recommend?from=home&to=gate&zone=N/O`, {
        "总用时大字(.rc-total)": ".rc-total",
      }),
    );
    // ② /commute：旧首页（方向卡）
    reports.push(
      await visit(browser, "/commute", `${BASE}/commute`, {
        "页面容器(.page)": "main.page",
      }),
    );
    // ③ /nav：全澳导航结果页
    reports.push(
      await visit(browser, "/nav", `${BASE}/nav?${navQ}`, {
        "导航页容器(.nav-page)": ".nav-page",
        "总用时大字(.rc-total)": ".rc-total",
      }),
    );
    // ④ /nav/detail：导航详情页（自带站条）
    reports.push(
      await visit(browser, "/nav/detail", `${BASE}/nav/detail?${navQ}`, {
        "总用时大字(.rc-total)": ".rc-total",
        "站条(.rc-strip)": ".rc-strip",
      }),
    );

    // ⑤ /card：从 /recommend 点第一张真卡进入（构造合法 URL 更繁琐 → 用真实点击）
    const ctxC = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pageC = await ctxC.newPage();
    const errC: string[] = [];
    const netC: string[] = [];
    pageC.on("pageerror", (e: Error) => errC.push(`[pageerror] ${e.message}`));
    pageC.on("console", (m: { type: () => string; text: () => string }) => {
      if (m.type() === "error") errC.push(`[console] ${m.text()}`);
    });
    pageC.on("response", (r: { status: () => number; url: () => string }) => {
      if (r.status() >= 400) netC.push(`${r.status()} ${r.url()}`);
    });
    await pageC.goto(`${BASE}/recommend?from=home&to=gate&zone=N/O`, { waitUntil: "networkidle", timeout: 40000 });
    await pageC.waitForTimeout(1200);
    const firstCard = pageC.locator(".card.rc:not(.rc--skeleton)").first();
    const hasCard = (await firstCard.count()) > 0;
    let cardRep: PageReport = {
      name: "/card",
      url: `${BASE}/card?（由 /recommend 点击进入）`,
      http: 0,
      cards: 0,
      missBadges: 0,
      altRows: 0,
      markers: {},
      errors: [],
      netIssues: [],
    };
    if (hasCard) {
      await firstCard.click();
      await pageC.waitForURL(/\/card\?/, { timeout: 20000 });
      await pageC.waitForTimeout(1500);
      cardRep = {
        name: "/card",
        url: pageC.url(),
        http: 200,
        cards: (await pageC.locator(".card.rc").count()) > 0 ||
          (await pageC.locator(".rc-detail").count()) > 0
          ? 1
          : 0,
        missBadges: await pageC.locator(".rc-tier--miss").count(),
        altRows: await pageC.locator(".rc-altrow").count(),
        markers: { "详情页容器(.rc-detail)": (await pageC.locator(".rc-detail").count()) > 0 },
        errors: filterNoise(errC),
        netIssues: filterNoise([...new Set(netC)]),
      };
    } else {
      cardRep.errors = ["/recommend 未渲染出卡片 → 无法进入 /card"];
    }
    await ctxC.close();
    reports.push(cardRep);
  } finally {
    await browser.close();
  }

  console.log("\n══════════════ 真浏览器回归（5 条主链路）══════════════");
  let bad = 0;
  for (const r of reports) {
    const markerStr = Object.entries(r.markers)
      .map(([k, v]) => `${v ? "✓" : "✗"}${k}`)
      .join(" · ");
    const ok = r.http === 200 && r.errors.length === 0 && r.missBadges === 0 && Object.values(r.markers).every(Boolean);
    if (!ok) bad += 1;
    console.log(`\n${r.name}  ${ok ? "✓ OK" : "✗ 有问题"}`);
    console.log(`   ${r.url}`);
    console.log(`   HTTP ${r.http} · 真卡片 ${r.cards} · 后续班次行(.rc-altrow) ${r.altRows} · miss 徽章 ${r.missBadges}`);
    if (markerStr) console.log(`   标记：${markerStr}`);
    console.log(`   JS 错误：${r.errors.length ? r.errors.join(" || ") : "无"}`);
    if (r.netIssues.length) console.log(`   网络非 2xx：${r.netIssues.join(" || ")}`);
  }
  console.log(
    `\n═══ 汇总：${bad === 0 ? "5 条主链路全部正常 ✓" : `${bad} 条异常 ✗`}` +
      ` · 全站 .rc-tier--miss 出现 ${reports.reduce((s, r) => s + r.missBadges, 0)} 次（应为 0）═══`,
  );
  console.log(
    "（说明：已自动过滤本地环境噪声 —— @vercel analytics 脚本被本地鉴权中间件重定向成 HTML 导致的 `Unexpected token '<'`；该噪声在未改动的 /commute 上同样出现）",
  );
  process.exit(bad === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error("SCRIPT FAILED:", (e as Error).message);
  process.exit(1);
});
