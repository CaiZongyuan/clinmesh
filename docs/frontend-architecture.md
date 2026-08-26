# 跨端前端架构

本文是 Web、Desktop 和 Mobile 的代码归属与共享规则参考。系统业务和接口设计见[系统架构](architecture.md)。

首个可验收发布只开发 Web。Desktop 和 Mobile 保留现有包边界与工程壳，不承担门诊闭环、语义 parity 或发布验收；后续进入实际开发时再按本页共享规则接入。

## 目标拓扑

```text
apps/web -----------+
                    +--> packages/views --> packages/core --> packages/contracts
apps/desktop -------+          |
                               v
                         packages/ui

apps/mobile ------------> packages/core (pure entrypoints)
        +---------------> packages/contracts
```

Web 和 Desktop 都运行 DOM/React UI，因此共享视觉 primitives、业务视图、Query hooks 和客户端视图状态。Mobile 使用 React Native，信息密度、导航、生命周期、安全存储和发布节奏不同，只共享协议 schema、类型和纯领域函数。

## 应用职责

### Web

`apps/web` 是 Vite React SPA。它负责浏览器启动、Web 路由、cookie/CSRF 和 Web analytics。开发时将 `/api` 和 `/fhir` 代理到 Node.js 服务。

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
- 首期在 Command 成功后精确失效 Query，并通过聚焦刷新和短间隔轮询同步岗位状态；未来的推送仍只更新 Query cache，不把服务端 payload 镜像进 Zustand。
- 会导航、支付、发药、退费或确认的流程等待服务端成功后再清理本地状态。

## 构建和发布

| 目标 | 构建入口 | 发布节奏 |
| --- | --- | --- |
| Web + Server | `pnpm build` | 单实例 Node.js 构建与持久卷部署 |
| Desktop | `pnpm dev:desktop` / package build | 首期不交付；启用后使用独立安装包版本 |
| Mobile | `pnpm dev:mobile` / Expo build | 首期不开发；启用后使用独立移动版本与 OTA 策略 |
| Docs | `pnpm docs:build` | GitHub Pages workflow |

Root `build/typecheck/test` 默认排除 Mobile；CI 使用单独的 `typecheck:mobile`，避免 Expo/React Native 版本约束污染 Web/Desktop 构建图。

## 禁止的共享方式

- 不让 Mobile 导入 `packages/views` 或 `packages/ui`。
- 不在 `core` 中用 `typeof window` 隐藏平台分支。
- 不建立一个同时抽象 DOM、Electron 和 React Native 的万能 `Platform` 对象。
- 不复制 API response type 后用 TypeScript cast 绕过 schema。
- 不因 Web 与 Mobile 页面名称相同就要求组件树相同。
