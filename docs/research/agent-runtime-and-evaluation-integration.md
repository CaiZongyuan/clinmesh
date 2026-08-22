# Agent 运行时与评测融合研究

## 范围与结论

- 状态：未来设计输入，不定义 ClinMesh 当前已实现行为。
- 核验日期：2026 年 8 月 22 日。
- 核验范围：`references/HealthAgentBench`、`references/deepseek-harness`、`references/docs/Hospital_Agent_Platform_Design_v0.1.md`、`references/docs/Hospital_Agent_Platform_Unified_Design_v0.2.md`，以及 ClinMesh 的[系统架构](../architecture.md)、[领域词汇](../../CONTEXT.md)、[虚拟患者与病例创作系统研究](./virtual-patient-and-case-authoring-systems.md)和[嵌入式 HIS 助手融合研究](./embedded-his-assistant-integration.md)。

Agent 不应进入首期产品切片。首期仍应先完成可由人类医生操作的门诊闭环、不可变 Scenario、Hidden Fact 隔离、类型化结果模拟和追加式 ActionTrace；这些能力既是未来 Agent 的环境，也是评测可信度的前提。没有稳定的人类业务闭环时接入 Agent，只能证明模型能调用临时接口，不能证明它在模拟真实 HIS。

未来接入时，DeepSeek Harness（DSH）适合承担模型会话、工具执行管线和可组合运行时，不适合拥有医院状态、身份权限、病例真值或最终评测。本文后续的 Agent Run、独立 Runner 和 evaluator 只适用于嵌入式助手稳定后的显式自主任务与 benchmark，不是首个产品 Agent 的主链；侧栏助手的 Session、页面上下文、权限授予和人工复核由[嵌入式 HIS 助手融合研究](./embedded-his-assistant-integration.md)单独讨论。自主 Agent 对医院的读写仍只能通过 ClinMesh 自定义 Cordis 工具适配器进入现有 Query 或 CommandExecutor。

运行结束与临床成功必须是两个不同结论。DSH 高层 SDK 的一次 `run()` 是从 prompt 入队 receipt 到整个 Agent 再次 `idle` 的活动区间，返回值没有 prompt 级状态或因果归属；因此 `AgentRun.runtimeOutcome = completed` 只表示运行时正常回到 idle，不表示诊断正确、流程完成或安全规则满足。[独立 evaluator](#独立评测平面)必须根据 Hidden Fact、最终 HIS 状态和 ActionTrace 另行判断。

## 固定版本与证据边界

| 输入 | 固定版本 | 许可与证据用途 |
| --- | --- | --- |
| HealthAgentBench | commit [`ce89def2edf56f4a2ef068f37c8544bff944d5fc`][hab-tree] | MIT；核验任务组织、Harbor 生命周期、隐藏 verifier 和指标实现，不把终端文件任务当作 ClinMesh 业务内核 |
| DeepSeek Harness | tag `dsh-v0.1.1-rc.2`，commit [`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`][dsh-tree] | MIT；核验 TypeScript SDK、JSON-RPC、Cordis tools、session、telemetry、DeepSeek adapter 和 ACP 的实际合同 |
| 用户平台草稿 | 上述 `references/docs/` 两份文件 | 作为产品概念输入；不视为仓库当前规范，也不建立公开文档链接 |
| ClinMesh 文档 | 当前工作区版本 | 当前术语、所有权、安全和业务边界的优先事实来源 |

[HealthAgentBench README][hab-readme]列出 54 个任务和 7 类任务，并说明统一目录为 `task.toml + instruction.md + environment/ + tests/`；其依赖固定为 `harbor==0.8.0`。[DSH SDK client][dsh-sdk-client]则明确自身通过 stdio JSON-RPC 驱动子进程，[仓库根配置][dsh-package]要求 Node `^22.19.0 || >=24.0.0`。[两者][hab-license]均为[MIT 许可][dsh-license]，但许可允许复用不等于架构适合直接嵌入。

## 采用与排除

| 机制 | 决策 | 原因 |
| --- | --- | --- |
| DSH TypeScript SDK 子进程边界 | 采用，固定版本 | 进程生命周期清晰，ClinMesh 无须把 Harness 内部包图嵌入业务进程；SDK 协议面只有少量方法，便于做兼容检查 |
| 每个 Agent Run 一个 DSH 进程 | 自主任务首个 spike 采用 | 可把取消、超时、凭据和临时日志的边界绑定到一次 attempt，并避免跨 Run 上下文污染；不决定交互式助手的进程策略 |
| ClinMesh 自定义 Cordis tool adapter | 采用 | 原生 `ToolExecution` 带只读 `callId`，可把模型工具调用与受信请求头、Command 和 ActionTrace 串联 |
| DSH 现成 MCP bridge | 仅作未来兼容层 | `tools/call` 只转发 `name` 和 `arguments`，没有转发 Harness `callId`，不足以单独满足临床审计关联 |
| DSH ACP server | 首版排除 | ACP 有版本协商、取消和 permission request，但只支持 fresh session、一个 connection 拥有全部 session 生命周期，且首版不需要交互式 steering 或外部审批 |
| shell、filesystem、web、code runtime、subagent | 自主临床 profile 禁用 | 受控临床任务不需要通用计算机权限；这些能力扩大数据泄漏、越权和不可重放表面 |
| 项目 skill 或用户 skill 自动发现 | 临床 profile 禁用 | Skill 内容必须由 Runtime Profile 固定，不能从工作区或用户目录注入不受版本约束的指令 |
| HealthAgentBench 的 task/verifier 分离 | 吸收 | 模型可见任务与 verifier-only 真值隔离，并将二进制结果和丰富诊断指标分开 |
| Harbor 作为 canonical runtime | 排除 | 它围绕终端、文件提交和容器 verifier 组织；ClinMesh 的权威结果是服务端医院状态和 ActionTrace |
| Harbor export adapter | 不采用 | 当前没有兼容 Harbor 的产品需求；其 terminal/file submission 模型不应进入 ClinMesh 路线或反向决定 Scenario、Agent Run 与 evaluator |

## 自主评测三平面边界

```text
ClinMesh 控制平面
Scenario / Agent Task / Runtime Profile / Agent Run
              |
              | 受信启动声明 + 短期 capability token
              v
独立执行平面
Node/container Runner -> 每个 Agent Run 一个 DSH 进程
              |
              | ClinMesh Cordis Tool Adapter
              v
Agent Tool Gateway -> Query / CommandExecutor -> 医院权威状态

独立评测平面
evaluator-only 凭据 -> Hidden Fact + final state + ActionTrace
                    -> Evaluation Result
```

控制平面负责选择并冻结运行输入，Runner 负责执行和回收进程，DSH 负责模型循环，Tool Gateway 负责把每次调用约束到医院业务能力，evaluator 负责判断结果。任何一层都不能通过“同一进程里方便访问”绕过边界。

DSH 不应嵌入 Cloudflare Worker。TypeScript client 直接使用 `node:child_process.spawn`，DSH 又有明确的 Node 版本要求；Runner 因而是独立 Node 服务或容器工作负载，而不是 Worker 内的库调用。[ClinMesh 系统架构](../architecture.md#31-模块化单体)仍拥有医院模块化单体，Runner 只是其受限外部消费者。

### 所有权

| 所有者 | 长期拥有 | 明确不拥有 |
| --- | --- | --- |
| ClinMesh | Workspace/Epoch、Scenario、Hidden Fact、Actor、授权、FHIR R5 与领域状态、Command、Effect、ActionTrace、Agent Run、Evaluation Result | 模型内部上下文、reasoning、Harness 插件内部状态 |
| Runner | 进程调度、资源限制、网络策略、临时目录、启动和回收、运行时通知采集 | 医院业务规则、身份推断、评分规则 |
| DSH | 一次 Run 的模型会话、系统 prompt、工具 schema、tool pipeline、临时 session log | 病例真值、最终授权、医院写模型、长期审计、评分结论 |
| evaluator | 私有评测输入、指标计算、判定和 evaluator 自身版本 | Agent 凭据、交互控制、医院状态修改 |

## 自主运行的五个分离对象

以下对象用于显式自主任务和可比较的 benchmark attempt。普通侧栏消息只形成 `AssistantThread -> AssistantTurn -> DSH Turn -> DSH Step`，不会创建 Agent Run、Agent Task 或 Evaluation Spec。

### Scenario

Scenario 固定不可变医院世界、初始事实、Hidden Fact、外部系统模拟规则、允许的角色和动作范围。它不内嵌模型 prompt、provider、具体工具 composition 或 Evaluation Spec，也不反向引用某一套评分；否则同一病例无法独立支持不同任务和评测。[现有领域词汇](../../CONTEXT.md#仿真环境)目前把“评测规则”列为 Scenario 内容，若采用这里的分离模型，正式设计应把该项改为评测所需的私有场景事实与兼容信息，具体规则由 Evaluation Spec 单向引用 Scenario。

### Agent Task

Agent Task 只包含模型可见的目标、扮演角色、患者与 Encounter 上下文、可见背景和完成定义。它不包含 Hidden Fact、评测阈值、evaluator 凭据、模型配置或授权 token。相同 Scenario 可以关联多个 Task，例如“完成首诊”和“复核既有处方”，而不复制医院真值。

### Runtime Profile

Runtime Profile 固定 DSH commit 或发行版本、Cordis composition、provider/model、persona、受控 skills、工具目录、并发规则和资源预算默认值。工具是否存在是 runtime 能力，当前 Run 能否调用则由有效 capability manifest 再收窄；Profile 不能授予超出 Actor 与 Scenario 的权限。

### Agent Run

Agent Run 是一次不可重写的 attempt 记录，绑定 `scenarioRunId`、Agent Task、Runtime Profile、Actor、Patient、Encounter、Workspace/Epoch、有效 capability manifest、全部输入版本、Runner 版本、DSH `sessionId` 和生命周期结果。它记录外部可验证的动作与引用，不保存模型内部 plan、decision 或 chain-of-thought。

一次重试必须创建新的 `agentRunId`，不能覆盖原 Run。相同 Scenario Run 是否允许再次尝试属于控制平面策略；即使允许，也要明确从 checkpoint 重置、从当前医院状态继续，还是创建新 Epoch，不能由 Runner 猜测。

可比较的 benchmark attempt 默认各自创建新的 Scenario Run 和 Epoch。沿用已变更医院状态的继续运行、从 DSH session 恢复和同一 Run 内 steering 都是不同实验条件，不进入首版。

### Evaluation Spec

Evaluation Spec 是 evaluator-only 的版本化合同，单向引用兼容的 Scenario 与 Agent Task 版本，并包含私有输入引用、必须发生和禁止发生的行为、安全规则、指标、阈值、判定算法与 evaluator 版本。同一 Scenario 可以有多套 Evaluation Spec。它只读 Hidden Fact、最终 canonical state 和 ActionTrace，不从 DSH reasoning 推断“模型本来想做什么”。每次 Evaluation Result 绑定一个 Agent Run、一个 Evaluation Spec、实际 evaluator code/image digest 和全部输入 hash；重新评测产生新结果，不覆盖原结果。

### 必须固定的版本

| 维度 | Agent Run 中的固定值 |
| --- | --- |
| 医院世界 | Scenario id/version/hash、Scenario Run、Workspace/Epoch、虚拟时间起点、seed |
| 任务 | Agent Task id/version/hash、模型可见输入 hash |
| 运行时 | Runtime Profile id/version/hash、DSH commit/package versions、Runner image digest、Cordis composition hash |
| 模型 | provider、endpoint profile id、model id、reasoning effort、采样参数、最大 token |
| 工具与策略 | tool schema hash、effective capability manifest hash、policy version、目录和参考数据版本 |

Evaluation Spec 不属于 Agent Run 的模型可见输入。需要在运行开始前固定官方评测时，控制平面只保存不对 Agent 暴露的 opaque version reference；实际使用的 Spec、evaluator digest 和输入 hash 仍由 Evaluation Result 记录，因此以后可以在不改写 Agent Run 的前提下重新评测。

## DSH 运行生命周期

### 首版执行序列

1. 控制平面只在 Scenario Run 已激活、Actor 与患者上下文已确定后创建 Agent Run，并生成短期 capability token。
2. Runner 使用固定 image、最小环境变量和禁止默认外网的网络策略启动一个全新 DSH 进程，完成 `initialize` 后检查 server name、实际版本和 composition hash。
3. Runner 为该 Run 创建全新 session，只提交一个 Agent Task prompt；首版不发送 follow-up、steering、injected work，也不启用 subagent。
4. DSH 收到 `session/prompt` 后只返回 queued message id。高层 SDK 等到对应 `agent/inbox/spliced` receipt，再收集该 session tree 的事件，直到根 Agent 下一次 `idle`。[SDK 实现][dsh-sdk-api]和[协议说明][dsh-sdk-protocol]都明确这不是 prompt-specific result。
5. Cordis adapter 用 DSH `callId` 调用 Tool Gateway；Gateway 只相信 token 和受信请求头中的上下文，模型参数不能切换 Workspace、Actor、Patient 或 Encounter。
6. 回到 idle 后，Runner 关闭并回收 DSH 进程，封存临时日志索引，并根据 Tool Gateway receipt 与 ActionTrace 对账。
7. Agent Run 的 runtime outcome 封存后，独立 evaluator 才读取最终状态并生成 Evaluation Result。两者可以异步完成。

DSH SDK 本身允许一个子进程跨多次 `run()` 复用，但这不是 ClinMesh 首版选择。[SDK client][dsh-sdk-client]同时明确没有 mid-turn cancel、per-prompt result 或 per-prompt cancel；隔离到一个 Run 一个进程，使关闭 runtime 成为明确的放弃边界，也减少会话和凭据串用风险。

### 运行结果不等于临床结果

建议把运行和评测结果拆开，而不是在 Agent Run 上放一个笼统的 `status`：

| 所有者与字段 | 建议值 | 含义 |
| --- | --- | --- |
| `AgentRun.runtimeOutcome` | `completed / timed_out / cancelled / crashed / protocol_error / startup_error` | Runner 与 DSH 是否完成一次可解释的 receipt-to-idle 区间 |
| `AgentRun.clinicalCompletion` | `complete / incomplete / indeterminate` | 从服务端状态判断 Task 声明的业务终点是否出现，不判断质量高低 |
| `EvaluationResult.outcome` | `passed / failed / invalid / evaluator_error` | 某一 Evaluation Spec 对临床质量、流程和安全的独立判定；尚未请求或仍在执行由评测作业状态表达 |

`runtimeOutcome = completed` 只表示 DSH 正常回到 idle。`finalResponse` 是该活动区间最后一条已提交的根 session assistant 文本；SDK 明确它不一定与根 prompt 有因果一一对应。即使首版禁止 steering，也不能把文本中的“已完成”当作医院状态，临床完成只能读取权威业务对象。

### 取消、超时与迟到结果

SDK wire 只有 `initialize`、`session/prompt` 和 `shutdown` 三类 client request，没有 cancel、session close 或协议版本协商；`serverInfo.version` 目前也未由 client 验证。[协议类型][dsh-sdk-types]和[已知限制][dsh-sdk-protocol]要求 ClinMesh 自己固定兼容版本。超时或用户取消时，Runner 应关闭整个 runtime，并等待进程与其资源达到可观测 quiescence；若达不到则标记异常并隔离该工作负载。

关闭 DSH 进程不会回滚已经提交的 Command。Tool Gateway 可能已经接受请求、提交事务或安排 outbox，而 Runner 尚未收到结果；外部模拟回调也可能在进程退出后到达。因此取消语义是“停止继续决策”，不是“撤销医院事实”。权威结论来自 ClinMesh state、Command receipt 和 ActionTrace：

- 每次写调用的幂等键由受信 adapter 根据 `agentRunId + toolCallId + toolVersion` 派生，模型不能提供或替换；
- Command 带 expected version，重复调用返回同一 receipt 或明确冲突，不能再次产生 Effect；
- Runner 结束时按 `agentRunId/toolCallId/commandId` 对账 `accepted / committed / rejected / ambiguous`，不能把丢失 HTTP 响应解释为失败；
- in-flight 结果晚到时仍写入原 Workspace/Epoch 的 ActionTrace，并且必须通过 active Epoch 和业务版本条件，绝不能污染 reset 后的新 Epoch；
- 首版 crash 后不自动 resume。同一业务意图是否重试由控制平面根据 receipt 和 canonical state 显式决定，并创建新的 Agent Run。

这与[系统架构的 reset 和晚到副作用合同](../architecture.md#106-重置检查点和回放)一致：系统可以阻止旧结果污染新 Epoch，但不能声称已经发出的外部副作用会因本地取消自动撤销。

## 临床 Cordis Composition

自主临床 composition 的首个 spike 应保持最小，并显式列出允许加载的包，而不是从 DSH 的完整 headless 或 coding profile 上删减。建议只保留 SDK server、session、agent loop、选定 LLM adapter、必要的 retry/usage 记录、固定 persona、固定系统 prompt、ClinMesh tool adapter 和受限临时持久化。

以下能力默认不装配：shell、PowerShell、terminal、filesystem、任意 web search/fetch、code runtime、MCP client、subagent、Agent Team、项目 skills、用户 skills、todo/goal/workflow、计划模式和任意 URL 工具。自主临床 Agent 默认 `maxParallelToolCalls = 1`，让观察、写入和随后观察保持可解释顺序；未来只有证明业务工具可安全并发后，才在特定只读工具上放宽。

DSH 的 Cordis tool pipeline 提供 pre/execute/post/result 扩展点，而 `ToolExecution.callId` 在管线中只读。[工具合同][dsh-tools]适合装配 ClinMesh 的 schema 校验、deadline、审计关联和结果投影，但最终权限仍在 Tool Gateway。Harness 内的 allow/deny 只能减少模型看到或调用的能力，不能替代服务端授权。

模型看不到 shell、filesystem、web 或 subagent，不代表 DSH 进程没有网络。容器 egress 应只允许固定模型 endpoint 和 ClinMesh Tool Gateway，并限制 DNS 解析、IP 范围、TLS 身份和重定向；模型 endpoint 的上传内容也属于数据出境面，需要单独的数据分类与部署决策。

## Tool Adapter、身份与授权

### 有效 capability manifest

每次 Run 的能力由下列集合求交后生成，不接受模型或 Runner 临时扩大：

```text
Runtime Profile 工具目录
∩ Scenario 允许动作
∩ Actor / Practitioner Role / Location 权限
∩ Patient / Encounter 上下文
∩ Workspace / Epoch 状态
∩ 部署与安全策略
∩ 本次 Run 的预算和风险上限
= effective capability manifest
```

短期 token 至少绑定 `agentRunId`、Workspace、Epoch、Scenario Run、Actor、Patient、Encounter、工具 allowlist、预算、policy version、tool schema hash 和真实时间期限。业务参数只能进一步缩小范围；任何 `workspaceId`、`actorId`、`patientId` 或 `encounterId` 参数都只能作为与 token 一致的断言，不能切换上下文。[系统架构的 Workspace 与 Agent 工具约束](../architecture.md#101-workspace-隔离)继续是权威边界。

Better Auth 只负责 User Account 和浏览器会话，不应把人类 cookie、session token 或用户目录交给 DSH。自主 Runner 使用独立 Agent client 身份换取上述短期 token，ClinMesh 再把它绑定为受审计 Actor。代表真实用户的首个侧栏助手使用独立的授权、撤销、页面上下文和人工复核合同；这些合同由[嵌入式 HIS 助手融合研究](./embedded-his-assistant-integration.md#多用户认证授予和审计)拥有，不能套用本节的自主 Agent Run 身份。

### 调用链

```text
DSH ToolExecution.callId
  -> ClinMesh Cordis adapter 注入受信 correlation headers
  -> Tool Gateway 验证 token、manifest、schema、预算和 expected version
  -> Query handler 或 CommandExecutor
  -> Command receipt + Effect refs
  -> ActionTrace
```

模型可见 schema 只暴露临床意图所需参数，例如“查询已签发检验结果”“预览处方”“签发已预览处方”，不暴露任意 method/path/body、SQL、FHIR Bundle 或 URL。Adapter 不直连 repository，也不在 Harness 内复制业务状态机。

DSH 现成 MCP bridge 在调用 `tools/call` 时只发送 `{ name, arguments }`，虽然函数本身拿到了 `ToolExecution`，却没有把 `exec.callId` 放入 wire params。[实现证据][dsh-mcp-tools]意味着 stock MCP 无法自然提供 ClinMesh 所需的端到端 call correlation。未来如需 MCP 兼容，应增加受信扩展或 gateway-side invocation envelope，并用对照测试固定；首选路径仍是薄 Cordis adapter。

用户草稿中的 HACT 可收敛为这份窄化 Agent Tool Catalog，调用与 Web 医生站相同的 Query/Command owner。HACP 不需要成为新的 wire protocol；它可收敛为控制平面按 Run 生成的 effective capability manifest，并且绝不等同于授权本身。

## 双日志与 Reasoning 保留

DSH session 是追加式事件日志，完整 `assistant/message`、原始 `assistant/chunk`、工具调用和结果都会进入 canonical log。[session 合同][dsh-session]明确消息历史由该日志派生，持久化必须无损保留事件。LLM 核心类型包含 `ReasoningBlock`，而 DeepSeek adapter 会把每个已保留 assistant turn 的 `reasoning_content` 原样回传给后续请求，包括工具调用轮次；[adapter 说明][dsh-deepseek-readme]和[序列化测试][dsh-deepseek-serialize]都固定了这一行为。

这带来两个结论。第一，reasoning 不是“只在模型端短暂存在”的数据；只要开启 thinking 并持久化 DSH session，它就可能出现在磁盘日志和下一轮 provider request。第二，不能通过 telemetry redaction 清理 canonical log：DSH telemetry 默认把 event payload 的完整副本交给 backend，自身没有内建脱敏规则，且 redaction 只修改导出副本。[telemetry 合同][dsh-telemetry]要求临床 profile 默认不装配 outbound session telemetry；确需观测时，只能装配显式 allowlist 投影，不能依赖事后黑名单。

| 日志 | 用途与内容 | 保留策略 |
| --- | --- | --- |
| 临时 DSH Run bundle | 诊断一次运行所需的 session header/events、reasoning、raw chunks、stderr 和 runtime metadata | 受限访问、独立加密、短保留；按 `agentRunId` 整包删除，不进入普通日志或分析仓库 |
| 长期 ClinMesh Agent Run / ActionTrace | 输入版本引用、模型和工具 schema 版本、tool call、Command receipt、Effect、资源版本、耗用、错误和结果引用 | 按医院仿真审计策略保留；绝不保存 CoT 或模型内部 plan |
| Evaluation Result | evaluator 版本、输入 hash、规则结果、指标、证据引用和 evaluator error | 与 Agent Run 分离保留；不得读取或复制 reasoning |

长期记录可以保存经分类的模型最终文本 artifact，但它不是状态真值或评分依据，并应有独立的敏感数据与保留策略。删除临时 DSH bundle 后，ClinMesh 仍须仅凭固定版本、ActionTrace 和 canonical state 解释业务效果与评测结果。

## 独立评测平面

evaluator 使用与 Agent、Runner 和普通 API 不同的凭据，只读 evaluator storage 中的 Hidden Fact、目标 Evaluation Spec、运行结束后的 canonical state 和 ActionTrace。隐藏输入永不进入 DSH composition、模型 prompt、tool result、普通服务日志、前端 bundle 或 Agent 可读 artifact。[ClinMesh Hidden Fact 设计](../architecture.md#105-隐藏真值与评分)已经要求独立 binding/storage；未来 Agent 评测沿用该边界。

Evaluation Spec 至少支持：

- 必须达到的最终业务事实，例如诊断、检查结果被读取、处方状态和病历签署；
- 禁止行为，例如越权读取、过敏冲突药物签发、在关键结果前不当提交或跨患者访问；
- 过程约束，例如是否通过正常 Clinical Request 生命周期获得证据，不能只比较最终文本；
- 多种可接受路径和分项指标，避免把一条专家路径误当唯一正确策略；
- evaluator 自身失败、缺失真值和输入版本不匹配的独立结果，不能伪装成 Agent 得分为零。

评分永远不读取 reasoning。Intent 只能从模型提交的外部动作、结构化文书和状态变化判断；“模型想过正确答案但没有执行”不构成临床成功，反之也不能因 reasoning 措辞不同惩罚等价正确行为。

### 从 HealthAgentBench 吸收的评测机制

HealthAgentBench 通过 Harbor 将 Agent run、verifier run 和 artifacts 分开，[任务 README][hab-readme]还说明二进制 `reward.txt` 与丰富的 `metrics.json` 分别保存。其 data-quality verifier 只在 verifier 阶段挂载 `/tests`，Agent 看不到 labels，[入口注释][hab-hidden-verifier]明确了这个边界。这些机制支持 ClinMesh 把“是否通过”和“为何通过或失败”分开，并让 evaluator-only 输入具有真正的服务端隔离。

它也暴露了应避免的风险。全部 54 个 `task.toml` 都设置 `allow_internet = true`，而 README 另外建议禁用 WebSearch/WebFetch 来防止搜索金标准；这说明 prompt 或 agent flag 不能替代容器网络策略。[示例 task][hab-task]和[运行说明][hab-readme]共同构成该证据。另一个直接证据是多个 data-quality evaluator 的函数 docstring 写 `precision > 0.5`，实际常量和 pass 判定却使用 `0.01`；[固定实现][hab-evaluator]说明 verifier 文档、代码和期望可能漂移。

因此每个 ClinMesh evaluator 必须有 fixture/meta-tests，至少覆盖 golden pass、near miss、禁止动作、恶意或超大输出、缺失 Hidden Fact、版本不匹配和 evaluator crash。测试应直接断言指标和结果类别，而不只运行一次 golden case；发布 Evaluation Spec 时应固定代码 digest 与 fixture digest。

## 不采用 Harbor 的边界

ClinMesh 不复制 HealthAgentBench 的 terminal/file submission 模型，也没有计划实现 Harbor export adapter。Agent 不能通过写一个答案文件声明自己完成任务，verifier 应读取服务端 final state 与 ActionTrace。下表只解释两种模型为何不能直接等同，不是实施路线：

| ClinMesh 对象 | Harbor 投影 |
| --- | --- |
| Agent Task | `instruction.md` |
| Runtime Profile 与预算 | `task.toml` 的 agent/environment 限制 |
| Scenario launcher 或 snapshot | `environment/` |
| Evaluation Spec 与 evaluator image | `tests/` |
| Evaluation Result | `reward.txt + metrics.json + artifacts` |

若未来因新的明确需求重新评估兼容层，仍必须单独设计且不能成为 canonical owner；在此之前，Harbor trial id、目录格式和运行生命周期都不进入 ClinMesh 合同。

## 与用户平台草稿的收敛

`references/docs/Hospital_Agent_Platform_Design_v0.1.md` 和 `references/docs/Hospital_Agent_Platform_Unified_Design_v0.2.md` 提供了有价值的产品语言，但 ClinMesh 不需要据此新增平行基础设施：

| 草稿概念 | ClinMesh 收敛建议 |
| --- | --- |
| HACM | 不建立第二套临床资源真值；以 ClinMesh FHIR R5 和领域状态为 owner，只提供 `PatientSnapshot`、`Timeline` 等少量只读 Agent projection |
| HACT | 映射为窄化 Agent Tool Catalog；Web 与 Agent 调用同一 Query/Command owner |
| HACP | 映射为每次 Agent Run 固定的 effective capability manifest；它描述可用能力，不自行授予权限，也不另造协议 |
| AgentRun | 采用为一级执行记录，但不保存模型内部 plan、decision 或 CoT |
| EvidenceRef | 轻量引用现有 resource/version、ActionTrace 或 artifact，不复制临床事实成为第二事实源 |
| Healthcare Agent Skill | 只保存模型可见的工作方法和约束，不拥有权限、连接凭据、病例真值或 evaluator |

v0.1 中“verifier 属于 Skill”的提议不应采用。Scenario、Agent Task、Runtime Profile 和 Evaluation Spec 必须独立版本化，否则更换模型或工作方法会意外更换真值与评分，或者把 verifier-only 信息打包进模型可见 Skill。v0.2 已明确 Skill 不是权限、HACP 不等于授权、凭据应短期最小化、医生与 Agent 共用后台 handler，这些原则与 ClinMesh 边界一致。

这些英文缩写目前只作为研究映射，不自动进入 `CONTEXT.md`。真正实施前应通过批准的设计 issue 决定是否保留名称；即使保留，也不能改变现有 Scenario、Command、Effect、Actor 和 Hidden Fact 的所有权。

## 自主评测轨道的后置实施路线

本路线晚于[嵌入式助手路线](./embedded-his-assistant-integration.md#分阶段路线)，不与首个侧栏助手并行实施。

### Phase A：先完成 Agent 无关基础

完成 Web 门诊医生从接诊、问诊/查体、诊断、Clinical Request、结果返回、处方、病历签署到完诊的真实闭环；同时完成 Scenario schema/compiler、Hidden Fact 服务端隔离、不可变版本、ActionTrace、canonical replay hash 和二型糖尿病 golden case。该阶段不引入 DSH、Agent token、Agent 页面或评分 UI。

### Phase B：只读 Runner spike

建立独立 Runner，用固定 DSH 版本和自定义最小 Cordis composition 运行单 prompt、只读任务。验证 process-per-run、SDK handshake、call-id correlation、临时日志删除、凭据泄漏检查和 egress 策略；结果不进入产品 SLA，也不允许写 Command。

### Phase C：显式自主医生 Agent golden case

让 Agent 在与人类医生相同的二型糖尿病 Scenario 上使用只读工具和草稿型 Command，例如创建诊断或处方预览，但不直接签发高风险动作。对比人类 UI 与 Agent tools 产生的 canonical state，不引入通用聊天入口或多 Agent。

### Phase D：受控写与独立 evaluator

在幂等、expected version、receipt 对账、预算和安全 meta-tests 全部通过后，逐项开放低风险 commit 工具；加入 evaluator-only storage、Evaluation Spec、过程/安全指标和回归矩阵。运行时成功、临床完成和评测结果分别展示。

### Phase E：跨 runtime 评测

核心合同稳定后再做不同 provider/runtime 对比、批量 benchmark 和更丰富 Agent 场景，不实现 Harbor 导出。ACP、交互式 steering、resume、多 Agent、生产医院连接和高风险自动签发均需要独立设计，不因 DSH 已支持某些机制而自动进入范围。

## 实施前验证 Spikes

| Spike | 必须证明的可观察结果 |
| --- | --- |
| SDK handshake 与版本固定 | 不支持的 `serverInfo`、DSH package 或 wire event 立即拒绝；升级有 snapshot/contract diff，不能静默兼容 |
| Timeout quiescence | 关闭后 DSH 进程、子进程、网络连接和新工具调用都停止；已提交 Command 单独进入对账，不宣称回滚 |
| 迟到结果 | 在 tool response 丢失或进程被杀后，Command receipt、Effect 和回调仍能由 `commandId` 找回；旧 Epoch 结果不污染新 Epoch |
| Cordis correlation | 自定义 adapter 传播 `toolCallId`；重试命中同一幂等 receipt，ActionTrace 可关联到 Agent Run |
| MCP 对照 | stock MCP bridge 的请求不含 Harness call id，测试固定其缺口，防止误把 MCP transport 当成完整审计合同 |
| 凭据泄漏 | prompt、tool args/result、DSH log、stderr、artifact 和 telemetry 都不含 capability token 或模型 API key |
| Hidden Fact canary | Agent、普通 API、前端/Runner 构建产物、错误和日志均无法读取 canary；evaluator-only 凭据可以读取 |
| Reasoning retention/delete | thinking run 后确认 DSH bundle 含 reasoning 且可按 Agent Run 整包删除；长期 Agent Run、ActionTrace 和 Evaluation Result 不含 reasoning |
| Container egress | 除固定模型 endpoint 与 Tool Gateway 外，域名、直连 IP、重定向和 DNS rebinding 路径全部拒绝 |
| Evaluator meta-tests | golden pass、near miss、越权、恶意输出、缺失真值、版本不匹配和 evaluator crash 得到彼此可区分的确定结果 |
| Replay | 固定 Scenario/Task/Profile/seed/action sequence 得到相同 canonical state hash；非确定 provider 文本不进入业务 hash |
| 无自动 resume | runtime crash 只封存原 Run；任何后续 attempt 都有新 `agentRunId` 和显式起始状态策略 |

## 风险与未决问题

| 风险或未知项 | 当前处理 |
| --- | --- |
| DSH 为 `0.1.1-rc.2`，SDK 无协议协商，session format 仍无兼容承诺 | 固定 commit、image digest 和 wire snapshots；升级先过 spike，不跟随浮动版本 |
| process-per-run 的冷启动、内存和并发成本未知 | 先在只读 spike 测量；安全边界稳定前不做进程池或跨 Run 会话复用 |
| 模型 endpoint 的地域、数据保留和 reasoning 处理未知 | Runtime Profile 显式选择部署；未经数据治理决策不发送被分类为敏感的字段 |
| Runner 部署平台与 Cloudflare 控制面的调度方式未定 | 只固定外部 Runner 边界和协议，不在研究阶段选择队列或容器平台 |
| 临床等价路径与评分阈值需要医生验证 | 先保存可重放证据，不在首期实现分数；Evaluation Spec 发布需要临床审阅和 meta-tests |
| 一个工具调用可能跨越取消边界并产生迟到 Effect | 幂等、expected version、receipt、ActionTrace 和对账是强制合同，取消不承诺回滚 |
| 长期保存模型最终文本仍可能含敏感信息 | 与 ActionTrace 分离为受分类 artifact，设置独立访问与保留策略 |

## 固定源码来源

### DeepSeek Harness

- [固定源码树][dsh-tree]与[MIT License][dsh-license]
- [Node 版本与发行版本配置][dsh-package]
- [TypeScript SDK client 合同][dsh-sdk-client]、[高层 receipt-to-idle 实现][dsh-sdk-api]、[子进程 client][dsh-sdk-process]
- [SDK wire 类型][dsh-sdk-types]与[协议已知限制][dsh-sdk-protocol]
- [ToolExecution 与 Cordis pipeline][dsh-tools]、[MCP `tools/call` bridge][dsh-mcp-tools]
- [session append-only 合同][dsh-session]、[ReasoningBlock 类型][dsh-reasoning-type]
- [DeepSeek reasoning passback 说明][dsh-deepseek-readme]与[固定测试][dsh-deepseek-serialize]
- [session telemetry payload 与 redaction 合同][dsh-telemetry]
- [ACP 生命周期、cancel 与 permission request 合同][dsh-acp]

### HealthAgentBench

- [固定源码树][hab-tree]、[MIT License][hab-license]与[54 个任务、7 类和 Harbor 生命周期][hab-readme]
- [`harbor==0.8.0` 固定依赖][hab-pyproject]
- [环境默认允许互联网的 task 示例][hab-task]
- [verifier-only `/tests` 挂载说明][hab-hidden-verifier]
- [二进制 reward、丰富 metrics 和 precision 文档/实现漂移][hab-evaluator]

[dsh-tree]: https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
[dsh-license]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/LICENSE
[dsh-package]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/package.json
[dsh-sdk-client]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/sdk/client/README.md
[dsh-sdk-api]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/sdk/client/src/api.ts
[dsh-sdk-process]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/sdk/client/src/client.ts
[dsh-sdk-types]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/sdk/protocol/src/types.ts
[dsh-sdk-protocol]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/sdk/protocol/README.md
[dsh-tools]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/tools/src/index.ts
[dsh-mcp-tools]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/mcp/mcp-client/src/tools.ts
[dsh-session]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/subsystems/session.md
[dsh-reasoning-type]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm/src/types.ts
[dsh-deepseek-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-deepseek/README.md
[dsh-deepseek-serialize]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-deepseek/tests/serialize.spec.ts
[dsh-telemetry]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/subsystems/session-telemetry.md
[dsh-acp]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/acp/acp/README.md
[hab-tree]: https://github.com/microsoft/HealthAgentBench/tree/ce89def2edf56f4a2ef068f37c8544bff944d5fc
[hab-license]: https://github.com/microsoft/HealthAgentBench/blob/ce89def2edf56f4a2ef068f37c8544bff944d5fc/LICENSE
[hab-readme]: https://github.com/microsoft/HealthAgentBench/blob/ce89def2edf56f4a2ef068f37c8544bff944d5fc/README.md
[hab-pyproject]: https://github.com/microsoft/HealthAgentBench/blob/ce89def2edf56f4a2ef068f37c8544bff944d5fc/pyproject.toml
[hab-task]: https://github.com/microsoft/HealthAgentBench/blob/ce89def2edf56f4a2ef068f37c8544bff944d5fc/tasks/ehr_data_quality_task_inconsistency/task.toml
[hab-hidden-verifier]: https://github.com/microsoft/HealthAgentBench/blob/ce89def2edf56f4a2ef068f37c8544bff944d5fc/tasks/ehr_data_quality_task_inconsistency/tests/verify.py
[hab-evaluator]: https://github.com/microsoft/HealthAgentBench/blob/ce89def2edf56f4a2ef068f37c8544bff944d5fc/tasks/ehr_data_quality_task_inconsistency/tests/harbor_evaluator.py
