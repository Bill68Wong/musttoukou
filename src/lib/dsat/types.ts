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
  /**
   * 速度 km/h——⚠️ 不可靠（2026-09-03 实测反馈）：
   * 停靠待发的车可能残留非空速度、进站中的车可能显示很高值
   * （MY9487 发车台未动车却显示 33；AB6431 进站显示 49），疑似
   * GPS 采样滞后/缓存。只作展示参考，禁止参与任何状态判定。
   */
  speed?: string | number;
  /**
   * v0.8.4（2026-09-04）口径修正——推翻 9-3"挂载站=下一站"假设：
   * '1' = 停靠挂载站（到站/上下客中，含总站停靠待发）
   * '0' = 已离开挂载站、正驶向下一站——**挂载站是刚离的站，不是下一站**
   * 依据：DSAT 挂载站按「到站事件」更新（车离站后仍挂旧站，直到驶到下一站
   * 停稳才切换）。实测：probe-switch.ts（26 路 20s×5 帧）AB5503 s0@C652 连续
   * 40s+ 后才 s1@C655；用户实测"车驶离 C654/3 仍报还有 2 站"（实为即将进站）。
   * ETA：站距 = 用户站与挂载站的站差，s0/s1 同值（不再 +1）；
   * s0 挂用户站 = 车刚离站（环线绕圈 N 站 / 双方向线跳过）；
   * 总站待发判定只看 status=1 + 挂首/末站（不依赖 speed）。
   * 早期观察（2026-09-02/03）'1'/'0' 的状态划分本身仍有效。
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
