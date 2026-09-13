/**
 * DSAT 全澳巴士「追踪式计时」自动采集器（scripts/track-collect.mjs）
 *
 * 定位：只读采集器。**不写数据库、不改 src/**，只把 DSAT 实时报站原始帧落盘
 *       gzip，供 scripts/track-derive.mjs 事后算「离开 A → 离开 B」的站间时长。
 *
 * 为什么是 .mjs 而不是 .ts：本脚本刻意**不 import 任何生产模块**（src/ 下含 pg 的
 * server 模块在纯 node 环境跑不了），token 算法在此内联复刻，保证与 src/lib/dsat/token.ts
 * 完全一致（md5(qs) 按 YYYYMMDDHHmm 插位成 44 字符）。
 *
 * ── 轮询计划（2026-09-13 全量实测确定，见 .verify/routes-probe2.txt）──
 *   · direction=2（71 条）：dir=0 一次返回往返全程 → 只查 1 次
 *   · direction=0（21 条）：往返分开返回 → 必须查 dir=0 与 dir=1
 *   ⇒ 每轮请求数 = 113（不是 92，也不是 184）；5 秒间隔 → 22.6 次/秒
 *
 * ── 用法 ──
 *   node scripts/track-collect.mjs --dry-plan                  # 只打印计划，不发请求
 *   node scripts/track-collect.mjs --minutes=2 --stage=3       # 2 分钟全速自检
 *   node scripts/track-collect.mjs --minutes=30                # 正式一轮（含渐变启动）
 *
 * ── 参数 ──
 *   --minutes=30        总时长（含渐变期）
 *   --interval=5        基准轮询间隔（秒）
 *   --pool=6            并发请求上限
 *   --timeout=3000      单请求超时（毫秒）
 *   --stage=auto|0|1|2|3  起始档；auto=从档0渐变；给 3 则跳过渐变直接全速
 *   --ramp=3,3,5        档0/1/2 各持续分钟（档3 吃掉剩余全部时间）
 *   --seg-minutes=2     落盘分片时长（越小越抗中断，每片是完整可解压的 gzip）
 *   --out=data/tracking 落盘目录
 *   --plan=...          轮询计划缓存（缺失则按 direction 规则现推）
 *   --refresh-plan      强制重拉线路清单并全量复扫 dir（184 次请求）
 *   --label=xxx         文件名标签（默认按澳门时间戳）
 *
 * ── 落盘 ──
 *   <out>/<stamp>-partNN.jsonl.gz   原始帧（每请求一行）
 *   <out>/<stamp>-meta.json         本次运行参数、档位时间线、健康度采样、总计
 *   <out>/<stamp>-run.log           人类可读运行日志
 *
 * ── 安全机制（渐变启动 + 降级阶梯 + 硬熔断）──
 *   渐变：档0(8条)→档1(24)→档2(48)→档3(92)，每档须「失败率=0 且延迟稳定」才放行
 *   降级：滑动窗口失败率 > 5% → 降一档（单向，不再自动回升）
 *         滑动窗口 p50 延迟异常 → 间隔 5s→10s→20s（单向）
 *   熔断：连续失败 ≥ 10 次 → 立即中止整轮并落盘收尾
 *
 * ── 延迟降级的防误触发（2026-09-13 首轮实测踩坑后加固）──
 *   首轮现象：升档后仅 40 秒就触发「p50 52ms > 3× 基线 16ms」→ 间隔单向放宽到 10s，
 *             后 158 轮全部 10s 跑完，**样本量直接砍半**（而档3 单请求 p50 只有 12~21ms，
 *             5s 间隔每请求预算 44ms，完全跑得动 → 这次降级纯属误判）。
 *   根因：升档瞬间请求数翻倍，延迟自然抬升（16ms→26~31ms），叠一个 p95 尖峰就把窗口 p50 拉过 3×。
 *   现加固为**三个条件同时满足**才放宽间隔：
 *     ① 倍数阈值 3× → **5×**，且窗口 p50 必须 > 80ms（绝对地板，防低基线放大噪声）
 *     ② 必须**连续 3 个窗口**都超阈值（单次尖峰不再触发）
 *     ③ 升档后 **90 秒冷静期**内不因延迟降级（给延迟重新收敛的时间）
 *   ⚠️ 「放宽间隔」仍是单向的（不自动回升）——宁可少采也不要来回震荡。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

// ════════════════════════════ 0. 参数 ════════════════════════════

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return d;
  const v = hit.includes("=") ? hit.split("=").slice(1).join("=") : "true";
  return v;
};
const has = (k) => argv.some((a) => a === `--${k}` || a.startsWith(`--${k}=`));

const ROOT = path.resolve(process.cwd());
const CFG = {
  minutes: Number(arg("minutes", "30")),
  intervalSec: Number(arg("interval", "5")),
  pool: Number(arg("pool", "6")),
  timeoutMs: Number(arg("timeout", "3000")),
  stage: arg("stage", "auto"),
  ramp: String(arg("ramp", "3,3,5")).split(",").map(Number),
  segMinutes: Number(arg("seg-minutes", "2")),
  out: path.resolve(ROOT, arg("out", "data/tracking")),
  planFile: path.resolve(ROOT, arg("plan", "data/tracking/poll-plan.json")),
  refreshPlan: has("refresh-plan"),
  dryPlan: has("dry-plan"),
  label: arg("label", ""),
  baseUrl: arg("base", "https://bis.dsat.gov.mo:37812/macauweb"),
};

/** 采集优先级：真缺 54 段全在前 8 条 → 渐变期也先把最有价值的数据拿到手 */
const PRIORITY = [
  "25", "51B", "25AX", "51A", "59", "26", "50", "51", // ① A 组（真缺段所在）
  "26A", "56", "25B", "25BS", "102", "701X", "N6",     // ② 通勤网络其余线
];
const A_GROUP_SIZE = 8;

const STAGE_ROUTE_COUNT = [8, 24, 48, Number.POSITIVE_INFINITY];

// ════════════════════════════ 1. 基础工具 ════════════════════════════

const pad = (n) => String(n).padStart(2, "0");
function macauStamp(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}-${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}`;
}
function macauNowMinute() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}
/** ★ 必须与 src/lib/dsat/token.ts 逐字一致 */
function genToken(qs) {
  const m = crypto.createHash("md5").update(qs).digest("hex");
  const o = macauNowMinute();
  return `${m.slice(0, 4)}${o.slice(0, 4)}${m.slice(4, 12)}${o.slice(4, 8)}${m.slice(12, 24)}${o.slice(8, 12)}${m.slice(24, 32)}`;
}
/** 站码归一：C653 → C653；T376/1 → T376 */
const mainCode = (c) => /^[A-Za-z]+\d+/.exec(String(c ?? ""))?.[0] ?? String(c ?? "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qsOf = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("&");

// ════════════════════════════ 2. 采集器主体 ════════════════════════════

const stamp = CFG.label || macauStamp();
const logLines = [];
let _logDirReady = false;
function LOG(msg, echo = true) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logLines.push(line);
  if (echo) process.stdout.write(line + "\n");
  // ★ 实时落盘：进程若被中途杀掉（宿主守卫 / OOM / 强杀），日志必须还在
  try {
    if (!_logDirReady) { fs.mkdirSync(CFG.out, { recursive: true }); _logDirReady = true; }
    fs.writeFileSync(path.join(CFG.out, `${stamp}-run.log`), logLines.join("\n") + "\n", "utf8");
  } catch { /* 日志写不了也不能拖垮采集 */ }
}

/** gzip 分片写入器：每片正常 end() → 任何一片都是完整可解压的 gzip
 *  ⚠️ 写入必须串行化：rotate() 是异步的（要等 close 事件），若不排队就会出现
 *     「gz 已置空、rotate 未完成」的窗口 → 下一个 write() 撞 null 崩溃（自检 B 实测）。 */
class SegmentWriter {
  constructor(dir, stamp, segMinutes) {
    this.dir = dir;
    this.stamp = stamp;
    this.segMs = segMinutes * 60 * 1000;
    this.idx = 0;
    this.gz = null;
    this.ws = null;
    this.openedAt = 0;
    this.files = [];
    this.bytes = 0;
    this.queue = [];
    this.pumping = false;
  }
  _open() {
    this.idx++;
    const name = `${this.stamp}-part${String(this.idx).padStart(2, "0")}.jsonl.gz`;
    const file = path.join(this.dir, name);
    this.gz = zlib.createGzip({ level: 6 });
    this.ws = fs.createWriteStream(file);
    this.gz.pipe(this.ws);
    this.openedAt = Date.now();
    this.files.push(name);
    this.name = name;
    this.bytesHere = 0;
    LOG(`📦 新分片 ${name}`);
    return file;
  }
  start() { this._open(); }
  write(obj) {
    const buf = Buffer.from(JSON.stringify(obj) + "\n", "utf8");
    this.bytes += buf.length;
    this.queue.push(buf);
    // ⚠️ 必须用「同步布尔标志」而不是 `pump = _pump()`：
    //    后者在 _pump() 同步跑完时会先被 finally 置 null、再被外层赋值回一个已决议 Promise
    //    → finish() 的 while(pump) 死循环占满 CPU，进程永不退出（自检 B/C/D 实测被宿主强杀）。
    if (!this.pumping) { this.pumping = true; this._pump(); }
  }
  async _pump() {
    try {
      while (this.queue.length) {
        if (Date.now() - this.openedAt >= this.segMs) await this.rotate();
        this.gz.write(this.queue.shift());
      }
    } catch (e) {
      // 落盘失败必须显式暴露（静默吞掉会产出「看起来完整其实缺帧」的数据集）
      this.fatal = e;
      LOG(`✗ 落盘失败：${e?.message || e}`);
    } finally {
      this.pumping = false;
    }
  }
  async closeCurrent() {
    if (!this.gz) return;
    const gz = this.gz, ws = this.ws;
    this.gz = null; this.ws = null;
    await new Promise((res) => {
      ws.on("close", res);
      ws.on("error", res);
      gz.end();
    });
  }
  async rotate() {
    await this.closeCurrent();
    this._open();
  }
  async finish() {
    while (this.pumping || this.queue.length) await new Promise((r) => setTimeout(r, 20));
    await this.closeCurrent();
    if (this.fatal) throw this.fatal;
  }
}

/** 健康度：滑动窗口 + 熔断判定 */
class Health {
  constructor() {
    this.win = [];          // {ok, ms, at}
    this.winMax = 100;
    this.consecFail = 0;
    this.total = 0;
    this.fail = 0;
  }
  push(ok, ms) {
    this.total++;
    if (!ok) this.fail++;
    this.consecFail = ok ? 0 : this.consecFail + 1;
    this.win.push({ ok, ms, at: Date.now() });
    if (this.win.length > this.winMax) this.win.shift();
  }
  get winFailRate() {
    if (!this.win.length) return 0;
    return this.win.filter((x) => !x.ok).length / this.win.length;
  }
  get winP50() {
    const v = this.win.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  }
  get winP95() {
    const v = this.win.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
    return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] : 0;
  }
}

async function fetchRoute(route, dir, opts = {}) {
  const params = { action: "dy", routeName: route, dir, lang: "zh_tw", routeType: "0", device: "web" };
  const qs = qsOf(params);
  const token = genToken(qs);
  const t0 = Date.now();
  const rec = { route, dir, t: t0 };
  try {
    const res = await fetch(`${CFG.baseUrl}/routestation/bus`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", token },
      body: qs,
      signal: AbortSignal.timeout(CFG.timeoutMs),
      cache: "no-store",
    });
    rec.ms = Date.now() - t0;
    rec.http = res.status;
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch { rec.ok = false; rec.err = "notjson"; rec.snip = text.slice(0, 80); return rec; }
    rec.hdr = String(j.header ?? "");
    if (j.header === "1200") { rec.ok = false; rec.err = "token1200"; return rec; }
    const info = j.data?.routeInfo;
    if (!Array.isArray(info)) { rec.ok = false; rec.err = "nopayload"; return rec; }
    rec.ok = true;
    rec.n = info.length;
    rec.x = {
      lastBusType: j.data?.lastBusType ?? null,
      badCar: j.data?.badCar ?? null,
      lastBusPlate: j.data?.lastBusPlate ?? null,
      toBeginBus: j.data?.toBeginBus ?? null,
      busColor: j.data?.busColor ?? null,
    };
    if (opts.withSeq) rec.staSeq = info.map((st) => (st?.staCode != null ? String(st.staCode) : null));
    const veh = [];
    for (let i = 0; i < info.length; i++) {
      const st = info[i];
      const code = st?.staCode != null ? String(st.staCode) : null;
      const list = st?.busInfo;
      if (!Array.isArray(list)) continue;
      for (const b of list) {
        veh.push({
          idx: i,
          sta: code,
          main: mainCode(code),
          plate: String(b.busPlate ?? "?").trim(),
          status: String(b.status ?? "?"),
          busType: b.busType != null ? String(b.busType) : null,
          busCode: b.busCode != null ? String(b.busCode) : null,
          fac: b.isFacilities != null ? String(b.isFacilities) : null,
          flow: b.passengerFlow != null ? String(b.passengerFlow) : null,
          speed: b.speed != null ? String(b.speed) : null,
        });
      }
    }
    rec.veh = veh;
    return rec;
  } catch (e) {
    rec.ms = Date.now() - t0;
    rec.ok = false;
    const msg = String(e?.message || e);
    rec.err = /abort|timeout/i.test(msg) ? "timeout" : `net:${msg.slice(0, 50)}`;
    return rec;
  }
}

/** 并发池：tasks 已按时间排好，每项等到自己的时刻再发 */
async function runPool(tasks, limit, worker) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (true) {
        const k = i++;
        if (k >= tasks.length) break;
        const task = tasks[k];
        const wait = task.at - Date.now();
        if (wait > 0) await sleep(wait);
        await worker(task);
      }
    }),
  );
}

// ════════════════════════════ 3. 轮询计划 ════════════════════════════

async function loadPlan() {
  if (!CFG.refreshPlan && fs.existsSync(CFG.planFile)) {
    try {
      const p = JSON.parse(fs.readFileSync(CFG.planFile, "utf8"));
      if (Array.isArray(p?.plan) && p.plan.length) {
        LOG(`📋 复用轮询计划：${CFG.planFile}（${p.fetchedAt}，${p.plan.length} 条，每轮 ${p.perRound} 次请求）`);
        return p;
      }
    } catch (e) {
      LOG(`⚠️ 计划文件读取失败（${e.message}），将现推`);
    }
  }
  LOG("🔎 拉取 DSAT 线路清单…");
  const list = await fetchRouteList();
  if (!list.length) throw new Error("无法获取线路清单");
  const plan = list.map((m) => ({
    code: m.code,
    direction: m.direction,
    dirs: m.direction === "2" ? ["0"] : ["0", "1"],
    stops0: null, stops1: null, buses0: null, buses1: null,
    dupInDir0: null,
    seq: {},
    inferred: true,
  }));
  const perRound = plan.reduce((a, r) => a + r.dirs.length, 0);
  LOG(`📋 现推轮询计划：${plan.length} 条 · 每轮 ${perRound} 次请求（未做 dir 实测，如需精确请 --refresh-plan）`);
  return { fetchedAt: new Date().toISOString(), count: plan.length, perRound, plan, inferred: true };
}

async function fetchRouteList() {
  const qs = qsOf({ lang: "zh_tw", device: "web" });
  const res = await fetch(`${CFG.baseUrl}/getRouteAndCompanyList.html`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", token: genToken(qs) },
    body: qs,
    signal: AbortSignal.timeout(CFG.timeoutMs * 3),
  });
  const j = await res.json();
  return (j?.data?.routeList ?? [])
    .map((r) => ({ code: String(r.routeName ?? "").trim(), direction: String(r.direction ?? "") }))
    .filter((r) => r.code && r.code !== "undefined");
}

/** 全量复扫 dir（184 次请求，一次性），并把每线每方向的站序缓存进计划 */
async function refreshPlanSweep(routeMeta) {
  LOG(`🔎 全量复扫 dir（${routeMeta.length * 2} 次请求）…`);
  const t0 = Date.now();
  const out = [];
  await runPool(
    routeMeta.map((m, k) => ({ ...m, at: t0 + k * 120 })),
    4,
    async (m) => {
      const d0 = await fetchRoute(m.code, "0", { withSeq: true });
      const d1 = await fetchRoute(m.code, "1", { withSeq: true });
      const dirs = ["0"];
      if (d1.ok && d1.n > 0) dirs.push("1");
      const seq = {};
      if (d0.ok) seq["0"] = d0.staSeq;
      if (d1.ok && d1.n > 0) seq["1"] = d1.staSeq;
      const mains0 = (d0.staSeq ?? []).map(mainCode).filter(Boolean);
      out.push({
        code: m.code, direction: m.direction, dirs,
        stops0: d0.ok ? d0.n : null, stops1: d1.ok ? d1.n : null,
        buses0: d0.ok ? d0.veh.length : null, buses1: d1.ok ? d1.veh.length : null,
        dupInDir0: mains0.length ? new Set(mains0).size < mains0.length : null,
        seq, inferred: false,
      });
    },
  );
  out.sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
  const perRound = out.reduce((a, r) => a + r.dirs.length, 0);
  LOG(`✅ 复扫完成 ${((Date.now() - t0) / 1000).toFixed(1)}s · 每轮 ${perRound} 次请求`);
  return { fetchedAt: new Date().toISOString(), count: out.length, perRound, plan: out, inferred: false };
}

/** 按优先级排序 + 组装档位 */
function orderRoutes(plan) {
  const byCode = new Map(plan.map((p) => [p.code, p]));
  const ordered = [];
  const used = new Set();
  for (const c of PRIORITY) {
    const p = byCode.get(c);
    if (p) { ordered.push(p); used.add(c); }
  }
  const rest = plan.filter((p) => !used.has(p.code)).sort((a, b) =>
    a.code.localeCompare(b.code, "en", { numeric: true }),
  );
  return [...ordered, ...rest];
}

// ════════════════════════════ 4. 主流程 ════════════════════════════

async function main() {
  LOG(`════ DSAT 全澳追踪式采集 ════ `);
  LOG(`参数：${CFG.minutes} 分钟 · 间隔 ${CFG.intervalSec}s · 并发 ${CFG.pool} · 超时 ${CFG.timeoutMs}ms · 分片 ${CFG.segMinutes} 分钟 · 起始档 ${CFG.stage}`);

  const planFileOnDisk = fs.existsSync(CFG.planFile);
  let planData;
  if (CFG.refreshPlan || !planFileOnDisk) {
    planData = await refreshPlanSweep(await fetchRouteList());
    if (!CFG.dryPlan) {
      fs.mkdirSync(path.dirname(CFG.planFile), { recursive: true });
      fs.writeFileSync(CFG.planFile, JSON.stringify(planData, null, 2), "utf8");
      LOG(`💾 计划已缓存 ${CFG.planFile}`);
    }
  } else {
    planData = await loadPlan();
  }

  const ordered = orderRoutes(planData.plan);
  const needDir1 = ordered.filter((p) => p.dirs.length > 1).map((p) => p.code);
  const perRound = ordered.reduce((a, p) => a + p.dirs.length, 0);

  LOG(`线路 ${ordered.length} 条 · 其中需双方向 ${needDir1.length} 条（${needDir1.join(",")}）`);
  LOG(`每轮请求数 ${perRound} · 5 秒间隔 → ${(perRound / CFG.intervalSec).toFixed(1)} 次/秒`);
  LOG(`A 组（前 ${A_GROUP_SIZE} 条，真缺段所在）：${ordered.slice(0, A_GROUP_SIZE).map((p) => p.code).join(",")}`);

  // 档位时间线（渐变分钟数按总时长收敛，保证「合计 = --minutes」）
  const stages = [];
  let remaining = CFG.minutes;
  for (let s = 0; s < 3; s++) {
    const cnt = Math.min(STAGE_ROUTE_COUNT[s], ordered.length);
    const mins = Math.max(0, Math.min(CFG.ramp[s] ?? 0, remaining));
    remaining -= mins;
    stages.push({ stage: s, routeCount: cnt, minutes: mins, reqsPerRound: ordered.slice(0, cnt).reduce((a, p) => a + p.dirs.length, 0) });
  }
  stages.push({ stage: 3, routeCount: ordered.length, minutes: Math.max(0, remaining), reqsPerRound: perRound });
  if (CFG.stage === "auto" && CFG.minutes < (CFG.ramp[0] + CFG.ramp[1] + CFG.ramp[2]))
    LOG(`⚠️ 总时长 ${CFG.minutes} 分钟 < 渐变 ${CFG.ramp.join("+")} 分钟，已按比例压缩（可能跑不到全速档）`);
  if (CFG.stage !== "auto") LOG(`⏭ --stage=${CFG.stage}：跳过渐变，直接起于档 ${CFG.stage}`);

  if (CFG.stage === "auto") {
    LOG(`渐变时间线：`);
    for (const s of stages)
      LOG(`   档${s.stage}｜${s.routeCount} 条｜${s.reqsPerRound} 请求/轮｜${(s.reqsPerRound / CFG.intervalSec).toFixed(1)} 次/秒｜${s.minutes} 分钟`);
    LOG(`   合计 ${stages.reduce((a, s) => a + s.minutes, 0)} 分钟`);
  } else {
    const s0 = Number(CFG.stage);
    LOG(`档${s0}｜${Math.min(STAGE_ROUTE_COUNT[s0], ordered.length)} 条｜${stages[s0].reqsPerRound} 请求/轮｜${(stages[s0].reqsPerRound / CFG.intervalSec).toFixed(1)} 次/秒｜持续 ${CFG.minutes} 分钟`);
  }

  if (CFG.dryPlan) {
    LOG("--dry-plan：仅打印计划，未发任何请求。");
    fs.mkdirSync(CFG.out, { recursive: true });
    fs.writeFileSync(path.join(CFG.out, `dry-plan-${stamp}.json`), JSON.stringify({ cfg: CFG, stages, perRound, needDir1 }, null, 2), "utf8");
    return;
  }

  // ── 开始采集 ──
  const runStartMs = Date.now();
  fs.mkdirSync(CFG.out, { recursive: true });
  const writer = new SegmentWriter(CFG.out, stamp, CFG.segMinutes);
  writer.start();
  const health = new Health();
  const roundSamples = [];
  const healthSamples = [];
  const stageLog = [];

  let seq = 0;
  let round = 0;
  let startStage = CFG.stage === "auto" ? 0 : Number(CFG.stage);
  let curStage = Math.max(0, Math.min(3, startStage));
  let intervalMs = CFG.intervalSec * 1000;
  const baseInterval = intervalMs;
  let intervalStep = 0;               // 0=5s 1=10s 2=20s
  let baselineP50 = 0;                // ★ 每个档位单独取基线（低负载档的延迟不能当全速档的基准，
  let baselineStage = -1;             //    否则升档后延迟自然上升会误触发降级 —— 自检 B 暴露）
  // ★ 延迟降级防误触发（详见文件头「延迟降级的防误触发」）
  const LATENCY_MULT = 5;             //   倍数阈值（原 3× 太松）
  const LATENCY_FLOOR_MS = 80;        //   绝对地板：p50 必须超过它才可能是真异常
  const LATENCY_STRIKES_NEEDED = 3;   //   需连续 N 个窗口都超阈值
  const STAGE_COOLDOWN_MS = 90 * 1000;//   升档后冷静期，期间不因延迟降级
  let latencyStrikes = 0;             //   连续超阈值计数（一恢复就清零）
  let degraded = false;
  let aborted = null;
  let lastSignalTs = "";

  const finishAt = Date.now() + CFG.minutes * 60 * 1000;
  let stageStartMs = Date.now();
  stageLog.push({ stage: curStage, at: new Date().toISOString(), reason: "start" });

  const onSignal = async (sig) => {
    LOG(`⚠️ 收到 ${sig}，收尾落盘…`);
    aborted = `signal:${sig}`;
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  let roundStart = Date.now();
  while (Date.now() < finishAt && !aborted) {
    // ── 档位轮转（仅在渐变期，且未被降级）──
    if (!degraded && curStage < 3) {
      const elapsedMin = (Date.now() - stageStartMs) / 60000;
      if (elapsedMin >= (stages[curStage].minutes || 0)) {
        // 放行条件：窗口够大且失败率 = 0（不达标就原地停，不硬闯）
        const ready = health.win.length >= 20 && health.winFailRate === 0;
        if (ready) {
          curStage++;
          stageLog.push({ stage: curStage, at: new Date().toISOString(), reason: `档${curStage - 1}达标放行（失败率 0%）` });
          LOG(`⬆️ 升档 → 档${curStage}（${Math.min(STAGE_ROUTE_COUNT[curStage], ordered.length)} 条）`);
          health.win.length = 0;
          health._heldOnce = false;
          latencyStrikes = 0;
          stageStartMs = Date.now();
        } else if (!health._heldOnce) {
          health._heldOnce = true;
          LOG(`⏸ 档${curStage} 未达标（失败率 ${(health.winFailRate * 100).toFixed(1)}%，样本 ${health.win.length}）→ 原地停留`);
        }
      }
    }

    const activeRoutes = ordered.slice(0, Math.min(STAGE_ROUTE_COUNT[curStage], ordered.length));
    const reqs = [];
    for (const p of activeRoutes) for (const d of p.dirs) reqs.push({ route: p.code, dir: d });

    const slot = intervalMs / reqs.length;
    const tasks = reqs.map((r, k) => ({
      ...r,
      at: roundStart + k * slot + (Math.random() * 2 - 1) * slot * 0.25,
    }));

    round++;
    const roundT0 = Date.now();
    let okN = 0, failN = 0;

    await runPool(tasks, CFG.pool, async (task) => {
      const rec = await fetchRoute(task.route, task.dir);
      seq++;
      rec.seq = seq; rec.round = round; rec.stage = curStage;
      writer.write(rec);
      health.push(!!rec.ok, rec.ms ?? 0);
      if (rec.ok) {
        okN++;
        if (curStage !== baselineStage) { baselineStage = curStage; baselineP50 = 0; }
        if (baselineP50 === 0 && health.win.length >= 100) {
          baselineP50 = health.winP50;
          LOG(`📏 档${curStage} 基线延迟 p50 = ${baselineP50}ms（本档前 100 次成功请求）`);
        }
      } else {
        failN++;
        if (failN <= 3) LOG(`   ✗ ${task.route}/d${task.dir} ${rec.err}${rec.hdr ? ` hdr=${rec.hdr}` : ""}`);
      }
    });

    const roundMs = Date.now() - roundT0;
    roundSamples.push({ round, stage: curStage, intervalMs, reqs: reqs.length, ok: okN, fail: failN, ms: roundMs });

    // ── 每 6 轮（≈30s）打一条健康度 ──
    if (round % 6 === 0) {
      const hs = {
        at: new Date().toISOString(), round, stage: curStage, intervalMs,
        done: seq, okRate: (1 - health.fail / health.total) * 100,
        winFailRate: health.winFailRate * 100, p50: health.winP50, p95: health.winP95,
        consecFail: health.consecFail, roundMs,
      };
      healthSamples.push(hs);
      LOG(`♥ 轮${round} 档${curStage} 间隔${intervalMs / 1000}s 请求${seq} 累计成功率${hs.okRate.toFixed(2)}% 窗失败率${hs.winFailRate.toFixed(1)}% p50=${hs.p50}ms p95=${hs.p95}ms 轮耗时${roundMs}ms`);
    }

    // ── 降级判定 ──
    if (health.consecFail >= 10) {
      aborted = `连续失败 ${health.consecFail} 次 → 硬熔断`;
      LOG(`🛑 ${aborted}`);
      break;
    }
    if (health.win.length >= 50 && health.winFailRate > 0.05) {
      if (curStage > 0) {
        degraded = true;
        const prev = curStage;
        curStage = Math.max(0, curStage - 1);
        stageLog.push({ stage: curStage, at: new Date().toISOString(), reason: `窗失败率 ${(health.winFailRate * 100).toFixed(1)}% > 5%，从档${prev}降档` });
        LOG(`🔻 降档 档${prev} → 档${curStage}（窗失败率 ${(health.winFailRate * 100).toFixed(1)}%）`);
        health.win.length = 0;
        latencyStrikes = 0;
        stageStartMs = Date.now();
      } else if (intervalStep < 2) {
        intervalStep++;
        intervalMs = baseInterval * 2 ** intervalStep;
        stageLog.push({ stage: curStage, at: new Date().toISOString(), reason: `档0 仍 >5%，间隔放宽至 ${intervalMs / 1000}s` });
        LOG(`🐌 间隔放宽 ${intervalMs / 1000}s（窗失败率 ${(health.winFailRate * 100).toFixed(1)}%）`);
        health.win.length = 0;
      } else {
        aborted = "档0 且间隔已 20s，失败率仍 >5% → 中止";
        LOG(`🛑 ${aborted}`);
        break;
      }
    }
    // ★ 延迟异常 → 放宽间隔（三层加固，2026-09-13 首轮误降级后修订）
    //    ① 5× 基线 + 绝对地板 80ms  ② 连续 3 个窗口  ③ 升档后 90 秒冷静期
    if (health.win.length >= 50 && baselineP50 > 0 && intervalStep < 2) {
      const overMult = health.winP50 > baselineP50 * LATENCY_MULT;
      const overFloor = health.winP50 > LATENCY_FLOOR_MS;
      const cooled = Date.now() - stageStartMs >= STAGE_COOLDOWN_MS;
      if (overMult && overFloor && cooled) {
        latencyStrikes++;
        if (latencyStrikes < LATENCY_STRIKES_NEEDED)
          LOG(`⋯ 延迟偏高第 ${latencyStrikes}/${LATENCY_STRIKES_NEEDED} 个窗口（p50 ${health.winP50}ms vs 基线 ${baselineP50}ms），暂不放宽`);
      } else latencyStrikes = 0;
      if (latencyStrikes >= LATENCY_STRIKES_NEEDED) {
        intervalStep++;
        intervalMs = baseInterval * 2 ** intervalStep;
        stageLog.push({ stage: curStage, at: new Date().toISOString(), reason: `连续 ${LATENCY_STRIKES_NEEDED} 个窗口 p50 ${health.winP50}ms > ${LATENCY_MULT}× 基线 ${baselineP50}ms（且 >${LATENCY_FLOOR_MS}ms），间隔放宽至 ${intervalMs / 1000}s` });
        LOG(`🐌 延迟异常（连续 ${LATENCY_STRIKES_NEEDED} 窗口）→ 间隔放宽 ${intervalMs / 1000}s（p50 ${health.winP50}ms vs 基线 ${baselineP50}ms）`);
        latencyStrikes = 0;
        health.win.length = 0;
      }
    } else latencyStrikes = 0;

    // ── 下一轮起点 ──
    roundStart += intervalMs;
    if (roundStart < Date.now() - intervalMs) {
      // 落后超过一轮 → 丢掉欠账，重新对齐（避免雪崩追赶）
      LOG(`⚠️ 轮${round} 耗时 ${roundMs}ms 超出间隔，调度重对齐`);
      roundStart = Date.now();
    } else if (roundStart > Date.now()) {
      await sleep(Math.min(roundStart - Date.now(), 2000));
    }
  }

  LOG(`⏳ 收尾：flush 落盘（剩余队列 ${writer.queue.length}）…`);
  await writer.finish();
  LOG(`✅ 收尾：落盘完成，开始写 meta…`);

  // ── 收尾 ──
  const meta = {
    stamp,
    startedAt: new Date(runStartMs).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMin: Number(((Date.now() - runStartMs) / 60000).toFixed(2)),
    aborted,
    cfg: CFG,
    planSource: { fetchedAt: planData.fetchedAt, count: planData.count, perRound: planData.perRound, inferred: !!planData.inferred },
    routeOrder: ordered.map((p) => p.code),
    needDir1,
    stages,
    stageLog,
    totals: {
      rounds: round,
      requests: health.total,
      failed: health.fail,
      failRatePct: health.total ? (health.fail / health.total) * 100 : 0,
      intervalFinalMs: intervalMs,
      roundMsP50: roundSamples.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(roundSamples.length / 2)] ?? null,
      roundMsMax: roundSamples.length ? Math.max(...roundSamples.map((r) => r.ms)) : null,
      gzBytes: writer.bytes,
      parts: writer.files,
    },
    healthSamples,
    roundSamples,
  };
  fs.writeFileSync(path.join(CFG.out, `${stamp}-meta.json`), JSON.stringify(meta, null, 2), "utf8");
  fs.writeFileSync(path.join(CFG.out, `${stamp}-run.log`), logLines.join("\n") + "\n", "utf8");

  LOG(`════ 采集结束 ════`);
  LOG(`轮次 ${round} · 请求 ${health.total} 次 · 失败 ${health.fail} 次（${meta.totals.failRatePct.toFixed(2)}%）`);
  LOG(`轮耗时 p50 ${meta.totals.roundMsP50}ms / max ${meta.totals.roundMsMax}ms · 间隔终值 ${intervalMs / 1000}s`);
  LOG(`gzip 落盘 ${(writer.bytes / 1048576).toFixed(2)} MB · ${writer.files.length} 片`);
  LOG(`中止原因：${aborted ?? "正常到时结束"}`);
  LOG(`产物：${writer.files.join("  ")}`);
  LOG(`      ${stamp}-meta.json  ${stamp}-run.log`);
}

/** 任何路径下都要留下一份日志（未捕获异常会绕过 main().catch） */
function dumpLog(tag, e) {
  logLines.push(`❌ ${tag} ${e?.stack || e?.message || e}`);
  try {
    fs.mkdirSync(CFG.out, { recursive: true });
    fs.writeFileSync(path.join(CFG.out, `${stamp}-run.log`), logLines.join("\n") + "\n", "utf8");
  } catch { /* 尽力而为 */ }
}
process.on("uncaughtException", (e) => { dumpLog("UNCAUGHT", e); console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { dumpLog("UNHANDLED_REJECTION", e); console.error(e); process.exit(1); });

main().catch((e) => {
  dumpLog("FATAL", e);
  console.error(e);
  process.exit(1);
});
