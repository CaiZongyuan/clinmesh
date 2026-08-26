# Agent Note: 真实组件拥有临床 UI 合同

Status: implemented

## Problem

ClinMesh 的 Web/Desktop 需要稳定的高信息密度视觉合同，但静态页面或复制的组件示例不能证明生产 primitive 的尺寸、状态、主题和可访问行为。设计说明、运行时 token 和业务页面若分别维护同一套数值，也会让 204px 侧栏、54px 顶栏、13px 正文、语义色和低圆角逐步漂移。本决策由 [issue 33](https://github.com/CaiZongyuan/clinmesh/issues/33) 交付。

## Decision

`packages/ui/src/styles.css` 拥有 Web/Desktop 的语义 token，`packages/ui/src/components` 拥有共享视觉 primitive，`docs/ui/design.md` 解释稳定的人机合同。Web 工作台组合这些入口，不复制颜色、状态机或 primitive 样式；Mobile 继续使用独立 React Native UI。

Web 提供无需登录的 `/components` 路由。该路由不请求应用 API，直接静态导入真实 `@clinmesh/ui/components/*`，并通过三个可键盘操作的 Tabs 展示尺寸、variant、disabled、focus、loading、error、临床表格、语义状态、AlertDialog、Toast、亮暗主题、长中文和固定提交区。页面不成为第二个组件注册表，也不复制 shadcn 示例源码。

`packages/ui` 运行自身的可访问性测试，固定 Spinner 的 status 名称、Tabs 的键盘激活和 AlertDialog 的命名及焦点恢复。Web 测试从 `/components` 公共路由验证零网络访问和目录交互。设计文档通过 `apps/docs/docs.ts` 投影到文档站。

## Alternatives considered

**复制一套静态组件展示 markup。** 页面搭建更快，但不会随真实 primitive、variant 和可访问行为变化，视觉验收会给出错误证据。

**引入独立 Storybook 或第二套组件注册系统。** 它能提供更完整的展示工具，但会增加构建、主题和发布入口；当前真实路由与包级测试已经覆盖临床交付所需状态。

**把组件目录放在登录后的工作台。** 这可复用应用壳，却会让设计检查依赖 Server、合成账户和业务数据，也难以区分组件错误与会话错误。

**在文档中复制全部 token 数值。** 文档查询方便，但会产生第二个运行时 owner。文档只固定稳定的人机约束，精确色值和主题映射由 CSS 变量拥有。

## Consequences

组件目录可以在 Server 不可用时独立验收，主题切换仍写入 Web 的现有偏好键。共享 primitive 的可访问行为在包级失败，路由、组合和主题持久化在 Web 级失败，测试责任不依赖组件内部实现。

修改共享密度、语义 token、关键 variant 或目录覆盖面时，需要同步检查真实业务消费者、`/components` 和设计合同。目录只覆盖需要人工比较的临床通用组合；包导出仍由源码和 package manifest 表达，业务能力仍由工作台与服务端接口拥有。
