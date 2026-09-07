/**
 * 轻轨线路/方向公共映射（src/lib/lrt/map.ts）
 * 业务层一律用本库码：线路 'LRT-氹仔线'…、站点 'LRT-MUST'…；
 * motransportinfo 的 route_no(TPL/HQL/SPVL)/站 id(BAR/MUS…) 只在服务端内部出现。
 *
 * ⚠️ 换乘站（LOT/UH）目标台码常属他线 → 方向解析只认本线站序，
 *    不做「以目标站码在本线求位」的假设（v0.14.1 教训的轻轨版）。
 */

/** 本库线路码 → motransportinfo route_no */
export const LRT_LINE_TO_ROUTE_NO: Record<string, string> = {
  "LRT-氹仔线": "TPL",
  "LRT-横琴线": "HQL",
  "LRT-石排湾线": "SPVL",
};

/** route_no → 本库线路码 */
export const LRT_ROUTE_NO_TO_LINE: Record<string, string> = Object.fromEntries(
  Object.entries(LRT_LINE_TO_ROUTE_NO).map(([k, v]) => [v, k]),
);

export const isLrtLineCode = (c?: string | null): boolean => !!c && c.startsWith("LRT-");
export const isLrtStationCode = (c?: string | null): boolean => !!c && c.startsWith("LRT-");

/**
 * 乘车方向推导（纯函数；供 /api/lrt/eta 用，语义对齐 dsat.eta.deriveRouteDir）：
 * dirStops 按 dsat_dir 分组的有序站码表（服务端从 route_stations 查出）。
 * 取「from 在 to 之前」的那套方向；均不在/推导不出回退 fallbackDir。
 * 站码同段前缀（C688↔C688/2）取末次出现，与巴士口径一致。
 */
export function directionOfTravel(
  dirStops: Record<string, string[]>,
  from: string | null | undefined,
  to: string | null | undefined,
  fallbackDir = "0",
): string {
  if (!from || !to) return fallbackDir;
  let fallbackCandidate: string | null = null;
  for (const [dir, stops] of Object.entries(dirStops)) {
    let fromIdx = -1;
    let toIdx = -1;
    for (let i = 0; i < stops.length; i++) {
      const c = stops[i] ?? "";
      if (c === from || c.startsWith(`${from}/`)) fromIdx = i;
      if (c === to || c.startsWith(`${to}/`)) toIdx = i;
    }
    if (fromIdx >= 0 && toIdx >= 0) {
      fallbackCandidate = fallbackCandidate ?? dir;
      if (fromIdx < toIdx) return dir;
    }
  }
  return fallbackCandidate ?? fallbackDir;
}

/** 去除站名尾缀「站」用于「往 XX」方向文案（'氹仔碼頭站' → '氹仔碼頭'） */
export const destLabelOf = (nameTc?: string | null): string =>
  nameTc ? nameTc.replace(/站$/, "") : "";
