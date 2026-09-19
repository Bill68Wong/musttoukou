/**
 * 本地枚举 · 候选装配（src/lib/nav/enumerate-nav.ts，v1.3.0 提案 · T03 / G4）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   把 `graph-search` 的**站点级路径**装配成:
 *     · `NavCandidate`（含 from/to `NavPoint` + 复用旧 `RideSegment`/`TransferSegment`）；
 *     · `OptionSeed`（喂 `modelOption`，与旧链路**同一形状** → 计时口径零漂移）。
 *
 *   站码归一与共享口径全部复用 `src/lib/recommend/enumerate.ts` 的纯函数
 *   （`segmentsOf` / `idxsOf` / `deriveDirInMemory`）—— 不在本文件重写站序逻辑。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §B.5 / §B.6 / §4（NavCandidate）
 */
import type { RideSegment, TransferSegment } from "@/lib/recommend/types";
import type { OptionSeed } from "@/lib/recommend/types";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { NavCandidate, NavPoint } from "./types";
import type { StationPath } from "./graph-search";

/** 线路码 → 载具种类（我们库轻轨码统一 `LRT-` 前缀） */
export function kindOfRoute(route: string): "bus" | "lrt" {
  return route.startsWith("LRT-") ? "lrt" : "bus";
}

const candidateKey = (segments: RideSegment[]): string =>
  segments.map((s) => `${s.route}@${mainCodeOf(s.board)}>${mainCodeOf(s.alight)}`).join("|");

/** 站点级路径 → `NavCandidate[]` */
export function pathsToCandidates(
  paths: StationPath[],
  from: NavPoint,
  to: NavPoint,
): NavCandidate[] {
  const out: NavCandidate[] = [];
  for (const p of paths) {
    const segments: RideSegment[] = p.rides.map((r) => ({
      route: r.route,
      kind: kindOfRoute(r.route),
      board: r.board,
      alight: r.alight,
      hops: r.hops,
    }));
    if (!segments.length) continue;
    const transfers: TransferSegment[] = p.transfers.map((t, i) => {
      const a = segments[i];
      const b = segments[i + 1];
      const sameField =
        mainCodeOf(t.at) === mainCodeOf(t.to) && !a.alight.startsWith("LRT-") && !b.board.startsWith("LRT-");
      return { at: a.alight, to: b.board, sameField };
    });
    const key = candidateKey(segments);
    out.push({
      id: key,
      from,
      to,
      segments,
      transfers,
      crossBorder: false,
      key,
    });
  }
  // 去重（同一 key）
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)));
}

/** 中性展示文案（产品口径：不写「本地算法」，§B.5） */
export const LOCAL_SUMMARY = "其他組合";

/**
 * `NavCandidate[]` → `OptionSeed[]`（喂 `modelOption`）。
 * @param planIdBase 合成 planId 起点（避免与高德方案撞号；本地用 ≥900000）
 * @param fromSlug/toSlug 合成 slug（`model.ts` 用不到真实 slug —— 步行由 `walkIdx` 提供）
 */
export function candidatesToSeeds(
  candidates: NavCandidate[],
  opts: { planIdBase?: number; fromSlug?: string; toSlug?: string } = {},
): OptionSeed[] {
  const base = opts.planIdBase ?? 900_000;
  const fromSlug = opts.fromSlug ?? "from";
  const toSlug = opts.toSlug ?? "to";
  return candidates.map((c, i) => ({
    planId: base + i,
    summary: LOCAL_SUMMARY,
    fromSlug,
    toSlug,
    crossBorder: c.crossBorder,
    segments: c.segments,
    transfers: c.transfers,
    key: c.key,
  }));
}
