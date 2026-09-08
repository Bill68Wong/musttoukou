/**
 * 通勤方向/地点展示常量与共享类型（src/lib/home-plans-shared.ts，v0.13.x）
 * 纯常量 + 类型，无任何 db / node 依赖 —— 可被客户端组件安全 import。
 * 服务端查询见 home-plans.ts（本文件内容 + getPool 查询函数）。
 */

export interface PlanRow {
  id: number;
  summary: string;
  from_slug: string;
  from_kind: string;
  from_name: string;
  to_slug: string;
  to_kind: string;
  to_name: string;
  samples: number;
  /** v0.7.0：各载具段主线路主题色（按乘坐顺序，walk 段不参与） */
  colors?: (string | null)[];
  /** v0.16.2：多车可选方案（去横琴纯巴士：同程可换乘多条线路）→ 卡片双色左右交替闪烁 */
  blink?: boolean;
}

export interface ActiveSession {
  id: number;
  summary: string;
}

/** 起点 place（宿舍/擎天匯）slug */
export const HOME_SLUG = "home";

/** place slug → 首页/选择页展示短名（v0.9.0 校名「澳科大」；口岸名沿用主人定稿口径） */
export const PLACE_SHORT: Record<string, string> = {
  home: "擎天匯",
  school: "澳科大",
  hengqin: "橫琴口岸",
  guanqin: "關閘（拱北口岸）",
};

/** 方向对顺序（首页分行顺序）：宿舍 ⇄ 學校 / 橫琴口岸 / 關閘（拱北口岸） */
export const PAIR_ORDER = ["school", "hengqin", "guanqin"] as const;

/** 「擎天匯 → 澳科大」方向标题 */
export function dirLabel(from: string, to: string): string {
  return `${PLACE_SHORT[from] ?? from} → ${PLACE_SHORT[to] ?? to}`;
}
