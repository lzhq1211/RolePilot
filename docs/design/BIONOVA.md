# RolePilot BIONOVA 前端规范 v1.0

> **状态：生效中（本仓库唯一 UI 规范事实源）。** 本文件自 2026-09-08 起收口于仓库内 `docs/design/`，由根 `DESIGN.md` 指向。原外部上级规范 `FRONTEND_HANDOVER_SPEC.md` 仅作历史来源，不再作为执行依据；如有冲突，以本文件为准。

## 0. 使用规则

### 0.1 设计方向

采用 **BIONOVA 现代极简**：主站纯白、深灰文字、柔蓝高光、圆形药丸操作、轻量毛玻璃 Top Pill 和克制的冷灰细节。界面留出足够的呼吸空间，让任务、简历和结果成为主体；避免复古纸张、重黑底、高饱和渐变、厚重卡片和装饰性说明文字。

### 0.2 规范优先级

1. 产品事实、内容证据、数据合同和业务可用性优先于视觉效果；UI 不得虚构匹配率、成果、用户状态或功能。
2. 本文件优先于历史视觉基线、截图和 Demo；外部上级规范仅作历史来源，不再作为执行依据。
3. 项目内冻结的内容排版、打印规则和无障碍要求继续有效；视觉重构不得突破它们。
4. 新页面优先复用 token、Top Pill、按钮、卡片、表单和状态样式；不得为单页另建一套颜色、圆角、阴影或字体体系。

### 0.3 实施与验收要求

- 使用语义化 HTML / 现有组件，样式通过 token 落地；不得只靠截图或像素绝对定位实现页面。
- 每个可操作元素保留明确名称、键盘访问、焦点态和禁用态；只有功能真实存在时才可点击。
- 新增 UI 必须覆盖桌面与窄屏。桌面以 `1140px` 主容器、`94vw` 顶栏为基线；`900px` 以下切为单列或抽屉导航，`620px` 以下收紧间距和按钮文字。
- 动效仅服务于层级、反馈或媒体；遵从 `prefers-reduced-motion`，不以自动播放或滚动效果遮挡任务内容。
- 文本、状态、指标和媒体应来自真实系统数据或明确的静态产品文案。没有认证、导出、连接或分析能力时，使用禁用态或不展示入口。

## 1. BIONOVA Token

`apps/rolepilot-web/src/styles/tokens.css` 是 RolePilot 的 token 出口。组件仅使用语义与组件 token，不在 JSX 或局部样式中加入裸写颜色和任意视觉尺寸。

```css
:root {
  --rp-bg-page: #ffffff;
  --rp-bg-field: #f8fafc;
  --rp-bg-surface: #ffffff;
  --rp-bg-surface-strong: #edf5ff;

  --rp-text-primary: hsl(0, 0%, 17%);
  --rp-text-secondary: #475569;
  --rp-text-muted: #64748b;
  --rp-text-on-light: #0f172a;

  --rp-border-subtle: rgb(15 23 42 / 8%);
  --rp-border-default: rgb(15 23 42 / 9%);
  --rp-border-hover: rgb(15 23 42 / 20%);
  --rp-shadow-surface: 0 8px 30px rgb(0 0 0 / 5%);

  --rp-brand-primary: hsl(213, 90%, 78%);
  --rp-brand-emphasis: #356da8;
  --rp-action-primary-bg: var(--rp-brand-primary);
  --rp-action-primary-bg-hover: hsl(213, 90%, 72%);
  --rp-action-primary-fg: #0f172a;

  --rp-status-success: #047857;
  --rp-status-warning: #b45309;
  --rp-status-danger: #dc2626;
  --rp-focus-ring: #568bd0;
}
```

## 2. 字体与排版

- 应用外壳默认使用 `Poppins, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`；`Poppins` 不可用时必须自然退回本机中文字体。
- 正文使用 `--rp-text-primary`，辅助信息使用 `--rp-text-muted`；不使用纯黑大段正文。
- 标题以 500–700 字重和紧凑字距建立层级，不使用夸张的全大写、渐变文字或描边字。
- 外壳标题、标签、按钮与输入控件遵循此字体体系。简历纸张内部的字体、字号、行高和文字网格由排版器冻结样式决定，不得被全局字体覆盖。

## 3. Top Pill、导航与按钮

- Top Pill 是一级导航和核心工作台工具栏的默认形态：`top: 14px`、`width: min(94vw, 1140px)`、`border-radius: 9999px`、半透明白色背景、`blur(18px)`、低对比边框和 `--rp-shadow-surface`。
- Top Pill 内保留品牌、当前页导航、主操作和移动菜单。窄屏时允许换行或压缩，不能仅为保持单行而隐藏关键功能。
- 按钮统一使用 `border-radius: 9999px`、`padding: 8px 20px`、`font-size: 0.825rem`、`font-weight: 600`。
- 主按钮使用 `--rp-brand-primary` 背景和 `#0f172a` 文字；次按钮使用白底、深灰文字、`1px solid var(--rp-border-default)` 边框。
- hover 仅使用约 `160ms` 的背景、边框、阴影或 `translateY(-1px)` 反馈。disabled 必须可辨，且不应伪装成可用功能。

## 4. 容器、卡片与表单

- 页面底色固定 `--rp-bg-page`；仅工作区可使用 `--rp-bg-field` 和低对比度点阵。点阵不得出现在结果详情或 A4 纸张内部。
- 常规内容最大宽度为 `1140px`，使用清晰的单栏或双栏网格；主操作区优先留白，避免无意义分隔线堆叠。
- 卡片使用纯白背景、低对比边框、`24px` 圆角和 `--rp-shadow-surface`；媒体卡片可使用 `24–36px` 圆角。
- 输入框和文本域使用白色或冷灰背景、深灰文字、`16px` 圆角。错误只用于真实校验失败，不能用颜色代替错误内容。
- 工作流、状态列表和结果详情保持信息密度与可读性，不用大面积装饰遮挡业务状态。

## 5. 状态、焦点与反馈

- 成功、警告和错误仅表示真实系统状态；状态文本必须说明含义，不能只显示颜色或图标。
- 键盘焦点使用最小 `2px` 的 `--rp-focus-ring`，并留出可见偏移；hover、active、disabled 状态必须可区分。
- Toast、弹窗和辅助面板均使用白色微阴影卡片；弹窗使用遮罩并支持 Escape 关闭，除非是不可中断的明确业务步骤。
- 图标按钮必须有 `aria-label`；错误信息就近显示于对应字段或操作，不能只在页面顶部给出泛化提示。

## 6. 响应式与动效

- 桌面以 `1140px` 容器和双栏内容为基线；`900px` 以下切为单列、内容流侧栏或抽屉导航；`620px` 以下收紧间距，Top Pill 保留品牌、主操作和菜单。
- 页面不得产生水平滚动；输入卡、工作流和媒体卡在窄屏占满可用宽度并按内容纵向排列。
- 动效只服务于层级和反馈。页面入场使用轻量淡入上移；不得使用闪烁、弹跳或持续扰动。
- 必须遵从 `prefers-reduced-motion`，不使用自动播放或滚动效果遮挡任务内容。

## 7. 媒体规则

- 视频是增强表达，不是业务证据。仅用于真实产品语义，不得叠加无来源的量化成果或承诺。
- 自动视频必须静音、`playsInline`、无控件、低优先级加载；页面隐藏或用户偏好减少动态时暂停，并保留静态背景作为失败回退。
- 第三方视频、字体或运行时依赖不能阻断主流程；离线时页面仍须可读、可填写、可提交已有业务表单。
- 首页媒体卡使用“真实经历、岗位分析、面试准备”的静态产品文案；禁止改为虚构的匹配率、薪资或成功率。

## 8. RolePilot 实现映射

| 范围 | 规范入口 | 约束 |
|---|---|---|
| Token | `apps/rolepilot-web/src/styles/tokens.css` | 新增颜色和组件参数先定义 token。 |
| 应用外壳 | `apps/rolepilot-web/src/styles/app.css`、`components/Shell.tsx` | Top Pill、页面容器、卡片、表单、焦点和窄屏布局统一在此维护。 |
| 首页媒体 | `pages/HomePage.tsx`、`components/HeroVideo.tsx` | 视频可失败回退，不能阻断路由或主操作。 |
| 业务页面 | `pages/*`、`features/*` | 仅呈现真实 API / Run 状态，不把视觉状态写成业务真值。 |
| 排版器边界 | `packages/resume-workbench`（`resume.css`、`renderer.js`、A4 纸张 DOM、`print.css`） | 不改动排版器冻结样式与纸张 DOM。 |

## 9. 新页面交付清单与例外

1. 使用本文件的 token、Top Pill、按钮和卡片基线。
2. 验证桌面、`900px` 和 `620px` 布局无横向溢出。
3. 覆盖 hover、focus、disabled、loading、empty、error 和成功状态中的实际适用项。
4. 检查键盘导航、焦点可见性和减少动态偏好。
5. 没有真实数据或功能时，使用中性占位或禁用入口，不能捏造结果。

当前无例外。任何长期偏离 BIONOVA 规范的页面级规则，必须在本节登记原因、范围、替代 token 和回收条件。
