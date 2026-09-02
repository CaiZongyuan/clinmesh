# 跨端前端架构

本文是 Web、Desktop 和 Mobile 的代码归属与共享规则参考。系统业务和接口设计见[系统架构](architecture.md)。

当前可验收发布包含 standalone Web 和复用同一 application interface 的 DSH React Surface。Desktop 和 Mobile 保留现有包边界与工程壳，不承担门诊闭环、语义 parity 或发布验收；后续进入实际开发时再按本页共享规则接入。

## 目标拓扑

```text
apps/dsh-web --> apps/web application/runtime --+
apps/web ----------------------------------------+--> packages/views --> packages/core --> packages/contracts
apps/desktop ------------------------------------+          |
                                                            v
                                                      packages/ui

apps/mobile ------------> packages/core (pure entrypoints)
        +---------------> packages/contracts
```

standalone Web、DSH Surface 和 Desktop 都运行 DOM/React UI，因此共享视觉 primitives、业务视图、Query hooks 和客户端视图状态。当前 DSH adapter 直接复用 `apps/web` application/runtime；Mobile 使用 React Native，信息密度、导航、生命周期、安全存储和发布节奏不同，只共享协议 schema、类型和纯领域函数。

## 应用职责

### Web

`apps/web` 是 Vite React SPA。它负责浏览器启动、Web 路由、cookie/CSRF 和 Web analytics。开发时将 `/api` 和 `/fhir` 代理到 Node.js 服务。

Web application 接受可注入的 API base、Router history、Portal container、appearance root、退出动作和 Surface Agent controller。standalone 默认使用 Browser History、document theme 和默认 API base；平台差异不进入岗位页面或 Command 调用。

### DSH Web

`apps/dsh-web` 是 DSH Host/Client adapter，不拥有医院状态或第二套页面。Host 注册固定 loopback `/clinmesh-api` proxy 与 execution-proof route；Client 把 `apps/web` 挂载为 `dsh-react-surface`，使用 DSH 共享 React runtime、Memory Router、独立 QueryClient 和 ShadowRoot 样式/Portal。

Surface Agent controller 把当前页面注册投影成 DSH Session-scoped browser Tools。Client adapter 订阅 DSH 唯一的 current-session store 与 resolved theme，并把当前 Session ID 和 light/dark 结果作为 Web runtime 输入；切换 Session 会立即撤下旧 Page Context 与 review，ClinMesh `system` 主题随 DSH 变化。Capability availability 由 DSH bridge 拥有；publisher 先发布 registration 以启动冷探测，已 active 的 lease 报告失败状态时替换 Page Context 和 registration，正常 `connecting` 则完成刚发布 registration 的租约切换。完整生命周期见[系统架构](architecture.md#72-page-context)。Detached review 只在 lease 保持 `active` 时有效，离开时立即取消。Page Context、Tool catalog、proposal 和 review contract 位于 `packages/contracts` 与 Server；DSH adapter 不导入 Repository、Workflow 状态机或 Hidden Fact。默认布局是 `workspace`，Surface 小于 `1024px` 时由 runtime 退化到 `full-frame`；Web root 受宿主高度约束，业务 panel 独立纵向滚动，隐藏时 keep-alive 保留客户端草稿。

DSH Client artifact 是一个 lazy-CJS 文件，React、ReactDOM 和 Surface runtime 保持 external，不生成动态 chunk 或第二份 React。`vendor/dsh-react-surface` 以 submodule 固定；pnpm 仍拥有 workspace 并通过 tsx 生成样式，Bun 只执行上游 Surface builder 和 artifact verifier。

### Server

`apps/server` 的首期目标是运行于 Node.js 的 Hono 后端应用。它负责 HTTP/FHIR adapter、鉴权、Command 调用、SQLite adapter 和可部署构建中的 Web 静态资源 fallback。浏览器与服务端保持同源；具体运行和持久化约束由[Web Demo 运行与部署架构](demo-architecture.md)拥有。

### Desktop

`apps/desktop` 是 Electron 壳。main/preload 只提供桌面能力和安全 IPC；renderer 使用 `packages/views`。Renderer 不直接获得 Node 权限，`contextIsolation` 和 sandbox 保持启用。

路由、系统通知、文件选择、自动更新和本地安全存储通过 Desktop adapter 注入共享视图。平台逻辑不得进入 `packages/views`。

### Mobile

`apps/mobile` 是 Expo / React Native 应用。它拥有 Expo Router、原生 UI、SecureStore、移动 QueryClient、AppState/NetInfo 生命周期和独立发布流程。

移动端必须与 Web/Desktop 保持以下语义一致：

- FHIR logical id、业务 identifier 和资源引用。
- 权限、可见性、状态枚举与状态转换。
- 列表过滤、计数、去重、分页和 unknown enum fallback。
- Command 的幂等、预期版本、审批和错误分类。

Mobile 可以在布局和交互上不同。桌面医生工作站的多栏高密度界面不能直接缩放到手机；移动查房应使用原生导航、短任务和逐层详情。

## 共享包

### contracts

`packages/contracts` 是所有运行时共享的 wire 定义：Zod schema、DTO、FHIR 辅助类型、错误码和工具参数。网络和持久化输入先由这里的 schema 校验。

不得放入 React hook、fetch 实现、DOM 类型或平台配置。

### core

`packages/core` 保存无平台领域函数、状态转换、query key 规则和 API client 基础。代码不能读取 DOM、`localStorage`、Electron、React Native 或 `process.env`。

为 Mobile 暴露的运行时入口必须保持纯函数或显式依赖注入。Web/Desktop 专用 React hooks 应拆到独立入口，不能让 Mobile bundle 拉入 DOM 依赖。

### ui

`packages/ui` 保存 Web/Desktop 视觉 primitives、语义 token 和通用可访问性模式。它不导入 `core`，也不出现 Patient、Encounter、Medication 等业务概念。

组件通过 shadcn CLI 作为源码加入本包，优先使用现有 variant 和语义颜色。Mobile 使用原生或 React Native primitives，不导入这个包。

Web/Desktop 的尺寸、主题、组件组合与真实目录由[临床 UI 设计合同](ui/design.md)统一说明。

### views

`packages/views` 保存 Web/Desktop 共享业务页面和组合组件。它可依赖 `core + ui`，但不得导入 Vite、Electron、Expo、Next.js 或具体路由库。

平台动作通过小 interface 注入，例如：

```ts
interface NavigationAdapter {
  navigate(path: string): void
  replace(path: string): void
}
```

只有 Web 与 Desktop 两个实际 adapter 同时存在时，interface 才成为公共 seam；单平台能力先保留在 app 内。

## 状态所有权

- TanStack Query 是服务端状态唯一客户端缓存。
- Zustand 只保存筛选、工作台布局、未提交草稿、弹窗和临时选择。
- 当前 Patient/Encounter context 由路由或服务端 Actor context binding 驱动，store 只能镜像平台 plumbing 所需的稳定标识。
- DSH Page Context 是短期授权快照，不进入 TanStack Query 或 Zustand；DSH Session、页面 scope、selection 或资源版本变化会替换 lease，其他可见页面状态只重新签发 context，二者都不成为医院状态 owner。
- 首期在 Command 成功后精确失效 Query，并通过聚焦刷新和短间隔轮询同步岗位状态；未来的推送仍只更新 Query cache，不把服务端 payload 镜像进 Zustand。
- 会导航、支付、发药、退费或确认的流程等待服务端成功后再清理本地状态。

## 构建和发布

| 目标 | 构建入口 | 发布节奏 |
| --- | --- | --- |
| Web + Server | `pnpm build` | 单实例 Node.js 构建与持久卷部署 |
| DSH Web adapter | `pnpm --filter @clinmesh/dsh-web build` | 随固定 DSH Web Profile 安装；需要 Bun `1.4.0` 构建 artifact |
| Desktop | `pnpm dev:desktop` / package build | 首期不交付；启用后使用独立安装包版本 |
| Mobile | `pnpm dev:mobile` / Expo build | 首期不开发；启用后使用独立移动版本与 OTA 策略 |
| Docs | `pnpm docs:build` | GitHub Pages workflow |

Root `build/typecheck/test` 默认排除 Mobile，并包含 DSH Web adapter；CI 递归 checkout submodule 并固定 Bun。Mobile 使用单独的 `typecheck:mobile`，避免 Expo/React Native 版本约束污染 Web/Desktop 构建图。

## 禁止的共享方式

- 不让 Mobile 导入 `packages/views` 或 `packages/ui`。
- 不在 `core` 中用 `typeof window` 隐藏平台分支。
- 不建立一个同时抽象 DOM、Electron 和 React Native 的万能 `Platform` 对象。
- 不复制 API response type 后用 TypeScript cast 绕过 schema。
- 不让 DSH Host、Tool 或 Surface 直接读取 DOM、Query cache、浏览器存储、Repository、Hidden Fact 或 Scenario authoring truth。
- 不为 Surface 建立第二份 transcript、Query cache owner 或 Command 状态机。
- 不因 Web 与 Mobile 页面名称相同就要求组件树相同。
