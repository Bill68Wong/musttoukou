/**
 * 站码映射（src/lib/nav/map-stations.ts，v1.3.0 提案 · T03）
 *
 * ── 职责（设计 §B.3a / §C.4）───────────────────────────────────────────
 *   ① 载入 `station_amap_map`（**人工确认优先**：`verified_by_human=true` 优先，其次置信度）；
 *   ② 把高德方案里的「高德站 + 高德线路名」**桥接**成我们的**主码 + 线路码 + 逐跳站序**；
 *   ③ 过滤：穿梭巴士（黑名单）/ 轻轨在建线（ES1–ES6）；
 *   ④ 判定「是否整方案乘车段全映射失败」（是 → 剔除该方案，§C.4）。
 *
 * ── 两个索引与两个网 ─────────────────────────────────────────────────
 *   · **站映射**：`station_amap_map`（高德站 id / 高德简体名 → 我们主码）。
 *     高德站名是**简体**、我们库是**繁体** ⇒ 桥接用 `normalizeName()` 繁简归一。
 *   · **线路映射**：高德**没有**线路映射表 ⇒ 本文件按规则从线路名推导
 *     （巴士：「30X路(…)」→ 取「路」前并大写 → 校验在我们线路集合内；
 *      轻轨：「氹仔线(…)」→ `LRT-氹仔线`）；推导不出或不在集合内 → 该腿**未映射**（回落高德时长）。
 *
 * ── 逐跳站序从哪来 ────────────────────────────────────────────────────
 *   ★ **不是**高德的 `via_stops`（那是高德站，无法直接给 `lookupHop` 用），
 *   而是用**我们的**站序索引 `segmentsOf(routeIdx, route, boardMain, alightMain)` 解出
 *   ⇒ 保证与旧版 `rideOfHops` 同口径（`segment_stats` 逐跳）。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §B.2 / §B.3a / §B.3b·c / §C.4
 */
import type { Pool } from "pg";
import { isShuttleBus, isUnderConstruction } from "@/lib/amap/transit";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { RouteIndex } from "@/lib/recommend/types";
import { segmentsOf } from "@/lib/recommend/enumerate";
import { normalizeName } from "@/lib/shared/normalize";
import type { AmapPlanLeg, AmapStop, StationConfidence } from "./types";

// ─────────────────────────── 站映射 ───────────────────────────

export interface StationMapping {
  main: string;
  nameTc: string;
  verified: boolean;
  confidence: StationConfidence;
}

export interface StationMap {
  /** 高德站 id → 映射 */
  byId: Map<string, StationMapping>;
  /** 归一化高德站名（简体去噪）→ 映射 */
  byName: Map<string, StationMapping>;
  /** 主码 → 我们站名（繁体，展示用） */
  nameTcOfMain: Map<string, string>;
  /** 行数（诊断） */
  size: number;
}

/**
 * 载入映射表（★ 人工确认优先：`verified_by_human DESC, confidence DESC`）。
 * 同一高德站若有多行，**先到者胜**（已排序 ⇒ 即「最可信的那行」）。
 */
export async function loadStationMap(pool: Pool): Promise<StationMap> {
  const byId = new Map<string, StationMapping>();
  const byName = new Map<string, StationMapping>();
  const nameTcOfMain = new Map<string, string>();
  const res = await pool.query(
    `SELECT amap_station_id, amap_name, dsat_station_main, name_tc, verified_by_human, confidence
       FROM station_amap_map
      WHERE dsat_station_main IS NOT NULL
      ORDER BY verified_by_human DESC,
               CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC,
               id ASC`,
  );
  for (const r of res.rows as Record<string, unknown>[]) {
    const main = String(r.dsat_station_main);
    const conf = String(r.confidence ?? "low") as StationConfidence;
    const m: StationMapping = {
      main,
      nameTc: String(r.name_tc ?? ""),
      verified: r.verified_by_human === true,
      confidence: conf,
    };
    const id = r.amap_station_id ? String(r.amap_station_id) : "";
    if (id && !byId.has(id)) byId.set(id, m);
    const nm = normalizeName(String(r.amap_name ?? ""));
    if (nm && !byName.has(nm)) byName.set(nm, m);
    if (m.nameTc && !nameTcOfMain.has(main)) nameTcOfMain.set(main, m.nameTc);
  }
  return { byId, byName, nameTcOfMain, size: byId.size };
}

/** 高德站（可带 id）→ 我们主码；映射不到返回 null */
export function bridgeStop(map: StationMap, stop: { id?: string; name?: string }): string | null {
  if (stop.id && map.byId.has(stop.id)) return map.byId.get(stop.id)!.main;
  const nm = normalizeName(stop.name ?? "");
  if (nm && map.byName.has(nm)) return map.byName.get(nm)!.main;
  return null;
}

// ─────────────────────────── 线路映射 ───────────────────────────

/** 高德线路名 → 我们线路码（推导不出或不在集合内 → null） */
export function routeCodeOf(name: string, kind: "bus" | "lrt", valid: Set<string>): string | null {
  if (kind === "lrt") {
    if (/氹仔[线線]/.test(name) && valid.has("LRT-氹仔线")) return "LRT-氹仔线";
    if (/石排[湾灣]/.test(name) && valid.has("LRT-石排湾线")) return "LRT-石排湾线";
    if (/[横橫]琴/.test(name) && valid.has("LRT-横琴线")) return "LRT-横琴线";
    return null;
  }
  // 巴士：'30X路(关闸广场--关闸广场)' → '30X'
  const head = name.split(/[(（]/)[0].trim();
  const cand = head.replace(/路$/, "").replace(/\s+/g, "").toUpperCase();
  if (!cand) return null;
  if (valid.has(cand)) return cand;
  // 少数线路名带前后缀（如 'N2路' 已覆盖）；再试去零宽字符
  const alt = cand.replace(/[\u200b-\u200d\ufeff]/g, "");
  return valid.has(alt) ? alt : null;
}

// ─────────────────────────── 过滤（§B.3b·c） ───────────────────────────

/** 是否含在建轻轨站（ES1–ES6；本库没有、绝不推荐） */
function hasUnderConstructionStop(leg: AmapPlanLeg): boolean {
  if (isUnderConstruction(leg.amapLineName)) return true;
  return leg.amapViaStops.some((s) => /\bES[1-6]\b/i.test(s.name));
}

/**
 * 方案是否应被**过滤掉**（穿梭巴士 / 在建轻轨）。
 * ⚠️ 只需求内任一腿命中即剔整方案 —— 因为这类方案在澳门无意义（赌场免费巴）、
 *    或含本库没有的在建站（无法逐跳重算、且不该推荐）。
 */
export function planFilterReason(legs: AmapPlanLeg[]): string | null {
  for (const leg of legs) {
    if (leg.kind === "bus" && isShuttleBus(leg.amapLineName)) return `shuttle:${leg.amapLineName}`;
    if (leg.kind === "lrt" && hasUnderConstructionStop(leg)) return `under_construction:${leg.amapLineName}`;
    if (leg.kind === "bus" && hasUnderConstructionStop(leg)) return `under_construction:${leg.amapLineName}`;
  }
  return null;
}

// ─────────────────────────── 桥接 ───────────────────────────

export interface BridgeContext {
  map: StationMap;
  validRoutes: Set<string>;
  routeIdx: RouteIndex;
}

/** 主码与载具种类是否一致（轻轨码统一 `LRT-` 前缀）——防止「LRT 站误配到巴士站码」
 *
 * ★ **待人工复核的具体行**（T01 自动映射产物；产品按此 SQL 逐行确认）：
 * ```sql
 * -- (1) 高德侧写着「地铁站/轻轨站」、却被映射到【非 LRT-】站码的行（= 本护栏兜的那类错配）
 * SELECT id, amap_station_id, amap_name, dsat_station_main, name_tc, match_dist_m, confidence
 *   FROM station_amap_map
 *  WHERE (amap_name LIKE '%地铁站%' OR amap_name LIKE '%轻轨站%' OR amap_name LIKE '%輕軌站%')
 *    AND (dsat_station_main IS NULL OR dsat_station_main NOT LIKE 'LRT-%')
 *  ORDER BY confidence, match_dist_m;
 *
 * -- (2) 我们库的 LRT 站，是否都已被高德站正确映射（应尽量命中 LRT- 站码）
 * SELECT s.code AS our_lrt, s.name_tc, m.amap_name, m.dsat_station_main,
 *        m.match_method, m.match_dist_m, m.confidence, m.verified_by_human
 *   FROM stations s
 *   LEFT JOIN station_amap_map m ON m.dsat_station_main = s.code
 *  WHERE s.kind = 'lrt'
 *  ORDER BY (m.dsat_station_main IS NULL), s.code;
 * ```
 * 复核后在 CSV 填 `我们站码` 并清空「待人工确认」，跑 `db:apply-amap-map` 回写。
 */
function mainKindOk(code: string, kind: "bus" | "lrt"): boolean {
  const isLrt = code.startsWith("LRT-");
  return kind === "lrt" ? isLrt : !isLrt;
}

/** 桥接一腿（就地返回新对象；映射失败时 mapped* 为 null） */
export function bridgeLeg(ctx: BridgeContext, leg: AmapPlanLeg): AmapPlanLeg {
  const mappedRoute = routeCodeOf(leg.amapLineName, leg.kind, ctx.validRoutes);
  let mappedBoard = bridgeStop(ctx.map, leg.amapBoard);
  let mappedAlight = bridgeStop(ctx.map, leg.amapAlight);
  // ★ 种类一致性护栏：LRT 腿必须映到 `LRT-` 站、巴士腿必须映到非 LRT 站
  //   （实测：T01 自动映射把高德轻轨站最近邻到了 60m 内的巴士站 C651 ⇒ 若放行，
  //     `segmentsOf` 解不出逐跳 + 上下车站标签错 ⇒ 宁可判「未映射」回落高德时长）
  if (mappedBoard && !mainKindOk(mappedBoard, leg.kind)) mappedBoard = null;
  if (mappedAlight && !mainKindOk(mappedAlight, leg.kind)) mappedAlight = null;

  let mappedHops: [string, string][] | null = null;
  if (mappedRoute && mappedBoard && mappedAlight && mainCodeOf(mappedBoard) !== mainCodeOf(mappedAlight)) {
    const seg = segmentsOf(ctx.routeIdx, mappedRoute, mappedBoard, mappedAlight);
    if (seg && seg.segs.length) mappedHops = seg.segs;
  }

  return { ...leg, mappedRoute, mappedBoard, mappedAlight, mappedHops };
}

/** 该腿是否「可用我们的数据重算」（三要素齐 + 逐跳可解） */
export function legIsMapped(leg: AmapPlanLeg): boolean {
  return !!(leg.mappedRoute && leg.mappedBoard && leg.mappedAlight && leg.mappedHops && leg.mappedHops.length);
}

/** ★ §C.4：整方案乘车段**全部**映射失败 → 剔除该方案 */
export function planFullyUnmapped(legs: AmapPlanLeg[]): boolean {
  return legs.length > 0 && legs.every((l) => !legIsMapped(l));
}

/** 高德站 id 从 `AmapStop` 未携带（解析层未取 id）—— 名称兜底已足够；此函数保留以备将来扩展 */
export function stopLabel(stop: AmapStop): string {
  return stop.name;
}
