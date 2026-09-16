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
 * 各档相对「正常走」的**耗时比**（权威步速 5.5 / 3.1 / 1.5 / 1.0 / 0.6 m/s 归一）：
 *   正常走 1.5 m/s → ×1.0（基准 3）· 慢走 1.0 m/s → ×1.5 · 快走 2.3 m/s → ×0.65≈0.48(慢跑)
 *   冲刺 5.5 m/s → ×0.27 · 第⑤档「爬」0.6 m/s → ×2.5
 */
export const SPEED_RATIO: Record<CatchTier, number> = {
  1: 0.27,
  2: 0.48,
  3: 1.0,
  4: 1.5,
  5: 2.5,
};

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
}
