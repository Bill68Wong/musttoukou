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
- `speed` 实时速度 km/h（实测 8 秒间隔数值变化，数据为活数据）
- `status` 状态（"0"/"1"，推测为进站/离站）
- `passengerFlow` 载客情况（实测均为 -1，疑似未开放）

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
