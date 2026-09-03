# Agent Note: 运行时错误关联与客户端恢复

Status: implemented

## Problem

[Issue #75](https://github.com/CaiZongyuan/clinmesh/issues/75) 要求补齐已知业务错误之外的运行时失败。未知 Hono 异常曾退化为 `text/plain` 500，Web 会直接抛出 fetch、JSON 或 Zod 原生异常，渲染异常则可能留下空白应用；后台 dispatch loop 只记录固定文本。调用方无法稳定分类这些失败，也没有一个不暴露异常原文的请求标识把响应与 Server 日志关联。

## Decision

Server 为每个 HTTP 请求生成新的 UUID correlation ID，不信任或复用客户端同名 header。所有响应通过 `X-Correlation-Id` 返回该值；HIS JSON 错误还在 `error.correlationId` 返回可选字段，以兼容未升级的 Server。FHIR 保持标准 R5 `OperationOutcome`，不增加本地 extension。未知 HIS 与 FHIR 异常分别返回固定通用诊断和正确 media type，原始异常 message、请求正文、查询内容与认证信息不进入响应。

未知 HTTP 异常与后台 dispatch failure 通过同一 runtime reporter 写入结构化 stderr。reporter 只接受受控 scope 和元数据，记录 correlation ID、HTTP method、匹配 route template 与内建错误类别；任意错误名统一为 `UnknownError`，实际 path、message 和 stack 均不记录。已知认证、授权、validation 和业务 conflict 不重复记为未知运行异常。

Web HTTP adapter 的 30 秒期限覆盖 fetch 和完整响应体读取，并与调用方 `AbortSignal` 组合。network、timeout、caller cancellation、非 JSON 与 schema mismatch 统一转换为 `ApiClientError`，岗位 UI 只映射受控 code/conflict。根 Error Boundary 捕获 React 渲染异常，显示当前语言的恢复界面并在用户重试时重新挂载应用子树。CLI 保留有效的服务端 correlation ID，但写入 5xx、响应丢失和非法响应仍维持 ambiguous outcome，不自动重试。

## Alternatives considered

**复用客户端提供的 request ID。** 这便于调用方指定追踪值，却允许未信任输入伪造或污染 Server 日志关联，因此 correlation ID 只由 Server 生成。

**在错误响应和日志中保留原始 message 或 stack。** 诊断信息更多，但异常可能包含患者内容、查询值、凭证或外部 provider 文本；响应使用固定诊断，日志只保留受控字段和有限错误类别。

**由每个岗位页面分别处理网络和协议错误。** 这会复制分类、超时和本地化逻辑；错误归一化集中在 Web HTTP adapter，页面只消费稳定错误 interface。

**自动重试所有超时和 5xx。** 读取可能受益，但写请求可能已经提交；统一自动重试会破坏 ambiguous recovery 和幂等意图，因此本次不增加自动重试。

## Consequences

调用方可以用 correlation ID 报告一次失败，Server 可以在不记录请求内容的前提下定位对应 runtime error。旧 Server 或第三方响应不提供该字段时，Web 与 CLI 仍按既有错误合同工作。30 秒期限会结束慢响应，调用方取消与超时保持不同 code；Error Boundary 重试会丢弃未持久化的 React 子树状态，已由 TanStack Query 或 Server 持有的状态不被复制。

该机制不是分布式 tracing、成功请求日志或 metrics exporter，也不提供日志持久化、检索和告警。Command `requestId`、outbox correlation ID 与 HTTP correlation ID 仍是不同 owner，不能互相替代。
