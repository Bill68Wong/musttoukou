# UI 全局重构 SPEC · v0.3.0（Material You）

> 状态：**待用户审批**
> 日期：2026-09-03
> 范围：纯前端视觉与交互层重构，不改动任何业务逻辑

## 1. 背景与目标

用户反馈：页面太丑、不好看、不好用。四条核心诉求：

1. 页面简洁美观
2. 点击反馈舒适
3. 用户体验良好
4. 对标 Google/微软大厂（YouTube、Chrome 级别的国民舒适度）

**方案**：引入 Material You（M3）设计体系，通过设计令牌（Design Tokens）+ 统一交互基元实现，参考 YouTube/Android 的视觉与触感规范。

## 2. 已确认的设计决策

| 决策项 | 结论 | 用户确认方式 |
|---|---|---|
| 风格 | Material You (M3) | 选择题选定 |
| 明暗模式 | 双主题，跟随系统自动切换 | 选择题选定 |
| 主色 | M3 蓝系（源色 #0B57D0，Google 蓝），为通勤题材微调 | 选择题选定（跟随风格默认） |

## 3. 设计规范（令牌定义）

### 3.1 色彩（M3 蓝色 scheme）

**浅色主题（默认）**

| 令牌 | 值 | 用途 |
|---|---|---|
| `--primary` | `#0B57D0` | 主按钮、强调 |
| `--on-primary` | `#FFFFFF` | 主按钮文字 |
| `--primary-container` | `#D3E3FD` | 次级强调容器（tonal 按钮） |
| `--on-primary-container` | `#041E49` | tonal 按钮文字 |
| `--bg` | `#F9F9FF` | 页面背景（M3 surface） |
| `--surface` | `#FFFFFF` | 卡片表面 |
| `--surface-dim` | `#EDEEF4` | 次级卡片/输入底 |
| `--on-surface` | `#191C20` | 主文字 |
| `--on-surface-var` | `#44474E` | 次文字 |
| `--outline` | `#74777F` | 边框 |
| `--error` | `#BA1A1A` | 危险/删除 |
| `--ok` | `#146C2E` | 成功/进行中 |

**深色主题**（`@media (prefers-color-scheme: dark)`）

| 令牌 | 值 |
|---|---|
| `--primary` | `#A8C7FA` |
| `--on-primary` | `#062E6F` |
| `--primary-container` | `#0842A0` |
| `--on-primary-container` | `#D3E3FD` |
| `--bg` | `#111318` |
| `--surface` | `#1C1E24` |
| `--surface-dim` | `#2A2D34` |
| `--on-surface` | `#E2E2E9` |
| `--on-surface-var` | `#C4C6D0` |
| `--outline` | `#8E9099` |
| `--error` | `#FFB4AB` |
| `--ok` | `#6DD58C` |

### 3.2 字体层级（M3 Type Scale 简化）

| 级 | 字号/字重 | 用途 |
|---|---|---|
| display | 32px / 500 | 结束页大标题 |
| headline | 24px / 500 | 页面主标题、下一站 |
| title | 16px / 500 | 卡片标题、分组标题 |
| body | 15px / 400 | 正文 |
| label | 13px / 400 | 辅助说明、时间轴 |

字体族：系统栈（-apple-system / Segoe UI / PingFang SC / MiSans 等），不引入外部字体（保性能+国内可达）。

### 3.3 形状与间距

- 圆角：按钮 999px（胶囊，M3 filled button）、卡片 16px、输入框 12px
- 间距栅格：4px 基数（8/12/16/24）
- 触达目标：所有可点元素 ≥ 48px（保持现状）

### 3.4 动效与触感（"点击反馈舒适"的核心）

| 项 | 规范 |
|---|---|
| 缓动 | M3 emphasized：`cubic-bezier(0.2, 0, 0, 1)` |
| 时长 | 150ms（状态切换）/ 250ms（进入动画） |
| 按压 | `transform: scale(0.97)` + 状态层渐显（hover 8%、active 12% overlay） |
| 进入 | 页面/步骤切换 fade+上移 8px |
| 减弱偏好 | `prefers-reduced-motion: reduce` 时全部禁用 |
| 触觉 | 仅关键打点（出发/上车/下车/到达成功）触发 `navigator.vibrate(10)`，非每次点击 |

## 4. 改动范围

| 文件 | 动作 |
|---|---|
| `src/app/globals.css` | 全量重写（令牌 + 基元类） |
| `src/app/layout.tsx` | 加 `themeColor` viewport（双主题） |
| `src/components/HomeClient.tsx` | 视觉迁移（内联样式→设计类） |
| `src/components/TimerWizard.tsx` | 视觉迁移（最大件，分步卡片化） |
| `src/components/LiveEta.tsx` | 视觉迁移（车距卡片化+刷新动效） |
| `src/components/RecordsClient.tsx` | 视觉迁移（记录卡列表） |
| `src/components/FinishForm.tsx` | 视觉迁移（大标题+表单） |
| `src/components/LoginForm.tsx` | 视觉迁移 |

**明确不改动**：业务逻辑、事件流、API 路由、数据库、ETA/自动记录/报站口径等一切功能代码。

## 5. 任务分解（checklist）

- [ ] **T1 设计地基**（globals.css 重写）：令牌双主题 / 按钮 4 变体（filled/tonal/outline/text）/ 卡片 / 输入 / 状态层按压 / focus ring / 动画 keyframes / reduced-motion
- [ ] **T2 组件迁移 · 首页**：HomeClient（方案卡 tonal 化、分组标题、进行中卡片、记录入口、页脚）
- [ ] **T3 组件迁移 · 计时链路**：TimerWizard（步骤卡、主按钮胶囊化、分钟选择 chip 化、时间轴、触觉反馈）+ LiveEta（车距卡、刷新指示）
- [ ] **T4 组件迁移 · 次要页**：RecordsClient / FinishForm / LoginForm + layout themeColor
- [ ] **T5 验证**：tsc / 本地双主题逐页截图（首页、计时三屏、记录、结束、登录）/ 计时全流程功能回归
- [ ] **T6 上线**：提交（正确作者邮箱）→ push → 线上截图复核 → 打 tag v0.3.0 → 汇报

## 6. 验收标准

- [ ] 首页/计时/记录/结束/登录五页在浅色、深色两主题下截图排版正常、对比度达标（正文 ≥ 4.5:1）
- [ ] 所有按钮按压有 scale+状态层反馈，过渡 150-300ms 无卡顿
- [ ] 步骤切换有轻微进入动画；系统开启"减弱动态效果"时无动画
- [ ] 计时全流程（出发→等车→上车→下车→到达）功能回归通过，自动记录不断链
- [ ] 手机视口（390×844）无横向滚动、无内容溢出
- [ ] 线上部署后截图与本地一致，v0.3.0 tag 发布

## 7. 风险与回滚

- 视觉层与逻辑分离，功能风险趋近于零；若个别页面翻车可按 git 提交粒度回滚单页
- 每阶段 headless 截图留档（/tmp/ui-v030-*.png）
- Vercel 部署沿用现有链路；提交前校验 author 邮箱（铁律）
