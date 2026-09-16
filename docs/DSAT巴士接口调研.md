# DSAT 巴士报站系统接口调研报告

> 调研日期：2026-09-01
> 结论：**可行**。澳门交通事务局官方报站网页背后的接口可获取实时车辆数据（车牌、速度、载客状态、所在站点），无需官方授权。但属逆向非公开接口，存在变更/封禁风险，需配合混合兜底策略。

## 1. 数据源背景

- 官方数据开放政策（《交通事务局交通数据开放管理(试行)办法》）规定：
  - **巴士定位数据**（车辆代号、时间、经纬度、速度、方向，10 秒更新）→「依申请开放」，且目前**尚未开放**；申请对象为机构（需澳门本地服务器、网络安全制度、签保密协议等），**个人开发者无法申请**
  - **巴士路线资料**（静态站点/线路数据）→ 无条件开放，可在 data.gov.mo 下载（Shapefile/XLS 格式）
- 实际可用路径：DSAT 官方报站网页 `https://www.dsat.gov.mo/bus/site/busstopwaiting.aspx` 是一个壳页面，内嵌真实系统 `https://bis.dsat.gov.mo:37812/macauweb/`。该系统前端 JS 中包含全部数据接口及签名算法，可完整复现。

## 2. 接口清单（已实测验证）

### 2.1 全部线路列表 ✅

```
POST https://bis.dsat.gov.mo:37812/macauweb/getRouteAndCompanyList.html
Body: lang=zh_cn&device=web
```

返回：公司列表（新福利=Blue、澳巴=Orange）+ 全部线路（routeName、direction、color、routeChange）。

### 2.2 线路站点数据 ✅

```
POST https://bis.dsat.gov.mo:37812/macauweb/getRouteData.html
Body: action=sd&routeName=<线路号>&dir=<方向>&lang=zh_cn&routeType=<方向>&device=web
```

返回：routeCode、按顺序的站点列表（staName、laneName、staCode、busstopcode、suspendState 停靠状态）、线路坐标 routeCoors、改道消息等。

### 2.3 实时车辆位置（核心接口）✅

```
POST https://bis.dsat.gov.mo:37812/macauweb/routestation/bus
Body: action=dy&routeName=<线路号>&dir=<方向>&lang=zh_cn&routeType=<方向>&device=web
```

返回：逐站点的当前车辆列表，每辆车含：
- `busPlate` 车牌（如 MY9362）
- `busCode` 车辆编号（如 E3390）
- `speed` 实时速度 km/h —— ⚠️ **不可靠**（2026-09-03 实测反馈：停靠待发的车可能残留非空速度如 33、进站中的车可能显示 49，疑似 GPS 采样滞后/缓存）。**只作展示参考，禁止参与状态判定**
- `status` 状态（"0"/"1"，语义已实测定论，见下节 2.3.1）
- `passengerFlow` 载客情况（实测多为 -1/0，疑似未开放，仅作参考）

#### 2.3.1 status 语义与四类状态特征（实测定论 2026-09-03）

**status = 车相对「挂载站」的位置标记**（挂载站 = routeInfo 中该车所在站条目）：
- `'0'` = 已离站、**正在驶向挂载站**（挂载站是它的下一站）
- `'1'` = **已到达/停靠挂载站**（含总站停靠待发）

实测方法：26 路每 45 秒连续 6 轮采样（AC4098 挂新站瞬间恒 1、同站第二轮变 0）+ 早高峰实时验证（AA2535 行驶=0、AB6172 到终点停靠=1、AB6172 进站=1、MY9487 发车台停靠=1）。

| 状态 | status | speed | 挂载站 | 说明 |
|---|---|---|---|---|
| 行驶中 | 0 | 不可靠（勿用） | 任意 | 正在驶向下一个站 |
| 進站中 | 1 | 不可靠（勿用） | 非首末站 | 短暂状态，停靠后再次离站变 0 |
| 到终点停靠 | 1 | 不可靠（勿用） | 首/末站 | 停驻待发/收班，停留时长不定 |
| 即将发车 | 起步后变 0 | 不可靠（勿用） | 首站附近 | 刚离总站起步 |

判定铁律：**只看 status + 挂载站位置，speed 一律不参与**。总站停靠待发 = status=1 + 挂首/末站（若该站恰是乘客等车站则显示"已进站"而非待发）。

**报站口径（2026-09-03 实测定义，26 路真实站序 seq27-30 验证）**：用户站 U，车挂载站 X（idx 序数），N = (U−X) + (status=0 ? 1 : 0)：
- s1 挂 U−3 / s0 挂 U−2 → 还有 3 站；s1 挂 U−2 / s0 挂 U−1 → 还有 2 站
- s1 挂 U−1 → 还有 1 站；**s0 挂 U（正驶来本站）→ 「即将进站」**；s1 挂 U → 「已进站」
- 例：T344(seq27)/T356-1(28)/T358(29)/T373-2(30) 在 T373/2 等车，车到 T358 → 还有 1 站；车离 T358 驶来 → 即将进站

**⚠️ 常见误区（踩过坑）**：
1. s0 挂用户站 ≠ 车刚离站开走——s0 挂载站=正在驶向的站，即车**正开来本站**（曾误当"刚离站"跳过/绕圈，导致漏报来车）
2. speed 空 ≠ 停稳——待发车可能残留非空速度，判定禁止依赖 speed
3. 循环线首末同站区（如 26 路 M95/3 同时是 idx0 发车台和 idx75 到达台），同码两义需区分

### 2.4 其他已发现接口（未逐一实测）

| 接口 | 用途 |
|---|---|
| `/macauweb/routestation/location` | 地图坐标/车辆位置（getMapCoordinate） |
| `/macauweb/ddbus/busmess/route` (action=search) | 线路资讯消息 |
| `/macauweb/ddbus/common/station/capacity` | 站点容量/客流 |
| `/macauweb/ddbus/common/zone/runtime` | 分区实时状态 |
| `/macauweb/ddbus/common/keyPoi/*` | 关键 POI（地点查询） |
| `/macauweb/getRouteChangeMessage.html` | 改道消息 |
| `/macauweb/getDyMessage.html` | 动态消息（跑马灯） |

注意：`/macauweb/ddbus/*` 部分路径直接访问返回 403（如 GET 方式的 app/passenger/route），但 POST 的部分可用；`.html` 系列接口实测稳定可用。

### 2.5 实测新增接口（2026-09-16 · **含巴士实时经纬度**）

> 探针：`.verify/dsat-geo-probe.mjs` / `dsat-geo-probe2.mjs` / `dsat-geo-probe3.mjs` / `dsat-geo-probe4.mjs`
> 方法：从官网 `map.html` 页面加载的 `map.6e5a0476.js` 反查真实调用参数（见 §2.5.4 教训）。

#### 2.5.1 ★★ `/routestation/location` —— **车辆实时经纬度 + 全线站点经纬度**

```
POST https://bis.dsat.gov.mo:37812/macauweb/routestation/location
Body: routeName=<线路号>&routeCode=<6位码>&dir=<方向>&lang=zh-tw&device=web
```

★ **`dir` 而非 `direction`** —— 写错直接 `header:1000`（本次踩坑处）。
`routeCode` 从 `getRouteData` 响应顶层取（26 路 = `00026`，51 路 = `00051`）。

返回 `header:"000"`，`data` 结构：

| 字段 | 内容 |
|---|---|
| `busInfoList[]` | ★ **每辆车**：`latitude` / `longitude`（6 位小数 · WGS84）/ `busPlate` / `busType` / `speed` |
| `stationInfoList[]` | 该线路**全部站点**：`latitude` / `longitude`（10 位小数）/ `stationCode` / `stationName` / `laneName`（車道） |
| `lastBusPlate` / `lastBusType` / `busColor` / `badCar` | 末班车牌、车型、车队颜色（`Blue`=新福利 / `Orange`=澳巴）、异常车标记 |

实测样例（2026-09-16 上午）：
- 51 路 dir=0 → 20 站 + **8 辆在途车**，例 `AA7759 @ 22.143946, 113.576010 · speed 36`
- 26 路 dir=0 → 76 站 + **8 辆在途车**，例 `MY9154 @ 22.163757, 113.543643 · speed 40`

⇒ **这是「车在哪」的唯一可得来源**，也是官网地图页画车辆图标的数据源。

#### 2.5.2 `GET /ddbus/common/station/gps` —— 按坐标反查附近站（含每站坐标）

```
GET https://bis.dsat.gov.mo:37812/ddbus/common/station/gps
    ?log=<经度>&lat=<纬度>&range=<米>&device=web&HUID=<id>&needStaInfo=true&lang=zh_tw
```

★ 经度参数名是 **`log`**（不是 `lng`）。
返回每站：`latitude` / `longitude`（7 位小数）/ `stationCode` / `stationName` / `stacode` / `stalabel` / `metro`（`"1"` = 与轻轨接驳）。

实测：擎天匯（22.1527, 113.5641, range=500）→ **13 站**（`T373/1`·`T373/2`·`T374`·`T358`·`T363/1`·`T363/2`·`T391`·`T392`…，与项目在用站码一致）。

#### 2.5.3 地图页另外两个接口（**均不含坐标，仅作背景**）

| 接口 | 方法 | 返回 |
|---|---|---|
| `/ddbus/common/supermap/routeStation/traffic` | GET | `stationInfo[]` = `stationCode` / `trafficLevel` / `newRouteTraffic`（**路段拥堵等级**，非坐标）。参数：`device`+`HUID`+`routeCode`+`direction`+`indexType=00`+`lang`+`categoryIds` |
| `/ddbus/common/supermap/route/traffic` | POST | 同上族，拥堵态势 |

⚠️ **注意**：地图页的**线路折线**（`routeCoors`）来自上面这族接口的 `routeCoordinates`（`"x,y;x,y;…"` 字符串，**EPSG:3857 Web Mercator**），
而 `getRouteData.html` 里同名的 `routeCoors` / `stationCoors` 字段**恒为空数组**（4 组参数实测）——**同名不同源，勿混用**。

#### 2.5.4 ★ 方法论教训（本次踩坑，值得记住）

报站接口 `/routestation/bus` 的车辆字段只有 `busType/busCode/busPlate/status/isFacilities/passengerFlow/speed`，
**确实不含坐标**（这点没错）；但我据此推断「车辆坐标拿不到」是**错的**。

★★ **正确判据（新铁律）**：**只要官网某个页面上把某类数据渲染出来了，该类数据就一定存在对应接口。**
发现自己「参数猜不出来、接口全部报错」时，**不要下「数据不存在」的结论** ——
应当**去读那个页面的 JS**（本例 `map.html` → `map.6e5a0476.js`），它会明写参数对象与接口路径。
本次正是靠 `map.js` 里的 `N = {routeName, dir, lang, routeCode}` 才发现参数名是 `dir`。

#### 2.5.5 地图页的图标定位方式（`map.6e5a0476.js` 实录）

- 底图服务：SuperMap iServer —— `https://bis.dsat.gov.mo:8091/iserver/services/map-ugcv5-aomenC1/rest/maps/aomenC1`
- 视野范围：`new SuperMap.Bounds(12620332.57231, 2516699.65887, 12661971.64346, 2545860.38516)`
  （**EPSG:3857** Web Mercator 米）→ `.transform(EPSG:3857 → EPSG:4326)` 转经纬度
- 线路折线：`routeCoordinates.split(";")` → 每段 `"x,y"` → `new SuperMap.Geometry.Point(x, y)` → `LineString`
- **车辆图标**：直接用 `busInfoList[i].latitude/longitude` 落点（无需投影转换）
- 刷新节拍：`setTimeout(…, 15e3)` —— **官网自己就是 15 秒轮询一次**

#### 2.5.6 批量能力实测（2026-09-16 · 回答「能不能把请求合并」）

> 探针：`.verify/batch-probe.mjs` ~ `batch-probe5.mjs`。结论：**核心接口不能合并，113 次/轮是硬下限。**

| 目标 | 尝试的多线路传法 | 结果 |
|---|---|---|
| `/routestation/bus`（报站） | `routeName=26,51` · `routeName=26\|51` | ❌ `header:"000"` 但 **`data:{}` 空壳**（静默空，不报错） |
| `/routestation/location`（位置） | 逗号线表 · 重复同名参数 · `routeName[]=` | ❌ 逗号→空；重复参数→**只认第一个**；数组形式→ `1000` 拒绝 |
| `/ddbus/map` | 带 `routeName/routeCode` | ❌ 403 Forbidden |
| `/ddbus/common/zone/runtime` | `id=` / `zoneId=` / `zone_id=` | ❌ 全部 403 Forbidden（与 `app/passenger/*` 同族，被挡） |
| `/ddbus/operation/statistics` | — | ❌ `status:"001"`（空） |

**★ 唯一的例外：`POST /ddbus/common/route/collection/info` —— 真的能批量**

```
POST /ddbus/common/route/collection/info?device=web&HUID=<id>
Content-Type: application/json
Body: { "stationCode": "T373/2",
        "routeList": [ { "direction": "0", "routeCode": "00026" }, … ] }
```
`stationCode` **必填**（缺了回 `status:"1000"`；表单体则回 `415 Unsupported Media Type` ⇒ **必须是 JSON**）。
`direction` 必须与该线路的真实方向值一致（传 `"2"` 给 26 路 → 空数组）。

实测返回（26 路 @ `T373/2`）：
```json
{"data":[{"routecode":"00026","routeCode":"00026","direction":"0",
  "runningBusInfoList":[
    {"numberPlate":"MY9362","wheelChair":"0","passengerFlow":"-1","stopCounts":"8"},
    {"numberPlate":"MY9487","wheelChair":"0","passengerFlow":"-1","stopCounts":"22"}]}],
 "header":{"status":"000"}}
```
⇒ **一次请求可带多条线路，返回每辆车「距该站还有 N 站」**。

**但有两个硬限制，故本采集器不采用它替代 113 次轮询**：
1. `stationCode` 是**整个请求共用一个** —— 只能问「这些线路距某一个站还有几站」
2. 只给 `stopCounts`（派生值），**不给挂载站、不给 `status`**（原始字段）

⚠️ **为什么不拿它替代现有轮询**：追踪式计时的核心是「每辆车的**挂载站 + status**」→ 判断「离开 A 站」的时刻。
虽然理论上可用「相对终点站剩余站数 + 本库站序」倒推挂载站，但那是**用派生值倒推原始值**，
而现有口径是**官网同款、已逐帧对拍验证**的。**用未验证的推理替换已验证的数据，方向是错的。**

**★ 意外收获（本次真正的优化点）**：`/routestation/location` 每次都会附带该线路的
`stationInfoList`（全线站点坐标 + 停靠车道）⇒ **站点坐标是一次性静态资产**：
- **补全站点坐标** = 跑一趟（92 线 × 1~2 dir = 113 请求）**永久有效**
- **日常轮询** 只需采**车辆位置**（动态部分）
- 两者代价由此分开：前者一次性 113 请求；后者每次轮询 +33%（位置降频 15s）或 +100%（全量）

⚠️ **落盘纪律（否则文件会爆）**：位置响应约 8.8 KB，其中**绝大部分是每次重复的 `stationInfoList`**（静态站表）。
若照单全收：`8838 B × 226 × 360 ≈ 719 MB`／30 分钟。**必须只落 `busInfoList`，`stationInfoList` 去重后单独存一份**
→ 降到约 **5~8 MB**（gzip 后）。

#### 2.5.7 ★★ 位置接口**到底有没有「车到哪一站」的数据**（2026-09-16 补测 · 结论：**没有**）

> 探针：`.verify/loc-vs-bus.mjs`（字段穷举）+ `.verify/loc-vs-bus2.mjs`（车辆盘子 / 站表顺序对拍）
> 动机：直接追问「既然位置接口有坐标，它是不是也顺带有站点信息？」

**① 字段穷举（51 路 dir=0 与 26 路 dir=0，两条线各一次，字段取并集）**

`busInfoList[]` 元素**只有 5 个字段，无任何一个与站点/进度有关**：

```json
{"latitude":"22.160543","longitude":"113.574104","busPlate":"AA7312","busType":"1","speed":39}
```

| 类别 | 命中字段 |
|---|---|
| 坐标类 | `latitude` · `longitude` · `busPlate` |
| 车辆类 | `busPlate` · `busType` · `speed` |
| **站点 / 进度类** | **【无】** —— 无 `stationCode` / `status` / `seq` / `stopCounts` / `nextSta` 等 |

⇒ **位置接口只知道「车在哪个经纬度」，不知道「车挂在哪一站、还有几站」。**

**② 根因：两个接口的骨架根本不同**

| | `/routestation/bus`（报站） | `/routestation/location`（位置） |
|---|---|---|
| 顶层结构 | `routeInfo[]` = **以站为骨架**（51 路 20 站 / 26 路 76 站） | `busInfoList[]` = **以车为骨架** |
| 每站/每车载荷 | 站下挂 `busInfo[]`：`busPlate`/`busType`/`busCode`/`status`/**`isFacilities`**/`passengerFlow`/`speed` | 车上只有 `latitude`/`longitude`/`busPlate`/`busType`/`speed` |
| 回答的问题 | 「**第 N 站下面挂着哪几台车**」 | 「**这几台车各自在哪**」 |
| 站点字典 | 只有 `staCode`（**无坐标**） | `stationInfoList[]`：**含坐标 + 站名 + 车道** |

⇒ 结构上就是**互为补集**，这也是「不能靠合并省掉一趟」的根本原因（见 §2.5.6）。

**③ 两接口的车辆盘子对比（同一次探测内背靠背调用）**

| 线路 | 位置接口 | 报站接口 | 差值 |
|---|---|---|---|
| 51 dir=0 | **8** 台 | 7 台 | 位置多 `AD3397` |
| 26 dir=0 | **9** 台 | 8 台 | 位置多 `MY9211` |

★ 推测（**未定论，需多次抽样确认**）：报站接口只列**已挂载到某个站的**车；位置接口列**所有在路上跑的车**，
多出来的那台很可能是「刚出总站、尚未被挂到任何站下」的车 → **位置接口的在途车盘子更全**。
⚠️ 单次快照不足以定论（首轮 51 路还出现过 `AA7428`，次轮就没了）。

**④ ★ 意外收获：`stationInfoList` 的顺序 = 线路行进顺序（已对拍验证）**

| 线路 | 位置接口站表 | 采集计划 `seq[dir]` | 顺序完全一致？ |
|---|---|---|---|
| 51 dir=0 | 20 站 | 20 站 | ✅ 是 |
| 26 dir=0 | 76 站 | 76 站 | ✅ 是 |

⇒ 位置接口的站表**既给坐标、又给顺序**，可作为「站序 × 坐标」的一次性静态资产直接入库。
⇒ 也意味着理论上可用「车的坐标 + 站的坐标」**自己算最近站**来间接推「到哪一站」，
但那是**用几何推理替换官网已验证的挂载站口径**，**不采用**（同 §2.5.6 的理由）。

**⑤ 对采集方案的直接含义**

「站点坐标」与「车辆轨迹」是两种**不同性质**的数据，代价可以彻底分开：

- **站点坐标** = 一次性静态资产 → 跑 1 轮全量位置（113 请求）**永久拿到全澳站点坐标**，之后不必再采
- **车辆轨迹** = 动态数据 → 才需要按档位持续采（这才是 +9% / +18% / +33% / +100% 那笔账）



## 3. 请求签名算法（已破解验证）

所有请求需带 `token` 请求头，算法如下：

1. 构造参数串 `qs`：按对象键顺序拼接 `k1=v1&k2=v2...`（**顺序必须与请求体完全一致**）
2. `m = md5(qs)`（32 位小写十六进制）
3. `o = 当前时间 YYYYMMDDHHmm`（12 位，本地时间，每分钟变化）
4. 拼接：

```
token = m[0:4]  + o[0:4]  + m[4:12] + o[4:8] + m[12:24] + o[8:12] + m[24:32]
```

（即把时间戳的 年、月日、时分 四段分别插入 MD5 的第 4、12、24 位之后，总长 44 字符）

### Bash 验证脚本

```bash
gen_token() {
  local QS="$1"
  local M=$(echo -n "$QS" | md5sum | cut -d' ' -f1)
  local O=$(date +%Y%m%d%H%M)
  echo "${M:0:4}${O:0:4}${M:4:8}${O:4:4}${M:12:12}${O:8:4}${M:24:8}"
}
QS="action=dy&routeName=26&dir=0&lang=zh_cn&routeType=0&device=web"
curl -sk -X POST "https://bis.dsat.gov.mo:37812/macauweb/routestation/bus" \
  -H "token: $(gen_token "$QS")" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "$QS"
```

token 校验失败返回 `{"data":"","header":"1200"}`；参数错误返回 `header:"999"` + error 信息；成功为 `header:"000"`。

## 4. 与本项目相关的线路（实测确认）

| 线路 | 经过站点 |
|---|---|
| **26** | 伟龙/科技大学 |
| **50** | 霍英东马路/科技大学、**横琴澳方口岸** |
| **25B** | 横琴澳方口岸 |
| **MT1** | 伟龙/科技大学 |

- 「伟龙/科技大学」即澳科大正门站；50 路一条线串联科大与横琴口岸，覆盖本项目全部核心场景
- 擎天汇宿舍周边线路待补充调研（需现场确认站点名）

## 5. 风险与建议

1. **非公开接口**：该接口无文档、无 SLA，为官方网页内部接口。DSAT 可随时修改签名算法或加防护。**必须**按需求文档既定的「混合兜底」策略设计：实时接口异常时自动退回历史规律估算。
2. **请求频率**：建议服务端代理轮询（如每 10~30 秒一次，按需按线路），前端只查自己的后端，避免直连 DSAT（暴露签名实现 + IP 被封风险）。
3. **合规**：个人自用/小规模使用风险低；若未来开放给大量用户，需重新评估（官方办法明令不得披露/出售数据，且面向机构开放的数据未经许可）。产品页面建议标注数据来源为 DSAT。
4. **passengerFlow 载客数据**目前恒为 -1，不可依赖；拥挤度可用计时器自采数据补足。
5. 时间敏感性：token 含分钟级时间戳，服务器时间校验窗口未知；跨时区部署时注意使用 GMT+8 时间生成。

## 6. 附：原始材料

- 前端 JS（含签名算法实现）：`https://bis.dsat.gov.mo:37812/macauweb/static/assets/js/index.6e5a0476.js`、`vendors.6e5a0476.js`、`routeLine.6e5a0476.js`（本地备份见 `.workbuddy/research/`）
- 官方数据开放办法 PDF：dsat.gov.mo（搜索「交通數據開放管理辦法」）
- 静态线路数据下载：`https://data.gov.mo`（巴士路线资料，完全开放）

## 补充：响应结构与调用要点（2026-09-01 实测，来自代码联调）

- **token 放请求头**：`-H "token: xxx"`，不进请求体（放进 body 会返回 `header:1200` 拒绝）
- **响应信封**：所有 `.html` 接口返回 `{ "data": <载荷>, "header": <状态码> }`；`header == "1200"` 表示 token 无效，正常时取 `.data`
- **getRouteData 载荷**：`data.routeInfo[]`，每项含 `staCode` / `staName` / `busstopcode` / `laneName`
- **routestation/bus 载荷**：`data.routeInfo[]`，每项 `{ staCode, busInfo: [...] }`，`busInfo` 内是该车信息（busPlate/busCode/speed/status/passengerFlow）
- 实测样例：50 路 dir=0 共 45 站，getRouteData 74ms
- 已封装为项目模块：`src/lib/dsat/`（token 签名、信封解包、超时、熔断、日限、记账），任何新调用必须走该模块
