# Agent Note: Operation Catalog 驱动的 Agent 原生 HIS CLI

Status: implemented

## Problem

ClinMesh 的 HIS 与 FHIR 接口已经拥有多岗位业务能力，但直接调用者仍需理解 HTTP path、body wrapper、Better Auth cookie、幂等 header 和资源版本。把 route 机械改名为子命令会在 CLI、服务端授权和 Agent 指引之间建立多份易漂移合同，也会诱导通用 HTTP、FHIR write 或数据库逃生入口。实现合同由 [GitHub issue 61](https://github.com/CaiZongyuan/clinmesh/issues/61) 追踪。

## Decision

`packages/contracts` 中导出的 `hisOperationCatalog` 是 Agent 操作面的唯一合同 owner。每项 operation 显式拥有稳定 ID、版本、`cliPath`、mode、输入/输出/错误 schema、HTTP adapter、handler owner、identity、岗位、风险、幂等、expected version 与 preview token 要求；CLI 命令树、离线 discovery、服务端 Agent route matching、Grant Catalog hash 和 Skill 示例验证都投影这份合同。病例级检验目录作为独立 operation 暴露当前 Case 的 Investigation Generation Capability，避免 Agent 用全局概念目录推测结果是否可生成。既有 Command receipt 使用不同持久 operation 名称时，Catalog 保存 adapter 名称，使 Agent 始终用公开 operation ID 恢复而不改写历史 receipt。

`apps/cli` 发布 `clinmesh` 可执行入口。Human mode 使用本地 Better Auth profile，高风险 write 需要 `--yes`；Agent mode 只接受 runner 注入的短期 `cma_` token，不回退到 human profile。Agent Client 是稳定非人类 Actor，并与 Human Membership 一样投影到 `workspace_actor`；Agent Capability Grant 把它绑定到一个 Workspace、Epoch、Scenario Run、单一 Practitioner Role、operation allowlist、Catalog hash、policy version 和期限。Grant 与 allowlist 使用 Workspace/Epoch 复合键和关系行持久化，operation ID 在 contracts 边界按 Catalog 验证，不保存 JSON 授权集合。Human 控制面要求当前选中的 Acting Practitioner Role 是 administrator，不能只凭账户拥有该岗位。控制面 mutation 复用 CommandExecutor 的幂等、审计和 Action Trace；Grant 原 token 只返回一次，receipt 脱敏且不能重放。控制面结果未知时先检查当前状态；Grant 创建结果未知时撤销可能已经创建的 Grant，再用新幂等键签发替代 Grant。服务端只保存 token SHA-256；撤销、过期、Client 禁用、Epoch reset、Scenario Run 关闭、岗位停用或版本变化都会使 Grant 失效。

CLI 默认输出版本化 JSON，human mode 可选择 table。所有 write 显式携带 idempotency key，连接丢失或 write 5xx 不自动重试，而是返回 ambiguous 并通过 Command receipt 对账。Command receipt 持久化 Acting Practitioner Role，公开查询必须匹配原 Actor、岗位、Workspace 和 Epoch；无法从历史 Audit Event 可靠回填岗位的旧 receipt 保持不可见。复杂输入只从 workspace 内文件或 stdin 进入窄 schema。CLI 不提供通用 invoke、任意 URL、method/path/body、SQL、JSON Patch、FHIR write 或 Bundle write。

生成 Synthetic Case 开始或 replay 时，活动 Patient Brief 的问诊主题被确定性物化为 case-scoped Consultation Question Rules；首次问诊同时接管医生责任。独立处方开具原子创建 MedicationRequest 与药品 ChargeItem/Charge Record，只有 Encounter 完成后才能支付并移交药房。这两条桥接保证同一病例不依赖 legacy first-visit 或组合签署入口即可完成 CLI 跨岗位闭环。

七个 model-invoked `clinmesh-*` Skills 按共享恢复、挂号、分诊、医生、收费、药房和 FHIR 拆分。Skills 解释业务意图、状态前置、岗位交接和反例，精确 flags 与 schema 仍由 Catalog discovery 拥有；临床 Skills 不包含 Agent Client/Grant 管理命令。

## Alternatives considered

**为每个 HTTP route 手写 CLI 和 Skill。** 这种方式能快速包装少量 endpoint，但 path/body、岗位和示例会形成多个 owner，兼容 route 也会被误当成新能力。

**提供 raw HTTP、FHIR Bundle 或通用 operation invoke。** 这种方式覆盖面大，却把 URL、method/body 和资源编排权交给模型，绕开业务意图、最小权限和可审计命令边界。

**让 Agent 复用 human profile 或多岗位 token。** 这种方式减少控制面对象，但 task 可以意外继承长期 cookie 或在流程中自选岗位，无法把一次授权限制到单一责任上下文。

**修改全部既有 Command operation 名称以匹配 Catalog。** 这会破坏跨版本 idempotency receipt 与审计标识。显式 adapter 保留历史持久语义，同时给 CLI 一个稳定公开 ID。

## Consequences

新增或修改 Agent-facing operation 时必须同时更新 Catalog、真实 handler mapping、对应 Skill 和漂移测试；route coverage 会拒绝未分类的 HIS route。Agent runner 需要按岗位签发多个短期 Grant，并负责把原 token 安全注入进程环境。CLI 能覆盖当前完整 canonical HIS，但不等于交付模型 runner、嵌入式助手、MCP、OAuth/SMART、Evaluation Spec 或评分系统；这些表面只能在后续复用同一 Catalog 和服务端授权边界。
