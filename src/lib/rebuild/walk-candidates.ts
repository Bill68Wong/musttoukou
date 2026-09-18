/**
 * 步行需求组的统一枚举（src/lib/rebuild/walk-candidates.ts，v1.2.0）
 *
 * ── 这个模块解决什么问题 ──────────────────────────────────────────────
 *   `walk_times` 的聚合键是 **(place, 站码主码, zone)**。但「到底有哪些组」这件事
 *   在两个地方都要用：
 *     · `walk-times.ts`  —— 从实测样本聚合出 minutes
 *     · `walk-distances.ts` —— 给这些组去高德抓距离
 *   两边必须**枚举出同一套键**，否则抓了距离却对不上聚合键、白干活。
 *   ⇒ 抽到这个模块，两边共用一份真相源。
 *
 * ── 需求组为什么只有几十个而不是 595 × 4 × 3 ─────────────────────────
 *   只枚举「读端真的会查的那些组合」—— 来源是 `commute_plans` + `plan_legs` 的
 *   上下车候选集（三处汇总，见下），再按 place 展开 zone。
 *   绝不枚举全部 595 个站点。
 *
 * ── 候选集来自三处（与 walk-times.ts v0.28.0 口径一致，必须同步）────────
 *   ① walk 腿自身的 `to_station`（起点侧）/ `from_station`（到点侧）
 *   ② veh 腿的 `board_candidates` / `alight_candidates` 两列
 *   ③ veh 腿 `route_meta` 中每条备选线路的 `board` / `alight` / `to`
 *   ⚠️ 「首段/末段 walk」只比较 `leg_kind='walk'` 的腿的 seq 极值 ——
 *      不能用所有腿的极值（跨境方案的 cross_border 腿会把步行腿挤出极值位）。
 *
 * ── 站码主码归一 ──────────────────────────────────────────────────────
 *   `C690/3 → C690`、`M9/2 → M9` —— 同台多线站台是**同一物理位置**、步行时长一致，
 *   样本与距离都必须合并成一行（与读端 `segment-lookup.ts#mainCodeOf` 口径一致）。
 */
import type { Pool } from "pg";

/** 站码主码归一：剥掉站台号后缀（C690/3 → C690、M9/2 → M9、T376/1 → T376） */
export const mainCode = (c: string): string => /^[A-Za-z]+\d+/.exec(c)?.[0] ?? c;

/** 澳科大的三个校区座别 —— **三栋不同建筑 = 三个不同目的地**，各算一组 */
export const SCHOOL_ZONES = ["B/C", "N/O", "R"] as const;
export type SchoolZone = (typeof SCHOOL_ZONES)[number];

export interface WalkNeed {
  placeId: number;
  placeSlug: string;
  /** 站码主码（C690、T363），与 walk_times 聚合键一致 */
  stationMain: string;
  /** 'B/C' | 'N/O' | 'R'；非澳科大 place 恒为 null */
  zone: string | null;
  /**
   * 该主码下**真实存在的站台码列表**（如 ['C690/1','C690/2','C690/3']）
   * —— `walk_times.station_code` 有 FK 指向 `stations(code)`，而 stations 里
   *    只有带站台号的行、**没有主码行**，所以落库必须用这些值。
   */
  stationCodes: string[];
}

/**
 * 枚举全部「步行需求组」= (place, 站码主码, zone) 的去重集合
 *
 * @param onlyActivePlaces 只保留 `places.is_active = true` 的（默认 true）
 */
export async function enumerateWalkNeeds(
  pool: Pool,
  opts: { onlyActivePlaces?: boolean } = {},
): Promise<WalkNeed[]> {
  const onlyActive = opts.onlyActivePlaces !== false;

  // ── 地点 ──
  const places = (
    await pool.query(`SELECT id, slug FROM places${onlyActive ? " WHERE is_active = true" : ""}`)
  ).rows as { id: number; slug: string }[];
  const slugOf = new Map<number, string>();
  for (const p of places) slugOf.set(p.id, p.slug);
  const schoolId = places.find((p) => p.slug === "school")?.id ?? null;

  // ── 候选站：按方案算出「起点侧」与「到点侧」的候选集 ──
  const allLegs = (
    await pool.query(`
    SELECT p.id AS plan_id, p.from_place, p.to_place,
           l.seq, l.leg_kind, l.from_station, l.to_station,
           l.board_candidates, l.alight_candidates, l.route_meta
      FROM commute_plans p
      JOIN plan_legs l ON l.plan_id = p.id
     ORDER BY p.id, l.seq
  `)
  ).rows as {
    plan_id: number;
    from_place: number;
    to_place: number;
    seq: number;
    leg_kind: string;
    from_station: string | null;
    to_station: string | null;
    board_candidates: string[] | null;
    alight_candidates: string[] | null;
    route_meta: Record<string, { board?: string[]; alight?: string[]; to?: string }> | null;
  }[];

  /** (placeId → 主码集合) */
  const byPlace = new Map<number, Set<string>>();
  const add = (placeId: number | null, code: string | null | undefined) => {
    if (placeId == null || !code) return;
    if (!slugOf.has(placeId)) return; // 非活动地点，跳过
    const m = mainCode(code);
    let s = byPlace.get(placeId);
    if (!s) { s = new Set(); byPlace.set(placeId, s); }
    s.add(m);
  };

  const legsByPlan = new Map<number, typeof allLegs>();
  for (const r of allLegs) {
    const a = legsByPlan.get(r.plan_id);
    if (a) a.push(r); else legsByPlan.set(r.plan_id, [r]);
  }

  for (const [, ls] of legsByPlan) {
    const ws = ls.filter((l) => l.leg_kind === "walk");
    if (!ws.length) continue;
    // 🚨 只统计 walk 腿的极值（跨境方案的 cross_border 腿会插在步行腿外侧）
    const mn = Math.min(...ws.map((x) => x.seq));
    const mx = Math.max(...ws.map((x) => x.seq));

    const boards = new Set<string>();
    const alights = new Set<string>();
    for (const v of ls) {
      if (v.leg_kind !== "bus" && v.leg_kind !== "lrt") continue;
      for (const c of v.board_candidates ?? []) boards.add(c);
      for (const c of v.alight_candidates ?? []) alights.add(c);
      const m = v.route_meta;
      if (m) {
        for (const k of Object.keys(m)) {
          for (const c of m[k]?.board ?? []) boards.add(c);
          for (const c of m[k]?.alight ?? []) alights.add(c);
          if (m[k]?.to) alights.add(m[k].to);
        }
      }
    }

    // 起点侧：出发地 → 上车站
    const sLeg = ws.find((x) => x.seq === mn);
    if (sLeg) {
      if (sLeg.to_station) boards.add(sLeg.to_station);
      const place = sLeg.from_place;
      for (const c of boards) add(place, c);
    }
    // 到点侧：下车站 → 目的地
    const eLeg = ws.find((x) => x.seq === mx);
    if (eLeg) {
      if (eLeg.from_station) alights.add(eLeg.from_station);
      const place = eLeg.to_place;
      for (const c of alights) add(place, c);
    }
  }

  // ── 主码 → 真实站台码列表（落库用；FK 指向 stations.code）──
  const stationRows = (
    await pool.query(`
    SELECT code,
           COALESCE(substring(code from '^[A-Za-z]+[0-9]+'), code) AS main
      FROM stations
     WHERE code IS NOT NULL
  `)
  ).rows as { code: string; main: string }[];
  const codesOfMain = new Map<string, string[]>();
  for (const r of stationRows) {
    const a = codesOfMain.get(r.main);
    if (a) a.push(r.code); else codesOfMain.set(r.main, [r.code]);
  }

  // ── 展开 zone 维度 ──
  const needs: WalkNeed[] = [];
  for (const [placeId, mains] of byPlace) {
    const slug = slugOf.get(placeId) ?? "?";
    const zones: (string | null)[] = placeId === schoolId ? [...SCHOOL_ZONES] : [null];
    for (const stationMain of [...mains].sort()) {
      const stationCodes = codesOfMain.get(stationMain);
      if (!stationCodes?.length) continue; // 站表里不存在这个主码 → 跳过（FK 会拦）
      for (const zone of zones) {
        needs.push({ placeId, placeSlug: slug, stationMain, zone, stationCodes: [...stationCodes].sort() });
      }
    }
  }
  // 稳定排序（便于 diff 与报告）
  needs.sort(
    (a, b) =>
      a.placeSlug.localeCompare(b.placeSlug) ||
      a.stationMain.localeCompare(b.stationMain) ||
      String(a.zone ?? "").localeCompare(String(b.zone ?? "")),
  );
  return needs;
}
