/* v0.6.0 UI 无头真点验证（scripts/e2e-v060.cjs）
   场景：
     A. 回宿舍 51A（school-home-2-51a）：乘车到 C688/2 → 出现「下车/途经」决策卡 → 途经 → 终点收尾
     B. 去学校 51B（home-school-10）：出发前出现「在哪里上车」chips，选 C689/2 → 全链路站名跟随
     C. 轻轨（home-school-8）：到站记分钟，选中高亮 + 改选覆盖 + 无「已记 N 次」文案
   用法：node scripts/e2e-v060.cjs（需本地 dev server :3000 + 本地库） */
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");
const os = require("os");
process.loadEnvFile(".env");

const PW = path.join("C:", "Users", "ASUS", ".workbuddy", "binaries", "node", "workspace", "node_modules", "playwright-core");
const CHROME = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
const BASE = "http://localhost:3000";
const OUT = path.join(os.tmpdir(), "musttoukou-e2e-v060");
fs.mkdirSync(OUT, { recursive: true });

const pool = new Pool({ connectionString: process.env.DATABASE_URL_LOCAL, max: 1 });
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  ✅", msg); }
  else { fail++; console.log("  ❌", msg); }
}
const body = (page) => page.evaluate(() => document.body.innerText);

async function mkSession(planKey) {
  const r = await pool.query("SELECT id FROM commute_plans WHERE plan_key=$1", [planKey]);
  const planId = r.rows[0]?.id;
  if (!planId) throw new Error("无方案 " + planKey);
  const resp = await fetch(BASE + "/api/timer", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId }),
  });
  const j = await resp.json();
  if (!j.sessionId) throw new Error(JSON.stringify(j));
  return j.sessionId;
}
async function cleanup(ids) {
  if (!ids.length) return;
  await pool.query("UPDATE timer_sessions SET deleted_at = now() WHERE id = ANY($1)", [ids]);
}
async function tapBtn(page, text, waitText) {
  const btn = page.getByRole("button", { name: new RegExp(`^${text}$`) }).first();
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click();
  if (waitText) {
    await page.waitForFunction(
      (t) => document.body.innerText.includes(t),
      waitText,
      { timeout: 10000 },
    );
  } else {
    await page.waitForTimeout(600);
  }
}
async function tapAny(page, text) {
  const btn = page.locator("button", { hasText: text }).first();
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click();
  await page.waitForTimeout(500);
}
async function shot(page, name) {
  const f = path.join(OUT, name);
  await page.screenshot({ path: f });
  console.log("  📷", f);
  return f;
}

(async () => {
  const { chromium } = require(PW);
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  const made = [];

  try {
    // ---------- A. 回宿舍 51A 动态下车 ----------
    console.log("\n===== A. school-home-2-51a 回宿舍 51A =====");
    const a = await mkSession("school-home-2-51a");
    made.push(a);
    await page.goto(`${BASE}/timer/${a}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);
    let t = await body(page);
    ok(!t.includes("在哪里上车"), "回宿舍不出现「在哪里上车」（无 board_candidates）");
    await tapBtn(page, "出发", "到站，开始等车");
    await tapBtn(page, "到站，开始等车", "上车");
    await tapBtn(page, "上车", "乘车中");
    t = await body(page);
    ok(t.includes("乘车中") && t.includes("51A"), "进入乘车：51A");
    let sawDecision = false;
    for (let i = 0; i < 9; i++) {
      t = await body(page);
      if (t.includes("就在此下车")) { sawDecision = true; break; }
      if (!t.includes("✓ 停靠")) break;
      await tapAny(page, "✓ 停靠");
      await page.waitForTimeout(250);
    }
    t = await body(page);
    ok(sawDecision && t.includes("就在此下车"), "到 C688/2 出现「下车/途经」决策卡");
    ok(t.includes("途经") && t.includes("坐到"), "决策卡含「途经 · 坐到…总站」");
    await shot(page, "A1-decision.png");
    await tapAny(page, "途经");
    await page.waitForTimeout(600);
    t = await body(page);
    ok(!t.includes("就在此下车") && t.includes("蝴蝶谷"), "途经后决策卡消失、目标切到总站方向");
    for (let i = 0; i < 4; i++) {
      t = await body(page);
      if (t.includes("已到站") || t.includes("就在此下车")) break;
      if (!t.includes("✓ 停靠")) break;
      await tapAny(page, "✓ 停靠");
      await page.waitForTimeout(250);
    }
    t = await body(page);
    ok(t.includes("已到站") && t.includes("蝴蝶谷"), "到总站提示下车");
    await shot(page, "A2-terminal.png");

    // ---------- B. 去学校 51B 上车点选择 ----------
    console.log("\n===== B. home-school-10 去学校 51B =====");
    const b = await mkSession("home-school-10");
    made.push(b);
    await page.goto(`${BASE}/timer/${b}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);
    t = await body(page);
    ok(t.includes("在哪里上车") && t.includes("樂群樓"), "出发前出现上车点 chips（含 C689/2）");
    ok(t.includes("默认") && t.includes("蝴蝶谷"), "默认站提示：蝴蝶谷总站");
    await shot(page, "B1-default.png");
    await tapAny(page, "樂群樓");
    await page.waitForTimeout(400);
    t = await body(page);
    ok(t.includes("在「") && t.includes("樂群樓") && t.includes("上车"), "选中 C689/2 后提示更新");
    await shot(page, "B2-chosen.png");
    await tapBtn(page, "出发", "到站，开始等车");
    t = await body(page);
    ok(t.includes("樂群樓"), "等车步骤站名跟随 C689/2");
    await tapBtn(page, "到站，开始等车", "上车");
    await tapBtn(page, "上车", "乘车中");
    await page.waitForTimeout(600);
    t = await body(page);
    ok(t.includes("51B") && t.includes("威尼斯人"), "乘车目标 = T363/1 威尼斯人");
    await shot(page, "B3-riding.png");

    // ---------- C. 轻轨记分钟 ----------
    console.log("\n===== C. home-school-8 轻轨分钟 =====");
    const c = await mkSession("home-school-8");
    made.push(c);
    await page.goto(`${BASE}/timer/${c}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);
    await tapBtn(page, "出发", "到站，开始等车");
    t = await body(page);
    ok(t.includes("轻轨还有几分钟"), "轻轨到站出现分钟条");
    await page.locator("button", { hasText: /^5$/ }).first().click();
    await page.waitForTimeout(500);
    t = await body(page);
    ok(t.includes("已选 5 分钟"), "选中 5 高亮提示");
    ok(!/已记 \d+ 次/.test(t), "无「已记 N 次」文案");
    await shot(page, "C1-five.png");
    await page.locator("button", { hasText: /^3$/ }).first().click();
    await page.waitForTimeout(500);
    t = await body(page);
    ok(t.includes("已选 3 分钟") && !t.includes("已选 5"), "改选 3 覆盖原值");
    // 第一段乘车→下车→第二段到站→独立分钟
    await tapBtn(page, "到站，开始等车", "上车");
    await tapBtn(page, "上车", "下车");
    await tapBtn(page, "下车", "轻轨还有几分钟");
    t = await body(page);
    ok(t.includes("轻轨还有几分钟") && !t.includes("已选 3"), "第二段轻轨独立：先前选 3 未带到此站");
    await page.locator("button", { hasText: /^7$/ }).first().click();
    await page.waitForTimeout(500);
    t = await body(page);
    ok(t.includes("已选 7 分钟"), "第二段轻轨独立记录 7 分钟");
    await shot(page, "C2-second.png");
  } catch (e) {
    fail++;
    console.error("  ❌ 场景异常：", e.message);
    const f = path.join(OUT, "error.png");
    await page.screenshot({ path: f }).catch(() => {});
    console.error("  📷", f);
  } finally {
    await cleanup(made);
    await browser.close();
    await pool.end();
  }
  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  if (errs.length) console.log("页面错误：\n" + errs.join("\n"));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("脚本失败", e.message); process.exit(1); });
