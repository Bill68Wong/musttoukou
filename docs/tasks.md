# MUST登校 · 任务拆解（Tasks）

> 版本：v1.0（2026-09-01），依据 spec v1.0
> 标注：每任务含验收标准（详见 checklist.md）；⭐ = 关键路径

## M0 · 脚手架（第 1 周前半）

- [x] T0.1 ⭐ 初始化 Next.js 15 + TypeScript 项目，配置 ESLint/Prettier，建立 spec 中目录结构 ✅ 2026-09-01
- [ ] T0.2 ⭐ 创建 GitHub 私有仓库并推送（git 身份配置 + 用户一次性授权；AI 代管）→ 待用户提供 GitHub 用户名/邮箱
- [x] T0.3 数据库建表：db/schema.sql 在本地 PG 执行通过，15 张表 + 索引齐全 ✅ 脚本就绪，待 .env 配置后在本地/云端执行
- [x] T0.4 种子导入脚本 db/seed.ts：commute-network.json → places/stations/routes/walk_times/commute_plans/plan_legs ✅ 2026-09-01
- [ ] T0.5 Supabase 项目创建，schema + 种子同步到云端；.env 体系（本地/云端切换）→ 待用户注册 Supabase
- [x] T0.6 DSAT 客户端模块：lib/dsat（token 签名 GMT+8、请求封装、超时）+ lib/risk.ts（熔断/日限）+ config/risk.ts 参数 ✅ 已实测通过（50路 45 站 74ms）

## M1 · 计时器上线（第 1 周后半）—— 开始采集

- [x] T1.1 ⭐ 口令门：middleware + /login + /api/auth（cookie 30 天）✅ 2026-09-01
- [x] T1.2 ⭐ 方案选择首页：按场景分组（回宿舍/去学校/去横琴）、常用置顶、显示样本数 ✅ 2026-09-01
- [x] T1.3 ⭐ POST /api/timer 创建 session；计时器向导页骨架（状态机 + 中断恢复）✅ 2026-09-01
- [x] T1.4 ⭐ 打点 API：events（depart/wait_start/missed/board/station_arrive/alight/border_*/arrive）+ wait_snapshots ✅ 2026-09-01
- [x] T1.5 ⭐ 向导 UI：大按钮主流程 + missed 一键 + 等车快捷条（0/1/2/3/5/8/10+，可重复点）✅ 2026-09-01
- [x] T1.6 打点时 DSAT 车辆抓取：异步调用经风控守卫，结果写 session.vehicle_*，失败留空 ✅ 2026-09-01（前端 fire-and-forget 触发 /api/dsat/grab）
- [x] T1.7 结束页：拥挤度四选一 + 提交（计算 total_minutes、time_bucket、weekday）✅ 2026-09-01
- [ ] T1.8 ⭐ 部署上线：Vercel + Supabase + 口令门验证，手机实测全流程走通一次真实通勤 → 待用户提供 Supabase/Vercel 账号
- [x] T1.9 PWA 基础：manifest + 图标（添加到主屏幕）✅ 2026-09-01

## M2 · 采集期迭代（第 2~3 周）

- [ ] T2.1 记录列表页（倒序 + missed/已编辑标记 + 删除）
- [ ] T2.2 ⭐ 记录编辑：全字段可改，每次修改写 edit_audit，is_edited 置位
- [x] T2.3 统计概览：每方案样本数/均值/最短/最长 + 冲刺进度（≥5 达标）✅ 2026-09-03（v0.5.0）
- [x] T2.4 CSV 导出：/api/export，UTF-8 BOM ✅ 2026-09-03（v0.5.0）
- [ ] T2.5 每日备份：backup.ps1 + Windows 任务计划 + 手动 npm run db:backup
- [ ] T2.6 dsat_call_logs 查看页（风控记账本：每日调用量/失败率/熔断事件）
- [ ] T2.7 采集期实测反馈修复（错漏打点补救、UI 调整，按实际使用反馈）

## M3 · 方案查询（采集期后，另行细化）

- [ ] T3.1 场景首屏（回宿舍/去学校/去口岸大按钮）
- [ ] T3.2 DSAT 轮询（启用 poll 配置：仅使用时段 60s/次）+ bus_snapshots
- [ ] T3.3 混合兜底估算引擎（实时 + segment_stats 历史）
- [ ] T3.4 方案对比页（前 2~3 方案排序展示）
- [ ] T3.5 轻轨数据源接入（待调研：班次表/间隔）
- [ ] T3.6 定时汇总任务：timer 数据 → segment_stats

## 环境准备（穿插）

- [ ] E.1 用户侧：git 身份配置（user.name/email）+ GitHub 授权（gh CLI 或 PAT，一次性）
- [ ] E.2 用户侧：Supabase 账号注册（免费）
- [ ] E.3 用户侧：Vercel 账号注册（免费，可用 GitHub 登录）
- [ ] E.4 本地 PostgreSQL 可用性确认（服务启动、pg_dump 在 PATH）

## 定向数据补缺（采集冲刺期并行，非开发任务）

- [ ] D.1 50 路直达横琴口岸实地验证
- [ ] D.2 T373（伟龙/科大）等未实测步行时间补测
- [ ] D.3 通关区段耗时采集（border_start/end 打点积累）
- [ ] D.4 51X 是否停运确认
