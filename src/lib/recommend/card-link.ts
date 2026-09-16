/**
 * 详情页 URL 契约（src/lib/recommend/card-link.ts，v1.1.8）
 *
 * ⚠️ 纯函数、零依赖 → **client / server 都能 import**（不涉及 pg）。
 *
 * 为什么四元组缺一不可：`planId` **不唯一** —— 同一 plan 的「首段线路 × 下车站」
 * 各出一个 seed（`enumerate.ts`），所以单靠 `planId` 定位不到唯一一条路线。
 * `route + board + alight` 正是 `POST /api/timer` 需要的同一组字段，两处共用一份契约。
 */
import type { SchoolZone } from "./types";

export interface CardLinkParams {
  from: string;
  to: string;
  zone: SchoolZone | null;
  /** plan_legs 所属方案 id */
  plan: number;
  route: string;
  board: string;
  alight: string;
  /** 名次（1 起，仅展示用） */
  rank?: number;
  /** 列表页取几张卡（决定 thresholdMin，默认 5） */
  limit?: number;
}

/** 拼 `/card?...` 查询串 */
export function buildCardHref(p: CardLinkParams): string {
  const q = new URLSearchParams({
    from: p.from,
    to: p.to,
    plan: String(p.plan),
    route: p.route,
    board: p.board,
    alight: p.alight,
  });
  if (p.zone) q.set("zone", p.zone);
  if (p.rank) q.set("rank", String(p.rank));
  q.set("limit", String(p.limit ?? 5));
  return `/card?${q.toString()}`;
}

/** 解析并校验；缺任一必填项返回 null（调用方 redirect 回 `/recommend`） */
export function parseCardQuery(sp: Record<string, string | string[] | undefined>): CardLinkParams | null {
  const one = (k: string): string | null => {
    const v = sp[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : null;
  };
  const from = one("from");
  const to = one("to");
  const route = one("route");
  const board = one("board");
  const alight = one("alight");
  const planRaw = one("plan");
  if (!from || !to || !route || !board || !alight || !planRaw) return null;
  const plan = Number(planRaw);
  if (!Number.isFinite(plan)) return null;

  const zoneRaw = one("zone");
  const zone = (zoneRaw as SchoolZone | null) ?? null;
  const rankRaw = one("rank");
  const rank = rankRaw && Number.isFinite(Number(rankRaw)) ? Number(rankRaw) : undefined;
  const limitRaw = one("limit");
  const limit = limitRaw && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 5;

  return { from, to, zone, plan, route, board, alight, rank, limit };
}

/** 同一张卡的身份键（用于在 `cards[]` 里命中）—— 与 `RecommendCards` 的 React key 同口径 */
export function cardKey(c: { planId: number; rides: { route: string; board: string; alight: string }[] }): string {
  const r0 = c.rides[0];
  return `${c.planId}|${r0?.route ?? ""}|${r0?.board ?? ""}|${r0?.alight ?? ""}`;
}
