/**
 * DSAT 全澳巴士「追踪式计时」自动采集器（scripts/track-collect.mjs）
 *
 * 定位：只读采集器。**不写数据库、不改 src/**，只把 DSAT 实时报站原始帧落盘
 *       gzip，供 scripts/track-derive.mjs 事后算「离开 A → 离开 B」的站间时长。
 *
 * 合规：请求带**可识别 UA**（见下方 USER_AGENT）——不伪装浏览器、不隐藏身份、注明用途。
 *       依据 docs/数据来源合规备忘-20260914.md（DSAT 使用條款：非商業 · 注明來源 · 不得修改內容）。
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
 *   --dry-plan                  # 只打印计划，不发请求
 *   node scripts/track-collect.mjs --selftest                  # 护栏自检（离线，0 请求）
 *   node scripts/track-collect.mjs --minutes=2 --stage=3       # 2 分钟全速冒烟（真发请求）
 *   node scripts/track-collect.mjs --minutes=30                # 正式一轮（含渐变启动）
 *
 * ── 参数 ──
 *   --minutes=30        总时长（含渐变期）
 *   --interval=5        基准轮询间隔（秒）
 *   --pool=6            并发请求上限
 *   --timeout=3000      单请求超时（毫秒）
 *   --stage=auto|0|1|2|3  起始档；auto=从档0渐变；给 3 则跳过渐变直接全速
 *   --ramp=3,3,5        档0/1/2 各持续分钟（档3 吃掉剩余全部时间）
 *   --recover-hold=180  降档后恢复期：每档需稳定停留的秒数（默认 180）
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
 * ── 安全机制（渐变启动 + 降级阶梯 + 恢复 + 硬熔断）──
 *   渐变：档0(8条)→档1(24)→档2(48)→档3(92)，每档须「失败率=0 且延迟稳定」才放行
 *   降级：滑动窗口**有效**失败率 > 5% **且有效失败数 ≥ 5** → 降一档
 *         滑动窗口 p50 延迟异常 → 间隔 5s→10s→20s（单向）
 *   恢复：降档后**逐级升回**——每档须稳定停留 `--recover-hold`（默认 180 秒）且窗口零失败
 *   熔断：连续失败 ≥ 10 次 → 立即中止整轮并落盘收尾
 *
 * ── 降档护栏四修（v0.27.4，依据第六轮误降档事故 · DETAILS §D）──
 *   第六轮现象：同一秒 3 个目标（3/d0、3/d1、3X/d0）同时 timeout → 旧窗口 3/50 = 6.0% > 5%
 *   → 降档；且旧代码 `degraded` 一次置 true 即**永久锁死**，此后 19.5 分钟钉在档1（只覆盖 24/92 条线）。
 *   根因 = **本机瞬时停顿 ~3 秒**（p50 全程 13~17ms 纹丝不动 · 失败全为 timeout · 零 net:fetch failed）
 *   → 四个缺陷，逐一修：
 *     ① **降档可恢复**：`degraded` 由「永久锁」改为「恢复模式」标志 —— 降档后按恢复节奏逐级升回档3
 *     ② **绝对失败数下限**：降档须同时满足 `失败率 > 5%` **且 `窗口失败数 ≥ FAIL_MIN_COUNT(5)`**
 *        （旧逻辑只按比例 → 小分母下 3 个失败即触发，且高档位下 50 请求只相当于 0.44 轮）
 *     ③ **窗口改「最近 90 秒」时间制**（原「最近 50 个请求」）→ 灵敏度与档位无关，恒定
 *     ④ **同秒突发豁免**：同一秒内 ≥3 个不同目标失败、且窗口 p50 未超基线 2× → 判**客户端瞬时停顿**，
 *        该簇失败不参与降档判定（计入总数与日志，只豁免「降档」这一个决定）
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

// ── DSAT 请求的 User-Agent（合规自证，v0.27.3）──────────────────────────
// 本脚本刻意不 import src/（见文件头），故此处内联复刻 src/lib/dsat/ua.ts 的同一格式：
// 产品名/版本 + (+项目说明页) + 用途；版本号随 package.json 自动同步。
// ❌ 不伪装成浏览器 · ❌ 不写 bot/crawler/spider 字样 · ❌ 不放中文或 emoji · ❌ 不放个人邮箱
// 依据：docs/数据来源合规备忘-20260914.md §七 #1 —— **改格式时两处都要改**。
const PKG_VERSION = JSON.parse(fs.readFileSync(path.resolve(ROOT, "package.json"), "utf8")).version;
const USER_AGENT = `MUSTDengxiao/${PKG_VERSION} (+https://musttoukou.vercel.app; personal non-commercial)`;

const CFG = {
  minutes: Number(arg("minutes", "30")),
  intervalSec: Number(arg("interval", "5")),
  pool: Number(arg("pool", "6")),
  timeoutMs: Number(arg("timeout", "3000")),
  stage: arg("stage", "auto"),
  ramp: String(arg("ramp", "3,3,5")).split(",").map(Number),
  recoverHoldSec: Number(arg("recover-hold", "180")),
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

/** 健康度：**时间**滑动窗口（默认最近 90 秒）+ 熔断判定
 *  ★ v0.27.4：原「最近 50 个请求」的计数窗口在档案高时只相当于 0.44 轮 → 一轮里 3 个失败即触发降档；
 *    改为**时间制**后，窗口内样本数随档位自然伸缩，**灵敏度恒定**。 */
const WIN_MS = 90 * 1000;        // 窗口时长（毫秒）
const WIN_MAX_HARD = 4000;       // 窗口内最多保留条数（档3 ≈ 2030 条/90s，留足余量）

// ── 降档判定参数（v0.27.4 · 见文件头「降档护栏四修」）──
const FAIL_RATE_LIMIT = 0.05;    // 有效失败率上限（> 即降档候选）
const FAIL_MIN_COUNT = 5;        // ★ ② 绝对失败数下限 —— 两个条件都满足才降档
const WIN_MIN_SAMPLES = 50;      // 窗口样本数下限（不够就不判，避免刚启动误判）
const CLIENT_BURST_TARGETS = 3;  // ★ ④ 同秒突发豁免：同一秒内 ≥ N 个不同目标失败
const CLIENT_BURST_P50_MULT = 2; // ★ ④ 且窗口 p50 ≤ 基线 × N（服务端未变慢）才算客户端侧
class Health {
  constructor() {
    this.win = [];          // {ok, ms, at, tgt}
    this.consecFail = 0;
    this.total = 0;
    this.fail = 0;
  }
  push(ok, ms, tgt = "") {
    this.total++;
    if (!ok) this.fail++;
    this.consecFail = ok ? 0 : this.consecFail + 1;
    this.win.push({ ok, ms, at: Date.now(), tgt });
    this.prune();
  }
  /** 丢掉过期样本（时间窗）并按硬上限截断 */
  prune(now = Date.now()) {
    const cut = now - WIN_MS;
    let i = 0;
    while (i < this.win.length && this.win[i].at < cut) i++;
    if (i) this.win.splice(0, i);
    if (this.win.length > WIN_MAX_HARD) this.win.splice(0, this.win.length - WIN_MAX_HARD);
  }
  reset() { this.win.length = 0; }
  get winLen() { return this.win.length; }
  get winFail() { let n = 0; for (const x of this.win) if (!x.ok) n++; return n; }
  get winFailRate() { return this.win.length ? this.winFail / this.win.length : 0; }
  get winP50() {
    const v = this.win.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  }
  get winP95() {
    const v = this.win.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
    return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] : 0;
  }
}

/**
 * 同秒突发豁免（v0.27.4）：把「同一秒内 ≥ CLIENT_BURST_TARGETS 个**不同目标**（线路×方向）同时失败」
 * 且**服务端 p50 未抬升**的失败，判为**客户端瞬时停顿**，不计入降档判定。
 *
 * 依据（第六轮实况）：网络层若被限流/拒绝会拿到 HTTP 响应，而实测失败全是 3000ms 超时 +
 * 零 net:fetch failed；服务端若拥塞必然同步抬高 p50，而实测 p50 全程 13~17ms 纹丝不动
 * → 只可能是本机一次停顿同时打断多个在途请求（pool=6 + 3000ms 超时）。
 *
 * ⚠️ 只豁免「降档」这一个决定：失败照常计入 totals、照常写日志、0 次豁免时行为与旧版完全一致。
 * @returns {{exempt:number, bursts:number[], p50:number}}
 */
function clientStallExempt(win, baselineP50) {
  const bySec = new Map();
  for (const e of win) {
    if (e.ok) continue;
    const sec = Math.floor(e.at / 1000);
    let s = bySec.get(sec);
    if (!s) { s = new Set(); bySec.set(sec, s); }
    s.add(e.tgt);
  }
  const bursts = [];
  for (const [sec, set] of bySec) if (set.size >= CLIENT_BURST_TARGETS) bursts.push(sec);
  if (!bursts.length) return { exempt: 0, bursts: [], p50: 0 };
  const v = win.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
  const p50 = v.length ? v[Math.floor(v.length / 2)] : 0;
  // 服务端若同步变慢 → 不是客户端侧，不豁免
  if (baselineP50 > 0 && p50 > baselineP50 * CLIENT_BURST_P50_MULT) return { exempt: 0, bursts: [], p50 };
  const burstSet = new Set(bursts);
  let exempt = 0;
  for (const e of win) if (!e.ok && burstSet.has(Math.floor(e.at / 1000))) exempt++;
  return { exempt, bursts, p50 };
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
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT, token },
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
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT, token: genToken(qs) },
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

// ════════════════════════════ 3.5 护栏自检（--selftest · 零网络请求）════════════════════════════

/**
 * 护栏自检：用**合成窗口**复现「第六轮误降档（2026-09-14 12:01）」并验证四修生效。
 * 纯离线 —— 0 网络请求、0 落盘，可随时跑：`node scripts/track-collect.mjs --selftest`
 */
function selfTest() {
  const T = Math.floor(Date.now() / 1000) * 1000;   // 对齐整秒，便于构造「同一秒」
  const okAt = (at, tgt, ms = 14) => ({ ok: true, ms, at, tgt });
  const failAt = (at, tgt) => ({ ok: false, ms: 3000, at, tgt });
  const rows = [];
  const check = (name, got, want) => {
    const pass = got === want;
    rows.push(`${pass ? "✅" : "❌"} ${name}　得 ${got}　期望 ${want}`);
    return pass;
  };

  // ① 第六轮实况：50 样本、同一秒 3 个不同目标（3/d0 · 3/d1 · 3X/d0）超时、p50 与基线持平 14ms
  {
    const w = [];
    for (let i = 0; i < 47; i++) w.push(okAt(T - (90 - i) * 1000, `R${i}/d0`));
    const sec = T - 30 * 1000;
    w.push(failAt(sec + 120, "3/d0"), failAt(sec + 240, "3/d1"), failAt(sec + 360, "3X/d0"));
    const ex = clientStallExempt(w, 14);
    const rawFail = w.filter((x) => !x.ok).length;
    check("① 同秒 3 目标突发 → 全部豁免", ex.exempt, 3);
    check("① 窗口原始失败率 6.0% > 5%（旧逻辑会降档）", rawFail / w.length > FAIL_RATE_LIMIT, true);
    check("① 有效失败 0 < FAIL_MIN_COUNT → 不降档", rawFail - ex.exempt < FAIL_MIN_COUNT, true);
  }
  // ② 真拥塞：5 个失败分散在 5 个不同秒（不成簇）→ 不豁免，且够 5 个下限 → 应降档
  {
    const w = [];
    for (let i = 0; i < 45; i++) w.push(okAt(T - (90 - i) * 1000, `R${i}/d0`));
    for (let k = 0; k < 5; k++) w.push(failAt(T - (60 - k * 8) * 1000, `S${k}/d0`));
    const ex = clientStallExempt(w, 14);
    const eff = w.filter((x) => !x.ok).length - ex.exempt;
    check("② 分散失败 → 0 豁免", ex.exempt, 0);
    check("② 有效失败 5 ≥ FAIL_MIN_COUNT", eff >= FAIL_MIN_COUNT, true);
    check("② 有效失败率 10% > 5% → 判定降档", eff / w.length > FAIL_RATE_LIMIT, true);
  }
  // ③ 同秒 3 目标突发，但**服务端 p50 抬到 60ms**（> 基线 14 × 2）→ 判服务端变慢 → 不豁免
  {
    const w = [];
    for (let i = 0; i < 47; i++) w.push(okAt(T - (90 - i) * 1000, `R${i}/d0`, 60));
    const sec = T - 30 * 1000;
    w.push(failAt(sec + 120, "3/d0"), failAt(sec + 240, "3/d1"), failAt(sec + 360, "3X/d0"));
    const ex = clientStallExempt(w, 14);
    check("③ p50 抬升 60ms > 基线×2 → 不豁免", ex.exempt, 0);
  }
  // ④ 绝对下限：同秒 3 个突发（豁免）+ 另有 1 个分散失败 → 有效 1 个 < 5 → 不降档
  {
    const w = [];
    for (let i = 0; i < 46; i++) w.push(okAt(T - (90 - i) * 1000, `R${i}/d0`));
    const sec = T - 30 * 1000;
    w.push(failAt(sec + 120, "3/d0"), failAt(sec + 240, "3/d1"), failAt(sec + 360, "3X/d0"));
    w.push(failAt(T - 70 * 1000, "Z/d0"));
    const ex = clientStallExempt(w, 14);
    const eff = w.filter((x) => !x.ok).length - ex.exempt;
    check("④ 豁免 3、有效 1 < 5 → 不降档（小分母不再误触发）", eff < FAIL_MIN_COUNT, true);
  }
  // ⑤ 时间窗裁剪：窗口外的旧样本必须被 prune 掉（旧实现是「最近 N 个请求」，与时间无关）
  {
    const h = new Health();
    for (let i = 0; i < 80; i++) h.push(true, 14, `R${i}/d0`);
    for (let i = 0; i < 20; i++) h.win.unshift({ ok: true, ms: 14, at: Date.now() - 200 * 1000, tgt: `OLD${i}/d0` });
    h.prune();
    check("⑤ 窗口外 20 个旧样本被裁掉 → 80", h.winLen, 80);
    check("⑤ 窗口内失败数统计正确 → 0", h.winFail, 0);
  }
  // ⑥ 恢复常量可被 --recover-hold 覆盖且不小于 30 秒（防误配成 0 导致抖动）
  {
    check("⑥ RECOVER_HOLD_MS ≥ 30s", Math.max(30, CFG.recoverHoldSec) * 1000 >= 30000, true);
  }

  const bad = rows.filter((r) => r.startsWith("❌")).length;
  console.log("════ 降档护栏自检（--selftest · 0 网络请求）════");
  console.log(`窗口 ${WIN_MS / 1000}s · 失败率上限 ${FAIL_RATE_LIMIT * 100}% · 绝对下限 ${FAIL_MIN_COUNT} 个 · 同秒突发目标数 ≥${CLIENT_BURST_TARGETS} · p50 倍数 ${CLIENT_BURST_P50_MULT}× · 恢复停留 ${CFG.recoverHoldSec}s`);
  for (const r of rows) console.log(r);
  console.log(bad ? `\n❌ 自检未通过：${bad} 项` : `\n✅ 自检全绿（${rows.length} 项）`);
  process.exitCode = bad ? 1 : 0;
}

// ════════════════════════════ 4. 主流程 ════════════════════════════

async function main() {
  if (has("selftest")) { selfTest(); return; }
  LOG(`════ DSAT 全澳追踪式采集 ════ `);
  LOG(`参数：${CFG.minutes} 分钟 · 间隔 ${CFG.intervalSec}s · 并发 ${CFG.pool} · 超时 ${CFG.timeoutMs}ms · 分片 ${CFG.segMinutes} 分钟 · 起始档 ${CFG.stage}`);
  LOG(`护栏：窗口 ${WIN_MS / 1000}s · 有效失败率 >${FAIL_RATE_LIMIT * 100}% 且 ≥${FAIL_MIN_COUNT} 个才降档 · 降档后每档稳定 ${CFG.recoverHoldSec}s 即逐级恢复 · 同秒 ≥${CLIENT_BURST_TARGETS} 目标突发且 p50 未超基线 ${CLIENT_BURST_P50_MULT}× → 豁免`);
  LOG(`UA：${USER_AGENT}`);

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
  // ★ v0.27.4：`degraded` 语义由「永久锁」改为「恢复模式」——降档后仍可逐级升回档3
  let degraded = false;               //   是否已触发过降档（此后走恢复节奏而非渐变节奏）
  const RECOVER_HOLD_MS = Math.max(30, CFG.recoverHoldSec) * 1000; // 恢复期每档需稳定停留的时长
  let exemptTotal = 0;                //   累计「同秒突发豁免」的失败数（仅豁免降档判定，总数照记）
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
    // ── 档位轮转（渐变期 或 降档后的恢复期）──
    //  ★ v0.27.4：两者用同一套逻辑，只差「每档需停留多久」与日志措辞 ——
    //    渐变期按 --ramp 分钟；恢复期按 --recover-hold 秒（默认 180）。都要求窗口够大且失败率 = 0。
    const rampMode = !degraded && curStage < 3;
    const recoverMode = degraded && curStage < 3;
    if (rampMode || recoverMode) {
      const holdMs = rampMode ? (stages[curStage].minutes || 0) * 60000 : RECOVER_HOLD_MS;
      if (Date.now() - stageStartMs >= holdMs) {
        const ready = health.winLen >= 20 && health.winFailRate === 0;
        if (ready) {
          const from = curStage;
          curStage++;
          stageLog.push({
            stage: curStage, at: new Date().toISOString(),
            reason: rampMode
              ? `档${from}达标放行（失败率 0%）`
              : `恢复升档：档${from} 稳定 ${(RECOVER_HOLD_MS / 1000).toFixed(0)}s 且失败率 0%`,
          });
          LOG(`${rampMode ? "⬆️ 升档" : "🔁 恢复升档"} → 档${curStage}（${Math.min(STAGE_ROUTE_COUNT[curStage], ordered.length)} 条）`);
          health.reset();
          health._heldOnce = false;
          latencyStrikes = 0;
          stageStartMs = Date.now();
        } else if (!health._heldOnce) {
          health._heldOnce = true;
          LOG(`⏸ 档${curStage} 未达标（失败率 ${(health.winFailRate * 100).toFixed(1)}%，样本 ${health.winLen}）→ 原地停留`);
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
      health.push(!!rec.ok, rec.ms ?? 0, `${task.route}/d${task.dir}`);
      if (rec.ok) {
        okN++;
        if (curStage !== baselineStage) { baselineStage = curStage; baselineP50 = 0; }
        if (baselineP50 === 0 && health.winLen >= 100) {
          baselineP50 = health.winP50;
          LOG(`📏 档${curStage} 基线延迟 p50 = ${baselineP50}ms（本档前 100 次成功请求）`);
        }
      } else {
        failN++;
        if (failN <= 3) LOG(`   ✗ ${task.route}/d${task.dir} ${rec.err}${rec.hdr ? ` hdr=${rec.hdr}` : ""}`);
      }
    });

    const roundMs = Date.now() - roundT0;
    health.prune();   // ★ v0.27.4：时间窗 —— 判定前先丢掉过期样本
    roundSamples.push({ round, stage: curStage, intervalMs, reqs: reqs.length, ok: okN, fail: failN, ms: roundMs });

    // ── 每 6 轮（≈30s）打一条健康度 ──
    if (round % 6 === 0) {
      const hs = {
        at: new Date().toISOString(), round, stage: curStage, intervalMs,
        done: seq, okRate: (1 - health.fail / health.total) * 100,
        winFailRate: health.winFailRate * 100, p50: health.winP50, p95: health.winP95,
        consecFail: health.consecFail, roundMs,
        winLen: health.winLen, winFail: health.winFail,   // ★ v0.27.4：窗口透明度
      };
      healthSamples.push(hs);
      LOG(`♥ 轮${round} 档${curStage} 间隔${intervalMs / 1000}s 请求${seq} 累计成功率${hs.okRate.toFixed(2)}% 窗失败率${hs.winFailRate.toFixed(1)}%（${hs.winFail}/${hs.winLen}） p50=${hs.p50}ms p95=${hs.p95}ms 轮耗时${roundMs}ms`);
    }

    // ── 降级判定 ──
    if (health.consecFail >= 10) {
      aborted = `连续失败 ${health.consecFail} 次 → 硬熔断`;
      LOG(`🛑 ${aborted}`);
      break;
    }
    if (health.winLen >= WIN_MIN_SAMPLES && health.winFailRate > FAIL_RATE_LIMIT) {
      // ★ v0.27.4 ②：绝对失败数下限　★ ④：同秒突发豁免（客户端瞬时停顿不算数）
      const ex = clientStallExempt(health.win, baselineP50);
      const effFail = health.winFail - ex.exempt;
      const effRate = health.winLen ? effFail / health.winLen : 0;
      if (ex.exempt) {
        exemptTotal += ex.exempt;
        LOG(`🙈 同秒突发豁免 ${ex.exempt} 个失败（秒=${ex.bursts.join("·")}｜窗口 p50 ${ex.p50}ms vs 基线 ${baselineP50}ms 未变慢）`
          + ` → 有效失败 ${effFail}/${health.winLen} = ${(effRate * 100).toFixed(1)}%`);
      }
      if (effFail < FAIL_MIN_COUNT || effRate <= FAIL_RATE_LIMIT) {
        if (!ex.exempt) LOG(`… 失败率 ${(health.winFailRate * 100).toFixed(1)}% 但有效失败 ${effFail} < ${FAIL_MIN_COUNT}（未达绝对下限）→ 不降档`);
      } else if (curStage > 0) {
        degraded = true;   // ★ v0.27.4 ①：进入恢复模式（不再永久锁死）
        const prev = curStage;
        curStage = Math.max(0, curStage - 1);
        stageLog.push({ stage: curStage, at: new Date().toISOString(), reason: `有效失败 ${effFail}/${health.winLen} = ${(effRate * 100).toFixed(1)}% > ${FAIL_RATE_LIMIT * 100}% 且 ≥ ${FAIL_MIN_COUNT} 个，从档${prev}降档（豁免 ${ex.exempt}）` });
        LOG(`🔻 降档 档${prev} → 档${curStage}（有效失败 ${effFail}/${health.winLen} = ${(effRate * 100).toFixed(1)}%，豁免 ${ex.exempt}）`
          + `｜将于稳定 ${(RECOVER_HOLD_MS / 60000).toFixed(1)} 分钟后逐级恢复`);
        health.reset();
        latencyStrikes = 0;
        stageStartMs = Date.now();
      } else if (intervalStep < 2) {
        intervalStep++;
        intervalMs = baseInterval * 2 ** intervalStep;
        stageLog.push({ stage: curStage, at: new Date().toISOString(), reason: `档0 仍 >${FAIL_RATE_LIMIT * 100}%，间隔放宽至 ${intervalMs / 1000}s` });
        LOG(`🐌 间隔放宽 ${intervalMs / 1000}s（有效失败 ${effFail}/${health.winLen} = ${(effRate * 100).toFixed(1)}%）`);
        health.reset();
      } else {
        aborted = `档0 且间隔已 20s，有效失败率仍 >${FAIL_RATE_LIMIT * 100}% → 中止`;
        LOG(`🛑 ${aborted}`);
        break;
      }
    }
    // ★ 延迟异常 → 放宽间隔（三层加固，2026-09-13 首轮误降级后修订）
    //    ① 5× 基线 + 绝对地板 80ms  ② 连续 3 个窗口  ③ 升档后 90 秒冷静期
    //    ★ v0.27.4：窗口已改 90 秒时间制 —— 单个 p95 尖峰更难撼动窗内 p50，误触发概率进一步下降
    if (health.winLen >= WIN_MIN_SAMPLES && baselineP50 > 0 && intervalStep < 2) {
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
        health.reset();
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
    // ★ v0.27.4：把降档护栏参数写进 meta，报告可自解释（旧轮的 meta 无此段）
    guard: {
      winMs: WIN_MS,
      winMaxHard: WIN_MAX_HARD,
      failRateLimit: FAIL_RATE_LIMIT,
      failMinCount: FAIL_MIN_COUNT,
      winMinSamples: WIN_MIN_SAMPLES,
      clientBurstTargets: CLIENT_BURST_TARGETS,
      clientBurstP50Mult: CLIENT_BURST_P50_MULT,
      recoverHoldSec: RECOVER_HOLD_MS / 1000,
      exemptTotal,
    },
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
  if (exemptTotal) LOG(`🙈 同秒突发豁免累计 ${exemptTotal} 次失败（仅不计入降档判定，总数照记）`);
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
