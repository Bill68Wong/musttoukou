/**
 * 本地别名库解析（src/lib/nav/alias-resolve.ts，v1.3.0 · T02）
 *
 * ── 定位 ──────────────────────────────────────────────────────────────
 *   两段式搜索（设计 §2.A.6）的**第一段**：把用户打的字（**可能简体 / 可能错字**）
 *   归一化后查本地 `poi_aliases` 表，**0 高德配额**、秒回。命中即直接给候选；
 *   未命中才由 `poi-search.ts` 在「回车」时走高德兜底。
 *
 * ── 归一化（★ 关键，复用 T01 的 normalize）─────────────────────────────
 *   别名库的匹配键 `alias_norm` 一律是「**繁体→简体 + 去空白 + 小写**」（seed 用
 *   `normalizeQuery` 生成）。所以查询也必须**用同一函数归一化**，否则
 *   「機場」（用户打繁体）永远匹配不到存为「机场」的键 ✗（实测：直接查 `機場` 0 命中）。
 *   另用 `normalizeName`（额外**去交通后缀**）生成第二个键，支持「关闸」匹配「關閘總站」。
 *
 * ── 匹配层级（精确 > 前缀 > 包含）──────────────────────────────────────
 *   ① 精确：`alias_norm = 键`（含去后缀键）—— 权重最高；
 *   ② 前缀：`alias_norm LIKE '键%'` —— 逐字输入的自然扩展（打「威尼」→「威尼斯人」）；
 *   ③ 包含：`alias_norm LIKE '%键%'`（仅当键长 ≥2，避免单字噪声）。
 *   排序：匹配层级 → 别名库 weight 降序 → 短键优先（越短越具体）；有定位时叠加近者优先。
 *
 * ── 坐标 ──────────────────────────────────────────────────────────────
 *   别名库坐标已是 **GCJ-02**（T01 seed 用 `wgs84ToGcj02` 转好）。带坐标的命中 → 直接
 *   可作 transit destination；**无坐标**的命中（线路名/轻轨/葡文/口语）→ 交给调用方
 *   归入 `pending`，选中时由高德确认。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §2.A / §2.A.6 / §6.2；
 *      seed：scripts/seed-poi-aliases.ts（别名库列结构）。
 */
import { getPool } from "@/lib/db";
import { haversineM, type LatLng } from "@/lib/amap/coord";
import { normalizeName, normalizeQuery } from "@/lib/shared/normalize";
import type { PoiKind, PoiSearchResult } from "@/lib/nav/types";

/** 一条别名命中（带匹配方式与打分） */
export interface AliasMatch {
  /** 归一化别名键（简体、无空白） */
  aliasNorm: string;
  /** 别名原文（诊断用） */
  aliasRaw: string;
  /** 'station' | 'lrt_station' | 'route' | 'poi' | 'place' */
  targetKind: string;
  /** 站码 / 线路码 / 地点 slug */
  targetCode: string;
  /** 目标显示名（★ 繁体官方原文） */
  nameTc: string;
  /** 经度（GCJ-02）；无坐标为 null */
  lng: number | null;
  /** 纬度（GCJ-02）；无坐标为 null */
  lat: number | null;
  /** 别名库权重 */
  weight: number;
  /** 来源：'station'|'route'|'campus'|'border'|'lrt'|'pt'|'manual' */
  source: string;
  /** 匹配方式（精确 > 前缀 > 包含） */
  matchType: "exact" | "prefix" | "contains";
  /** 综合分（越大越靠前） */
  score: number;
}

const MATCH_BASE: Record<AliasMatch["matchType"], number> = { exact: 1000, prefix: 600, contains: 300 };
/** 近距离加成上限（米 → 0 分）；与 poi.ts 的取向量级解耦，避免高德/本地排序混用 */
const PROX_MAX = 100;
const PROX_SCALE_M = 50;

/** target_kind → 对外 PoiKind */
export function kindOfTarget(targetKind: string): PoiKind {
  switch (targetKind) {
    case "station":
      return "station";
    case "lrt_station":
      return "lrt_station";
    case "place":
      return "place";
    default:
      return "poi"; // route / poi / 其它
  }
}

interface RawRow {
  alias_norm: string;
  alias_raw: string;
  target_kind: string;
  target_code: string;
  name_tc: string;
  lng: number | null;
  lat: number | null;
  weight: string | number;
  source: string;
  rank: number;
}

/**
 * 查本地别名库。
 *
 * @param query  用户原始输入（可简体 / 可繁体 / 可有错字）
 * @param opts.userPos 用户当前位置（GCJ-02），给了就叠加「近者优先」
 * @param opts.limit  最多返回条数（默认 12）
 * @returns 命中的别名（已排序）；无命中返回空数组（**不抛错**）
 */
export async function resolveAliases(
  query: string,
  opts: { userPos?: LatLng; limit?: number } = {},
): Promise<AliasMatch[]> {
  const raw = (query ?? "").trim();
  if (!raw) return [];
  const key = normalizeQuery(raw); // 繁体→简体 + 去空白 + 小写
  if (!key) return [];
  const keyCore = normalizeName(raw); // 额外：去交通后缀（「關閘總站」→「关闸」）
  const limit = Math.max(1, Math.min(50, opts.limit ?? 12));
  const contains = key.length >= 2;

  const pool = getPool();
  const { rows } = await pool.query<RawRow>(
    `SELECT alias_norm, alias_raw, target_kind, target_code, name_tc, lng, lat, weight, source,
            CASE
              WHEN alias_norm = $1 OR alias_norm = $2 THEN 0
              WHEN alias_norm LIKE $3 THEN 1
              ELSE 2
            END AS rank
       FROM poi_aliases
      WHERE alias_norm = $1
         OR alias_norm = $2
         OR alias_norm LIKE $3
         OR ($5::boolean AND alias_norm LIKE $4)
      ORDER BY rank ASC, length(alias_norm) ASC, weight DESC, alias_norm ASC
      LIMIT $6`,
    [key, keyCore, `${key}%`, `%${key}%`, contains, limit],
  );

  const userPos = opts.userPos;
  return rows
    .map((r) => {
      const matchType: AliasMatch["matchType"] = r.rank === 0 ? "exact" : r.rank === 1 ? "prefix" : "contains";
      const weight = Number(r.weight);
      const lng = r.lng === null ? null : Number(r.lng);
      const lat = r.lat === null ? null : Number(r.lat);
      let prox = 0;
      if (userPos && lng !== null && lat !== null) {
        prox = Math.max(0, PROX_MAX - haversineM(userPos, { lng, lat }) / PROX_SCALE_M);
      }
      return {
        aliasNorm: r.alias_norm,
        aliasRaw: r.alias_raw,
        targetKind: r.target_kind,
        targetCode: r.target_code,
        nameTc: r.name_tc,
        lng,
        lat,
        weight,
        source: r.source,
        matchType,
        score: MATCH_BASE[matchType] + weight * 10 + prox,
      } satisfies AliasMatch;
    })
    .sort((a, b) => b.score - a.score);
}

/** 别名命中 → `PoiSearchResult`（⚠️ 无坐标返回 null —— 那条应归入 `pending`） */
export function aliasToResult(m: AliasMatch, opts: { userPos?: LatLng } = {}): PoiSearchResult | null {
  if (m.lng === null || m.lat === null) return null;
  const distM = opts.userPos ? Math.round(haversineM(opts.userPos, { lng: m.lng, lat: m.lat })) : undefined;
  return {
    source: "local",
    name: m.nameTc,
    lng: m.lng,
    lat: m.lat,
    kind: kindOfTarget(m.targetKind),
    distM,
    score: m.score,
  };
}

/** 诊断用：别名库是否可用（表存在 + 行数） */
export async function aliasStats(): Promise<{ ok: boolean; total: number; withCoord: number }> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ n: string; c: string }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE lng IS NOT NULL AND lat IS NOT NULL) AS c FROM poi_aliases`,
    );
    return { ok: true, total: Number(rows[0]?.n ?? 0), withCoord: Number(rows[0]?.c ?? 0) };
  } catch {
    return { ok: false, total: 0, withCoord: 0 };
  }
}
