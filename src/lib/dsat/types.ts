/** DSAT 接口返回类型定义（src/lib/dsat/types.ts）
 *  实测响应信封：{ data: <载荷>, header: <状态码> }；header '1200' = token 无效
 */

/** 线路站点序列条目（getRouteData → data.routeInfo[]） */
export interface RouteStationItem {
  staCode?: string; // 'C653'
  staName?: string; // '金峰南岸/金譽峰'
  busstopcode?: string; // '00050001'
  laneName?: string;
  suspendState?: string;
}

/** 实时车辆信息（routestation/bus → data.routeInfo[].busInfo[]） */
export interface BusPosition {
  busPlate?: string; // 车牌 'MY9362'
  busCode?: string; // 车号 'E3390'
  speed?: string | number;
  /**
   * '1' = 進站中/已到达挂载站（含总站停靠待发，此时 speed 常为空）
   * '0' = 行驶中/已离站——挂载站是该车的"下一站"，尚未到达
   * 结论来源：2026-09-02/03 实测 26 路 6 轮连续采样（AC4098 挂新站瞬间恒为 1、
   * 同站第二轮变 0；MY9282 到总站 M95/3 后连停多轮 status 恒 1 speed 空）。
   * ETA 修正：status='0' 时车距用户站数 = 取模结果 + 1
   */
  status?: string;
  passengerFlow?: number;
}

/** 某站的车辆列表 */
export interface StationBuses {
  staCode: string;
  busInfo: BusPosition[];
}

/** getRouteData 载荷 */
export interface RouteDataPayload {
  routeCode?: string;
  routeInfo?: RouteStationItem[];
  [k: string]: unknown;
}

/** routestation/bus 载荷 */
export interface BusPositionsPayload {
  routeInfo?: StationBuses[];
  [k: string]: unknown;
}

/** DSAT 调用结果 */
export interface DsatResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  httpStatus?: number;
  latencyMs: number;
}
