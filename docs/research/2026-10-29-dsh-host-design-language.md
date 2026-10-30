# DSH 宿主设计语言与 ClinMesh 整屏对齐

研究日期：2026-10-29。范围：DSH Web 整屏的区域划分与尺寸、宿主自身的视觉 token、`dsh-react-surface` 的品牌与布局合同，以及 ClinMesh 在 DSH 中的当前接入方式。本文不定义当前行为，也不构成实施授权；当前接入合同以[Surface 与 Host 边界](../architecture/agent-integration.md#71-surface-与-host-边界)和[跨端前端架构](../frontend-architecture.md#dsh-web)为准，ClinMesh 自身的 token、组件与测试现状由[UI/UX 现状审计](2026-10-29-ui-ux-current-state-audit.md)拥有，本文不重复。

标注约定：**事实**可由所引文件或命令复现；**推断**是基于事实的判断，未在浏览器中运行验证；**建议**不代表用户决定；**未决**需要用户决定或进一步取证。

## 证据来源与版本

| 简写 | 实际位置 | 版本 | 用途 |
| --- | --- | --- | --- |
| `surface/` | `vendor/dsh-react-surface`（子模块，工作区检出 `ab6092e6`，提交于 2026-10-19；索引记录 `7db43def`，`git diff` 显示工作区相对索引为 rewind） | 自述测试 cohort 为 DSH `0.2.1-rc.2` + React `18.3.1`（[architecture.md](../../vendor/dsh-react-surface/docs/architecture.md) 第 95 行） | 布局引擎、品牌 token、ShadowRoot 基础样式 |
| `<dsh-0.2.1>/` | 仓库 `node_modules/.pnpm/@deepseek-ai+<pkg>@0.2.1-rc.2_*/node_modules/@deepseek-ai/<pkg>/` | `0.2.1-rc.2`，与 `apps/dsh-web/package.json:64-94` 锁定的宿主一致 | 侧栏、对话区、右栏、布局与主题 presenter 的组件 CSS 和 JS；**不含** `dsh-client-ui-theme`，没有 token 取值 |
| `<dsh-0.1.1>/` | `/mnt/c/Users/26341/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/`（Windows 全局安装，只读） | `@deepseek-ai/dsh` `0.1.1-rc.2`（同包 `package.json` 的 `version`） | 唯一可读的 `--dsw-*` token 定义（`dsh-client-ui-theme/lib/client.js`）与 Web 前端产物（`dsh-web-frontend/dist/assets/*.css`） |

事实：本机没有 `0.2.1-rc.2` 的宿主安装。`scripts/dev-dsh.ts:60-72` 默认把 dshvm 槽位放在仓库 `.data/dsh-runtime/versions/dsh-0.2.1-rc.2`，该目录不存在；Windows 的 `~/.dsh/profiles` 下同样是 `0.1.1-rc.2`；pnpm store（`~/.local/share/pnpm/store/v11`）全文检索不到 `--dsw-radius-sm:` 或 `--dsw-alias-bg-base:` 的定义。官方仓库 `deepseek-ai/deepseek-harness` 的主题源码路径在 GitHub 上返回 404（`raw.githubusercontent.com/.../v0.2.1-rc.2/packages/client/ui-theme/src/styles/design-platform.css` 与 `github.com/.../tree/main/packages/client/ui-theme/src/styles`），无法联网补充。

推断：颜色 token 名称在两版之间稳定。`0.2.1` 组件 CSS 引用的 `--dsw-alias-*`/`--dsw-specific-*` 名称都能在 `0.1.1` 主题中找到，`surface/packages/runtime/src/client/shell-branding.ts:35-86` 映射的别名（按 `0.2.1` 测试）也全部存在于 `0.1.1`。取值是否变化无法核实。`0.2.1` 新增了 `--dsw-radius-{xs,sm,md,lg,panel}`、`--dsw-elevation-{panel,soft,stroke-color}`、`--dsw-focus-ring-{width,color}`、`--dsw-menu-backdrop-filter`、`--dsw-alias-link`（从 `<dsh-0.2.1>` 组件 CSS 中统计），这些在 `0.1.1` 中不存在，取值未知。下文颜色表因此标注为 `0.1.1-rc.2` 取值。

## 核心结论

1. 事实：DSH 整屏是 `Sidebar | 中央对话列 | Details（右栏，原生文件）` 三列网格（`<dsh-0.2.1>/dsh-client-ui-layout/lib/client.js:38-46,321`）。ClinMesh 在 `workspace` 预设下插入 Sidebar 与对话列之间，对话列被压到 340–440px（`surface/.../layout-engine.ts:186-215`）。推断：常见 1440px 窗口、侧栏收起、右栏关闭时 ClinMesh 约 944px 宽；右栏打开时会降到下限 360px；1280px 及以下且右栏打开时进入 `shrink`，宽度只有 218–333px。
2. 事实：DSH 主题的“品牌主色”是近黑/近白单色（浅色 `--dsw-alias-brand-primary` = `#0f1115`，深色 `#f9fafb`），蓝色 `#4176e6`（深色 `#679efe`）只用于业务态、链接、焦点和引用芯片（`--dsw-alias-state-business-primary`；`<dsh-0.1.1>/dsh-client-ui-theme/lib/client.js:124`）。ClinMesh 当前主色是靛紫 `#6353d8`/`#8b7ff2`（`packages/ui/src/styles.css:163,226`）。DSH 字体是系统字体栈，无 Web 字体（同文件 `:121`）。
3. 事实：ClinMesh 使用 `branding.shell: 'preserve'`（`apps/dsh-web/src/client/index.tsx:150-154`），宿主外观完全不变；当前声明的 `identity` 只在 `shell === 'surface'` 时生效（`surface/.../brand-slots.tsx:23-26`），且即使生效也会被 ClinMesh 自己以更高优先级注册的 Profile 品牌覆盖（`apps/dsh-web/src/client/profile-brand.tsx:13-14`）。`'surface'` 模式只把 8 个单值 token 内联写到 frame 上，不区分浅深色、不覆盖业务蓝、状态色、圆角、阴影和字号（`shell-branding.ts:35-86`）。推断：`'surface'` 模式在当前合同下只能做到局部统一，并且如果直接写入单个颜色值，会破坏宿主的浅深色切换。
4. 事实：同一屏已经并存三套样式写法：ClinMesh 的 shadcn primitive 被挂进 DSH 侧栏的 ShadowRoot（`apps/dsh-web/src/client/workspace-navigation.tsx:97-121,141`）；ClinMesh 在宿主区域的历史弹层和设置行使用 `--dsw-*` 变量与硬编码回退（`workspace-history.tsx:9-44`、`font-size-settings.tsx:91-94`、`model-settings.tsx:75-104`）；DSH 原生组件使用 `--dsw-*`。推断：“结合 DSH 整体设计”首先要决定这些宿主区域内的 ClinMesh 元素跟随谁的语言。
5. 事实：AI 在整屏中分为两处：DSH 对话列承载模型 transcript、Tool 调用与澄清提问，ClinMesh 不复制（[Agent 适配器](../architecture/agent-integration.md#7-agent-适配器与能力边界)）；ClinMesh 工作区承载 Agent 执行反馈（环绕柔光、页头状态摘要）、人工审阅框，以及由 ClinMesh Server 自行调用模型生成的诊疗建议、病历整理和质控（[反馈时序](../agent-capabilities.md#反馈时序)、[临床流程](../architecture/clinical-workflows.md)）。

## 1. 整屏区域与尺寸

### 1.1 DSH frame（宿主拥有）

| 区域 | 尺寸（`0.2.1-rc.2`） | 依据 |
| --- | --- | --- |
| Sidebar 展开 | 默认 280px，拖拽范围 264–420px；关闭后不记忆拖拽宽度 | `<dsh-0.2.1>/dsh-client-ui-layout/lib/client.js:39,396,415` |
| Sidebar 收起 | 56px 图标轨；macOS 桌面与 Windows 自绘标题栏为 0 | 同文件 `:38,242` |
| 自动收起 | 视口 < 1024px 时收起为轨，手动展开时覆盖在中央列上 | 同文件 `:13,419,425` |
| 中央列 | `minmax(400px, 1fr)`（右栏存在时）；无右栏时可缩到 0 | 同文件 `:40,321` |
| Details（右栏） | 首次打开为视口 45%，范围 300px 至视口 70%；中央列放不下 400px 时右栏被移除 | 同文件 `:15-17,41,430,435` |
| 网格行 | `minmax(0,1fr) auto`，底部行用于底栏 | `<dsh-0.2.1>/dsh-client-ui-layout` 组件 CSS `.frame` 规则 |

事实：ClinMesh 默认让宿主侧栏收起（`workspace-navigation.tsx:259` 首次渲染若为展开则 `toggleSidebar()`），用户可以手动展开。

### 1.2 Surface 预设与 ClinMesh 的可用尺寸

事实：ClinMesh 只声明 `workspace` 和 `full-frame`，`fallback: 'shrink'`、`minSurfaceWidth: 360`、`fullFrameKeepDetails: true`，未声明 `conversation` 约束（`apps/dsh-web/src/client/index.tsx:159-168`），因此对话列使用运行时默认值：初始为 frame 宽度的 31%，范围 340–440px（`surface/.../layout-engine.ts:189-193`）。`workspace` 的计算如下（同文件 `:178-249`）：

- 可用宽度 `available = frame 宽 − sidebar 宽 − details 宽`。
- 对话列上限 `min(440, available − 360)`；上限 ≥ 340 时正常分屏，可拖拽调整，偏好持久化。
- 上限 < 340 时进入 `shrink`：对话列取 `available × 340 / 700`，ClinMesh 得到其余部分，隐藏拖拽手柄（[layouts-and-branding.md](../../vendor/dsh-react-surface/docs/layouts-and-branding.md) 第 35 行）。
- 会话整体收起时，ClinMesh 占据 `frame 宽 − sidebar 宽`，对话列和 Details 都隐藏但保留挂载（`layout-engine.ts:93-104`）。

`full-frame` 覆盖整个 frame（包括侧栏），侧栏与对话列被设为 `inert`、`aria-hidden` 并隐藏；`fullFrameKeepDetails` 在 `frame 宽 − details 宽 ≥ 360` 时保留 Details 列（`layout-engine.ts:123-146`，`surface/.../dsh-host-adapter.ts:426-461`）。高度在两种预设下都等于 frame 高度（bounds 的 top/bottom 为 0）；浏览器 Web 中即视口高度，macOS 桌面与 Windows 自绘标题栏另有顶部留白（layout 组件 CSS 中的 `--dsh-frame-top-clearance`）。

推断：按上述公式计算、未使用持久化的拖拽偏好时（`python3 -I` 计算，未在浏览器中测量），ClinMesh 的宽度如下：

| 视口 | 侧栏 | Details | 对话列 | ClinMesh（workspace） | 模式 | ClinMesh（full-frame） |
| --- | --- | --- | --- | --- | --- | --- |
| 1024 | 56 | 关 | 340 | 628 | 分屏 | 1024 |
| 1280 | 56 | 关 | 397 | 827 | 分屏 | 1280 |
| 1280 | 56 | 576 | 315 | 333 | shrink | 704 |
| 1440 | 56 | 关 | 440 | 944 | 分屏 | 1440 |
| 1440 | 56 | 648 | 376 | 360 | 分屏 | 792 |
| 1440 | 280 | 关 | 440 | 720 | 分屏 | 1440 |
| 1440 | 280 | 648 | 249 | 263 | shrink | 792 |
| 1920 | 56 | 关 | 440 | 1424 | 分屏 | 1920 |
| 1920 | 56 | 864 | 440 | 560 | 分屏 | 1056 |

推断：ClinMesh 的布局需要覆盖约 200px 到 1900px 的连续宽度区间。Details 打开是最常见的“被挤压”来源，因为右栏首次打开就占视口 45%。

### 1.3 容器查询

事实：每个 ShadowRoot 的 `:host` 声明 `container-name: dsh-react-surface`，应用根 `#dsh-react-surface-root` 声明 `container-name: dsh-react-surface-content`，两者都是 `inline-size`（`surface/.../surface-host.tsx:35-36,60-61`）。ClinMesh 构建时把 `@media (width >= …)` 改写为 `@container dsh-react-surface-content (width >= …)`，把 `100svh` 改为 `100%`，把 `:root`/`html`/`body`/`#root` 改为 `.clinmesh-web-root`（`apps/dsh-web/src/surface-styles.ts:69-99`）。因此 Tailwind 的 `sm:`/`md:` 在 DSH 中按 Surface 宽度而非视口生效；业务页另有 `@container/workspace-header`、`/doctor-workspace`、`/case-detail` 等命名容器（`apps/web/src/app/workspace-shell.tsx:468`、`apps/web/src/app/doctor/responsive-layout.tsx:37,86,131`）。

## 2. DSH 宿主的视觉语言

### 2.1 颜色 token（`0.1.1-rc.2` 取值）

事实：主题以 `body` 和 `body[data-ds-dark-theme]` 两组选择器定义静态色阶与语义别名（`<dsh-0.1.1>/dsh-client-ui-theme/lib/client.js:124`）；`0.2.1` 的 presenter 在 `body` 上切换 `data-ds-dark-theme`，并把主题快照中的 token 以内联样式写到 `body`（`<dsh-0.2.1>/dsh-client-ui-layout/lib/client.js:541-566`）。

| 角色 | Token | 浅色 | 深色 |
| --- | --- | --- | --- |
| 主画布 | `--dsw-alias-bg-base` | `#ffffff` | `#151517` |
| 层 1 / 2 / 3 | `--dsw-alias-bg-layer-1/2/3` | `#ffffff` / `#ffffff` / `#ffffff` | `#232324` / `#2c2c2e` / `#353638` |
| 菜单 | `--dsw-specific-menu` | 同 layer-3 `#ffffff` | 同 layer-3 `#353638` |
| 侧栏底 | `--dsw-specific-sidebar-fill` | `#f9fafb` | `#1b1b1c` |
| 模块底 / 设置控件 | `--dsw-alias-bg-module-platform` | `#f5f6f7` | `#353638` |
| 输入框 | `--dsw-specific-input-major` | `#ffffff` | `#2c2c2e` |
| 用户气泡 | `--dsw-specific-bubble` | `#edf3fe` | `#2c2c2e` |
| 主文字 | `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` |
| 次文字 | `--dsw-alias-label-secondary` | `#61666b`（5.80:1） | `#cfd3d6`（12.11:1） |
| 三级文字 | `--dsw-alias-label-tertiary` | `#81858c`（3.71:1） | `#adb2b8`（8.54:1） |
| 说明文字 | `--dsw-alias-label-caption` | `#adb2b8` | `#81858c` |
| 边线 l1 / l2 / l3 | `--dsw-alias-border-l1/l2/l3` | `#0000000a` / `#0000001a` / `#0000001f` | `#ffffff0f` / `#ffffff1f` / `#ffffff29` |
| 品牌 / 主按钮 | `--dsw-alias-brand-primary`、`--dsw-alias-button-primary-fill` | `#0f1115` | `#f9fafb` |
| 主按钮悬停 | `--dsw-alias-button-primary-hover` | `#43454a` | `#ebeef2` |
| 业务强调（链接、焦点、引用） | `--dsw-alias-state-business-primary` | `#4176e6`（4.23:1） | `#679efe`（6.86:1） |
| 业务浅底 | `--dsw-alias-state-business-tertiary` | `#e4edfd` | `#34415b` |
| 错误 | `--dsw-alias-state-error-primary` | `#ec1313` | `#f25a5a` |
| 成功 | `--dsw-alias-state-success-primary` | `#22c55e` | `#22c55e` |
| 警告 | `--dsw-alias-state-warn-primary` / `-label` | `#f59e0b` / `#dd8629` | `#f59e0b` / `#dd8629` |
| 悬停 / 按下 | `--dsw-alias-interactive-bg-hover` / `-active` | `#2631480f` / `#2631481a` | `#ffffff14` / `#ffffff24` |
| 侧栏选中 / 悬停 | `--dsw-specific-sidebar-nav-item-active` / `-hover` | `#ebeef2` / `#f1f3f5` | `#43454a` / `#2c2c2e` |
| Tooltip | `--dsw-alias-tooltip-bg` | `#2c2c2e` | `#43454a` |

括号内是对同主题 `bg-base` 的 WCAG 2.x 对比度，由 `python3 -I` 按相对亮度公式计算。浅色三级文字和浅色业务蓝作为正文均低于 4.5:1。

### 2.2 字体、阴影、动效与圆角

| 项 | 取值 | 依据 |
| --- | --- | --- |
| 正文字体 | `--dsw-font-family`：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif` | `<dsh-0.1.1>/dsh-client-ui-theme/lib/client.js:121` |
| 代码字体 | `--ds-font-family-code`：`"SF Mono", "JetBrains Mono", "Fira Code", Consolas, …` | 同上 |
| Web 字体 | 只打包 KaTeX 数学字体 | `<dsh-0.1.1>/dsh-web-frontend/dist/assets/fonts/` 文件名 |
| 字号阶梯 | 11/14、12/18、13/20、14/22、16/24、16/28、20/28、24/32（px/行高）；Markdown 正文 16/28，H1–H3 为 24/22/20 | 同主题文件 `:130` |
| 用户可调字号 | `0.2.1` 增加 `--dsh-content-font-size`、代码与终端字号及三类字体族变量，写在 `body` 上；对话输入卡默认 14px/24px | `<dsh-0.2.1>/dsh-client-ui-layout/lib/client.js:517-527,555-559`；对话组件 CSS `.uV2eYG_card` |
| 阴影 | `lv1 0 2px 4px #0000000d`；`lv2 0 4px 12px #00000005, 0 2px 8px #0000000a`；`lv3 0 0 1px #0003, 0 0 4px #00000005, 0 12px 32px #00000014` | 主题文件 `:130` |
| 动效 | `cubic-bezier(.4,0,.2,1)`，0.1s / 0.2s / 0.3s；侧栏展开与 Surface 列宽动画遵守 `prefers-reduced-motion` | 主题文件 `:121`；layout 组件 CSS |
| 滚动条 | 8px，圆角 4px，浮层内改用 l2 色 | 主题文件 `:127` |
| 圆角（`0.1.1` 字面值） | 全部组件 CSS 中 12px 出现 35 次、8px 26 次、999px 与 6px 各 24 次；输入卡和用户气泡 22px；Web 前端按钮 18px 胶囊 | `<dsh-0.1.1>` 组件 CSS 统计；`dsh-web-frontend/dist/assets/index-C6eRlFa6.css` `._button_*` |
| 圆角（`0.2.1`） | 改用 `--dsw-radius-xs/sm/md/lg/panel`，取值未知 | `<dsh-0.2.1>` 组件 CSS |
| 图标 | DSH 自有图标集（`IconNewChatOutlineRegular`、`IconPanelLeftOutlineRegular` 等）与 `FishLogo`，由 `dsh-client-ui-primitives` 提供 | `<dsh-0.2.1>/dsh-client-ui-sidebar/lib/client.js` 的 `require` 与成员引用 |

### 2.3 区域样式

| 区域 | 观察到的样式 | 依据 |
| --- | --- | --- |
| Sidebar | 底色 `sidebar-fill`，右边线 0.5px `border-l3`；内边距 12px；导航行最小高 36px、内边距 7px 8px、行高 22px、圆角 `radius-md`；图标按钮 28px（收起时 36px）；“新会话”按钮高 38px、0.5px 边线；品牌名 18px/600 | `<dsh-0.2.1>/dsh-client-ui-sidebar` 组件 CSS（`lib/client.js:91`）；layout 组件 CSS `.sidebarCol` |
| 对话列 | 底色 `bg-base`；页头最小高 76px、底边 0.5px `border-l3`；内容宽 `clamp(680px, 列宽 × 0.64, 920px)`，嵌入形态 `min(100% − 32px, 920px)` | 对话组件 CSS `.wSkVaW_header`、`.wSkVaW_body`、`.wSkVaW_embeddedBody`（`lib/client.js:17325`） |
| 输入卡 | `input-major` 底、`radius-panel`、`elevation-soft`；输入区最大高 336px；吸底时上方 36px 渐隐到 `bg-base` | 对话组件 CSS `.uV2eYG_card`（`lib/client.js:18703`）、`.wSkVaW_composerSeat` |
| 浮层与队列 | `specific-menu` 底、`radius-lg`、`elevation-panel`，可带 `backdrop-filter` | 对话组件 CSS `.lXshSW_root` |
| 用户消息（`0.1.1`） | `bubble` 浅蓝底、22px 圆角、10px 16px 内边距、16px/24px | `<dsh-0.1.1>/dsh-client-ui-conversation` 组件 CSS `.gdEzaW_bubble` |
| Surface 与对话列分界 | 1px 竖线，颜色取 `--dsh-surface-border` 或 `border-l1` | `surface/.../dsh-host-adapter.ts:413-418` |

推断：DSH 是“白底（或近黑底）、单色主按钮、蓝色仅表示交互与业务态”的低饱和语言。分区靠 0.5px 发丝线和整块底色差，不依赖卡片；只有输入卡、菜单和浮层使用圆角加柔和阴影抬升。基础字号 14px、导航行 36px，属于中等密度；大圆角与胶囊按钮偏消费级对话产品。ClinMesh 现行 Web 主题为 13px 基础字号、6px 圆角、1px 实色边线和靛紫主色（`packages/ui/src/styles.css:144-215`；细节见[现状审计](2026-10-29-ui-ux-current-state-audit.md)），密度更高、色彩更饱和。

## 3. `preserve` 与 `surface` 品牌模式

### 3.1 实际效果

| 项 | `shell: 'preserve'`（ClinMesh 当前） | `shell: 'surface'` |
| --- | --- | --- |
| `--dsh-surface-*` 稳定变量 | 写到 frame 内联样式（仅当 `tokens` 提供值）；ShadowRoot 的 `:host` 默认值取自 `--dsw-*` 别名 | 同左 |
| 宿主 `--dsw-*` 别名 | 不改变 | 在 Surface 激活期间把 8 个 token 内联写到 frame 上的约 25 个别名，关闭 Surface 后按 effect ledger 恢复 |
| `colorScheme` | `'light'`/`'dark'` 写 frame 的 `color-scheme`；`'system'` 不写 | 同左 |
| 侧栏身份 | 不注册 | 以 priority `-100` 注册 `sidebar.brand.mark`/`.name` |
| frame 标记 | 无 | `data-dsh-react-surface-brand="surface"` |

依据：`surface/.../shell-branding.ts:22-88`、`surface/.../dsh-host-adapter.ts:398,480-505`、`surface/.../brand-slots.tsx:18-62`、`surface/.../surface-host.tsx:40-49`、[layouts-and-branding.md](../../vendor/dsh-react-surface/docs/layouts-and-branding.md) 第 47-78 行。

`surface` 模式的映射（事实，`shell-branding.ts:35-86`）：

| Surface token | 写入的宿主别名 | 受影响的宿主区域（推断） |
| --- | --- | --- |
| `background` | `bg-base` | 对话列、右栏、frame 底 |
| `surface` | `bg-layer-1`、`bg-overlay`、`input-major`、`menu`、`sidebar-fill` | 侧栏底、输入卡、菜单 |
| `elevated`（缺省取 `surface`） | `bg-layer-2/3`、`selector` | 弹层、选择器 |
| `foreground` | `label-primary`、`label-primary-foreground` | 全部主文字；注意 `label-primary-foreground` 是主按钮上的文字色 |
| `mutedForeground` | `label-dimmed/secondary/tertiary` | 全部次级文字 |
| `border` | `border-l1/l2/l3` | 全部分隔线 |
| `accent` | `brand-primary`、`brand-text`、`button-primary-fill`、`sidebar-nav-item-active-accent` | 主按钮（含发送）、品牌字、侧栏选中强调 |
| `accentForeground` | `brand-primary-invert` | 主按钮反色 |
| `fontFamily` | `--dsw-font-family` | 宿主全部正文 |
| `background` + `accent` 同时提供 | 用 `color-mix` 派生 `interactive-bg-active`、`interactive-bg-hover-accent`、`sidebar-nav-item-active` | 悬停与选中底 |
| `radius` | 只写 `--dsh-surface-radius`，不映射宿主 | 无 |

事实：未映射的有 `state-business-*`（链接、焦点、引用芯片的蓝色）、错误/成功/警告状态色、`bubble`、阴影、`--dsw-radius-*`、字号与 `--dsh-content-font-size`。token 值只校验非空、≤ 256 字符、不含 `{}`（`surface/.../contracts.ts:377-386`）；每个 token 只有一个值，没有浅深色两套（`contracts.ts:55-78`）。

事实：`identity` 替换只作用于官方 `sidebar.brand.mark`/`sidebar.brand.name` 插槽，cohort 不提供时保留原身份（layouts-and-branding.md 第 76 行）；它不覆盖 `conversation.hero.brand.mark` 和浏览器标签标题。ClinMesh 已在 Profile 加载时以 priority `-200` 注册这两个插槽和 hero 插槽，注释说明其优先于运行时的 `-100`（`apps/dsh-web/src/client/profile-brand.tsx:13-14,96-125`）。

cohort 支持：事实上，运行时文档声明它“只映射为受支持 DSH cohort 验证过的语义 token”（layouts-and-branding.md 第 78 行），代码注释为 “tested DSH semantic aliases”（`shell-branding.ts:21`），测试 cohort 为 `0.2.1-rc.2`（architecture.md 第 95 行）。`surface/.../shell-branding.test.ts`（34 行）只断言声明映射表；ClinMesh 仓库没有任何 `shell: 'surface'` 的浏览器验证（`grep` `shell: 'surface'` 于 `apps/` 无结果）。

### 3.2 推断与含义

- 推断：`surface` 模式写入的是 frame 上的内联值，会覆盖 `body` 上随 `data-ds-dark-theme` 切换的别名。若 token 写成单一颜色，宿主切换深色后这些区域仍保持浅色值。要同时成立浅深色，token 必须是随 `color-scheme` 变化的表达式，例如 `light-dark(#fff, #151517)`（宿主在 `html` 上设置 `color-scheme`，见 `<dsh-0.2.1>/dsh-client-ui-layout/lib/client.js:550`），或引用宿主自身变量；运行时没有为此提供文档或测试。
- 推断：即使启用 `surface`，链接、焦点环、引用芯片仍是 DSH 业务蓝，状态色、圆角、阴影和对话气泡也保持 DSH 原样；只有底色、文字、边线、主按钮和字体会被统一。若 ClinMesh 主色为靛紫，同一屏会出现“靛紫主按钮 + DSH 蓝焦点与链接”。
- 推断：`preserve` 模式下 ClinMesh 仍能读取宿主 token。CSS 自定义属性跨 ShadowRoot 继承，且 `all: initial` 不重置自定义属性，所以 Surface 内可以通过 `--dsh-surface-*`（`:host` 默认值引用 `--dsw-*`）或直接引用 `--dsw-*` 跟随宿主。ClinMesh 当前不消费这些变量：`packages/ui/src` 与 `apps/web/src` 中 `dsh-surface-`/`dsw-` 零命中，应用根使用自有调色板。
- 含义：存在两条可行路线。路线 A“两套视觉并存”：保持 `preserve`，ClinMesh 维护独立 token，只对齐几何、字号与交互语义；风险是在同一屏出现两种主色与圆角体系，侧栏中的 ClinMesh 导航与 DSH 原生项也在风格上不一致。路线 B“统一成一个产品”：让 ClinMesh 的语义 token 在 Surface 中由宿主 `--dsw-*` 派生（`preserve` 即可实现，宿主不受影响），必要时再评估 `surface` 模式把少量品牌值反向写回宿主；风险是 ClinMesh 的医疗语义色（危急、过敏、待复核）需要在 DSH 的单色体系之上补充，且 `0.2.1` 的圆角与阴影取值目前无法取证。

## 4. 宿主拥有、ClinMesh 不能覆盖的部分

| 项 | 边界 | Owner |
| --- | --- | --- |
| 主题 | DSH 拥有 Light/Dark/System；Surface 只应用宿主解析结果，不提供主题选择 | [主题所有权 Note](../decisions/implemented/architecture/2026-09-15-dsh-host-theme-ownership.md)、[7.1](../architecture/agent-integration.md#71-surface-与-host-边界) |
| 语言 | DSH 拥有生效语言，ClinMesh 只映射为 `zh-CN`/`en-US` | [宿主语言归属](../decisions/implemented/architecture/2026-09-16-dsh-host-locale-ownership.md) |
| 字号 | ClinMesh 字号经 DSH 设置的官方 slot 提供三档，只缩放应用根，与宿主会话字号独立；宿主自身的 `--dsh-content-font-size` 由 DSH 设置 | [DSH 字号设置](../decisions/implemented/architecture/2026-09-16-dsh-font-size-settings.md)、`<dsh-0.2.1>/dsh-client-ui-layout/lib/client.js:517-559` |
| 侧栏 | 宽度、展开/收起、自动收起由宿主 layout 拥有；ClinMesh 只能通过官方插槽和在 `sidebar.workspaces` 区前插入节点来放置导航 | `workspace-navigation.tsx:97-121,283-296`；[紧凑侧栏与会话历史](../decisions/implemented/architecture/2026-10-06-dsh-workspace-session-history.md) |
| 对话列与 Details | 内容、页头、输入卡、原生文件栏均为宿主所有；运行时只能调整对话列宽度与可见性 | `surface/.../dsh-host-adapter.ts:398-461` |
| 布局形态 | 只能在注册的预设中选择；用户选择与拖拽尺寸按版本化 localStorage 键持久化 | [layouts-and-branding.md](../../vendor/dsh-react-surface/docs/layouts-and-branding.md) 第 29 行 |
| 样式隔离 | 一个 open ShadowRoot，`:host { all: initial; contain: strict }`；公开接口不接受 DSH 选择器或任意全局 CSS | `surface/.../surface-host.tsx:31-39`；layouts-and-branding.md 第 78 行 |
| 弹层边界 | 对话框、菜单、Tooltip、Toast 必须挂到注入的 `portalRoot`，否则逃出 ShadowRoot 样式；`contain: strict` 使弹层不能超出 Surface 边界 | [application-integration.md](../../vendor/dsh-react-surface/docs/application-integration.md) 第 45 行；[DSH 集成记忆](../memory/dsh-integration.md) |
| 层级 | DSH 原生文件全屏覆盖 HIS，不抬高 Surface 层级修补遮挡 | [产品偏好](../memory/product-references.md#工作台布局与交互偏好) |
| 视口 | 视口媒体查询被改写为容器查询；`100svh` 改为 `100%` | `apps/dsh-web/src/surface-styles.ts:90-99` |
| 产物 | 单文件 lazy-CJS，不生成动态 chunk，React 18.3.1 由宿主提供 | [跨端前端架构](../frontend-architecture.md#dsh-web)；体积现状见[现状审计](2026-10-29-ui-ux-current-state-audit.md) |

事实：ClinMesh 现有两处依赖宿主 DOM 结构的例外：向 `document.head` 注入全局样式，隐藏 `sidebar.workspaces`、面板列表和“新建会话”按钮（`workspace-navigation.tsx:243-254`）；改写新会话 hero 标语文本节点（`profile-brand.tsx:23-50`，注释说明 RC 没有标语替换 API）。推断：这两处在宿主升级时最容易失效，新设计不宜在其上继续叠加宿主 DOM 改写。

## 5. AI 交互在整屏中的归属

| 位置 | 承载内容 | 视觉 owner | 依据 |
| --- | --- | --- | --- |
| DSH 对话列 | 模型 transcript、reasoning、Tool 调用展示、`ask_user_question`、会话历史；preset 为 `clinmesh-assistant` | DSH | [7 节](../architecture/agent-integration.md#7-agent-适配器与能力边界)、[业务会话](../agent-capabilities.md#业务会话) |
| 对话列页头 | ClinMesh 注入的会话历史弹层，使用 `--dsw-*` 变量与回退色 | ClinMesh 代码、DSH 语言 | `apps/dsh-web/src/client/workspace-history.tsx:9-44` |
| DSH 输入卡 → ClinMesh | 门诊医生病例会话中，输入卡提交的文本由桥接登记为医生任务许可或病历补充来源 | 数据由 ClinMesh 拥有，界面在 DSH | `apps/dsh-web/src/client/doctor-task.ts`、`apps/web/src/app/surface-agent-publisher.ts:167-214` |
| ClinMesh 工作区边缘与目标 | Agent 非 proposal 动作执行期间的环绕柔光、目标淡边框与菱形标记、完成停留与淡出 | ClinMesh（`--clinmesh-glow` 为靛紫） | [反馈时序](../agent-capabilities.md#反馈时序)、`packages/ui/src/styles.css:196,253` |
| ClinMesh 页头 | Agent 状态摘要（进行中、待人工确认、提交中、需查看） | ClinMesh | 同上 |
| ClinMesh 工作区内 | `.propose` 动作的人工审阅框，批准与拒绝保持静态 | ClinMesh | 同上；[产品偏好](../memory/product-references.md#工作台布局与交互偏好) |
| ClinMesh 工作区内 | 诊疗建议（检验、放射、病理、诊断、处方）、病历自动整理、质控，由 ClinMesh Server 自行调用模型，不经 DSH 对话 | ClinMesh | [临床流程](../architecture/clinical-workflows.md) |

推断：同一屏有两个 AI 发声位置。对话列是“与助手对话”，语言是 DSH 的气泡与输入卡；工作区内是“系统给出的辅助结果与执行痕迹”，语言是 ClinMesh 自己的。重构需要明确两者的视觉区分规则：建议与 Agent 执行痕迹是否使用与 DSH 业务蓝一致的强调色，柔光是否继续使用靛紫。事实：DSH 已用 `state-business-primary` 蓝色表示引用芯片与焦点（对话组件 CSS `.yAWgPa_chip`、`.q44v1G_reference`），这是宿主中与“AI 引用到业务对象”最接近的既有语义。

## 6. 综合

### 6.1 必须与 DSH 对齐的项

1. 明暗主题：两套主题都必须成立，并只响应宿主解析结果；不提供 Surface 内主题入口（第 4 节）。
2. 几何：ClinMesh 在约 200–1900px 宽度内连续可用，以 `dsh-react-surface-content` 容器宽度为准，不依赖视口；`shrink` 下保持左右分屏，不改为上下排列（第 1.2 节；[产品偏好](../memory/product-references.md#工作台布局与交互偏好)）。
3. 弹层与层级：所有浮层留在 Surface 边界与 `portalRoot` 内；不靠提升 z-index 跨越宿主区域（第 4 节）。
4. 宿主区域内的 ClinMesh 元素（侧栏导航、对话页头历史弹层、设置行）应与相邻的 DSH 原生项在行高、圆角、悬停与选中语义上一致。推断：目前侧栏导航用的是 ClinMesh `Button` 变体，与 DSH 36px 导航行不同源（第 2.3 节、`workspace-navigation.tsx:141-150`）。
5. 分界线：Surface 与对话列之间的竖线由运行时绘制（`--dsh-surface-border` 或 `border-l1`）；ClinMesh 左右边缘不应再画第二条重复边线。
6. AI 职责划分：模型对话只在 DSH 对话列，ClinMesh 不复制 transcript 或推测模型活动（第 5 节）。

### 6.2 ClinMesh 可以自主决定的项

1. Surface 内部的 token 取值与组件视觉（`preserve` 模式下不影响宿主）。
2. 页面内信息架构、栏目组织、密度与排版阶梯（受宿主字号设置外的 ClinMesh 字号三档约束）。
3. 医疗语义色（危急、过敏、待复核、偏高偏低）与其对比度标准；DSH 没有对应语义。
4. 工作区内 AI 建议、执行反馈与人工审阅的呈现方式（受已确认的“环绕柔光”和“审阅静态”偏好约束，推翻需用户确认）。
5. 图标库：ClinMesh 使用 lucide（35 处导入），DSH 使用自有图标集；两者可以并存，是否在宿主区域内改用相近线宽属于设计选择。

### 6.3 需要用户决定的问题

1. 产品观感：DSH + ClinMesh 是“一个产品”（Surface 语义 token 由宿主 `--dsw-*` 派生）还是“宿主里的独立应用”（ClinMesh 维持独立调色板，只对齐几何与交互）？推荐“一个产品”：用户要求整屏设计，且 `preserve` 模式下即可实现，不改动宿主。
2. 是否改用 `shell: 'surface'`？推荐暂不改：映射不覆盖业务蓝、状态色与圆角，单值 token 与浅深色切换冲突，ClinMesh 未做浏览器验证；若需要，先做隔离原型验证 `light-dark()` 写法。
3. 主色：跟随 DSH 的单色主按钮 + 蓝色业务强调，还是保留 ClinMesh 靛紫？推荐跟随 DSH 的结构（中性主按钮、蓝色表示交互与 AI 引用），ClinMesh 只在医疗语义色上扩展；靛紫柔光是否改为业务蓝需单独确认。
4. 字体：跟随宿主系统字体栈（`--dsw-font-family`），还是另选字体？推荐跟随：DSH 不打包 Web 字体，而 DSH 产物体积已无余量（见[现状审计](2026-10-29-ui-ux-current-state-audit.md)）。
5. 基础字号与密度：ClinMesh 13px 与 DSH 14px 并排是否可以接受，还是统一为 14px？这决定临床表格的信息密度。
6. 页头高度：ClinMesh 页头 54px，DSH 对话页头最小高 76px（第 2.3 节），横向基线不一致；是否要求整屏页头对齐？
7. 宿主侧栏中的岗位导航，改为模仿 DSH 原生导航行，还是保留 ClinMesh 组件风格？

### 6.4 仍未解决的证据缺口

- `0.2.1-rc.2` 的 `--dsw-*` 颜色取值，以及 `--dsw-radius-*`、`--dsw-elevation-*`、`--dsw-focus-ring-*` 的取值，本机无源；需要 dshvm 安装的宿主槽位或可访问的官方源码。
- 第 1.2 节的宽度为公式推导，未在真实宿主中测量；用户拖拽过的对话列宽度会改变结果。
- 第 2.3 节的对话页头高度与内容宽度来自组件 CSS，未确认在 Surface `workspace` 下对话列 340–440px 时实际使用的是常规形态还是嵌入形态。

## 运行的只读命令

- `cat`、`sed -n`、`grep -n`、`ls`、`find`、`wc`：阅读规则、owner 文档、`vendor/dsh-react-surface` 文档与源码、`apps/dsh-web` 与 `packages/ui` 源码，定位本机 DSH 包与版本。
- `git submodule status`、`git diff --submodule=log vendor/dsh-react-surface`、`git diff apps/dsh-web/src/client/index.tsx`：确认子模块检出与 adapter 的未提交改动。
- `python3 -I` 脚本：从 `<dsh-0.1.1>` 与 `<dsh-0.2.1>` 的 `lib/client.js` 抽取内嵌 CSS 字符串到会话临时目录，统计圆角、字号与 token 引用；按布局引擎公式计算宽度表；按 WCAG 相对亮度公式计算对比度。
- `grep -rl`（带 `timeout`）：在 pnpm store、仓库 `node_modules` 与 Windows 全局安装中检索 `--dsw-*` token 定义。
- 两次 WebFetch 访问官方仓库主题源码路径，均返回 404。
- 未启动 DSH 宿主、未运行构建或浏览器、未调用模型；未读取任何图片、截图或影像像素文件。
