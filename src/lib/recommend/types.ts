/**
 * 自动选线 · 类型与常量（src/lib/recommend/types.ts，v1.0.0）
 *
 * ⚠️ 纯类型 / 常量模块：**不得 import 任何含 pg 的模块** —— client 组件会间接引用
 *    （`RecommendCard` 等视图类型要传到客户端渲染）。服务端查询见 ./query.ts。
 */

/** 澳科大校区（步行分组上下文；仅 school 侧有意义） */
export type SchoolZone = "B/C" | "N/O" | "R";

/** 澳科大三座区（默认 N/O） */
export const SCHOOL_ZONES: { value: SchoolZone; label: string }[] = [
  { value: "B/C", label: "B/C 座" },
  { value: "N/O", label: "N/O 座" },
  { value: "R", label: "R 座" },
];
export const DEFAULT_ZONE: SchoolZone = "N/O";

/** 赶车 5 档：1 = 全力冲刺有机会赶上 … 5 = 爬过去都能赶上 */
export type CatchTier = 1 | 2 | 3 | 4 | 5;

/**
 * 固定开销（秒）：反应时间 + 起步加速 + 路口/电梯等待。
 * 作用：让 n 小时的各档绝对差自动收敛（短距离跑与走差别不大）—— 正是需求点。
 * ⚠️ 初值，待用历史「depart → wait_start」打点分布回归标定。
 */
export const OVERHEAD_SEC = 15;

/**
 * 各档相对「正常走」的**耗时比** = `基准速度 ÷ 该档速度`
 *
 * ── ★ 基准：正常走 = 1.4 m/s ──────────────────────────────────────────
 *   双重依据（2026-09-18 调研 + 实测）：
 *   1. **文献**：Bohannon & Andrews (2011) *Physiotherapy* 97(3):182-189（PMID 21820535，
 *      41 项研究 / 23,111 人 meta）—— 青壮年男性舒适步速 **1.36~1.43 m/s**；
 *      Andrews et al. (2022)（PMID 36528509，51,248 人）—— 范围 0.97~1.40，
 *      且**结论：步速不因地理区域而异** ⇒ 澳门人群可直接套用 ✓
 *   2. **本项目实测**：19 组真实样本（walk_times 实测分钟 × 高德步行距离）反算
 *      隐含速度**中位数 1.43 m/s** —— 与 Bohannon 的 1.43 **完全吻合** ✓
 *   ⇒ 取 1.4 m/s 为两者之间的稳妥值 ✓
 *
 * ── 各档速度与依据 ────────────────────────────────────────────────────
 *   档1 冲刺 **3.6 m/s**（13 km/h）—— ★ 取「**20~50 米冲刺的平均速度**」，不是峰值
 *         未训练成人**峰值**冲刺 4.5~5.8 m/s，但峰值只能维持 1~3 秒、且需 10~15 米加速；
 *         赶车实际跑 20~50 米 ⇒ 平均 ≈ 峰值的 75~80% ⇒ 3.5~4.4 m/s；
 *         再计**背包**（占体重 8~15%，约降 5%）⇒ 3.3~4.2 ⇒ 取保守侧 **3.6** ✓
 *         ⚠️ 曾误用峰值 5.0 m/s（ratio 0.28）—— **过于乐观** ✗
 *   档2 小跑 **2.0 m/s**（7.2 km/h）—— ★ 中文「小跑」= 快步小碎步，**不是慢跑**
 *         参照：快走上限 1.8 · 小跑 2.0~2.2 · 慢跑(jogging) 2.2~2.7
 *         计背包（-5%）⇒ 1.9~2.1 ⇒ 取 **2.0** ✓
 *         ⚠️ 曾误引「慢跑 2.5 m/s」（ratio 0.56）—— **引错了口径** ✗
 *   档3 正常 **1.4 m/s**（5.0 km/h）—— 见上（★ 含背包，因基准来自实测）
 *   档4 慢走 **1.0 m/s**（3.6 km/h）—— 慢走典型值
 *   档5 极慢 **0.7 m/s**（2.5 km/h）—— 极慢步速区间 0.6~0.9 的中位
 *         ⚠️ 原值 0.6 偏极端（已属步行障碍区间）
 *
 * ── ★ 背包负重的处理原则（重要）───────────────────────────────────────
 *   文献（负重占体重：<10% → 降 1~3% · 20% → 降 10~15%）；
 *   学生书包约 8~15% 体重 ⇒ 约降 **5%** ✓
 *   **但只对档 1、2 施加此修正** —— 因为**档 3/4/5 的基准来自本项目实测，
 *   而实测时主人本就背着书包** ⇒ 背包影响已包含在内，不可重复扣 ✗
 *
 * ── ⚠️ 口径提醒（避免双重计数）────────────────────────────────────────
 *   文献的「3~30m 舒适步速」**含起步加速**，论文自己警示短距离测量不可作标准。
 *   而 `catch-up.ts#requiredSec` 已用 `OVERHEAD_SEC = 15` 秒**单独扣除**起步/反应/等灯，
 *   ⇒ 本比值对应的应是「纯行走的稳态速度」✓
 *   稳态速度略高于 3~30m 平均值（约 +5~10%），此处**刻意取保守侧** ——
 *   与项目「能否赶上的判定一律用下限（往短了算）」的既有原则一致 ✓
 *
 * 📄 完整调研（含全部文献表与交叉验证）：`docs/步行速度五档-文献依据-20260918.md`
 */
export const SPEED_RATIO: Record<CatchTier, number> = {
  1: 0.39, // 3.6 m/s  全力冲刺（20~50m 平均 + 背包；★ 非峰值速度）
  2: 0.7, // 2.0 m/s  小跑（快步小碎步 + 背包；★ 不是「慢跑」）
  3: 1.0, // 1.4 m/s  ★ 基准：正常走（文献 1.36~1.43 + 本项目实测 1.43，已含背包）
  4: 1.4, // 1.0 m/s  慢慢走
  5: 2.0, // 0.7 m/s  极慢（原 2.5/0.6 偏极端）
};

/**
 * ★ 常速步行速度（米/分钟）= **84**（= 1.4 m/s × 60）—— v1.2.0
 *
 * 用途：把高德返回的**步行路径距离（米）**折成「常速基准分钟」写入 `walk_times.minutes`：
 *   `minutes = distance_m ÷ WALK_BASE_M_PER_MIN`
 *
 * 🚫🚫 **严禁用本常量之外的任何速度在这里折算** ——
 *   分档缩放**只在** `catch-up.ts#requiredSec` 做（那里会乘 `SPEED_RATIO`）；
 *   若在这里也按分档速度算，读端会再乘一次 ⇒ **双重缩档** ✗
 *
 * ⚠️ 必须与 `SPEED_RATIO[3] === 1` 的定义基准（1.4 m/s）保持一致，
 *    `src/lib/rebuild/walk-times.ts` 顶部有运行时断言守着这条。
 */
export const WALK_BASE_M_PER_MIN = 84;

/**
 * ★ 档 1（全力冲刺）的**随距离衰减**模型 —— v1.2.0
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 *   线性模型（一个 `SPEED_RATIO` 乘到底）隐含假设「3.6 m/s 能跑完全程」✗
 *   但 **磷酸原（PCr）系统只能撑 8~10 秒**（≈30 米）——
 *   之后糖酵解接管（速度降至峰值约 60%）、再之后有氧主导（约 50%）。
 *   ⇒ 距离越长，恒定速度的高估越严重（1000 米时约高估 90 秒）✗
 *
 * ── 模型：按「时间」分四段（不是「30 米断崖」）────────────────────────
 *   | 段位           | 时间窗      | 相对峰值 | 速度   | 该段可跑距离 |
 *   |----------------|------------|---------|-------|------------|
 *   | PCr（含加速）  | 0~8 s      | 85%     | 3.80  | ~30 m      |
 *   | PCr→糖酵解     | 8~30 s     | 80%     | 3.58  | ~79 m      |
 *   | **糖酵解主导** | **30~120 s** | **60%** | **2.68** | ~241 m   |
 *   | 有氧主导       | >120 s     | 50%     | 2.24  | 不限        |
 *
 *   ⚠️ 峰值取**保守侧**：由「0~8 秒段 = 3.80 m/s」反推约 4.47 m/s
 *      （而非文献中位的 5.15）—— 与项目「能否赶上的判定一律用下限」一致 ✓
 *
 *   ★ 校核：≤30 m 时得到 3.80 m/s，与线性基线 3.6 基本一致
 *     ⇒ **最常见的赶车场景（校门口跑到站台）几乎不受影响** ✓
 *
 * 📄 完整推导与三版模型对比：`docs/步行速度五档-文献依据-20260918.md` §9
 */
export const TIER1_SEGMENTS: { name: string; durSec: number; speedMps: number }[] = [
  { name: "PCr（含加速）", durSec: 8, speedMps: 3.8 },
  { name: "PCr→糖酵解", durSec: 22, speedMps: 3.58 }, // 8 → 30 秒
  { name: "糖酵解主导", durSec: 90, speedMps: 2.68 }, // 30 → 120 秒
  { name: "有氧主导", durSec: Infinity, speedMps: 2.24 }, // > 120 秒
];

/** 档 1 走完 `distanceM` 米所需的**纯行走秒数**（分段累计） */
export function sprintWalkSec(distanceM: number): number {
  if (!Number.isFinite(distanceM) || distanceM <= 0) return 0;
  let remain = distanceM;
  let t = 0;
  for (const seg of TIER1_SEGMENTS) {
    if (remain <= 0) break;
    const segMaxM = seg.durSec === Infinity ? Infinity : seg.durSec * seg.speedMps;
    const m = Math.min(remain, segMaxM);
    t += m / seg.speedMps;
    remain -= m;
  }
  return t;
}

/**
 * 档 1 的**有效速度比** = `基准速度 ÷ 该距离下的实际平均速度`。
 * 距离未知时退回线性基线值 `SPEED_RATIO[1]`（保持向后兼容）。
 */
export function tier1EffRatio(distanceM: number | null | undefined): number {
  if (distanceM == null || !Number.isFinite(distanceM) || distanceM <= 0) return SPEED_RATIO[1];
  const sec = sprintWalkSec(distanceM);
  if (sec <= 0) return SPEED_RATIO[1];
  const avgSpeed = distanceM / sec; // m/s
  return WALK_BASE_M_PER_MIN / 60 / avgSpeed;
}

/** 分档文案（固定话术，不用「推荐理由」标签） */
export const TIER_TEXT: Record<CatchTier, string> = {
  1: "全力冲刺有机会赶上",
  2: "小跑能赶上",
  3: "正常走能赶上",
  4: "慢慢走能赶上",
  5: "爬过去都能赶上",
};

// ★ v1.0.6：不再需要「本班赶不上，等下一班」文案 —— 赶不上的路线**整条不进候选**
//   （见 model.ts 首段：巴士两辆在途车都赶不上 / 轻轨首段赶不上 → 直接剔除）。
//   理由：若保留，卡片总用时里会掺一个「按班次间隔估」的等车值（轻轨更是直接用赶不上的
//   那班车算），数字偏小却没有依据 —— 与既定的「不用估算卡凑数」口径冲突。
//
// ★ v2.0.1（产品 2026-09-19 复拍板）：**确认不再引入 `TIER_TEXT_NEEDS_WAIT` / `needsWait`**。
//   · 卡片按【线路】组织：最近一班赶不上 ⇒ 该线**整条不显示**（原行为即正确）；
//   · 「后续车次」由 `altBuses`（v1.1.5，`RecommendCard.altBuses`）承担，无需单独文案。
//   · 工程上「字面实现 needsWait 必然丢步行出门段」的坑详见 `model.ts` 顶部 v2.0.1 说明。

/**
 * 轻轨表定逐跳时长（分钟）。
 * 来源：氹仔线表定「逐跳间隔」恒 2.0 分钟（5 对邻站 11 次实测 → 119~121 秒）。
 * ⚠️ 合规：这是派生值，UI 必须注明算法（见 /about）。
 */
export const LRT_MIN_PER_HOP = 2.0;

/** 步行数据全落空时的常数兜底（分钟，1~2 站台距离） */
export const WALK_FALLBACK_MIN = 3.0;

/** 换乘步行兜底（分钟）：LRT-LOT 蓮花 无样本 → 暂用 3 分并在 UI 标「估算」 */
export const TRANSFER_FALLBACK_MIN = 3.0;

/**
 * 巴士「第 2 段起」等车兜底：班次间隔均值（秒）。
 * 首段用实时 DSAT；换乘后的第 2 段起没有实时数据，按间隔 ÷ 2 估。
 */
export const BUS_HEADWAY_FALLBACK_SEC = 360;

/** 同场换乘（前后站在同一物理车站，如 T355/1 ↔ T355/2）→ 步行 0 */
export const SAME_FIELD_TRANSFER_MIN = 0;

/**
 * 巴士报时「上限」的相对余量（仅显示用；**能否赶上的判定一律用下限 loSec**，往短了算）。
 *
 * 逐跳样本是「离开口径」= `run(A→B) + dwell_B`（已含到站停靠），所以 sum 本身不是纯行驶；
 * 上限再乘 1.25 只为覆盖「区间内额外等灯 / 前车压车 / 上下客偏多」这类波动。
 * ⚠️ 初值，与 OVERHEAD_SEC 同批待用实测分布标定。
 */
export const HOP_HI_FACTOR = 1.25;

// ─────────────────────────── 枚举层 ───────────────────────────

/** 一条载具段（枚举产物，尚未算时长） */
export interface RideSegment {
  route: string;
  kind: "bus" | "lrt";
  board: string;
  alight: string;
  /** bus 必需：逐跳站码对（board → alight 行驶方向）；lrt 可为空（按跳数 × 表定） */
  hops: [string, string][];
}

/** 段间换乘（第 i 段 → 第 i+1 段） */
export interface TransferSegment {
  /** 前段下车点 */
  at: string;
  /** 后段上车站 */
  to: string;
  /** 同一物理车站（含 T355/1 ↔ T355/2 这类同场分台）→ 步行 0 */
  sameField: boolean;
}

/** 一条待算路线方案（＝一张卡里的一条路线方案） */
export interface OptionSeed {
  planId: number;
  summary: string;
  fromSlug: string;
  toSlug: string;
  /** 是否含跨境段（卡片须标「不含通关」） */
  crossBorder: boolean;
  /** 载具段（≥1） */
  segments: RideSegment[];
  /** 换乘（长度 = segments.length − 1） */
  transfers: TransferSegment[];
  /** 该方案的展示键（去重用）：route@board→alight 链 */
  key: string;
}

// ─────────────────────────── 数据索引（纯数据，server 构造） ───────────────────────────

/** 站序索引（一次 SQL 取全量站序；server 构造、纯数据传递） */
export interface RouteIndex {
  /** `${route}|${dir}` → 有序站码 */
  dirStops: Map<string, string[]>;
  /** `${route}|${dir}` → 站码 → 序号集合（三段式匹配用） */
  seqIdx: Map<string, Map<string, number[]>>;
  /** route → 该线的方向列表（按 dsat_dir 升序） */
  dirsOf: Map<string, string[]>;
  /** 站码 → 显示名（巴士「C653 金峰南岸」/ 轻轨「氹仔碼頭」） */
  nameOf: Map<string, string>;
  /** 邻接对 `mainCode(from)→mainCode(to)` → 拥有该邻接对的线路集合 */
  adjOwners: Map<string, Set<string>>;
}

/** segment_stats 行（读端最小列集） */
export interface SegmentStatRow {
  route_code: string;
  from_station: string;
  to_station: string;
  weekday: number;
  time_bucket: string;
  arrive_kind: string;
  avg_minutes: number | string;
  p50_minutes: number | string | null;
  samples: number;
}

/** walk_times 行（读端最小列集） */
export interface WalkTimeRow {
  place_id: number;
  station_code: string;
  zone: string | null;
  minutes: number | string | null;
  samples: number;
  /** ★ v1.2.0：高德步行路径距离（米）；NULL = 未知（此时档 1 退回线性） */
  distance_m?: number | string | null;
}

/**
 * ★ station_walk_distance 行（v1.2.0）
 * 与 `walk_times` **分层**存储：距离是「外部事实」（慢变、可增量抓），
 * minutes 是「派生值」。读端分开索引 —— 即使某组还没有实测样本，
 * 只要抓过距离，档 1 的衰减就能算 ✓
 */
export interface StationWalkDistanceRow {
  place_id: number;
  station_main: string;
  zone: string | null;
  distance_m: number | string;
}

/** transfer_walks 行（v1.0.0 新表） */
export interface TransferWalkRow {
  from_station: string;
  to_station: string;
  minutes: number | string;
  samples: number;
  source: string;
}

// ─────────────────────────── 实时层 ───────────────────────────

/** 一辆在途巴士 → 到用户站的「区间」（秒，自 now 起算；下限 = 往短了算） */
export interface BusArrival {
  /** 还有 N 站 */
  stopsAway: number;
  /** DSAT 挂载站码（调试/展示用） */
  atStation: string;
  /** 车辆当前状态：'0' = 已离挂载站驶向下一站（在区间中）；'1' = 停靠挂载站 */
  status: string | null;
  /** 到用户站的区间下限（秒）：区间中 → 该跳算 0 */
  loSec: number;
  /** 到用户站的区间上限（秒） */
  hiSec: number;
  /** 区间下限对应的「跳数」（用于文案） */
  hopMin: number[];
}

/** 单车次实时视图（巴士） */
export interface BusLive {
  kind: "bus";
  route: string;
  /** true = 该方向无任何在途车（不在运营时间 → 整条方案排除） */
  empty: boolean;
  nearest: BusArrival | null;
  second: BusArrival | null;
  /**
   * ★ v1.1.4：第 **3 辆起**的候选（升序，可能为空数组）。`nearest` + `second` + `more`
   * = 「**还没到用户上车站**」的全部在途车，**不设条数上限**。
   *
   * 动机：原先只看 `nearest`/`second` 两辆 —— **两辆都赶不上就整条剔除**，
   * 实测高峰期「第 3 辆 3 分钟后到」的路线被白丢。
   * ⚠️ 已过站的车（`EtaBus.passed`，环线按绕一圈计）**不进池**：它们往往要等一整圈，
   *   留着会让「赶不上就整条剔除」名存实亡。
   * ⚠️ 放宽是**纯增益**：`service.ts` 是「按总用时升序取前 5」，等待更久的路线只会排到后面
   *   （要么填满空位、要么不显示），**不会挤掉更优的方案**。
   */
  more: BusArrival[];
}

/** 单车次实时视图（轻轨；时刻表本地算，无网络） */
export interface LrtLive {
  kind: "lrt";
  route: string;
  state: "running" | "before_first" | "after_last" | "no_data";
  /** 后续发车绝对毫秒（升序，含跨午夜续班；只保留未来若干班） */
  departures: number[];
  /** 发车时刻 'HH:MM'（与 departures 一一对应，供展示） */
  clocks: string[];
  directionName: string | null;
  lineCode: string;
}

export type RouteLive = BusLive | LrtLive;

// ─────────────────────────── 视图（传到客户端） ───────────────────────────

/** 步行视图 */
export interface WalkLegView {
  minutes: number;
  /** 展示标签（如「C653 金峰南岸」） */
  toLabel: string;
  /** 命中层级：1 = (place,主码,zone) · 2 = (place,主码,NULL) · 3 = 该地点均值 · 4 = 全表均值 · 5 = 常数 */
  level: number;
  /** level ≥ 3 → UI 标「估算」 */
  estimated: boolean;
  samples: number;
  /**
   * ★ v1.2.0：该段步行路径距离（米）；`null` = 未知。
   * 来源 `station_walk_distance`（高德步行路径规划）。**仅用于档 1 的随距离衰减**，
   * 不参与 minutes 的计算（minutes 仍是实测均值 / 距离推算值）。
   */
  distanceM?: number | null;
}

/** 载具段视图 */
export interface RideLegView {
  route: string;
  kind: "bus" | "lrt";
  board: string;
  alight: string;
  boardLabel: string;
  alightLabel: string;
  /** 车上用时（分钟） */
  minutes: number;
  /** 跳数 */
  hops: number;
  /** 各跳命中层级（bus；lrt 为空数组） */
  levels: number[];
  /** 本段等车（分钟，**已含在总用时内**；第 2 段起同样是真实推进值，不再恒 0） */
  waitMin: number;
  /**
   * 实时报站主文案。
   * ⚠️ 轻轨首段恒为 `""` —— 它的倒计时由 `<LrtEtaInline>`（客户端每秒重算）承担，
   *    服务端再下发一份冻结文案会让同一行出现两个数字（见 model.ts 注释）。
   * 第 2 段起：轻轨 = 「HH:MM 開出」（就是你会坐的那一班）；巴士 = 「按班次間隔估算」。
   */
  liveText: string;
  /**
   * 实时报站结构化数据（轻轨**首段**才有 → 客户端读秒用）。
   *
   * ★ v1.1.3：**只含「走到站台之后」的班次**（`d > now + 步行分钟`）——
   *   旧版原样下发全部班次，客户端取第一班 → 显示的是「马上就要开、但你还在路上」那班，
   *   与模型实际采用的那班不是同一趟（用户实测发现「显示的不是能赶上的班次」）。
   *   过滤后：`liveDepartures[0]` ≡ `model.ts` 里 `departures.find(d => d > cursor)` 那一班。
   * ⚠️ 第 2 段起不下发：`<LrtEtaInline>` 取的是「**现在**之后的下一班」，
   *    而第 2 段要表达的是「**到达换乘站之后**的第一班」——两者不是同一班车，
   *    故第 2 段起只用 `liveText` 里那个绝对时刻。
   */
  liveDepartures?: number[];
  liveClocks?: string[];
  /** 赶车档（仅首段有；第 2 段起恒 null） */
  tier: CatchTier | null;
  /** 档位文案（仅首段非空；第 2 段起为 ""） */
  tierText: string;
  /**
   * ★ v1.1.2：档位差额提示（如「需較常速快 2.5 分」）。
   *
   * 仅**首段**、且档位为 **1~2**（要比常速更快才赶得上）时非空。理由：
   * 卡面那一行「步行 X 分」显示的是**常速实测均值**，而顶部大字按该档速度算
   * → 可见项直接相加会比大字**大**（实测最多约 4 分钟）。大字没错，缺的是一句解释。
   * ⚠️ 字段挂在 `rides[0]`（档位属于首段载具），但**渲染在卡面第一行「步行」上**。
   */
  tierHint: string;
}

/** 换乘视图 */
export interface TransferView {
  at: string;
  atLabel: string;
  minutes: number;
  estimated: boolean;
  /** 同站台/同场 → 文案「同站台 · 无需步行」 */
  sameField: boolean;
}

/**
 * ★ v1.1.5：**本班之外的后续班次**（卡内列出，不另开卡）。
 *
 * 用户口径（2026-09-16）：
 *   「如果第二辆还有很久到就没有意义 → 限制：坐这一班的话，**门到门总时长要不差于
 *     五张卡片方案中的第五张**；并且不止列后面一班，应列出**所有**满足该条件的车；
 *     车的右边标注**怎样能赶上的分档**。」
 *
 * 场景动机：本班要求冲刺（档 1~2）时，后面「正常走就能赶上」的车原本完全不展示
 *   → 不想跑的用户以为这条线没戏，转去选慢得多的方案。
 */
export interface AltBusView {
  /** 还有 N 站 */
  stopsAway: number;
  /** 「約 lo~hi 分」——服务端算好，与主行同口径（`rangeText`） */
  waitText: string;
  /** 赶这一班的档位（1~5，恒非 null —— 赶不上的已在服务端剔除） */
  tier: CatchTier;
  /** 档位文案（如「正常走能赶上」） */
  tierText: string;
  /** 若乘这一班，门到门总时长（分钟）——用于「不差于第五张卡」的筛选 */
  totalMin: number;
}

export interface RecommendCard {
  planId: number;
  summary: string;
  fromSlug: string;
  toSlug: string;
  /** 总用时（分钟，含等车；门到门） */
  totalMin: number;
  /** 预计到达时刻（ms） */
  arriveAt: number;
  walkOut: WalkLegView;
  walkIn: WalkLegView;
  rides: RideLegView[];
  transfers: TransferView[];
  /** 乘车提示（开发者模式关闭时点击卡片展开） */
  hints: string[];
  /** 是否跨境（标「不含通关」） */
  crossBorder: boolean;
  /**
   * ★ v1.1.5：本班之外的后续班次（已按「总时长 ≤ 第 5 张卡」筛过，按总时长升序）。
   * ⚠️ 由 `service.ts` 在排序取前 N **之后**回填 —— 因为筛选阈值依赖最终入选的第 5 张卡；
   *    `modelOption` 只能算出候选，无法知道阈值。
   */
  altBuses?: AltBusView[];
}

/* ══════════════════════════════════════════════════════════════════════════
   ★ v1.1.8：预测卡片**详情页**的视图类型（用户 2026-09-16 口径）
   · 站条 = 一趟一条；中间站默认收起；左侧线路主题色轨；中间站之间给模型预测行驶时间
   · 折叠栏 = 该站台**剩余所有可达线路**的报站（每条旁可链接到各自详情页）
   ══════════════════════════════════════════════════════════════════════════ */

/** 站条上的一个节点 */
export interface StripStop {
  code: string;
  /** 显示名（「C653 金峰南岸/金譽峰」；轻轨不带站号前缀） */
  label: string;
  /** 到下一站模型预测分钟（末站 = 0）；lrt 为表定逐跳值 */
  minToNext: number;
  /** 该跳的命中层级 1~6（≥3 = 估算/兜底 → UI 标「估算」）；末站 = 0 */
  level: number;
  /** 是否上车站 / 下车站（UI 默认展开这两端） */
  role: "board" | "alight" | "mid";
}

/** 一段载具的纵向站条（**一趟一条**） */
export interface SegmentStrip {
  route: string;
  kind: "bus" | "lrt";
  board: string;
  alight: string;
  boardLabel: string;
  alightLabel: string;
  /** 上车站 → 下车站的有序节点（含两端） */
  stops: StripStop[];
  /** 车上时长（**与 `card.rides[i].minutes` 同源同值** —— 同一串 hops + 同一个 lookupHop） */
  rideMin: number;
  /** 该段之后的换乘（最后一段为 null）—— 用户口径：巴士标上一趟终点 + 换乘站台；轻轨写明换乘步行时长 */
  transferAfter: TransferView | null;
}

/** 折叠栏里一行 = 该站台一条可达线路 */
export interface ReachReport {
  route: string;
  kind: "bus" | "lrt";
  boardLabel: string;
  alightLabel: string;
  /** 实时报站主文案（「還有 3 站 · 約 4~6 分」/「15:32 開出」） */
  liveText: string;
  /** 轻轨读秒用（与卡片首段同口径，只含「走到站台之后」的班次） */
  liveDepartures?: number[];
  liveClocks?: string[];
  /** 该线在本站台的全部可行下车点 */
  alightCandidates: string[];
  /**
   * 门到门总时长（分钟）。
   * ⚠️ `null` 有**两种**成因，必须配合 `inPlan` 区分（v1.1.8 修正）：
   *    · `inPlan === false` → **该线不在任何在用方案表里**（没有 seed）→ 永远算不出总时长
   *    · `inPlan === true`  → 在方案表里，但**本轮没有在途车**（收车/不在营运时段）→ 暂时算不出
   *    两者在 UI 上文案不同（「未收錄於方案」vs「暫無實時車」），**不可混为一谈**。
   */
  minutes: number | null;
  /** 该线是否出现在在用方案表里（有 seed ⇒ 有实时车时就能算出门到门总时长） */
  inPlan: boolean;
  tier: CatchTier | null;
  tierText: string;
  /** 该线自己的详情页地址（`/card?...`）；无法定位时为 null */
  href: string | null;
  /** false = 本轮没拿到实时数据（超时 / 收车 / 不在营运时段） */
  live: boolean;
}

/** `/api/card` 的完整返回 */
export interface CardDetailPayload {
  fromSlug: string;
  toSlug: string;
  zone: SchoolZone | null;
  /** 命中的那张卡（含 altBuses） */
  card: RecommendCard;
  colors: Record<string, string>;
  /** 每段载具的站条（一趟一条） */
  strips: SegmentStrip[];
  /** 折叠栏：该站台剩余所有可达线路（含本卡自己，按 minutes 升序、null 排最后） */
  reports: ReachReport[];
  /** 筛选阈值 = 第 N 张卡的总时长（用户口径「速度優於五張卡片最慢方案」） */
  thresholdMin: number;
  generatedAt: number;
  /** true = 折叠栏那一批实时数据整体超时/失败 → UI 应提示「實時報站暫不可用」 */
  liveDegraded: boolean;
}
