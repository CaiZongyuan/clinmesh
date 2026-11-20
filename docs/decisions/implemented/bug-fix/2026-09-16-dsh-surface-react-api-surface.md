# Agent Note: DSH Surface 共享 React 18/19 API 面、ShadowRoot 样式初始值与容器响应式

Status: implemented

## Problem

DSH 宿主页面向插件提供上游锁定的 React 18.3.1 并将 Surface 挂载在 ShadowRoot 分屏容器内，而 standalone Web 与常规 Vitest 环境运行在 workspace 的 React 19.2 下。这带来三类仅在真实宿主显现的兼容性陷阱：在共享组件中使用 `useEffectEvent` 等 React 19 专属 API 会在宿主打开弹窗瞬间触发 `TypeError` 崩溃且服务端零报错日志；共享 `Button`／`Input` 若按 React 19 普通函数写法省略 `forwardRef`，在 React 18 下作为 Base UI 菜单或弹层触发器时会丢失 DOM 引用导致首次定位失败；Chromium 不在 ShadowRoot 内注册 Tailwind `@property` 声明，导致依赖非继承初始值的边框变量为空，同时若分屏变窄时自动切全屏或按整窗视口设断点，会遮挡用户正在使用的宿主侧栏或压扁中间表单。

## Decision

在共享前端代码、Surface 样式构建、分屏响应式与双版本浏览器契约测试四处建立硬约束，整体宿主集成见[DSH 原生 ClinMesh React Surface](../architecture/2026-08-30-dsh-native-clinmesh-surface.md)：

1. **共享 React 18.3.1 / 19.2 交集 API 与显式 `forwardRef`**：`apps/web`、`packages/ui`、`packages/views` 及 `packages/core` 的 React 代码严格限定使用 React 18.3.1 与 19.2 共有 API；“effect 内读取最新回调”统一采用 latest-ref 模式（`useRef` 加无依赖 `useEffect` 同步）替代 `useEffectEvent`，承载 Base UI `render` 组合与焦点恢复的共享 `Button`、`Input` 等基础组件统一通过 `forwardRef` 传递 DOM 引用，不维护 DSH 专属控件副本。
2. **ShadowRoot Tailwind `@property` 初始值自动提取**：Surface 样式构建步骤从实际编译 CSS 的 `@property` 规则中自动提取 `inherits: false` 且带 `initial-value` 的声明，注入 ShadowRoot 内低优先级 `properties` 层的元素与伪元素规则，既保证边框等工具类默认值生效且可被普通 utility 覆盖，又不向宿主全局 `document` 泄漏样式属性或维护手写变量清单。
3. **分屏 `shrink` 策略、手动全屏与容器查询自适应**：Surface 默认采用左右分屏 `shrink` 策略按最小宽度比例分配横向空间，不因右栏展开自动跳全屏或改上下堆叠；手动全屏切换保持同一应用实例挂载以完整保留当前病例与未保存草稿（全屏与导航位置见[DSH 原生 Surface 壳层协同](../architecture/2026-08-30-dsh-native-clinmesh-surface.md)）。业务内部布局统一观测各自所属内容容器宽度与容器查询（Container Queries），不耦合浏览器顶层视口宽度。
4. **React 18/19 双版本 ShadowRoot 浏览器合同矩阵**：通过 `react18`/`react-dom18` 别名与真实 Chromium（显式声明 `<meta charset="utf-8">`）对编译后样式、菜单定位、目录防抖搜索、共享弹窗与容器缩放执行 React 18 与 React 19 双版本回归。

## Alternatives considered

- **私自升级宿主 React 或在插件产物中打入第二份 React 运行时**：前者违背上游锁复现纪律，后者破坏宿主与 Surface 边界的 hooks／Context 共享并被 `verify-artifact.ts` 拦截。
- **仅手写补 `--tw-border-style` 或将全部 `@property` 注册到宿主顶层文档**：手写清单随 Tailwind 升级漂移，写顶层文档则污染宿主原生样式隔离。
- **仅靠 React 19 下的 jsdom 单元测试或窄宽度自动跳全屏**：jsdom/React 19 永远无法捕获 React 18 API 缺失与 ShadowRoot `@property`/ResizeObserver 行为，自动全屏则强行打断用户正在进行的右侧对话。

## Consequences

根 `AGENTS.md` 将 React 18/19 共有 API 面与新增对话框纳入双版本浏览器合同设为常驻红线；仅当未来 `dsh-upstreams.lock.json` 正式将宿主前端升级至 React 19 后，方可重新评估放宽该 API 约束。
