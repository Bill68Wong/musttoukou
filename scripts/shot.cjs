/* 手机视口截图诊断（scripts/shot.cjs）：
   node scripts/shot.cjs <url> [outfile.png] [w h] [light|dark]
   dark 通过 emulateMedia 模拟 prefers-color-scheme: dark */
const path = require("path");
const PW = path.join(
  "C:", "Users", "ASUS", ".workbuddy", "binaries", "node", "workspace", "node_modules", "playwright-core",
);
const CHROME = path.join(
  process.env.LOCALAPPDATA ?? "", "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe",
);

(async () => {
  const { chromium } = require(PW);
  const url = process.argv[2];
  const out = process.argv[3] ?? "shot.png";
  const w = Number(process.argv[4] ?? 390);
  const h = Number(process.argv[5] ?? 844);
  const scheme = (process.argv[6] ?? "light").toLowerCase();
  if (!url) {
    console.error("用法: node scripts/shot.cjs <url> [outfile] [w h] [light|dark]");
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.emulateMedia({ colorScheme: scheme });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(`[console] ${m.text()}`);
  });
  try {
    const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    console.log("HTTP:", resp?.status());
    await page.waitForTimeout(1500);
    const body = await page.evaluate(() => document.body.innerText);
    console.log("body:", body.replace(/\n+/g, " | ").slice(0, 400));
    await page.screenshot({ path: out, fullPage: false });
    console.log("saved:", out);
  } catch (e) {
    console.log("FAILED:", e.message.slice(0, 200));
  }
  console.log(errs.length ? errs.join("\n") : "(no page/console errors)");
  await browser.close();
})().catch((e) => {
  console.error("SCRIPT FAILED:", e.message);
  process.exit(1);
});
