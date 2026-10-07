# Agent Note: DSH 独立模型设置与持久任务路由

Status: implemented

人工重试沿用旧路由的决定已由[新的人工重试模型决策](../bug-fix/2026-10-07-generation-retry-current-model.md)部分取代；本文继续拥有模型来源、宿主桥接、上下文隔离与内部重试绑定的取舍。

## Problem

ClinMesh Server 与 DSH 分进程运行，原有模型调用读取独立的 OpenAI-compatible 环境配置。共享 DSH Provider 可以减少重复配置，但若从右侧 Session 或浏览器页面读取“当前模型”，切换会话、关闭 Surface 或重启会改变排队任务的来源。Provider 内的 model ID 也可能重名，单独保存 model 字符串不足以恢复任务。

## Decision

模型来源由 Server 启动配置固定为 `openai` 或 `dsh`。DSH 模式通过宿主公开 `llm` 与 `agentDefaultModel` 服务调用，原生通用设置中的独立 `generationModel` volatile 字段由宿主设置服务持久化，并沿用 Profile 设置管理权限及 revision 检查。该选择作用于同一 Profile 下的全部 ClinMesh 模型任务，不依赖右侧 Session。

选择默认模型时，任务解析宿主当时的 Provider、model 与可选 reasoning effort；显式选择同样保存完整路由。患者档案和目录补全在入队前绑定，问诊在首次生成回复时绑定，检验在首次实际模型生成时绑定。`GenerationModelBinding` 按 Workspace 和业务任务键持久化第一次成功解析的路由，重试、结构化输出修复与进程恢复读取同一绑定；后台入队的任务键包含发起人和幂等键，沿用 Command 的 Workspace 幂等范围。Persona 和目录任务表继续保存其绑定模型，结果 provenance 使用可辨识 Provider 的 `dsh:` 路由。确定性计算、精确来源事实与冻结快照复用不解析模型。

桥接接受 HTTP loopback 上带共享 secret 且没有浏览器 Origin 的受限请求，禁止客户端覆盖 URL、headers、Session 或 Tools。宿主仅发送 ClinMesh 业务输入与独立系统提示，不创建医生 Agent 会话记录；模型输出继续通过原有严格 schema 和诊断泄漏检查。请求、响应（包含非成功响应）、超时和卸载取消均有界。DSH 终止分片的 `AUTH`、`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL` 映射为封闭桥接错误 `MODEL_AUTH_FAILED`，Server 转为 `AI_AUTH_FAILED` 并提示检查所选 Provider 的凭据和访问权限；`TIMEOUT` 映射为 `MODEL_TIMEOUT`，Server 转为 `AI_TIMEOUT`，问诊显示模型回复超时；其余失败返回 `MODEL_UNAVAILABLE`。不解析或回传 Provider 原始消息，也不写入日志，避免泄露凭据或私有输入。公开设置描述使用 secret redaction。

## Alternatives considered

- 跟随右侧 Session：需要额外受信会话绑定，且会使患者模拟与医生 Agent 生命周期耦合；不能稳定恢复后台任务。
- 浏览器调用模型并回传结果：标签页关闭后任务无法完成，也会把隐藏生成输入移到岗位浏览器。
- 将 Provider 凭据复制到 ClinMesh：产生第二套凭据与配置管理，无法直接复用 DSH 的认证能力。
- 每次重试重新读取设置：模型修复与人工重试会无声切换来源；改设置应影响新任务，已有任务保留原路由。
- 修改官方 DSH 或维护 fork：公开扩展 API 已能完成设置、持久化与辅助调用，不增加宿主补丁维护面。

## Consequences

独立 Web 默认继续使用 OpenAI-compatible 配置；同一个 Server 即使同时服务 Web 和 DSH 也只有一个启动时选定的模型来源。DSH 失联、Provider 删除或旧任务路由与启动来源不兼容时显式失败，不自动降级或重映射。修复原 Provider 后可重试既有任务；需要新模型时重新发起任务。已保存 Persona Revision 和 Investigation Snapshot 保持不可变。

验证包含真实 HTTP 桥接与 SQLite 的路由、安全和重启回归，检验失败重试与确定性绕过，React 18/19 的中英文、窄窗口、主题和键盘合同，以及使用隔离 Profile、合成 Provider 和真实 DSH CLI 的显式 smoke。模型路由保存在业务持久层，凭据仍只归宿主与进程配置所有。
