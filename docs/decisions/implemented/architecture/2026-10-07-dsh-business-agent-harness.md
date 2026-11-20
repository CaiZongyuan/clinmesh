# Agent Note: DSH 业务 Agent Harness、分栏目工具预算与持久模型绑定

Status: implemented

## Problem

DSH 通用开发 preset 带有编码身份与文件系统／Shell 工具，直接用于临床会话会诱导模型绕开页面授权去翻查源码或数据库；同时 DSH browser Tool broker 强制要求单次注册不超过 32 个 Tool，而门诊放射、病理与专病能力持续扩展会使全页平铺注册触顶失败。此外，若让模型显式抄写随 TTL 续签变化的短期 Context ID，或让后台异步模型任务跟随右侧当前聊天会话切换模型，会在生成期间造成高频绑定失配与排队任务路由漂移。

## Decision

在 DSH 宿主 preset、分栏目工具目录、语义版本交接与服务端持久模型路由四层建立业务 Agent Harness，当前合同见[Agent 集成](../../../architecture/agent-integration.md)与[产品内 Agent 能力指南](../../../agent-capabilities.md)：

1. **医院业务专用 Preset 与分栏目／阶段工具发布**：通过 DSH 原生 preset 声明无 Shell／文件读写能力的医院业务助手。`packages/contracts` 统一维护栏目／阶段枚举与 `agentToolsForContext`（支持多栏目 `sections` 精确挂载，跨栏目仅保留病例选择、栏目切换、接诊与完诊等页头工具），Server 签发 `PageContextSnapshot.allowedOperationIds` 与 Surface 注册共用同一收窄函数，确保全岗位、全视图及栏目／阶段注册数严格 `<= 32`，非当前栏目调用在服务端直接以 `AGENT_OPERATION_NOT_ALLOWED` 拒绝。
2. **语义 `pageRevision` 签名与 `tools/post-execute` 目录交接**：模型参数仅绑定 `pageScope` 与表达真实视图及完整草稿引用的语义 `pageRevision`（排除短期 Context ID、TTL 与瞬态加载态；医生当前病例纯查询的免抄写绑定见[医生 Agent 纯查询绑定](2026-10-08-doctor-agent-query-binding.md)）。Host 从真实调用捕获原语义修订，与执行时最新有效 Context ID 一同签名一次性 execution proof 交由 Server 双重核对，既容忍同语义 TTL 续签，又在切换患者或草稿变化后拦截过期写意图。连续工具调用通过结果通道保留与 `tools/post-execute` 钩子等待新页面完整工具集就绪后再进入下一模型回合。
3. **启动固定模型源与任务级持久路由绑定**：Server 启动配置固定模型源为 `openai` 或 `dsh`。DSH 模式在宿主通用设置注册独立于右侧聊天会话的 `generationModel` 字段，首次解析时将完整 `Provider + model + reasoningEffort` 写入按 Workspace 与业务任务键隔离的 `GenerationModelBinding`，使自动重试、结构化修复与重启恢复始终沿用原路由；受共享密钥保护的环回桥接禁止覆盖 URL、请求头或会话工具，并将鉴权失败、超时与不可用映射为封闭错误码（`AI_AUTH_FAILED`、`AI_TIMEOUT`、`MODEL_UNAVAILABLE`），绝不回传或记录上游原始错误正文与凭据。

## Alternatives considered

- **在通用编码 preset 上叠加临床提示词，或继续合并宽泛工具压低总数**：提示词不能建立工具隔离边界；合并工具会不断膨胀单工具 schema 与人工审阅分支。
- **要求模型抄写最新短期 Context ID，或直接用执行时最新 Context 替换旧调用**：前者在 TTL 续签时必然失配，后者丢失原调用面向的页面与草稿版本校验。
- **用固定毫秒睡眠等待工具重注册，或让后台生成任务跟随右侧活动聊天会话模型**：固定延时既慢又不可靠；跟随聊天会话会使关闭面板或切换对话静默改变排队中的患者扮演、检验与病历任务模型。

## Consequences

TTL 续签不再打断长回合工具执行，切换诊疗栏目或患者后旧写意图与未决人工审阅仍立即失效，全站各栏目／阶段工具数受自动化契约测试守卫不超过 32 个。同一 Server 实例只启用单一模型来源配置，Provider 失联或凭据失效时显式报错停止，已落盘的 Persona 修订与检查快照保持不可变。
