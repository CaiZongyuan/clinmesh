# Agent Note: 问诊自动记录的组合与原生验收

Status: implemented

## Problem

[自动记录规格](../../../../docs/spec/2026-10-08-consultation-auto-record.md)跨越后台任务、病历编辑、来源审阅和签署准备。各切片的 HTTP/SQLite 与 React 合同能证明局部行为，但不能证明同一患者连续操作后仍保持编辑归属，也不能证明实际 DSH Session 注册并执行 browser Tool。真实模型的非确定输出又不适合作为 CI 故障恢复和签署竞态的输入。

## Decision

共享可见旅程 `apps/web/e2e/consultation-recording-journey.ts` 只拥有组合交互：同一合成患者经历来源查看、局部人工修改、未保存编辑、撤销、更正冲突、暂停补录、失败重试和签署冻结。Web E2E 使用真实生产构建、Hono listener、file-backed SQLite 与公开病例 Query，仅替换外部模型边界。受控在途提取必须真正启动后才准备签署，并等待任务结算后检查草稿不变；取消后检查补录，人工确认后重新读取不可变文书。

显式原生 smoke 复用同一旅程，在锁定 DSH 的隔离 Profile 中注册合成宿主 `LlmAdapter`。辅助调用不携带 Session/Tool；原生主会话独立建立 Session，实际请求当前工具 schema 并调用草稿 action 和签署 proposal。刷新通过 launcher 重新打开 Surface，发工具前等待当前浏览器客户端 lease 注册成功。模型桥接与 Agent Page Context 桥接分别配置，不能用自动记录成功或页面控件启用推断工具已注册。

草稿 action 的工具结果保存 Command 回执，验收从该回执关联 request、audit 和 trace，并用 Query 核对实际草稿。人工批准 proposal 的服务端验证链独立检查 Tool call、proposal、review decision、Command receipt、audit 和 Action Trace；正式签署前必须看到零份已签文书及未确认按钮禁用。两种链路沿用既有授权合同，不要求草稿动作伪装成人工批准 proposal。

`--live` 在上述旅程后创建新合成病例，使用显式配置的真实宿主模型生成患者回答和病史增量，断言已写入及 quote 逐字属于患者原回答。报告绑定源码 commit 和关键文件 SHA-256，记录锁定组件、数量及关联 ID，不保存 prompt、模型响应正文或凭据。部署步骤由[部署教程](../../../../docs/deployment.md#问诊自动记录原生验收)拥有。

## Alternatives considered

- 只运行组件或 standalone Web：无法发现实际宿主的 Session、Page Context、lease 与 Tool 装配问题。
- 为 Web 和原生分别维护旅程：相同可见验收容易漂移；共享步骤并注入刷新和原生工具入口即可覆盖平台差异。
- 真实模型进入完整 CI 矩阵：依赖密钥、外网与调用成本，也不能稳定生成超时、更正和签署在途竞态。
- 合成宿主替身代表真实模型质量：它只能验证真实桥接和工具路由；结构合法及引用存在不能证明医学语义正确。

## Consequences

常规 CI 不需要模型密钥或付费调用，HTTP owner 保留非法输出、隔离、重启和乱序等完整业务矩阵。原生 smoke 使用真实宿主但受控模型；live smoke 只提供有限成功样本的模型网络证据，两者均不代替医学质量评估。React 18/19 与 ShadowRoot 浏览器合同继续约束共享 API 和对话框。临时 Profile 和数据库自动清理，持久摘要只包含可公开的合成元数据。
