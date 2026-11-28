# Agent Note: 后端操作面一核双门面、四层渐进指导与 Agent-First CLI / 2026 Stateless MCP 规范

Status: proposed

## Problem

基于对仓库 [HIS Operation Catalog](../../../../packages/contracts/src/his-operations.ts) 与 `skills/*/SKILL.md` 的实测分析，ClinMesh 后端操作面面临五个结构性问题：

1. **工具定义与静态 Skill 严重膨胀**：仓库已有 `225` 个规范 HIS Operations（`read: 79`、`write: 103`、`high-risk-write: 43`）。若按传统 MCP 平铺全量 JSON Schema，首轮即消耗约 `51,283` tokens（单岗位住院医生 `77` 项仍需 ~`19,897` tokens，门诊医生 `73` 项需 ~`16,670` tokens）；而现有单体 Skill 文件同样过度膨胀（`clinmesh-inpatient/SKILL.md` 达 `95 KB` / ~`27,634` tokens），反而比直接暴露 schema 更重。
2. **内置工具与规范目录割裂且绑定语言实现**：Step 3 在 `agent-session-service.ts` 手写了 5 个仅返回拼接中文纯文本的只读工具，既无法复用全院 `79` 个规范只读操作，也没有 `structuredOutputSchema`，无法支持多步编程式聚合；同时若将 Agent 层硬耦合于特定宿主运行时，会在未来后端拆出或改写为 Rust/Go 服务时造成架构返工。
3. **跨操作面风险分级漂移**：实测发现 `outpatient-doctor` 有 `17` 个 `high-risk-write`、`cashier` 有 `21` 个，但 `inpatient-doctor` 的 `38` 个写操作中 `high-risk-write` 数量为 `0`，导致门诊/住院以及前端确认与后端门禁之间存在安全策略不一致。
4. **现有 CLI 缺乏面向 Agent 的省 Token 与防错人机工程**：缺少 `--summary` / `--compact` / `--fields` / `--tail` 有界读取、缺少病历局部补丁与 `--dry-run`、强制模型手编 `--idempotency-key` 易在重试时误换新键、缺少分组 `--help` 与缺参自纠错，且缺乏可审计的 `Skill Receipt`。
5. **多类消费者协议诉求分化**：有本地 Shell 的 Agent 适合薄 CLI + Skill 包；无本地 Shell 的云端/桌面/跨语言 Agent 需要现代无状态远程 MCP（`2026-07-28`）；评测运行则需要高吞吐、可并发复现的同源无头操作面。

## Proposal

确立以**优雅、完整、后端语言无关**为第一优先级的架构总纲（Cloudflare Workers 适配作为可选部署目标，不反向扭曲核心设计）：**1 份权威业务契约 + 1 套协议无关 `Clinical Playbook` Skill 包 + 2 大并列一等协议门面（Agent-First CLI & 2026 Stateless Progressive MCP）**，内置 `pi-durable` 通过抽象 `OperationClient` 解耦，暂不将 Mirage AgentVFS 引入主干运行时。

1. **单一权威业务内核与唯一 `Clinical Risk Tier`**：
   - `hisOperationCatalog` + `CommandExecutor` + 统一 `Reveal Policy`（硬隔离 `Case Truth`）继续作为全系统唯一业务真源。
   - 建立跨越前后端的单一 `Clinical Risk Tier` 分级标准，补齐住院医生等岗位 `high-risk-write` 遗漏标记，同时驱动前端 `data-agent-confirm`、CLI `--yes` 与 MCP `destructiveHint` / Elicitation。
2. **抽象 `OperationClient` 与内置 `pi-durable` 领域扩展**：
   - 废除手写 5 个散装文本工具，从 `hisOperationCatalog` 只读操作自动投影带 `structuredOutputSchema`、受信上下文注入与 `replay: "safe"` 的 5 个领域 `Extension`（`clinical.case`、`clinical.diagnostics`、`clinical.therapy`、`clinical.cds`、`clinical.finance`），按登录岗位动态装配且默认 `deferred: true`。
   - 领域扩展面向抽象的 `OperationClient` 执行：当前 TS 单仓默认注入 `InProcessOperationClient`，未来后端换 Rust/Go 时无缝切换为 `HttpOperationClient` 或 `McpOperationClient`。
3. **四层渐进工具指导与 Prompt Cache 静/动分离**：
   - **L1 静态总宪章**（~`500` tokens）：严格只放不变的决策树与安全铁律，保持前缀跨轮次不变以命中 Prompt Cache；动态易变上下文（病例、脏草稿增量、触发事件）一律尾置在当轮用户消息后。
   - **L2 协议无关 `Clinical Playbook` Skill 包 + `Skill Receipt`**：拆分为按场景划分的 `500–800` 字微剧本包，分别投影至 `ToolNamespace.instructions`、`<3 KB` CLI 路由卡与 `MCP Prompts`/`Resources`，每次运行记录 `Skill Receipt`（路径、字节数、SHA256）供 Context Inspector 审计。
   - **L3 自纠错诊断与 `prepareArguments`**；**L4 确定性 `beforeTool` / `afterTool` 硬护栏**（覆盖直调与 `codemode` 嵌套调用）。
4. **高频固化宏工作流 + `codemode` 双档能力**：
   - 3–5 个高频固定多步只读核查沉淀为确定性 `Clinical Workflow Macro` 并登记于只读目录，供内置助手、CLI 与 MCP 共享。
   - 基线启用 `@earendil-works/pi-durable/tool-search` + 宏工作流（~`1,000–1,500` tokens）；增强档位叠加 `@earendil-works/pi-durable/codemode`（Node 用 `CodemodeSandbox`，边缘可选 `RemoteCodemodeSandbox`，无沙箱自动回退基线）。
5. **一等门面 A：Agent-First CLI**：
   - 省 Token 有界读取旗标（`--summary`、`--compact`、`--fields`、`--tail`、`--since`）；`stdout` 纯 JSON / `stderr` 放游标与警告；宏读命令 + 局部精准补丁（带 `--base-revision`）+ `--dry-run` + 工作区内 `--*-file`；Agent 运行内自动确定性幂等键；分组 `--help` 与缺参自动回显 Help；`<3 KB` 瘦身 `skills/` 路由卡。
6. **一等门面 B：2026 Stateless Progressive MCP（独立模块 `mod-mcp`）**：
   - 遵循 MCP `2026-07-28` 无状态 Streamable HTTP（`POST /api/mcp`、`server/discover`、`_meta`、`Mcp-Method`/`Mcp-Name`、严格 `Origin` 校验、`ttlMs`/`cacheScope`）。
   - 仅暴露 3 个固定渐进元工具（`clinmesh_search_operations`、`clinmesh_get_operation`、`clinmesh_run_operation`）+ 只读 `MCP Resources` + 复用 `Clinical Playbook` 的 `MCP Prompts` + `Tool Annotations`；浏览器实时界面协同由 WebMCP（`@ui-sdk/react` `registerTools`）承担。
7. **无头同源评测与 Mirage 边界**：
   - 默认 `Evaluation Run` 采用服务端无头同源操作面，与浏览器 UI 操控专项评测解耦；Mirage AgentVFS 暂不引入主干，仅保留 `ExecutionEnv` 扩展位。

## Alternatives considered

- **平铺 225 个（或单岗位 70+ 个）工具给模型 / MCP**：首轮占用 `16k–51k` tokens，工具路由准确率下降且难以扩展。
- **为特定边缘部署强制绑定同进程原生/Wasm 架构**：被部署目标反客为主，增加跨语言演进复杂度。
- **只做 CLI 或只做 MCP**：有 Shell 的 Coding Agent 与无 Shell 的云端/跨语言 Agent 客观并存，基于同一契约维护两个极薄门面的边际成本极低。
- **主干强制引入 Mirage AgentVFS 承载读写操作**：不适合表达带乐观锁、幂等键、回执恢复和临床质控越权的事务写 Command。

## Acceptance criteria

- 全部 225 个操作完成统一 `Clinical Risk Tier` 审计并补齐住院医生高风险操作分级。
- 内置 `Clinician Assistant` 首轮静态提示词与工具声明总开销 `< 2,500` tokens（降幅 > 90%），动态上下文严格尾置以保持 Prompt Cache 命中。
- 5 个领域只读 `Extension` 面向 `OperationClient` 并校验 `structuredOutputSchema`，在基线与 `codemode` 模式下均通过真实基准测试与权限隔离测试。
- CLI 补齐省 Token 旗标、`stdout`/`stderr` 分离、自动确定性幂等键、分组 `--help` 与 `<3 KB` Skill 索引；`mod-mcp` 通过 2026 Stateless 3 元工具渐进协议测试。
- `Evaluation Run` 能够无头稳定跑完固定病例闭环且零 `Case Truth` 泄漏。

## Risks

- 自动投影 `hisOperationCatalog` 为工具时需严格区分简洁摘要 `output` 与完整 `structuredOutput`，并设置 `outputLimits` 截断防止大返回体污染上下文。
- 瘦身现有 95KB `clinmesh-inpatient/SKILL.md` 时须验证关键业务约束已无损下沉至 `operations schema`、错误诊断与 `Clinical Playbook`。
- Agent 自动确定性幂等键须严格绑定单次意图（含 `runId` / `taskId` / 规范化输入摘要），避免同运行内两次有意重复操作发生键碰撞。
