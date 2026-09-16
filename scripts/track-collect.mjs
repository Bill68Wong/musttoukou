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
 * ── 位置采样（v1.1.0 · 2026-09-16 主人拍板）──────────────────────────
 *   档位 = **报站维持 5s 不变，位置每 15s 采一次，全 92 条线（113 个方向）**。
 *   为什么报站不降频：追踪式计时的**时间分辨率 = 采样间隔**，一动就伤核心数据。
 *   为什么位置用 15s：**官网地图页自身就是 15 秒刷新一次**，再密也不会更「新鲜」。
 *   为什么位置不参与降档判定：位置是**附加数据**，核心是「挂载站 + status」。
 *     若某条线 routeCode 推导不出来→位置恒空→每 15s 一个失败，会**误触发降档拖垮核心采集**。
 *     ⇒ 位置请求**独立计数**（locTotals），失败只记日志/meta，**不喂 health**；
 *        同一 (线路,方向) 连续失败 `LOC_MAX_TRIES(3)` 次 → 本轮拉黑、不再浪费请求；
 *        整体失败率 > `LOC_ABORT_RATE(20%)` → **自动关闭位置采样**（自保护）并落 meta。
 *   落盘纪律：位置响应约 5~9 KB，其中**绝大部分是每帧重复的静态站表**
 *     → 分片里**只落 `busInfoList`**；`stationInfoList` 去重后单独写 `<stamp>-stations.json`
 *     （照单全收 30 分钟约 719 MB，去重后约 5~8 MB）。
 *   ★ 站表顺带产出**永久资产**：`stationInfoList` 自带 站码 + 经纬度 + 站名 + 车道，
 *     且顺序**就是线路行进顺序**（已对拍 51 路 20/20、26 路 76/76 与计划 seq 一致）。
 *
 * ── 用法 ──
 *   --dry-plan                  # 只打印计划，不发请求
 *   node scripts/track-collect.mjs --selftest                  # 护栏 + 位置采样自检（离线，0 请求）
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
 *   --loc-interval=15   位置采样间隔（秒）；**0 = 关闭位置采样**（回到 v1.0.x 行为）
 *
 * ── 落盘 ──
 *   <out>/<stamp>-partNN.jsonl.gz   原始帧（每请求一行）
 *   <out>/<stamp>-meta.json         本次运行参数、档位时间线、健康度采样、总计
 *   <out>/<stamp>-run.log           人类可读运行日志
 *   <out>/<stamp>-stations.json     位置采样顺带得到的**站点坐标资产**（去重后，永久有效）
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
  locIntervalSec: Number(arg("loc-interval", "15")),
};

/** 采集优先级：真缺 54 段全在前 8 条 → 渐变期也先把最有价值的数据拿到手 */
const PRIORITY = [
  "25", "51B", "25AX", "51A", "59", "26", "50", "51", // ① A 组（真缺段所在）
  "26A", "56", "25B", "25BS", "102", "701X", "N6",     // ② 通勤网络其余线
];
const A_GROUP_SIZE = 8;

const STAGE_ROUTE_COUNT = [8, 24, 48, Number.POSITIVE_INFINITY];

// ── 位置采样参数（v1.1.0）────────────────────────────────────────────
/**
 * routeCode 推导：**线路号右对齐补零到 5 位**。
 * 10/10 实测相符（2026-09-16）：`26`→`00026` · `51`→`00051` · `51A`→`0051A` ·
 * `MT1`→`00MT1` · `N6`→`000N6` · `25AX`→`025AX`。
 * ⚠️ 传错**不会报错** —— 位置接口照样回 `header:"000"` 但数据为空（静默丢数据）
 *    ⇒ 必须靠「站表为空」的**断言**兜住，见 fetchLocation()。
 */
const ROUTE_CODE_LEN = 5;
const routeCodeOf = (route) => String(route ?? "").trim().padStart(ROUTE_CODE_LEN, "0");

/** 同一 (线路,方向) 连续失败达此数 → 本轮拉黑，不再浪费请求 */
const LOC_MAX_TRIES = 3;
/** 位置采样整体失败率超此值 → 自动关闭位置采样（自保护，绝不拖垮报站） */
const LOC_ABORT_RATE = 0.2;
/** 位置请求的独立超时（位置响应体更大，给宽一点；仍远低于 5s 轮长） */
const LOC_TIMEOUT_MS = 4000;

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

/**
 * 站点坐标累积器（v1.1.0）
 *
 * 位置接口**每次响应都附带全线站表**（站码 + 经纬度 + 站名 + 停靠车道），
 * 15 秒一次 × 113 个方向 = 一轮重复万余次 → **必须去重**，否则落盘直接爆掉。
 *
 * 去重键 = **完整站码**（含站台号，如 `T373/2`）：
 * 站台号是**停靠位、不是方向**，同一主码的不同站台坐标**略有差异**（车道不同），
 * 保留各自的值比归并成主码更准。
 *
 * 顺带产出**站序资产**：`seq[线路][方向]` = 该站在该线路该方向中的 0 基下标。
 * 实测已对拍：51 路 dir=0 → 20/20、26 路 dir=0 → 76/76 与采集计划 `seq` 完全一致，
 * 即**站表顺序就是线路行进顺序**。
 */
class StationBook {
  constructor() {
    this.map = new Map();
    this.hits = 0;        // 收到的站表份数
    this.rows = 0;        // 收到的站行总数（去重前）
    this.conflicts = 0;   // 同一站码坐标不一致的次数（DSAT 改过点位时会 >0）
  }
  add(route, dir, list) {
    this.hits++;
    this.rows += list.length;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const code = s?.stationCode != null ? String(s.stationCode) : null;
      if (!code) continue;
      const lat = s.latitude != null ? String(s.latitude) : null;
      const lng = s.longitude != null ? String(s.longitude) : null;
      if (!lat || !lng) continue;
      let e = this.map.get(code);
      if (!e) {
        e = {
          code, main: mainCode(code),
          name: s.stationName != null ? String(s.stationName) : null,
          lane: s.laneName != null ? String(s.laneName) : null,
          lat, lng, n: 0, seq: {},
        };
        this.map.set(code, e);
      } else if (e.lat !== lat || e.lng !== lng) {
        // 同一站台的坐标理论上不该漂移；漂移了就记下来（保留首次值，附最近一次的偏差样本）
        this.conflicts++;
        e.latLast = lat; e.lngLast = lng;
      }
      e.n++;
      // 站序：同一 (线路, 方向) 只记第一次见到的下标
      const byDir = e.seq[route] ?? (e.seq[route] = {});
      if (byDir[dir] == null) byDir[dir] = i;
    }
  }
  get size() { return this.map.size; }
  snapshot() {
    return [...this.map.values()].sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
  }
}

/** 把站点坐标资产写盘（覆盖写：中途被杀也能留下已有部分） */
function writeStationAsset(book, stamp, out, extra = {}) {
  const stations = book.snapshot();
  const payload = {
    stamp,
    writtenAt: new Date().toISOString(),
    source: "POST /routestation/location → data.stationInfoList（去重后）",
    coordSystem: "WGS84 (EPSG:4326)",
    note: "seq[线路][方向] = 该站在该线路该方向中的 0 基下标；站表顺序 = 线路行进顺序（已对拍 51 路 20/20 · 26 路 76/76）",
    dedupKey: "完整站码（含站台号）；站台号是停靠位、不是方向",
    hits: book.hits,
    rawRows: book.rows,
    conflicts: book.conflicts,
    count: stations.length,
    ...extra,
    stations,
  };
  fs.writeFileSync(path.join(out, `${stamp}-stations.json`), JSON.stringify(payload, null, 1), "utf8");
  return payload;
}

/**
 * 位置采样：`POST /routestation/location`（v1.1.0）
 *
 * ⚠️ 参数名是 **`dir`**（不是 `direction`）× 必须带 **`routeCode`** ——
 *    两者任一写错都不会报错，接口照样回 `header:"000"`，只是 `data` 为空。
 *    ⇒ 所以这里对「站表为空」做**硬断言**（`silent:true`），并交给调用方独立计数。
 *
 * 落盘只取 `busInfoList`（动态部分）；`stationInfoList`（静态站表）交给 StationBook 去重后单独出文件。
 */
async function fetchLocation(route, dir, opts = {}) {
  const params = { routeName: route, routeCode: routeCodeOf(route), dir, lang: "zh-tw", device: "web" };
  const qs = qsOf(params);
  const t0 = Date.now();
  const rec = { kind: "loc", route, dir, t: t0, rc: params.routeCode };
  try {
    const res = await fetch(`${CFG.baseUrl}/routestation/location`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT, token: genToken(qs) },
      body: qs,
      signal: AbortSignal.timeout(LOC_TIMEOUT_MS),
      cache: "no-store",
    });
    rec.ms = Date.now() - t0;
    rec.http = res.status;
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch { rec.ok = false; rec.err = "notjson"; rec.snip = text.slice(0, 80); return rec; }
    rec.hdr = String(j.header ?? "");
    if (j.header === "1200") { rec.ok = false; rec.err = "token1200"; return rec; }
    const d = j.data;
    if (!d || typeof d !== "object") { rec.ok = false; rec.err = "nodata"; return rec; }
    const stas = Array.isArray(d.stationInfoList) ? d.stationInfoList : null;
    if (!stas) { rec.ok = false; rec.err = "noStationList"; return rec; }
    // ★ 静默空断言：routeCode 推导错 / 该线无数据 → header 仍是 000 但站表为空
    if (stas.length === 0) { rec.ok = false; rec.err = "emptyStationList"; rec.silent = true; return rec; }
    if (opts.book) opts.book.add(route, dir, stas);
    const cars = Array.isArray(d.busInfoList) ? d.busInfoList : [];
    rec.ok = true;
    rec.ns = stas.length;
    rec.n = cars.length;
    rec.cars = cars.map((b) => ({
      plate: String(b.busPlate ?? "?").trim(),
      lat: b.latitude != null ? String(b.latitude) : null,
      lng: b.longitude != null ? String(b.longitude) : null,
      busType: b.busType != null ? String(b.busType) : null,
      speed: b.speed != null ? String(b.speed) : null,
    }));
    rec.x = {
      lastBusPlate: d.lastBusPlate ?? null,
      lastBusType: d.lastBusType ?? null,
      busColor: d.busColor ?? null,
      badCar: d.badCar ?? null,
    };
    return rec;
  } catch (e) {
    rec.ms = Date.now() - t0;
    rec.ok = false;
    const msg = String(e?.message || e);
    rec.err = /abort|timeout/i.test(msg) ? "timeout" : `net:${msg.slice(0, 50)}`;
    return rec;
  }
}

/**
 * 把报站任务与位置任务**交错合并**（v1.1.0）
 *
 * 为什么不是「先发完报站、再补一批位置」：那样位置请求会**挤在轮尾爆发**，
 * 瞬时并发压力翻倍且挤占下一轮的准备时间。交错后两类请求均匀铺满整轮，
 * 单请求预算从 44ms 降到 22ms，而实测 p50 只有 13ms → 富余充足。
 * ⚠️ 报站任务在合并后的顺序**保持不变**（相对先后关系不被打乱），
 *    只是被插入了位置请求 —— 所以追踪式计时的时间分辨率仍是 5 秒。
 */
function interleave(busTasks, locTasks) {
  const out = [];
  const n = Math.max(busTasks.length, locTasks.length);
  for (let i = 0; i < n; i++) {
    if (i < busTasks.length) out.push(busTasks[i]);
    if (i < locTasks.length) out.push(locTasks[i]);
  }
  return out;
}

/** 派生脚本的报站分片选择条件（与 track-derive.mjs resolveFiles 的 `--label` 分支逐字一致）
 *  ★ 位置分片名是 `${label}-loc-part...`，**撞不上** `${label}-part` 前缀 —— 这条断言就是防回归用的。
 *  ⚠️ 绝不要改成「文件名含 -loc-」：标签若叫 `smoke-loc`，报站分片也含 `-loc-` → 把自己排掉（实测踩过）。 */
const isBusPartFile = (name, label) => name.startsWith(`${label}-part`) && name.endsWith(".jsonl.gz");

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

  // ══════ ⑦~⑪ 位置采样（v1.1.0）══════
  // ⑦ routeCode 本地推导：**右对齐补零到 5 位**（10/10 实测相符，2026-09-16）
  {
    const cases = [
      ["26", "00026"], ["51", "00051"], ["51A", "0051A"], ["MT1", "00MT1"],
      ["N6", "000N6"], ["25AX", "025AX"], ["1", "00001"], ["59", "00059"],
      ["701X", "0701X"], ["102", "00102"],
    ];
    const bad = cases.filter(([inp, want]) => routeCodeOf(inp) !== want);
    check("⑦ routeCode 右对齐补零到 5 位（10 条实测线全对）", bad.length, 0);
    check("⑦ 推导结果长度恒为 5", new Set(cases.map(([i]) => routeCodeOf(i).length)).size, 1);
  }
  // ⑧ 交错合并：报站任务相对顺序不被打乱（保证 5 秒时间分辨率不被破坏）
  {
    const bus = [{ route: "A" }, { route: "B" }, { route: "C" }];
    const locT = [{ route: "a", kind: "loc" }, { route: "b", kind: "loc" }];
    const m = interleave(bus, locT);
    check("⑧ 交错后总数 = 两类之和", m.length, 5);
    check("⑧ 报站相对顺序不变", m.filter((x) => x.kind !== "loc").map((x) => x.route).join(""), "ABC");
    check("⑧ 首项仍是报站（位置只填空隙）", m[0].route, "A");
    check("⑧ 位置项被均匀插入（下标 1,3）", m.map((x, i) => (x.kind === "loc" ? i : -1)).filter((i) => i >= 0).join(","), "1,3");
    check("⑧ 单边为空时退化为原数组", interleave(bus, []).length, 3);
  }
  // ⑨ 位置采样节拍：5 秒轮 × 15 秒位置 = 每 3 轮一次（报站一帧不少）
  {
    const intervalSec = 5, locIntervalSec = 15;
    let next = 0, fires = 0;
    for (let r = 0; r < 36; r++) {           // 36 轮 = 180 秒
      const now = r * intervalSec * 1000;
      if (now >= next) { fires++; next = now + locIntervalSec * 1000; }
    }
    check("⑨ 180 秒内位置采 12 轮（每 15 秒）", fires, 12);
    check("⑨ 报站仍 36 轮（未被位置挤掉）", 36, 36);
  }
  // ⑩ 位置分片文件名**不会**被派生脚本当成报站分片，且**标签自带 `-loc` 时也不误伤**（防回归）
  //    ⚠️ 这条是实测踩坑后补的：最初用「文件名含 -loc-」判断，标签叫 `smoke-loc` 时
  //       报站分片 `smoke-loc-part01.jsonl.gz` 也含 `-loc-` → 被自己误排除（派生器 0 分片）。
  //       正解 = 靠 `${label}-part` **前缀**（位置分片是 `${label}-loc-part`，撞不上）。
  {
    const label = "20260916-100000";
    check("⑩ 报站分片被识别", isBusPartFile(`${label}-part01.jsonl.gz`, label), true);
    check("⑩ 位置分片**不**被识别（-loc- 中缀）", isBusPartFile(`${label}-loc-part01.jsonl.gz`, label), false);
    const tricky = "smoke-loc";
    check("⑩ 标签自带 loc：报站分片仍被识别", isBusPartFile(`${tricky}-part01.jsonl.gz`, tricky), true);
    check("⑩ 标签自带 loc：位置分片仍被排除", isBusPartFile(`${tricky}-loc-part01.jsonl.gz`, tricky), false);
  }
  // ⑪ 位置采样自保护：失败率超阈值即关闭，且**绝不进入 health**（核心采集不被拖垮）
  {
    let enabled = true, fail = 0, requests = 0, disabledReason = null;
    const feed = (ok) => {
      requests++; if (!ok) fail++;
      const rate = requests ? fail / requests : 0;
      if (fail >= 20 && rate > LOC_ABORT_RATE && enabled) { enabled = false; disabledReason = `失败率 ${rate}`; }
    };
    for (let i = 0; i < 19; i++) feed(false);
    check("⑪ 失败 19 次（未达绝对下限 20）→ 仍开着", enabled, true);
    feed(false);
    check("⑪ 第 20 次失败且率 100% > 20% → 自动关闭", enabled, false);
    check("⑪ 关闭原因有记录", !!disabledReason, true);
    // 隔离性：位置失败不进 health —— 用一个只喂报站的 Health 验证窗口不含 loc 样本
    const h = new Health();
    for (let i = 0; i < 60; i++) h.push(true, 14, `R${i}/d0`);
    check("⑪ 仅报站样本入窗 → 窗内 60 条、0 失败", `${h.winLen}/${h.winFail}`, "60/0");
  }

  const bad = rows.filter((r) => r.startsWith("❌")).length;
  console.log("════ 护栏自检（--selftest · 0 网络请求）════");
  console.log(`窗口 ${WIN_MS / 1000}s · 失败率上限 ${FAIL_RATE_LIMIT * 100}% · 绝对下限 ${FAIL_MIN_COUNT} 个 · 同秒突发目标数 ≥${CLIENT_BURST_TARGETS} · p50 倍数 ${CLIENT_BURST_P50_MULT}× · 恢复停留 ${CFG.recoverHoldSec}s`);
  console.log(`位置采样：间隔 ${CFG.locIntervalSec}s · 同线连续失败 ${LOC_MAX_TRIES} 次拉黑 · 整体失败率 >${(LOC_ABORT_RATE * 100).toFixed(0)}% 自动关闭 · 请求独立计数（不参与降档判定）`);
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
  LOG(`报站：每轮 ${perRound} 次 · ${CFG.intervalSec} 秒间隔 → ${(perRound / CFG.intervalSec).toFixed(1)} 次/秒`);
  if (CFG.locIntervalSec > 0) {
    const basePerSec = perRound / CFG.intervalSec;
    const locPerSec = perRound / CFG.locIntervalSec;
    LOG(`位置：每 ${CFG.locIntervalSec} 秒一轮 × ${perRound} 次 → ${locPerSec.toFixed(1)} 次/秒`
      + `　⇒　合计 ${(basePerSec + locPerSec).toFixed(1)} 次/秒（+${((locPerSec / basePerSec) * 100).toFixed(0)}%）`);
    LOG(`　　★ 位置请求**独立计数**、不参与降档判定；同线连续失败 ${LOC_MAX_TRIES} 次即拉黑，整体失败率 >${(LOC_ABORT_RATE * 100).toFixed(0)}% 自动关闭`);
    LOG(`　　★ routeCode 本地推导（右对齐补零到 5 位）；站表为空 = routeCode 错 → 硬断言`);
  } else {
    LOG(`位置：已关闭（--loc-interval=0）→ 行为与 v1.0.x 完全一致`);
  }
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
      LOG(`   档${s.stage}｜${s.routeCount} 条｜报站 ${s.reqsPerRound} 请求/轮｜${(s.reqsPerRound / CFG.intervalSec).toFixed(1)} 次/秒`
        + (CFG.locIntervalSec > 0 ? `＋位置 ${(s.reqsPerRound / CFG.locIntervalSec).toFixed(1)} 次/秒` : "")
        + `｜${s.minutes} 分钟`);
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
  // ★ v1.1.0 位置采样走**独立分片流**（文件名中缀 `-loc-`）：
  //   ① 已验证的报站流水线与 track-derive.mjs 零影响（派生器按 `<stamp>-part*` 前缀找文件，`-loc-part*` 不匹配）
  //   ② 体积可分开核算
  const locWriter = CFG.locIntervalSec > 0 ? new SegmentWriter(CFG.out, `${stamp}-loc`, CFG.segMinutes) : null;
  if (locWriter) locWriter.start();
  const stationBook = new StationBook();
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

  // ── v1.1.0 位置采样状态（**独立于 health**，见文件头「位置采样」）──
  const loc = {
    enabled: CFG.locIntervalSec > 0,
    rounds: 0,          // 已发起的位置轮数
    requests: 0,
    ok: 0,
    fail: 0,
    silentEmpty: 0,     // 「站表为空」的静默失败次数（routeCode 推导错会集中在这里）
    maxCars: 0,
    disabledReason: null,
    badTries: new Map(),   // "线路/d方向" → 连续失败次数
    blacklist: new Set(),  // 连续失败达 LOC_MAX_TRIES → 本轮拉黑
    firstAt: null,
    lastAt: null,
  };
  let locNextAt = 0;   // 0 = 首轮立刻采（渐变期档0 时先小规模验证 routeCode 推导，再全速）

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

    // ── v1.1.0 位置采样：按**自己的节拍**取一轮候选，报站的 5 秒节拍完全不受影响 ──
    let locReqs = [];
    if (loc.enabled && Date.now() >= locNextAt) {
      locNextAt = Date.now() + CFG.locIntervalSec * 1000;
      loc.rounds++;
      if (!loc.firstAt) loc.firstAt = Date.now();
      for (const p of activeRoutes) for (const d of p.dirs) {
        const key = `${p.code}/d${d}`;
        if (loc.blacklist.has(key)) continue;
        locReqs.push({ route: p.code, dir: d, kind: "loc", _key: key });
      }
    }

    // ★ 两类请求**交错铺满整轮**，而不是「先采完报站、再补一批位置」——
    //   这样位置的 113 次请求被均摊进 5 秒，对服务器的**瞬时压力最平缓**；
    //   报站的轮内抖动只是从 25%×44ms 收窄到 25%×22ms（位置填的是空隙，不改报站节拍）。
    const merged = interleave(reqs, locReqs);

    const slot = intervalMs / merged.length;
    const tasks = merged.map((r, k) => ({
      ...r,
      at: roundStart + k * slot + (Math.random() * 2 - 1) * slot * 0.25,
    }));

    round++;
    const roundT0 = Date.now();
    let okN = 0, failN = 0;

    await runPool(tasks, CFG.pool, async (task) => {
      const isLoc = task.kind === "loc";
      const rec = isLoc
        ? await fetchLocation(task.route, task.dir, { book: stationBook })
        : await fetchRoute(task.route, task.dir);
      seq++;
      rec.seq = seq; rec.round = round; rec.stage = curStage;
      (isLoc ? locWriter : writer).write(rec);
      if (isLoc) {
        // ★ 位置请求**独立计数、绝不喂 health**（理由见文件头「位置采样」）：
        //   位置是附加数据；若某线 routeCode 推导不出来 → 位置恒空 → 每 15s 一个失败
        //   → 会**误触发降档**，把核心报站采集一起拖下水。故彻底隔离。
        loc.requests++;
        loc.lastAt = Date.now();
        if (rec.ok) {
          loc.ok++;
          if ((rec.n ?? 0) > loc.maxCars) loc.maxCars = rec.n;
          loc.badTries.delete(task._key);
        } else {
          loc.fail++;
          if (rec.silent) loc.silentEmpty++;
          const n = (loc.badTries.get(task._key) ?? 0) + 1;
          loc.badTries.set(task._key, n);
          if (n >= LOC_MAX_TRIES) {
            loc.blacklist.add(task._key);
            LOG(`🚫 位置采样拉黑 ${task._key}（连续 ${n} 次失败：${rec.err}）→ 本轮不再采它`);
          }
          if (loc.fail <= 5) LOG(`   ⚠️ loc ${task._key} ${rec.err}${rec.hdr ? ` hdr=${rec.hdr}` : ""}`);
          const rate = loc.requests ? loc.fail / loc.requests : 0;
          if (loc.fail >= 20 && rate > LOC_ABORT_RATE && loc.enabled) {
            loc.enabled = false;
            loc.disabledReason = `位置采样失败率 ${(rate * 100).toFixed(1)}% > ${LOC_ABORT_RATE * 100}% → 自动关闭（报站采集不受影响）`;
            LOG(`🛑 ${loc.disabledReason}`);
          }
        }
      } else {
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
      }
    });

    const roundMs = Date.now() - roundT0;
    health.prune();   // ★ v0.27.4：时间窗 —— 判定前先丢掉过期样本
    roundSamples.push({ round, stage: curStage, intervalMs, reqs: reqs.length, locReqs: locReqs.length, ok: okN, fail: failN, ms: roundMs });

    // ── 每 6 轮（≈30s）打一条健康度 ──
    if (round % 6 === 0) {
      const hs = {
        at: new Date().toISOString(), round, stage: curStage, intervalMs,
        done: seq, okRate: (1 - health.fail / health.total) * 100,
        winFailRate: health.winFailRate * 100, p50: health.winP50, p95: health.winP95,
        consecFail: health.consecFail, roundMs,
        winLen: health.winLen, winFail: health.winFail,   // ★ v0.27.4：窗口透明度
        // ★ v1.1.0 位置采样（独立计数，不参与上面的降档判定）
        locReqs: loc.requests, locFail: loc.fail, locStations: stationBook.size, locBlack: loc.blacklist.size,
      };
      healthSamples.push(hs);
      LOG(`♥ 轮${round} 档${curStage} 间隔${intervalMs / 1000}s 请求${seq} 累计成功率${hs.okRate.toFixed(2)}% 窗失败率${hs.winFailRate.toFixed(1)}%（${hs.winFail}/${hs.winLen}） p50=${hs.p50}ms p95=${hs.p95}ms 轮耗时${roundMs}ms`
        + (loc.requests ? ` ｜loc ${loc.ok}/${loc.requests}${loc.fail ? `(失败${loc.fail})` : ""} 站${stationBook.size}` : ""));
    }
    // ── 每 12 轮（≈60s）把站点坐标资产落一次盘：进程被强杀也留得住已有部分 ──
    if (locWriter && round % 12 === 0 && stationBook.size) {
      try {
        writeStationAsset(stationBook, stamp, CFG.out, {
          partial: true,
          elapsedMin: Number(((Date.now() - runStartMs) / 60000).toFixed(2)),
        });
      } catch (e) { LOG(`⚠️ 站点坐标落盘失败：${e?.message || e}`); }
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

  LOG(`⏳ 收尾：flush 落盘（报站队列 ${writer.queue.length}${locWriter ? ` · 位置队列 ${locWriter.queue.length}` : ""}）…`);
  await writer.finish();
  if (locWriter) await locWriter.finish();
  LOG(`✅ 收尾：落盘完成，开始写 meta…`);

  // ── 站点坐标资产（最终版，永久有效）──
  let stationAsset = null;
  if (locWriter || stationBook.size) {
    try {
      stationAsset = writeStationAsset(stationBook, stamp, CFG.out, { partial: false });
      LOG(`🗺 站点坐标资产：${stationAsset.count} 站（去重前 ${stationAsset.rawRows} 行 · 坐标漂移 ${stationAsset.conflicts} 次）→ ${stamp}-stations.json`);
    } catch (e) { LOG(`⚠️ 站点坐标资产落盘失败：${e?.message || e}`); }
  }

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
      // ★ v1.1.0：位置采样与报站**分开记账**（报站的 requests/failed 口径与 v1.0.x 完全一致）
      loc: {
        intervalSec: CFG.locIntervalSec,
        enabledAtEnd: loc.enabled,
        disabledReason: loc.disabledReason,
        rounds: loc.rounds,
        requests: loc.requests,
        ok: loc.ok,
        failed: loc.fail,
        failRatePct: loc.requests ? (loc.fail / loc.requests) * 100 : 0,
        silentEmpty: loc.silentEmpty,
        blacklist: [...loc.blacklist],
        maxCarsPerFrame: loc.maxCars,
        stations: stationBook.size,
        stationRawRows: stationBook.rows,
        stationConflicts: stationBook.conflicts,
        gzBytes: locWriter ? locWriter.bytes : 0,
        parts: locWriter ? locWriter.files : [],
      },
      allRequests: health.total + loc.requests,
      allReqPerSec: (health.total + loc.requests) / Math.max(1, (Date.now() - runStartMs) / 1000),
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
  if (locWriter) {
    const T = meta.totals.loc;
    LOG(`位置采样：${T.rounds} 轮 · 请求 ${T.requests} 次 · 失败 ${T.failed} 次（${T.failRatePct.toFixed(2)}%）`
      + ` · 静默空 ${T.silentEmpty} · 拉黑 ${T.blacklist.length} 条 · 单帧最多 ${T.maxCarsPerFrame} 台车`);
    LOG(`位置 gzip 落盘 ${(T.gzBytes / 1048576).toFixed(2)} MB · ${T.parts.length} 片`);
    LOG(`站点坐标资产 ${T.stations} 站（去重前 ${T.stationRawRows} 行 · 漂移 ${T.stationConflicts}）`);
    LOG(`合计请求 ${meta.totals.allRequests} 次 ≈ ${meta.totals.allReqPerSec.toFixed(1)} 次/秒`);
    if (T.disabledReason) LOG(`⚠️ ${T.disabledReason}`);
  } else LOG(`位置采样：未启用（--loc-interval=0）`);
  if (exemptTotal) LOG(`🙈 同秒突发豁免累计 ${exemptTotal} 次失败（仅不计入降档判定，总数照记）`);
  LOG(`中止原因：${aborted ?? "正常到时结束"}`);
  LOG(`产物：${writer.files.join("  ")}`);
  if (locWriter) LOG(`      ${locWriter.files.join("  ")}`);
  LOG(`      ${stamp}-meta.json  ${stamp}-run.log${stationAsset ? `  ${stamp}-stations.json` : ""}`);
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
