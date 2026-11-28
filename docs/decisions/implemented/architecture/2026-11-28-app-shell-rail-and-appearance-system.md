# Agent Note: 多空间应用导航轨、自定义外观主题引擎与 UI-SDK 交互组件体系

Status: implemented

## Problem

原有 `apps/web` 的 `WorkspaceShell` 进入后直接渲染单一临床岗位工作台，仅在 `/settings` 路由挂载左侧边栏，导致 `pi-durable` 会话能力被局限在右侧狭长临床助手抽屉中，缺乏统一的一级空间入口承接全屏聊天、个人智能体工作台与临床科研等跨岗位场景；同时外观设置仅提供亮/暗/系统与三档字号，缺少无侵权原创多主题、零 JS 本地主题包、安全模式、搜索式设置中心、全局 `Ctrl+K` 命令面板及面向临床高密度场景的 `@ui-sdk/react` 交互原语库。

## Decision

1. **多空间左侧主导航轨（`AppRail`）与圆角浮卡壳层（`AppShellCard`）**：
   - 在 [workspace-shell.tsx](../../../apps/web/src/app/workspace-shell.tsx) 与 [app-rail.tsx](../../../apps/web/src/app/app-rail.tsx) 引入常驻左侧主导航轨（默认 `56px` 图标轨，支持一键切换 `56px` 图标轨 / `198px` 展开侧栏 / 专注隐藏，后台助手运行中显示状态提示点），覆盖 5 个真实数据驱动空间：临床工作台（默认落点，保留全部 HIS 岗位与右侧助手抽屉）、全屏聊天（`/chat`）、个人智能体（`/agents`）、临床科研（`/research`，含交互式 `DataTable` 与批量子队列分析）及设置中心（`/settings`）。
   - 所有桌面端主区域统一包裹在 `AppShellCard` 圆角浮卡内并配顶部 `2px` `NavigationProgress` 路由切换进度条；新增 [space-navigation-store.ts](../../../apps/web/src/app/space-navigation-store.ts) 维护空间最后访问路径记忆（切回恢复、再点归根）与最近访问记录。设置中心侧栏顶部固定 **`← 返回工作台`** 返回离开前的业务页面（移动端提供顶部 `← 返回` 与 `CompactSpaceSheet`）。
2. **保持原版默认不变的外观主题引擎（`packages/ui/src/appearance/`）**：
   - `default`（临床默认）严格保留既有 ClinMesh `#f5f6f7` / `#ffffff` / `#1764c0`（深色 `#151517` / `#232324` / `#8dbbff`）基线；新增 5 套洁净室原创无商标冲突内置主题（`quiet-studio`、`ward-precision`、`warm-chart`、`scrub-fresh`、`ink-editorial`），全部 6×2 组合通过 `@ui-sdk/core/color` WCAG AA 对比度校验。
   - 支持按主题独立记忆的局部选项（`Theme Options`）、悬停实时试穿、用户菜单内快捷切肤、零 JS 本地 `.zip` 主题包导入/导出（IndexedDB 持久化，Tokenizer 级 CSS 净化拦截外部请求、锁定 `--specimen-cap-*` 采血管管帽色与 `data-agent-confirm` 门禁）以及 `?theme=default` 会话级 **Theme Safe Mode**，并从 `clinmesh.preferences:v1` 自动无损迁移至 `clinmesh.appearance:v2`（首屏内联脚本防 FOUC）。
3. **搜索式设置中心、`Ctrl+K` 命令面板与 `@clinmesh/ui` 交互原语库**：
   - 落地带键盘导航与关键词高亮的设置侧栏搜索、全局 `Ctrl+K` [command-palette.tsx](../../../apps/web/src/app/command-palette.tsx)（含最近访问与实时试穿换肤）及快捷键说明页（安全边界：禁止将带 `data-agent-confirm` 的临床正式写入绑定为单键快捷键）。
   - 在 `packages/ui/src/components/` 封装 24+ 项基于 `@ui-sdk/react` / `@ui-sdk/core` 的通用原语（`data-table`、`data-grid`、`pagination`、`timeline`、`waterfall`、`tree`、`segmented-control`、`combobox`、`number-input`、`date-picker`、`file-input`、`password-input`、`color-picker`、`token-input`、`resizable`、`hover-card`、`drawer`、`meter`、`accordion`、`toolbar`、`scroll-area`、`highlight-text`、`inline-edit`、`truncated-tooltip`、`command`、`kbd`、`slider`、`hold-button`、`theme-swatch`）及 `use-history` / `use-shortcuts` Hook，并在 `/settings/developer/components`（[component-catalog-sink.tsx](../../../apps/web/src/app/component-catalog-sink.tsx)）提供可直接交互试用的预备组件工作坊。

## Alternatives considered

- **将聊天、智能体、科研塞入右上角角色切换菜单**：角色菜单已承载门诊/住院/系统十个临床岗位切换，再混入一级应用空间会破坏信息架构与多空间连续切换心智。
- **使用固定 `220px` 宽主侧栏**：在 `1440px` 视口下与候诊队列、右侧助手抽屉叠加会挤压临床诊疗主卡；默认 `56px` 图标轨兼顾多空间切换与高密度临床主视口。
- **引入第三方产品命名主题或服务端 JS 主题插件**：第三方名称/配色表存在商标与版权风险，运行态 JS 插件会破坏纯本地零 JS 医疗安全边界。

## Consequences

- 临床工作台在默认主题下保持原版高可读蓝灰体系不变，同时支持全站多空间切换、多主题扩展与零 JS 本地定制。
- 面向临床与科研的复杂交互原语已统一收口至 `@clinmesh/ui/components/*`，自动继承全部主题与暗色 Token，并通过 `pnpm lint:ui-consistency` 与 Playwright E2E（[step35-shell-themes.spec.ts](../../../apps/web/e2e/step35-shell-themes.spec.ts)）持续守护。
- `GET /api/his/v1/patients` 放宽允许空 `query` 以列出工作区合成患者队列，支撑临床科研空间与后续队列筛选场景。
