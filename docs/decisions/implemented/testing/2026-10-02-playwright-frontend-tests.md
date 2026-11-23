# Agent Note: Playwright 前端浏览器合同、有限动画稳定采样、原生组合验收与 CI 失败注释

Status: implemented

## Problem

前端测试若混用逐例冷启动 Chrome DOM 导出、Vitest 内手工拉起浏览器与高频 `agent-browser` 命令行交互，会导致浏览器发现、时钟控制与环境清理碎片化；若将约 22–30 秒的生产 Vite 冷构建塞进单条用例超时预算，或让构建期的 `NODE_ENV=production` 污染同一 worker 内的服务端 Better Auth 注册限流，会制造与顺序偶发相关的假失败；同时，主题、字号与宿主分栏切换会触发有限 CSS／Web Animations 过渡，仅等待两帧 `requestAnimationFrame` 会采到插值中间态，而简单 `Promise.all(finished)` 又会把合法取消并重开的替代动画误判为异常；此外 CI 日志下载受阻时纯控制台 `list` 输出无法直接在 GitHub Check 上定位失败断言，跨前后端与 DSH 宿主的自动记录链路也需要可复用的非付费确定性组合旅程。

## Decision

由 `@playwright/test` 统一承载 React 18/19 ShadowRoot 浏览器合同与 standalone Web E2E，并配套构建预算隔离、有限动画收敛采样、CI 双报告器与原生宿主共享旅程，详细命令与分层规范见[测试策略](../../../testing.md)与[部署指南](../../../deployment.md)：

1. **构建与交互预算分离及宿主环境隔离**：Vitest 负责纯函数、组件与适配器单测；Playwright 按 React 版本分组在 `beforeAll` 复用编译产物，Web E2E 每 worker 执行一次独立 120 秒预算的生产构建（构建期间临时切换环境并在 `finally` 恢复 `test`，阻断 `production` 污染 Better Auth 合成账号初始化），单条交互用例保留紧凑的 30 秒／60 秒预算与 10 秒单动作上限，每例独占隔离 `BrowserContext`、随机端口 Hono 实例与临时文件 SQLite。Agent 柔光保持与淡出测试采用可控步进 `Date` 逻辑时钟配合真实渲染帧，消除调度抖动且不篡改产品动效时长。
2. **字号与有限动画最终态等待边界**：涉及几何矩形、滚动或同排对齐断言的测试（如外观矩阵、手术与护士集中办理旅程）在采样前先经过真实渲染帧，循环读取目标子树尚未结束的有限动画（排除无限旋转加载指示器），等待其完成或取消后再重读以覆盖取消瞬间派生的替代动画，并等待 `transition-all` 标签实际计算字号稳定后再触发真实指针点击，绝不靠放宽像素容差、插入固定 `sleep` 或关闭产品动画迁就测试。
3. **共享组合旅程与隔离 DSH 原生 Smoke**：抽取跨宿主共享可见旅程串联直接记录、刷新恢复、局部手改保护、暂停补录与签署准备冻结，既在生产 Web E2E 中运行，又在锁定 DSH 的隔离 Profile 原生 smoke 中注入合成 `LlmAdapter` 验证真实 Session、`PageContext` lease、草稿 action 与 `.propose` 人工批准到 `CommandReceipt`／`AuditEvent`／`ActionTrace` 的全链贯通（`--live` 实模样本仅在获当次显式许可时独立运行，绝不进入常规 CI）。
4. **CI `list` + `github` 双报告器**：CI 环境同时启用 Playwright 内置 `list` 与 `github` reporter（本地保持 `list`），在不改变零自动重试与超时门禁的前提下将失败文件、行号与断言直接发布为 GitHub Check 注释。

## Alternatives considered

- **把全部状态机与权限拒绝矩阵搬进 Playwright E2E，或每次迭代强制生成录屏／截图**：徒增构建与浏览器耗时；常规自动回归不落盘媒体，真实影像与切片遵循零像素读取红线仅校验文字快照与像素聚合统计。
- **调大交互用例总超时包纳冷构建，或用一次 `Promise.allSettled` 等待旧动画**：前者掩盖真正的交互卡死，后者漏掉旧动画取消后新启动的替代过渡动画。
- **自行编写日志解析脚本发 GitHub 注释，或把付费真实模型接入 CI**：内置 `github` reporter 已原生支持精确注释，付费实模则会引入外网波动、密钥暴露与非确定性输出。

## Consequences

`pnpm test` 与 `pnpm check` 在无需外部模型密钥的前提下稳定覆盖双版本 React、ShadowRoot 门户、容器响应式与端到端持久化恢复；CI 检查页面可直接阅读浏览器失败定位，原生 DSH 宿主升级则通过隔离 smoke 提供真实桥接证据。
