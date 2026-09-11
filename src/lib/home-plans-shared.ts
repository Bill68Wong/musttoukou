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
  /**
   * v0.16.2 → v0.17.0 卡片闪烁样式：
   *  'split' = 去横琴纯巴士卡，左右两色位置周期互换（「这几路都能乘」）
   *  'solid' = 同起点合并卡且含澳巴+新福利两色，整卡两色交替变换
   *  null/undefined = 不闪（单色静态色带）
   */
  blinkStyle?: "split" | "solid" | null;
  /** v0.20.5：每个载具段的线路码（按 seq；换乘多程 → 卡片上用「→」连接各组标签） */
  leg_routes?: string[][];
  /** v0.20.9：各线的上车台（M9/2、M9/3…），用于同主码合并卡只显示主码 */
  board_codes?: string[];
  /** v0.20.0（兼容）：首载具段线路码 */
  route_codes?: string[];
  /** v0.20.0：统一模板——上车站（编号+全称，来自首载具段/默认线路 meta） */
  board_name?: string | null;
  /** v0.20.0：统一模板——下车站（编号+全称） */
  alight_name?: string | null;
}

export interface ActiveSession {
  id: number;
  summary: string;
}

/** 起点 place（宿舍/擎天匯）slug */
export const HOME_SLUG = "home";

/** place slug → 首页/选择页展示短名（v0.9.0 校名「澳科大」；口岸名沿用用户定稿口径） */
export const PLACE_SHORT: Record<string, string> = {
  home: "擎天匯",
  school: "澳科大",
  hengqin: "橫琴口岸",
  gate: "關閘（拱北口岸）",
};

/** 方向对顺序（首页分行顺序）：宿舍 ⇄ 學校 / 橫琴口岸 / 關閘（拱北口岸） */
export const PAIR_ORDER = ["school", "hengqin", "gate"] as const;

/** 「擎天匯 → 澳科大」方向标题 */
export function dirLabel(from: string, to: string): string {
  return `${PLACE_SHORT[from] ?? from} → ${PLACE_SHORT[to] ?? to}`;
}
