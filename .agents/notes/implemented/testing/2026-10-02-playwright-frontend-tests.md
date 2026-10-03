# Agent Note: Playwright 前端浏览器回归

Status: implemented

## Problem

前端浏览器合同同时使用逐例启动 Chrome 的 DOM 导出和手动启动 Playwright；字号、动画和布局验证依赖不同的浏览器发现、时钟和清理机制。日常真实入口验证依赖多次 `agent-browser` 命令，增加操作延迟，也难以直接复用为自动回归。

## Decision

参考 `agentic-axum-saas-demo` 的分层方式，Vitest 保留单元、组件与 adapter 测试；`@playwright/test` 统一拥有浏览器合同和 standalone Web E2E。浏览器合同沿用生产 Vite/Tailwind 构建及 React 18/19 fixtures，真实帧驱动状态等待，worker 复用 Chromium，测试隔离 context/page。配置与实际命令见[测试策略](../../../../docs/testing.md#用户界面验证)。

Web E2E 每 worker 构建一次 Web，每测试创建真实 Hono listener、file-backed SQLite、合成账户和随机凭证；系统分配端口，fixture 完成后关闭 listener/runtime 并删除临时文件。登录、岗位切换和窄屏设置通过页面与正式 HTTP 会话查询验证，不读取开发配置或调用真实 provider。

日常 UI 回归与真实入口验证默认使用 Playwright；`agent-browser` 用于按需探索或接管已有会话。常规自动测试不生成截图、视频或 trace；真实影像仍只允许文字与聚合统计。原生 DSH Session/browser Tool 验收独立保留。

## Alternatives considered

- 保留 Chrome DOM 导出：每次启动独立浏览器，浏览器发现和虚拟时钟会继续干扰动画卸载与布局帧断言。
- 在 Vitest 内逐例手动启动 Playwright：能够运行真实帧，但浏览器生命周期、隔离和筛选需要自行维护，不能使用统一的 runner fixture。
- 把所有组件与状态机测试迁到 E2E：增加构建和浏览器成本，并重复较低层已有矩阵；只迁移浏览器行为，真实入口保留关键旅程。
- 强制每次 UI 验证录屏：会把媒体成本加入普通迭代；用户需要演示时再录制绑定 commit 的 WebM。

## Consequences

`pnpm test` 与 `pnpm check` 包含 Vitest、Playwright 合同和 Web E2E；CI 安装锁定版本对应的 Chromium 与系统依赖。包级 Vitest 不再执行浏览器合同，独立运行方式见测试策略。失败不自动重试；更高并发可由命令显式选择，默认并发限制生产构建的资源争用。

浏览器层只拥有 React 兼容、ShadowRoot、真实布局、渲染与用户入口集成；Command、FHIR、授权拒绝矩阵和门诊闭环由原有 owner 测试持有。生产构建 E2E 不证明已部署的 DSH 宿主原生 Session 正确。
