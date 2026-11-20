# Agent Note: Operation Catalog 驱动的 Agent 原生 HIS CLI 与运行时错误关联

Status: implemented

## Problem

ClinMesh 的多岗位 HIS 与 FHIR 接口若由调用方手工拼接 HTTP 路径、Better Auth Cookie、幂等头和预期版本，或机械包装路由生成 CLI 与技能文档，极易出现服务端授权、CLI 参数与运行时指引三处漂移，并诱发通用 HTTP、FHIR Bundle 或 SQL 逃生口。同时，未知服务端异常、客户端网络／协议超时与渲染崩溃若缺少不暴露敏感原文的统一关联标识和明确未知结果边界，会使人类页面与 Agent CLI 无法安全对账恢复。

## Decision

以单一声明式目录统合 CLI 操作面、短期单岗位授权与跨层错误恢复，详细合同见[Agent 集成](../../../architecture/agent-integration.md)与[安全与可靠性](../../../architecture/security-and-reliability.md)：

1. **`hisOperationCatalog` 单一操作面与 `clinmesh` CLI**：`packages/contracts` 导出的 `hisOperationCatalog` 唯一定义直接 HIS 操作的稳定 ID、版本、`cliPath`、输入／输出／错误 schema、HTTP 映射、岗位风险、幂等与版本前置要求；CLI 命令树、离线 discovery、服务端 Agent 路由匹配、Grant 目录哈希与根 `skills/clinmesh-*` 示例漂移测试共享同一投影（历史回执使用不同内部名称时经 `commandOperationAliases` 兼容映射，DSH 页面工具则由独立的 `agentToolCatalog` 管理）。
2. **双模式身份与单岗位短期 `Agent Capability Grant`**：`apps/cli` 在 Human 模式使用本地认证会话并对高风险写入要求 `--yes`；Agent 模式仅接受运行器注入的短期 `cma_` 令牌，绝不回退人类配置。管理员在显式选定 administrator 行动岗位后，通过受审计 Command 为非人类 `Agent Client` 签发绑定单一 Workspace、Epoch、Scenario Run、单一 `PractitionerRole`、操作白名单与目录哈希的 Grant（原令牌仅返回一次，数据库只存 SHA-256，任一上下文或版本变化即失效）。CLI 拒绝提供任意 URL、method/path/body、SQL、JSON Patch 或 FHIR 写入口。
3. **服务端生成 `correlationId` 与脱敏异常报告**：Server 为每个请求独立生成 UUID 并通过 `X-Correlation-Id`（及 HIS JSON `error.correlationId`）返回，不信任客户端传入的同名请求头；FHIR 保持标准 R5 `OperationOutcome`。未知 HTTP 异常与后台 outbox 派发异常统一由受控 runtime reporter 向结构化 stderr 记录 `correlationId`、HTTP 方法、路由模板与有限错误类别，绝不向响应或日志输出原始异常消息、堆栈、请求正文或凭证。
4. **客户端错误归一化与未知写结果对账**：Web HTTP 适配器以 30 秒总期限覆盖请求与响应体读取，将超时、断网、取消、非 JSON 与 schema 失配统一转为受控 `ApiClientError`，根 Error Boundary 提供本地化子树重挂恢复。CLI 与 Web 对写入 `5xx`、断连或响应丢失一律保持 `ambiguous` 语义、禁止自动换键重试，调用方必须按原 Actor、原岗位与原幂等键查询 `command.receipt.get` 对账。

## Alternatives considered

- **为每个 HTTP 路由手写 CLI 子命令或提供通用 HTTP／FHIR Bundle 写工具**：前者制造多份易漂移的权限与参数定义，后者将资源编排和越权组合交给模型，破坏窄命令审计边界。
- **允许 Agent 复用长期人类会话或跨岗位多角色令牌**：使单次任务意外继承宽泛权限或自行切换医院责任岗位。
- **直接信任客户端 `X-Request-Id` 或在错误响应／日志中透传原始异常栈**：允许伪造日志关联，并可能把患者文本、查询参数或外部 Provider 密钥写入响应与标准错误流。
- **对所有超时和 `5xx` 统一自动重试**：读请求虽可重试，但写请求可能已在服务端提交，自动重发会破坏未知结果对账纪律。

## Consequences

任何 Agent 可见操作的路径、schema 或错误恢复语义变更，均在同一提交内由目录版本、服务端路由覆盖检查与 `clinmesh-*` Skill 漂移测试同步约束。调用方凭 `correlationId` 即可在不暴露业务正文的前提下关联服务端故障日志；HTTP `correlationId`、Command `requestId` 与 outbox `correlationId` 保持各自职责，不冒充分布式全链路追踪系统。
