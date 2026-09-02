# MUST登校 · 技术规格（Spec）

> 版本：v1.0（2026-09-01）
> 依据：PRD v0.3（六维度需求问答全部定案）
> 范围：第一版（M0~M2）以计时器为核心的采集系统；M3 方案查询仅留接口占位，不在本期实现

---

## 1. 系统架构

```
手机浏览器（PWA，口令门保护）
   │ HTTPS
   ▼
Vercel（Next.js 15 App Router，TypeScript）
   ├─ 页面：方案选择 → 计时器向导 → 结束页 → 记录列表/编辑 → 统计概览
   ├─ API Routes：计时器 CRUD、统计、CSV 导出、DSAT 抓取
   ├─ 口令门中间件（middleware.ts，cookie 会话）
   └─ 风控模块（config/risk.ts + DSAT 客户端内置熔断/日限/日志）
   ▼
Supabase（PostgreSQL 免费层，生产库）
   └─ 15 张表（见《数据库设计》v0.2）

本地开发机（Windows）
   ├─ 本地 PostgreSQL（同一套 schema，.env 切换连接串）
   ├─ 每日备份：定时任务从 Supabase 导出 → 本地 pg_dump 归档
   └─ GitHub 私有仓库（AI 代管全部 Git 操作）
```

## 2. 目录结构

```
musttoukou/
├─ src/
│  ├─ app/
│  │  ├─ middleware.ts          # 口令门
│  │  ├─ page.tsx               # 首页 = 方案选择
│  │  ├─ timer/[sessionId]/     # 计时器向导（单页状态机）
│  │  ├─ finish/[sessionId]/    # 结束页（拥挤度勾选）
│  │  ├─ records/               # 记录列表 + 编辑
│  │  ├─ stats/                 # 极简统计概览
│  │  └─ api/
│  │     ├─ auth/route.ts       # 口令验证
│  │     ├─ plans/route.ts      # 方案列表（含常用排序）
│  │     ├─ timer/
│  │     │  ├─ route.ts         # POST 创建 session
│  │     │  ├─ [id]/route.ts    # GET 详情 / PATCH 编辑 / DELETE
│  │     │  └─ [id]/events/route.ts  # POST 打点（含 missed/快照）
│  │     ├─ stats/route.ts      # 统计概览
│  │     ├─ export/route.ts     # CSV 导出
│  │     └─ dsat/grab/route.ts  # 打点时车辆抓取（内部调用）
│  ├─ lib/
│  │  ├─ db.ts                  # 数据库连接（pg 或 supabase-js）
│  │  ├─ dsat/                  # DSAT 客户端（签名/请求封装，独立模块）
│  │  │  ├─ token.ts            # 签名算法（含时区 GMT+8 处理）
│  │  │  ├─ client.ts           # 请求封装 + 熔断 + 日志
│  │  │  └─ types.ts
│  │  └─ risk.ts                # 风控守卫（日限检查、熔断状态）
│  ├─ components/               # 计时器向导 UI 组件
│  └─ config/
│     └─ risk.ts                # ★ 风控参数集中配置（唯一可调处）
├─ db/
│  ├─ schema.sql                # 建表（与《数据库设计》一致）
│  ├─ seed.ts                   # commute-network.json → 数据库
│  └─ backup.ps1                # 每日 Supabase→本地 备份脚本
├─ data/commute-network.json    # 种子数据（已有）
└─ docs/                        # 文档（已有）
```

## 3. 风控配置（src/config/risk.ts，改参数不动代码）

```ts
export const RISK = {
  // 第一版：打点时单次查询。无轮询。
  timerGrab: {
    enabled: true,        // false = 完全不碰 DSAT（应急开关）
    timeoutMs: 5000,      // 单次超时；超时=失败，留空，不影响计时
  },
  // 通用保险（所有 DSAT 调用共用）
  circuitBreaker: {
    failThreshold: 3,     // 连续失败 3 次
    cooldownMin: 30,      // 静默 30 分钟
  },
  dailyLimit: 500,        // 每日请求总量硬上限（超限即停到次日）
  // M3 预留（本期不启用）
  poll: { enabled: false, intervalSec: 60 },
} as const;
```

## 4. 计时器向导状态机（核心页面）

前置：首页从 commute_plans 选方案（常用置顶，显示「样本数 N」），POST /api/timer 创建 session。

```
[depart 出发] → [wait_start 到站/开始等车]
                    │  ├─ 常驻快捷条：0/1/2/3/5/8/10+ （站或分钟，由方案 leg 类型决定）
                    │  │   每次点按 = 插入一条 wait_snapshot
                    │  ├─ 后台：调 DSAT 抓该线路在线车辆 → vehicle_plate/code
                    │  └─ [missed 没挤上] → session.missed_count++ → 回到等待（快捷条继续）
                    ▼
              [board 上车]（轻轨方案跳过 missed，快捷条切分钟）
                    ▼
              [station_arrive 沿途各站]（可选，能打就打；向导显示「下一站：C690 蝴蝶谷」）
                    ▼
              [alight 下车]（换乘方案：接 transfer → 下一 leg 的 wait_start）
                    ▼
              [border_start/border_end 通关]（仅横琴方案）
                    ▼
              [arrive 到达] → 结束页：勾拥挤度（空/正常/挤/爆满）→ 提交
```

规则：
- 每个打点仅一个大主按钮 + 上下文小按钮（missed、跳过沿途站），单手可操作
- 途经站不强制：随时可「跳到下车」
- 中断恢复：session 存库；页面刷新后按最后事件恢复状态
- 时区：全部时间戳存 UTC（timestamptz），展示用 GMT+8

## 5. 记录管理与统计

- 记录列表：按日期倒序，显示方案/线路/总耗时/missed 次数/已编辑标记
- 编辑：完全可编辑（含时间戳、拥挤度、vehicle 字段）；每次修改写 edit_audit（entity/field/old/new），session.is_edited = true
- 删除：软删除（session 加 deleted_at）或硬删除由实现决定，列表默认过滤已删
- 统计概览（极简）：每方案「样本数 / 均值 / 最短 / 最长」+ 冲刺目标进度（≥5 样本达标变绿）
- CSV 导出：`GET /api/export` → 一行一 session（含各事件时间列），UTF-8 BOM（Excel 直接打开不乱码）

## 6. 口令门（middleware.ts）

- 环境变量 `ACCESS_PASSWORD`；POST /api/auth 验证后设 HttpOnly cookie（30 天有效）
- middleware 校验 cookie；未通过 → 跳转 /login
- 登出入口：设置页（可后置）

## 7. DSAT 集成（第一版范围）

- 仅一个用途：打点（wait_start）时调用 `routestation/bus` 抓该线路车辆列表，匹配方向后存 session.vehicle_plate/code
- 调用链必须经过 lib/dsat/client.ts（统一签名、超时、日志、熔断、日限）——任何组件不得绕过
- 失败处理：静默失败，字段留空，打点正常返回；失败记录进 dsat_call_logs
- 接口细节与签名算法见《DSAT巴士接口调研》（token 时区必须 GMT+8）

## 8. 备份机制

- 本机 Windows 任务计划每日 09:00 跑 `db/backup.ps1`：pg_dump Supabase → `backups/YYYY-MM-DD.dump`（保留最近 30 份）
- 手动触发入口：`npm run db:backup`

## 9. 环境变量

```
DATABASE_URL            # Supabase 连接串（生产）
DATABASE_URL_LOCAL      # 本地 PG 连接串（开发）
ACCESS_PASSWORD         # 口令门
DSAT_BASE_URL           # https://bis.dsat.gov.mo:37812/macauweb
```

## 10. 非功能要求

- 手机优先：所有交互按钮 ≥ 48px 高，页面禁用横向滚动
- PWA：manifest + 图标，可添加到主屏幕（Service Worker 可后置到 M2）
- 性能：计时器页面 JS 包 < 150KB gzip；打点请求 < 500ms（DSAT 抓取异步不阻塞）
- 合规：页面底部标注「数据来源：澳门交通事务局」
