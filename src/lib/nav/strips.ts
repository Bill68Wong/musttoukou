/**
 * 详情页纵向站条构建（src/lib/nav/strips.ts，v1.3.0 · T04）
 *
 * 把 `RecommendCard`（`.rides[].board/alight/route`）→ `SegmentStrip[]`
 * （**一趟一条**、含逐跳分钟与命中层级），供 `StationStrip` 渲染。
 * 与旧 `/card` 的 `strips` **同源同口径**：逐跳一律 `lookupHop`、`rideMin` = 卡面 `rides[i].minutes`。
 *
 * ⚠️ server-only（用 `segmentsOf` 解析站序）；`SegmentStrip` 是纯视图类型，可安全传客户端。
 * 设计：docs/设计-全澳导航-v1-20260918.md §C.9（详情页与旧版同构）
 */
import { segmentsOf } from "@/lib/recommend/enumerate";
import { lookupHop, type SegmentIndex } from "@/lib/recommend/segment-lookup";
import type { RecommendCard, RouteIndex, SegmentStrip, StripStop, TransferView } from "@/lib/recommend/types";

export interface StripBuildCtx {
  routeIdx: RouteIndex;
  segIdx: SegmentIndex;
  nameOf: Map<string, string>;
  /** 今天星期（0=周日…6=周六） */
  weekday: number;
}

/** 构建每段载具的站条（`card.rides` 与返回数组**一一对应**） */
export function buildStrips(card: RecommendCard, ctx: StripBuildCtx): SegmentStrip[] {
  return card.rides.map((ride, i) => {
    const seg = segmentsOf(ctx.routeIdx, ride.route, ride.board, ride.alight);
    const codes = seg && seg.stops.length >= 2 ? seg.stops : [ride.board, ride.alight];

    const stops: StripStop[] = codes.map((code, k) => {
      const isFirst = k === 0;
      const isLast = k === codes.length - 1;
      const next = codes[k + 1];
      const hop = !isLast && next ? lookupHop(ctx.segIdx, ride.route, code, next, ctx.weekday) : null;
      return {
        code,
        label: ctx.nameOf.get(code) ?? code,
        minToNext: hop ? hop.minutes : 0,
        level: hop ? hop.level : 0,
        role: isFirst ? "board" : isLast ? "alight" : "mid",
      };
    });

    const t = card.transfers[i];
    const transferAfter: TransferView | null = t
      ? { at: t.at, atLabel: t.atLabel, minutes: t.minutes, estimated: t.estimated, sameField: t.sameField }
      : null;

    return {
      route: ride.route,
      kind: ride.kind,
      board: ride.board,
      alight: ride.alight,
      boardLabel: ride.boardLabel,
      alightLabel: ride.alightLabel,
      stops,
      rideMin: ride.minutes,
      transferAfter,
    };
  });
}
