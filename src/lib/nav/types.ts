/**
 * 全澳导航 · 类型与数据结构（src/lib/nav/types.ts，v1.3.0 提案）
 *
 * ⚠️ 纯类型 / 常量模块：**不得 import 任何含 pg 的模块** —— 这些视图类型会传到客户端
 *    渲染（`RecommendCard`/`CardDetailClient` 复用）。服务端查询一律另置模块。
 *
 * 对应设计：docs/设计-全澳导航-v1-20260918.md §4；类图 docs/class-diagram.mermaid。
 * 复用：`RideLegView`/`WalkLegView`/`TransferView`/`CatchTier`/`SegmentLevel` 直接沿用
 *       `src/lib/recommend/*`，**不重写**。
 */
import type { RideSegment, TransferSegment } from "@/lib/recommend/types";
import type { RideLegView, WalkLegView, TransferView } from "@/lib/recommend/types";
import type { SegmentLevel } from "@/lib/recommend/segment-lookup";

// ─────────────────────────── 坐标点 ───────────────────────────

/** 导航端点种类：GPS 定位 / 搜索到的 POI / 站点 / 预设地点 */
export type NavPointKind = "gps" | "poi" | "station" | "place";

/**
 * 导航端点。
 * ★ 坐标系铁律：进入本系统后，`lng`/`lat` **一律 GCJ-02**。
 *   · 用户 GPS（WGS84）在**边界处**转 GCJ-02（用户侧不自己转 / 由定位层统一处理）；
 *   · 高德返回坐标**原样**使用（已是 GCJ-02）；
 *   · 我们库 WGS84 坐标须经 `wgs84ToGcj02()`。
 */
export interface NavPoint {
  kind: NavPointKind;
  /** 展示名（站名用繁体官方原文，见 §6.2） */
  label: string;
  /** 经度（GCJ-02） */
  lng: number;
  /** 纬度（GCJ-02） */
  lat: number;
  /** 我们库站码（kind="station" 时有） */
  code?: string;
  /** 高德 POI id（kind="poi" 时有） */
  poiId?: string;
  /** 行政区划码（澳门 = 820000） */
  adcode?: string;
}

// ─────────────────────────── POI 解析 ───────────────────────────

/** 搜索结果来源：本地别名库（0 配额）/ 高德 inputtips / 高德 place/text */
export type PoiSource = "local" | "amap-inputtips" | "amap-text";

/** 结果类型 */
export type PoiKind = "station" | "lrt_station" | "poi" | "place";

/** 一条 POI 搜索结果（确认后即成为 transit 的 destination） */
export interface PoiSearchResult {
  source: PoiSource;
  /** 名称（本地命中给繁体原名；高德命中给高德原文） */
  name: string;
  address?: string;
  district?: string;
  adcode?: string;
  /** 经度（GCJ-02） */
  lng: number;
  /** 纬度（GCJ-02） */
  lat: number;
  kind: PoiKind;
  /** 与用户当前位置的距离（米）；未知则不填（inputtips 无 dist，见调研 §6 坑#8） */
  distM?: number;
  /** 排序分（越大越靠前；本地命中普遍高于高德） */
  score: number;
}

/** 本地别名库一行（`poi_aliases`） */
export interface AliasEntry {
  /** 归一化别名（已繁→简、去空白）—— 匹配键 */
  aliasNorm: string;
  /** 'station' | 'lrt_station' | 'route' | 'poi' | 'place' */
  targetKind: string;
  /** 站码 / 线路码 / 点位码 */
  targetCode?: string;
  /** 目标显示名（繁体官方原文） */
  nameTc: string;
  /** 经度（GCJ-02） */
  lng?: number;
  /** 纬度（GCJ-02） */
  lat?: number;
  /** 命中权重 */
  weight: number;
  /** 来源：'station'|'route'|'campus'|'border'|'lrt'|'pt'|'manual' */
  source: string;
}

// ─────────────────────────── 搜索建议响应（T02） ───────────────────────────

/**
 * 本地命中但**无坐标**的候选（线路名 / 轻轨网络 / 葡文地名 / 口语别名）。
 * 这些别名库里有、但没坐标 ⇒ 不能直接作 transit 端点；选中/回车时需由高德确认坐标。
 */
export interface PoiPendingMatch {
  /** 显示名（繁体官方原文） */
  name: string;
  /** 'station' | 'lrt_station' | 'route' | 'poi' | 'place' */
  targetKind: string;
  targetCode?: string;
  source: PoiSource;
  score: number;
}

/** 下拉区灰字提示的**语义键**（UI 据此渲染；文案常量见 `poi-search.ts`） */
export type PoiHint = "no_local_then_enter" | "amap_empty";

/** `/api/poi/suggest` 响应（★ 两段式搜索：打字纯本地 / 回车可调高德） */
export interface PoiSuggestResponse {
  /** 请求模式：type=打字（纯本地，0 配额）/ enter=回车（可调高德） */
  mode: "type" | "enter";
  /** 有坐标的候选（本地 + 高德混排；本地优先 → 近者优先） */
  results: PoiSearchResult[];
  /** 本地命中但无坐标（选中需走高德确认坐标） */
  pending: PoiPendingMatch[];
  /** 灰字提示键（仅「本地无命中且输入 ≥2 字符」或「高德也无结果」时给；否则无） */
  hint?: PoiHint;
  /** 灰字提示的**落地文案**（设计 §2.A.6 原文；与 `hint` 一一对应） */
  hintText?: string;
  /** true = 搜索配额熔断中（高德兜底已停，仅本地可用） */
  amapCircuitOpen?: boolean;
  /** 本次消耗的搜索配额次数（回车命中缓存时为 0） */
  quotaConsumed?: number;
}

// ─────────────────────────── 站码映射 ───────────────────────────

/** 匹配方法 */
export type StationMatchMethod = "coord" | "name" | "both" | "manual" | "unmatched";
/** 置信度（high=坐标≤30m 且名称命中；medium=坐标≤60m 或名称命中；low=其余） */
export type StationConfidence = "high" | "medium" | "low";

/**
 * 高德站 ↔ 我们站码 的映射一行（`station_amap_map`）。
 * ★ R5：`amapName`（高德简体）与 `nameTc`（我们繁体）**两列并存**，不可合并。
 */
export interface StationAmapMap {
  /** 高德站 id（有则优先按 id 匹配） */
  amapStationId?: string;
  /** 高德站名（简体） */
  amapName: string;
  /** 高德坐标（GCJ-02） */
  amapLng: number;
  amapLat: number;
  /** 我们【主码】（已剥站台后缀）；未匹配时为空 */
  dsatStationMain?: string;
  /** 我们站名（繁体官方原文） */
  nameTc?: string;
  matchMethod: StationMatchMethod;
  /** 坐标最近邻距离（米） */
  matchDistM?: number;
  /** 名称（繁简归一后）是否命中 */
  nameMatch: boolean;
  confidence: StationConfidence;
}

// ─────────────────────────── 步行 ───────────────────────────

/**
 * 步行段来源（§C.1 来源标注）。
 *  · `amap`           —— 高德 transit 自带的步行几何（主路径）
 *  · `amap-cache`     —— 降级路径命中 `walk_cache`
 *  · `walk-times`     —— 降级路径回落实测 `walk_times`
 *  · `amap-transfer`  —— 换乘步行（轻轨相关）用高德换乘时间
 *  · `straight-estimate` —— 直线 × 1.5 估算（拿不到几何时）
 *  · `fallback`       —— 常数兜底
 */
export type WalkSource =
  | "amap"
  | "amap-cache"
  | "walk-times"
  | "amap-transfer"
  | "straight-estimate"
  | "fallback";

/** 步行信息（首末段 minutes = corrected_m ÷ 84；换乘段轻轨相关 = 高德时间） */
export interface WalkInfo {
  /** 常速基准分钟（tier 3 口径） */
  minutes: number;
  /** 路径距离（米，短距修正后） */
  distanceM?: number;
  /** 目的显示名（如「C653 金峰南岸」） */
  toLabel: string;
  source: WalkSource;
  /** true = 估算（UI 标「估算」） */
  estimated: boolean;
  /** 样本数（实测口径才有意义；高德几何为 0） */
  samples: number;
}

/** `model.ts` 接缝：把「高德/缓存步行」注入 `modelOption`（不新增签名） */
export interface WalkResolver {
  /** 起点 → 上车站 */
  out(stationMain: string): WalkInfo;
  /** 下车站 → 目的地 */
  in(stationMain: string): WalkInfo;
}

// ─────────────────────────── 高德方案骨架（R2/R3 核心） ───────────────────────────

/** 高德站（含 GCJ-02 坐标） */
export interface AmapStop {
  name: string;
  /** 经度（GCJ-02） */
  lng: number;
  /** 纬度（GCJ-02） */
  lat: number;
  /** ★ 高德站 id —— 映射表的**首选**桥接键（比站名稳，站名会改名） */
  id?: string;
}

/** 高德方案里的一段载具（+ 站码桥接结果） */
export interface AmapPlanLeg {
  kind: "bus" | "lrt";
  /** 高德线路名（用于：地铁→轻轨文案、穿梭巴士黑名单） */
  amapLineName: string;
  /** 高德线路 type（'普通公交线路' | '地铁线路'） */
  amapLineType: string;
  /** 高德上车站（原始，含 GCJ-02） */
  amapBoard: AmapStop;
  /** 高德下车站（原始） */
  amapAlight: AmapStop;
  /** 完整站序（高德 `via_stops`，含坐标） */
  amapViaStops: AmapStop[];
  /** 高德该段时长（秒）；映射失败时作兜底 */
  amapDurationSec: number;
  /** ★ 桥接结果：高德站 → 我们主码（可能部分失败） */
  mappedRoute: string | null;
  mappedBoard: string | null;
  mappedAlight: string | null;
  mappedHops: [string, string][] | null;
}

/** 方案内的换乘步行（相邻 leg 之间的高德 walking 段） */
export interface AmapPlanTransfer {
  /** 高德换乘步行时长（秒）—— 轻轨相关时采用 */
  amapDurationSec: number;
  /** 换乘步行距离（米）；缺失 = null */
  distanceM: number | null;
}

/** 首末步行（含直线与短距修正后距离） */
export interface AmapWalkSeed {
  /** 高德步行距离（米） */
  distanceM: number;
  /** 直线距离（米，球面） */
  straightM: number;
  /** 短距修正后距离（米）—— 写卡口径 */
  correctedM: number;
}

/**
 * 一条高德方案的骨架（解析产物，**尚未二次计算**）。
 * ⚠️ 本对象是「候选来源」与「我们重算」之间的接缝：它保留高德原值（对照基准）
 *    与桥接结果（站码映射）。
 */
export interface AmapPlanSeed {
  /** 高德返回序（对照用） */
  index: number;
  /** 高德原始总时长（秒）—— 对照基准，**不用于排序** */
  amapTotalSec: number;
  /** 高德票价（元/MOP）；未知 = null */
  amapTransferFee: number | null;
  walkOut: AmapWalkSeed;
  walkIn: AmapWalkSeed;
  legs: AmapPlanLeg[];
  transfers: AmapPlanTransfer[];
}

/** 二次计算的来源/可信度凭据（差异告警用，§C.7） */
export interface RecomputeProvenance {
  /** 用我们 `lookupHop` 重算的乘车段数 */
  usedOurDataLegs: number;
  /** 映射失败、回落高德时长的乘车段数 */
  usedAmapFallbackLegs: number;
  /** 各乘车段逐跳命中层级（L1~L6） */
  hopLevels: SegmentLevel[][];
  /** |T_ours − T_amap| / T_amap */
  deviationRatio: number;
  /** true = 整方案存疑（差异过大 / 多段存疑） */
  suspect: boolean;
}

/**
 * 二次计算结果（逐方案）。
 * `totalMin` = 我们算出的门到门总时长（**排序主键**，§C.6）。
 */
export interface RecomputeResult {
  seed: AmapPlanSeed;
  /** 我们算出的门到门总时长（分钟） */
  totalMin: number;
  rides: RideLegView[];
  walkOut: WalkLegView;
  walkIn: WalkLegView;
  transfers: TransferView[];
  provenance: RecomputeProvenance;
}

// ─────────────────────────── 本地方案 / 结果页（R3 补漏与降级共用） ───────────────────────────

/** 本地图枚举产出的候选方案（R1 保留；R3 起为「补漏 + 降级」共用） */
export interface NavCandidate {
  id: string;
  from: NavPoint;
  to: NavPoint;
  /** 载具段（≥1；复用旧功能类型） */
  segments: RideSegment[];
  /** 换乘（长度 = segments.length − 1） */
  transfers: TransferSegment[];
  /** 是否含跨境段（卡片须标「不含通关」） */
  crossBorder: boolean;
  /** 展示键（去重用） */
  key: string;
}

/** 结果页内一条方案的分级标注 */
export interface Provenance {
  /** walkOut 来源标注（如「高德路徑」/「估算」） */
  walkOut: string;
  /** walkIn 来源标注 */
  walkIn: string;
  /** 各乘车段逐跳层级 */
  rideLevels: number[][];
  /** 是否含估算段 */
  hasEstimate: boolean;
}

/** 结果页一条方案（与 `RecommendCard` 结构兼容 → 渲染复用） */
export interface NavPlan {
  id: string;
  /** 排序位次（1 起） */
  rank: number;
  /** 我们算出的门到门总时长（分钟） */
  totalMin: number;
  /** 预计到达时刻（ms） */
  arriveAt: number;
  walkOut: WalkLegView;
  walkIn: WalkLegView;
  rides: RideLegView[];
  transfers: TransferView[];
  crossBorder: boolean;
  provenance: Provenance;
  /** 来源：'amap'（高德）/ 'local'（本地补漏）—— 卡片用中性文案，不暴露实现 */
  origin: "amap" | "local";
}

/** 空状态原因（§11.4；仅 0 条时呈现） */
export type NavEmptyReason =
  | "no_candidate" // 找不到可用路线
  | "no_live" // 无在途车 / 已收班
  | "too_close" // 距离过近 → 建议步行
  | "no_cover" // 附近无站点（郊区）
  | "amap_unavailable"; // 高德不可用（降级仍无结果）

/** 导航结果（`/api/nav` 返回） */
export interface NavResult {
  plans: NavPlan[];
  /** true = 走高德降级路径（本地推算），UI 须提示「本地推算」 */
  degraded: boolean;
  /** plans 为空时的原因 */
  emptyReason?: NavEmptyReason;
}

export type {
  RideLegView,
  WalkLegView,
  TransferView,
  RideSegment,
  TransferSegment,
  SegmentLevel,
};
