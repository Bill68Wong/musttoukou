/**
 * 追踪式计时派生器（scripts/track-derive.mjs）
 *
 * 作用：把 scripts/track-collect.mjs 落盘的**原始帧**还原成站间时长样本。
 *
 * ── 两个口径都算（本脚本的核心价值）────────────────────────────────
 *   离开口径  t(离 B) − t(离 A) = run + dwell_B   ← **与手动打点 / 现有 segment_stats 同口径（主口径）**
 *   到达口径  t(到 B) − t(到 A) = dwell_A + run   ← 仅供对照，无消费方
 *   两者相差 dwell_B − dwell_A。原始帧同时含 `status='1'`（停靠）与 `'0'`（已离站），
 *   所以一次采集两种都能算，**口径定案前不需要重采**。
 *
 *   实测口径定案（2026-09-13 首轮 30 分钟，与云端 segment_stats 对照 227~239 段）：
 *   离开口径 平均绝对差 **34 秒**（σ45）＜ 到达 39 秒（σ57）＜ 纯行驶 63 秒（σ53）
 *   → 主口径 = 离开口径。
 *
 * ── 状态机（status 语义）──────────────────────────────────────────
 *   '1' = 停靠挂载站；'0' = 已离站、驶向下一站
 *   到达时刻 = 该站首次出现 status='1' 的时刻
 *   离开时刻 = 该站首次由 '1' 翻成 '0' 的时刻
 *   ⚠️ **压缩键必须含 `idx`**：车辆驻站期间 idx 会「静默重锚」（终点掉头换方向 / API 重定位车辆），
 *      只按 (status, main) 合并会把重锚前后的帧并成一组、组的 idx 停在**首帧** →
 *      随后的 depart 事件带过期 idx → 骗过下面「严格相邻」过滤 → 造出横跨驻留期的**假区间**。
 *      （2026-09-13 首轮实测：σ 75.7 秒 / 最大 960 秒的假样本，修后 σ 33 秒 / 最大 370 秒）
 *      另加护栏：只接受 `s0 帧 idx === s1 帧 idx` 的 depart。
 *   状态缺口 = s1@X → s1@Y（跨站且**没有** s0 帧）→ X 的离开时刻不可测，
 *              X→Y 这一段必须整段丢弃（这是「长驻站/总站待发」的典型症状）。
 *
 * ── 三重过滤 + 一道聚合护栏（宁丢不错）─────────────────────────────
 *   ① 严格相邻：两次事件的站序下标差必须 === 1（差 > 1 说明中间站没采到 → 不是邻接区间）
 *   ② 无状态缺口：起点站的离开时刻必须真实测到
 *   ③ 时长合理：0.1 ~ 20 分钟之外一律丢弃并计入异常清单
 *   ④ **同键一致性护栏（聚合层，2026-09-13 后新增）**：同一共享键 n≥OUT_MIN_N 时，
 *      样本 > max(p50×OUT_MULT, p50+OUT_FLOOR_MIN 分) 判为可疑 → 从均值剔除（原值保留可回溯）。
 *      治「站外长时间停留」：司机休息/待發 期间 API 仍保留上一站且 status='0'（实测连挂 138 帧
 *      ≈ 11.4 分钟）→ ①②③ 全拦不住，「s0 持续时长」也判不出来（真实跨海段同样长 s0）。
 *      真实长区间不会误伤：同键多样本彼此一致 → p50 大 → 阈值随之上抬（`M9→T316` 全组 9.6~12.7 分，
 *      阈值 36 分，零命中）。参数可用 `--outlier-mult` / `--outlier-floor` / `--outlier-min-n` 覆盖。
 *
 * ── 输出 ──
 *   <out>/<label>-derived.json          结构化样本（按共享键 / 按线路键聚合）
 *   <out>/<label>-derived-report.txt    人读报告（含与 segment_stats 真值的对照）
 *
 * ── 用法 ──
 *   node scripts/track-derive.mjs --label=20260913-0700
 *   node scripts/track-derive.mjs --in=data/tracking/<label>-part*.jsonl.gz --truth=cloud
 *   node scripts/track-derive.mjs --label=x --truth=local   # 与本地影子库真值对照
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(process.cwd());
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return d;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : "true";
};
const CFG = {
  label: arg("label", ""),
  inGlob: arg("in", ""),
  out: path.resolve(ROOT, arg("out", "data/tracking")),
  truth: arg("truth", "none"),          // none | local | cloud
  minSamples: Number(arg("min-samples", "1")),
  plan: path.resolve(ROOT, arg("plan", "data/tracking/poll-plan.json")),
};

const MIN_MINUTES = 0.1;
const MAX_MINUTES = 20;

// ── 同键一致性护栏参数（2026-09-13 第二轮实测后新增，可用 --outlier-* 覆盖）──
const OUT_MULT = Number(arg("outlier-mult", "3"));       // 超过 p50 的倍数 → 可疑
const OUT_FLOOR_MIN = Number(arg("outlier-floor", "2")); // 且至少超 p50 这么多分钟（防小 p50 误判）
const OUT_MIN_N = Number(arg("outlier-min-n", "5"));     // 同键样本数 ≥ N 才启用（样本太少判不出）

const mainCode = (c) => /^[A-Za-z]+\d+/.exec(String(c ?? ""))?.[0] ?? String(c ?? "");
const p2 = (n) => String(n).padStart(2, "0");
function bucketOf(h) {
  if (h >= 7 && h < 10) return "am_peak";
  if (h >= 10 && h < 17) return "day";
  if (h >= 17 && h < 20) return "pm_peak";
  return "night";
}
/** 澳门时间分量 */
function macauParts(ms) {
  const d = new Date(ms + 8 * 3600e3);
  return { weekday: d.getUTCDay(), hour: d.getUTCHours(), hhmm: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` };
}

const out = [];
const L = (s) => { out.push(s); console.log(s); };

// ════════════════ 1. 读原始帧 ════════════════

function resolveFiles() {
  if (CFG.inGlob) {
    const dir = path.dirname(path.resolve(ROOT, CFG.inGlob));
    const base = path.basename(CFG.inGlob);
    const re = new RegExp("^" + base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));
  }
  if (!CFG.label) throw new Error("必须给 --label=<stamp> 或 --in=<glob>");
  return fs.readdirSync(CFG.out)
    .filter((f) => f.startsWith(`${CFG.label}-part`) && f.endsWith(".jsonl.gz"))
    .sort()
    .map((f) => path.join(CFG.out, f));
}

function loadFrames(files) {
  const frames = [];
  let bad = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f);
    let text;
    try { text = zlib.gunzipSync(buf).toString("utf8"); }
    catch { bad++; L(`  ⚠️ ${path.basename(f)} 解压失败（进程被强杀时的残片），已跳过`); continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { frames.push(JSON.parse(line)); } catch { bad++; }
    }
  }
  return { frames, bad };
}

// ════════════════ 2. 状态机 ════════════════

/** 单辆车（一条 series）→ 到达序列 / 离开序列 / 状态缺口 */
function extractEvents(series) {
  // 压缩连续同状态。
  // ⚠️ 键必须含 idx（详见文件头「状态机」注）：只按 (status, main) 合并会把 idx 重锚前后的帧
  //    并成一组、组的 idx 停在首帧 → 后续 depart 带过期 idx → 造出横跨驻留期的假区间。
  const comp = [];
  for (const s of series) {
    const last = comp[comp.length - 1];
    if (last && last.status === s.status && last.main === s.main && String(last.idx) === String(s.idx)) {
      last.lastT = s.t; last.n++;
    } else comp.push({ status: s.status, main: s.main, sta: s.sta, idx: s.idx, firstT: s.t, lastT: s.t, n: 1 });
  }
  const arrive = [], depart = [], gaps = [];
  let lastS1 = null, departed = false;
  for (const c of comp) {
    if (c.status === "1") {
      if (!lastS1 || lastS1.main !== c.main) arrive.push({ main: c.main, sta: c.sta, idx: c.idx, t: c.firstT, endT: c.lastT, holdMs: c.lastT - c.firstT });
      lastS1 = c;
      departed = false;
    } else if (c.status === "0") {
      // 护栏：只接受「同一 idx」上的 1→0。idx 变了 = 车辆被重锚（掉头 / 换方向），
      // 该站的离开时刻不可信 → 丢弃该 depart（否则会生成跨驻留期的假区间）。
      if (lastS1 && !departed && lastS1.main === c.main && String(lastS1.idx) === String(c.idx)) {
        depart.push({ main: lastS1.main, sta: lastS1.sta, idx: lastS1.idx, t: c.firstT, holdMs: lastS1.lastT - lastS1.firstT + (c.firstT - lastS1.lastT) });
        departed = true;
      }
    }
  }
  // 状态缺口：s1 → s1 跨站（该站离开时刻不可测）
  for (let i = 1; i < comp.length; i++)
    if (comp[i - 1].status === "1" && comp[i].status === "1" && comp[i - 1].main !== comp[i].main)
      gaps.push({ at: comp[i - 1].main, idx: comp[i - 1].idx, nextMain: comp[i].main, t: comp[i].firstT });
  return { arrive, depart, gaps, comp };
}

/** 由事件序列产出段样本：严格相邻 + 正常时长 */
function segments(evs) {
  const ok = [], dropAdj = [], dropDur = [];
  for (let i = 1; i < evs.length; i++) {
    const a = evs[i - 1], b = evs[i];
    const d = b.idx - a.idx;
    if (d !== 1) { dropAdj.push({ from: a.main, to: b.main, reason: d <= 0 ? `站序回退/同站(${d})` : `跨 ${d} 站`, t: a.t }); continue; }
    const minutes = (b.t - a.t) / 60000;
    const rec = { from: a.main, to: b.main, fromSta: a.sta, toSta: b.sta, fromIdx: a.idx, minutes, t: a.t };
    if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) { dropDur.push({ ...rec, reason: minutes < MIN_MINUTES ? `过短 ${minutes.toFixed(2)} 分` : `过长 ${minutes.toFixed(2)} 分` }); continue; }
    ok.push(rec);
  }
  return { ok, dropAdj, dropDur };
}

// ════════════════ 3. 聚合 ════════════════

function agg(list) {
  if (!list.length) return null;
  const v = list.map((x) => x.minutes).sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    n: v.length,
    avg: Math.round(mean * 100) / 100,
    p50: Math.round(v[Math.floor(v.length / 2)] * 100) / 100,
    min: Math.round(v[0] * 100) / 100,
    max: Math.round(v[v.length - 1] * 100) / 100,
  };
}

// ── 同键一致性护栏（核心）─────────────────────────────────────────────
// 治「站外长时间停留造假长区间」：司机休息/待發 期间，API 仍保留上一站且 status='0'
// （第二轮实测 s0 连挂 138 帧 ≈ 11.4 分钟）→ idx 严格 +1、无状态缺口、时长未越界，
// **解析层的三道过滤全拦不住**；连「s0 持续时长」也判不出来（真实跨海段同样长 s0）。
//
// 唯一可靠判据 = **同一共享键上其余样本是否一致**：
//   阈值 thr = max(p50 × OUT_MULT, p50 + OUT_FLOOR_MIN 分钟)，且该键样本数 ≥ OUT_MIN_N 才启用。
//   超阈样本 → 标记 suspicious、从均值剔除，但**原值保留在 json / 报告里可回溯**（绝不静默丢弃）。
//
// 为什么不会误伤真实跨海长区间：它们同键多样本且彼此一致 → p50 本身就大 → 阈值随之上抬。
//   实测 `M9→T316` 全组 9.58~12.74 分（p50 12.0）→ 阈值 36 分，零命中。
//   而被判可疑的 `M144→M76` 是「同键 p50 2.83，孤立 11.90」→ 阈值 8.49，精确命中。
function splitOutliers(list) {
  const v = list.map((x) => x.minutes).sort((a, b) => a - b);
  if (v.length < OUT_MIN_N) return { kept: list, outliers: [], thr: null, p50: null };
  const p50 = v[Math.floor(v.length / 2)];
  const thr = Math.max(p50 * OUT_MULT, p50 + OUT_FLOOR_MIN);
  const kept = [], outliers = [];
  for (const x of list) (x.minutes > thr ? outliers : kept).push(x);
  return { kept, outliers, thr, p50 };
}

/** 按共享键（from|to|weekday|bucket）分组找可疑样本 → { flagged:Set, list:[] } */
function flagOutliers(samples) {
  const groups = new Map();
  for (const s of samples) {
    const mp = macauParts(s.t);
    const k = `${s.from}|${s.to}|${mp.weekday}|${bucketOf(mp.hour)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const flagged = new Set();
  const list = [];
  for (const [k, g] of groups) {
    const { outliers, thr, p50 } = splitOutliers(g);
    for (const o of outliers) {
      flagged.add(o); // 用对象身份标记，便于从原集合里过滤
      list.push({ key: k, route: o.route, dir: o.dir, plate: o.plate, minutes: o.minutes, p50, thr, n: g.length, t: o.t });
    }
  }
  list.sort((a, b) => b.minutes - a.minutes);
  return { flagged, list };
}

// ════════════════ 4. 真值（DB）════════════════

async function loadTruth() {
  if (CFG.truth === "none") return null;
  try { process.loadEnvFile(path.join(ROOT, ".env")); } catch { /* 无 .env */ }
  const conn = CFG.truth === "cloud" ? process.env.DATABASE_URL : process.env.DATABASE_URL_LOCAL;
  if (!conn) { L(`⚠️ --truth=${CFG.truth} 但未找到连接串，跳过对照`); return null; }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: conn, max: 1, ssl: conn.includes("supabase") ? { rejectUnauthorized: false } : undefined });
  const r = await pool.query(
    `SELECT route_code, from_station, to_station, weekday, time_bucket, arrive_kind, avg_minutes, samples
       FROM segment_stats`,
  );
  await pool.end();
  const map = new Map(); // (fromMain|toMain) -> samples[]
  for (const row of r.rows) {
    const k = `${mainCode(row.from_station)}|${mainCode(row.to_station)}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  L(`📚 真值已载入：segment_stats ${r.rows.length} 行（${CFG.truth}）`);
  return map;
}

// ════════════════ 5. 主流程 ════════════════

async function main() {
  const files = resolveFiles();
  if (!files.length) throw new Error(`没找到分片：label=${CFG.label} in=${CFG.inGlob}`);
  const label = CFG.label || path.basename(files[0]).replace(/-part\d+\.jsonl\.gz$/, "");

  L(`════ 追踪式计时派生 · ${label} ════`);
  L(`分片 ${files.length} 个：${files.map((f) => path.basename(f)).join(" ")}`);
  const { frames, bad } = loadFrames(files);
  const okFrames = frames.filter((f) => f.ok);
  L(`帧 ${frames.length}（成功 ${okFrames.length} · 失败 ${frames.length - okFrames.length} · 解析失败 ${bad}）`);

  if (!okFrames.length) { L("无有效帧，终止。"); fs.writeFileSync(path.join(CFG.out, `${label}-derived-report.txt`), out.join("\n"), "utf8"); return; }

  const t0 = Math.min(...okFrames.map((f) => f.t));
  const t1 = Math.max(...okFrames.map((f) => f.t));
  const rounds = Math.max(...okFrames.map((f) => f.round));
  const intervalSec = Math.round((t1 - t0) / Math.max(1, rounds) / 100) / 10;
  const mp0 = macauParts(t0), mp1 = macauParts(t1);
  L(`时段 ${new Date(t0).toISOString()} ~ ${new Date(t1).toISOString()}（澳门 ${mp0.hhmm}~${mp1.hhmm}）`);
  L(`轮次 ${rounds} · 实际间隔 ≈ ${intervalSec}s · 线路数 ${new Set(okFrames.map((f) => f.route)).size}`);
  L(`车辆观测 ${okFrames.reduce((a, f) => a + (f.veh?.length ?? 0), 0)} 车次`);
  L("");

  // 站序（用于核查 idx→站码 是否与计划一致）
  let planSeq = {};
  try { planSeq = JSON.parse(fs.readFileSync(CFG.plan, "utf8"))?.plan ?? []; } catch { /* 可选 */ }
  const seqByRoute = new Map();
  for (const p of planSeq) if (p.seq) for (const [d, s] of Object.entries(p.seq)) if (Array.isArray(s)) seqByRoute.set(`${p.code}|${d}`, s);

  // ── 组装每辆车的时间序列 ──
  const series = new Map(); // route|dir|plate -> [{t,idx,sta,main,status}]
  let idxMismatch = 0;
  for (const f of okFrames) {
    for (const v of f.veh ?? []) {
      const k = `${f.route}|${f.dir}|${v.plate}`;
      if (!series.has(k)) series.set(k, []);
      const seq = seqByRoute.get(`${f.route}|${f.dir}`);
      if (seq && seq[v.idx] != null && String(seq[v.idx]) !== String(v.sta)) idxMismatch++;
      series.get(k).push({ t: f.t, idx: v.idx, sta: v.sta, main: v.main ?? mainCode(v.sta), status: v.status });
    }
  }
  const usable = [...series.entries()].filter(([, s]) => s.length >= 3);
  L(`车辆序列 ${series.size} 条（≥3 帧可用于状态机的 ${usable.length} 条）`);
  if (idxMismatch) L(`⚠️ 站序不一致 ${idxMismatch} 次（计划缓存的站序与实际返回不符，可能改道；仅告警不影响时长）`);
  L("");

  // ── 逐车跑状态机 ──
  const depSamples = [], arrSamples = [];
  const allGaps = [], allDropAdj = [], allDropDur = [];
  let nArr = 0, nDep = 0;
  for (const [k, s] of usable) {
    const [route, dir] = k.split("|");
    s.sort((a, b) => a.t - b.t);
    const { arrive, depart, gaps } = extractEvents(s);
    nArr += arrive.length; nDep += depart.length;
    for (const g of gaps) allGaps.push({ route, plate: k.split("|")[2], ...g });
    const seqLen = seqByRoute.get(`${route}|${dir}`)?.length ?? 0;
    if (seqLen && s[0].idx >= seqLen) allGaps.push({ route, plate: k.split("|")[2], at: s[0].main, idx: s[0].idx, nextMain: "(站序越界)", t: s[0].t });
    for (const [evs, sink, tag] of [[depart, depSamples, "depart"], [arrive, arrSamples, "arrive"]]) {
      const { ok, dropAdj, dropDur } = segments(evs);
      for (const r of ok) sink.push({ route, dir, plate: k.split("|")[2], ...r, kind: tag });
      for (const r of dropAdj) allDropAdj.push({ route, plate: k.split("|")[2], kind: tag, ...r });
      for (const r of dropDur) allDropDur.push({ route, plate: k.split("|")[2], kind: tag, ...r });
    }
  }
  L(`事件：到达 ${nArr} · 离开 ${nDep} · 状态缺口 ${allGaps.length} 处（→ 相邻段整段丢弃）`);
  L(`段样本：离开口径 ${depSamples.length} · 到达口径 ${arrSamples.length}`);
  L(`丢弃：站序不邻接 ${allDropAdj.length} · 时长越界 ${allDropDur.length}`);
  L("");

  // ── 聚合：共享键 / 线路键 ──
  function buildKeys(samples) {
    const byShared = new Map(), byRoute = new Map();
    for (const s of samples) {
      const mp = macauParts(s.t);
      const bucket = bucketOf(mp.hour);
      const ks = `${s.from}|${s.to}|${mp.weekday}|${bucket}`;
      const kr = `${s.route}|${s.from}|${s.to}|${mp.weekday}|${bucket}`;
      if (!byShared.has(ks)) byShared.set(ks, []);
      byShared.get(ks).push(s);
      if (!byRoute.has(kr)) byRoute.set(kr, []);
      byRoute.get(kr).push(s);
    }
    const pack = (m) => {
      const o = {};
      for (const [k, list] of m) { const a = agg(list); if (a && a.n >= CFG.minSamples) o[k] = a; }
      return o;
    };
    return { byShared: pack(byShared), byRoute: pack(byRoute) };
  }
  // ── 同键一致性护栏：剔除「站外长时间停留」造出的假长区间（原值保留，可回溯）──
  const depFlag = flagOutliers(depSamples);
  const arrFlag = flagOutliers(arrSamples);
  const depClean = depSamples.filter((s) => !depFlag.flagged.has(s));
  const arrClean = arrSamples.filter((s) => !arrFlag.flagged.has(s));
  L(`🧹 同键一致性护栏：离开口径可疑 ${depFlag.list.length}/${depSamples.length} 条 · ` +
    `到达口径可疑 ${arrFlag.list.length}/${arrSamples.length} 条（阈值 max(p50×${OUT_MULT}, p50+${OUT_FLOOR_MIN} 分)，同键 n≥${OUT_MIN_N} 启用）`);
  L("");

  const depAgg = buildKeys(depClean);
  const arrAgg = buildKeys(arrClean);

  // 双口径对照（同一段两口径的差 = dwell_B − dwell_A）；用**护栏后**样本，避免假区间污染
  const dPairs = new Map();
  for (const s of depClean) { const k = `${s.route}|${s.from}|${s.to}`; if (!dPairs.has(k)) dPairs.set(k, { d: [], a: [] }); dPairs.get(k).d.push(s.minutes); }
  for (const s of arrClean) { const k = `${s.route}|${s.from}|${s.to}`; if (dPairs.has(k)) dPairs.get(k).a.push(s.minutes); }
  const dualDiffs = [];
  for (const [k, v] of dPairs) {
    if (!v.d.length || !v.a.length) continue;
    dualDiffs.push({ key: k, dep: v.d.reduce((a, b) => a + b, 0) / v.d.length, arr: v.a.reduce((a, b) => a + b, 0) / v.a.length, n: Math.min(v.d.length, v.a.length) });
  }

  // ── 与真值对照 ──
  const truth = await loadTruth();
  const compares = [];
  if (truth) {
    const seen = new Map(); // route|from|to -> {mins:[], truth:[]}
    for (const s of depClean) {
      const k = `${s.route}|${s.from}|${s.to}`;
      if (!seen.has(k)) seen.set(k, { mins: [], rows: truth.get(`${s.from}|${s.to}`) ?? [] });
      seen.get(k).mins.push(s.minutes);
    }
    for (const [k, v] of seen) {
      if (!v.rows.length) continue;
      const [route, from, to] = k.split("|");
      const tMean = v.rows.filter((r) => r.arrive_kind !== "all" && r.weekday !== -1);
      const use = tMean.length ? tMean : v.rows;
      const tw = use.reduce((a, r) => a + Number(r.avg_minutes) * r.samples, 0) / use.reduce((a, r) => a + r.samples, 0);
      const tn = use.reduce((a, r) => a + r.samples, 0);
      const mine = v.mins.reduce((a, b) => a + b, 0) / v.mins.length;
      compares.push({ route, from, to, mine, truth: tw, diff: mine - tw, nMine: v.mins.length, nTruth: tn });
    }
    compares.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  }

  // ════ 报告 ════
  const depSharedN = Object.keys(depAgg.byShared).length;
  L("═".repeat(64));
  L("## 一、样本规模");
  L(`  离开口径（与手动打点同口径）：${depSamples.length} 段样本 · ${depSharedN} 个唯一邻接键`);
  L(`  到达口径（与 segment_stats 同口径）：${arrSamples.length} 段样本 · ${Object.keys(arrAgg.byShared).length} 个唯一邻接键`);
  L(`  🧹 护栏后净样本：离开 ${depClean.length} · 到达 ${arrClean.length}` +
    `（剔除「站外长时间停留」假区间：离开 ${depFlag.list.length} · 到达 ${arrFlag.list.length}，原值保留在 derived.json / 第六节）`);
  const bucketCount = {};
  for (const s of depSamples) { const b = bucketOf(macauParts(s.t).hour); bucketCount[b] = (bucketCount[b] ?? 0) + 1; }
  L(`  时段分布：${Object.entries(bucketCount).map(([k, v]) => `${k}=${v}`).join("  ") || "—"}`);
  L("");

  L("## 二、双口径内部一致性（差 = dwell_B − dwell_A，理论均值应≈0；护栏后样本）");
  if (dualDiffs.length) {
    const diffs = dualDiffs.map((x) => (x.dep - x.arr) * 60);
    const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - m) ** 2, 0) / diffs.length);
    L(`  可对照 ${dualDiffs.length} 段：均值差 ${m.toFixed(1)} 秒 · 标准差 ${sd.toFixed(1)} 秒 · 绝对值最大 ${Math.max(...diffs.map(Math.abs)).toFixed(0)} 秒`);
    for (const x of dualDiffs.sort((a, b) => Math.abs(b.dep - b.arr) - Math.abs(a.dep - a.arr)).slice(0, 5))
      L(`    ${x.key}：离开 ${x.dep.toFixed(2)} 分 vs 到达 ${x.arr.toFixed(2)} 分 → 差 ${((x.dep - x.arr) * 60).toFixed(0)} 秒（n=${x.n}）`);
  } else L("  （无同段双口径样本）");
  L("");

  L("## 三、样本最多的段（离开口径 Top 20 · 护栏后）");
  const top = Object.entries(depAgg.byShared).sort((a, b) => b[1].n - a[1].n).slice(0, 20);
  L(`  ${"共享键(from|to|wd|bucket)".padEnd(34)} ${"n".padStart(4)} ${"均值".padStart(7)} ${"p50".padStart(7)} ${"min".padStart(7)} ${"max".padStart(7)}`);
  for (const [k, a] of top) L(`  ${k.padEnd(34)} ${String(a.n).padStart(4)} ${String(a.avg).padStart(7)} ${String(a.p50).padStart(7)} ${String(a.min).padStart(7)} ${String(a.max).padStart(7)}`);
  L("");

  if (truth) {
    L(`## 四、与 segment_stats 真值对照（按站码归一 + 样本加权；--truth=${CFG.truth}；护栏后样本）`);
    if (!compares.length) L("  （无交集）");
    else {
      const ad = compares.map((c) => Math.abs(c.diff));
      const mad = ad.reduce((a, b) => a + b, 0) / ad.length;
      const signed = compares.reduce((a, c) => a + c.diff, 0) / compares.length;
      const within = (th) => compares.filter((c) => Math.abs(c.diff) <= th).length;
      L(`  可对照 ${compares.length} 段 · 平均绝对差 ${mad.toFixed(2)} 分（${(mad * 60).toFixed(0)} 秒）`);
      L(`  平均符号差 ${signed.toFixed(2)} 分（${(signed * 60).toFixed(0)} 秒）→ ${Math.abs(signed) < 0.15 ? "无系统性偏差" : "⚠️ 存在系统性偏差"}`);
      L(`  |差|≤0.5 分：${within(0.5)}/${compares.length} · ≤1 分：${within(1)}/${compares.length} · ≤2 分：${within(2)}/${compares.length}`);
      L(`  偏差最大的 10 段：`);
      for (const c of compares.slice(0, 10))
        L(`    ${c.route}路 ${c.from}→${c.to}：追踪 ${c.mine.toFixed(2)} 分 | 真值 ${c.truth.toFixed(2)} 分 | 差 ${c.diff >= 0 ? "+" : ""}${c.diff.toFixed(2)} 分（n追=${c.nMine} n真=${c.nTruth}）`);
    }
    L("");
  }

  L("## 五、异常与缺口清单");
  L(`  状态缺口 ${allGaps.length} 处（该站离开时刻不可测）`);
  for (const g of allGaps.slice(0, 15)) L(`    ${g.route}路 ${g.plate} @ ${g.at}(i${g.idx}) → 直接跳到 ${g.nextMain}  ${macauParts(g.t).hhmm}`);
  if (allGaps.length > 15) L(`    …另 ${allGaps.length - 15} 处`);
  L(`  站序不邻接 ${allDropAdj.length} 段（含跨站）；时长越界 ${allDropDur.length} 段`);
  for (const d of [...allDropDur].sort((a, b) => b.minutes - a.minutes).slice(0, 8))
    L(`    ${d.kind === "depart" ? "离开口径" : "到达口径"} ${d.route}路 ${d.from}→${d.to} = ${d.minutes.toFixed(2)} 分（${d.reason}）`);
  L("");

  L("## 六、同键一致性护栏命中（站外长时间停留 → 假长区间）");
  L(`  规则：同一共享键 n≥${OUT_MIN_N} 时，样本 > max(p50×${OUT_MULT}, p50+${OUT_FLOOR_MIN} 分) 判为可疑 → 从均值剔除（原值保留在 derived.json）`);
  if (!depFlag.list.length && !arrFlag.list.length) L("  无命中");
  else {
    for (const x of depFlag.list.slice(0, 20))
      L(`    离开 ${x.route}路 ${x.key}：${x.minutes.toFixed(2)} 分 vs 同键 n=${x.n} p50 ${x.p50.toFixed(2)}（阈值 ${x.thr.toFixed(2)}）· ${x.plate} ${macauParts(x.t).hhmm}`);
    if (depFlag.list.length > 20) L(`    …另 ${depFlag.list.length - 20} 条（离开口径）`);
    for (const x of arrFlag.list.slice(0, 10))
      L(`    到达 ${x.route}路 ${x.key}：${x.minutes.toFixed(2)} 分 vs 同键 n=${x.n} p50 ${x.p50.toFixed(2)}（阈值 ${x.thr.toFixed(2)}）· ${x.plate}`);
  }
  L(`  ⚠️ 同键样本 < ${OUT_MIN_N} 时护栏不启用（样本太少判不出一致性）→ 这类键的极端值见第三节 max 列，必要时人工核查`);
  L("");

  // ── 落盘 ──
  const derived = {
    label,
    generatedAt: new Date().toISOString(),
    source: { files: files.map((f) => path.basename(f)), frames: frames.length, okFrames: okFrames.length, rounds, intervalSec },
    window: { from: new Date(t0).toISOString(), to: new Date(t1).toISOString(), macau: `${mp0.hhmm}~${mp1.hhmm}` },
    counts: {
      vehicleSeries: series.size, usableSeries: usable.length,
      arriveEvents: nArr, departEvents: nDep,
      statusGaps: allGaps.length,
      departSamples: depSamples.length, arriveSamples: arrSamples.length,
      cleanSamples: { depart: depClean.length, arrive: arrClean.length },
      outliers: { depart: depFlag.list.length, arrive: arrFlag.list.length },
      dropped: { notAdjacent: allDropAdj.length, durationOutOfRange: allDropDur.length },
    },
    outlierGuard: {
      rule: { mult: OUT_MULT, floorMin: OUT_FLOOR_MIN, minN: OUT_MIN_N },
      note: "同键一致性护栏：剔除「站外长时间停留」造成的假长区间；原值保留在 rawDepartSamples 与下方清单中",
      departCandidates: depFlag.list,
      arriveCandidates: arrFlag.list,
    },
    depart: depAgg,
    arrive: arrAgg,
    dualDiff: dualDiffs,
    truthCompare: compares,
    anomalies: { gaps: allGaps, notAdjacent: allDropAdj, durationOutOfRange: allDropDur },
    rawDepartSamples: depSamples,
  };
  fs.writeFileSync(path.join(CFG.out, `${label}-derived.json`), JSON.stringify(derived, null, 2), "utf8");
  fs.writeFileSync(path.join(CFG.out, `${label}-derived-report.txt`), out.join("\n") + "\n", "utf8");
  L(`产物：${label}-derived.json · ${label}-derived-report.txt`);
}

main().catch((e) => {
  out.push(`❌ FATAL ${e?.stack || e?.message}`);
  try { fs.writeFileSync(path.join(CFG.out, `${CFG.label || "derive"}-derived-report.txt`), out.join("\n") + "\n", "utf8"); } catch { /* 尽力 */ }
  console.error(e);
  process.exit(1);
});
