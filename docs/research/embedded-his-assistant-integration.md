# 嵌入式 HIS 助手与 DeepSeek Harness 融合研究

## 范围与结论

- 状态：未来设计输入，不定义 ClinMesh 当前已实现行为。
- 核验日期：2026 年 8 月 22 日。
- 核验范围：DeepSeek Harness（DSH）、Multica、Microsoft Dragon Copilot、SMART App Launch、CDS Hooks 2.0、FHIR R5 HTTP，以及 ClinMesh 的[系统架构](../architecture.md)、[领域词汇](../../CONTEXT.md)和[Agent 运行时与评测融合研究](./agent-runtime-and-evaluation-integration.md)。
- 明确不在本轮处理：实现 Agent、评分机制、修改领域词汇或架构、复制 DSH Web UI、复用 Multica 源码。

首期产品仍应先完成可由人类医生操作的门诊业务闭环。未来第一个进入产品的 Agent 形态应是医生工作站内的嵌入式 HIS 助手，而不是自主执行完整任务的 Agent Run：医生在当前患者和 Encounter 上下文中提问，助手读取受限信息、导航、填写草稿和提出命令预览，医生复核后才由 ClinMesh 提交最终业务 Command。

DSH 适合拥有模型 Session、Turn、Step、工具循环和追加式事件日志；ClinMesh 必须拥有用户会话、助手线程、患者上下文、页面上下文、权限授予、临床草稿、人工复核、最终 Command 和审计。DSH 高层 SDK 的 `run()` 只是一次从 prompt receipt 到整个 Agent 再次 idle 的活动区间，不是 ClinMesh 产品对象，也不能当作一次消息的可靠结果边界。

推荐的核心关系是：

```text
Better Auth Human Session
  -> AssistantThread（ClinMesh，绑定 Actor + Patient + Encounter + Workspace/Epoch）
     -> DSH Session（1:1，模型历史和运行时事件）
        -> DSH Turn（一次实际进入循环的用户输入）
           -> DSH Step(s)（一次模型调用及其工具执行）

显式自主任务
  -> Agent Run（独立对象、独立 DSH Session；不复用交互侧栏线程）
```

本文用三类标签区分证据和设计：

- **来源事实**：由固定源码或官方规范直接证明。
- **ClinMesh 推论**：基于来源事实形成的项目设计建议，不声称来源项目已经这样实现。
- **未决问题**：实施前仍需 spike 或产品选择确认。

## 固定版本与证据边界

| 输入 | 固定版本 | 证据用途与限制 |
| --- | --- | --- |
| DeepSeek Harness | tag `dsh-v0.1.1-rc.2`，commit [`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`][dsh-tree]，2026-08-21，MIT | 核验 Session/Turn/Step、SDK wire、持久化、ConversationNode、ACP 和权限 preset；不把 DSH 产品 UI 当作 ClinMesh UI |
| Multica | commit [`722bde9d1818dbe5c49e60a8c57a283712646457`][multica-tree]，相对 `v0.4.30` 再前进 39 个提交，2026-08-20 | 核验 CLI/HTTP adapter、runtime registry、DSH adapter、task message、realtime 和不确定结果；当前版本采用含额外商业限制的 [Multica License][multica-license]，只作研究证据，不复制源码或 UI |
| CopilotKit | 核验时 HEAD commit [`e9387e04835545c45744b791aee7c9c03520be31`][copilotkit-tree] | 核验 `useCopilotReadable` 和 `useCopilotAction` 的结构化 app-state/action 模式；不直接采用 v1 hook，也不把前端 handler 当作临床授权边界 |
| AG-UI | 核验时 HEAD commit [`e42bdbedc27cdf982ed9b5de904215acd73a17fb`][agui-tree] | 核验 StateSnapshot/StateDelta 和 tool-call event flow；只借鉴事件同步，不用通用 JSON Patch 修改临床草稿 |
| Dragon Copilot | 2026-08-22 可见的 Microsoft 官方产品页 | 核验 EHR 内嵌、结构化文档、复核批准和 EHR transfer 的公开产品行为；不推断其内部协议或数据模型 |
| CDS Hooks 2.0 | 当前已发布 2.0 规范 | 核验 hook-specific context、建议、用户接受/拒绝和 stale guidance；不直接采用其全部 Cards wire |
| SMART App Launch | HL7 官方当前发布页 | 核验 EHR launch context、patient/encounter context 和最小 scope；ClinMesh 内部侧栏不需要实现一次 SMART OAuth launch |
| FHIR | R5 `5.0.0` HTTP 规范 | 核验 `meta.versionId`、弱 `ETag`、`If-Match` 和 `412 Precondition Failed`；领域原生 Command 仍使用自身 expected version |

Microsoft 官方页面公开说明 Dragon Copilot 可嵌入 Epic 等受支持 EHR；医生工作流生成可定制 notes，护士工作流把实时观察转为结构化 flowsheet documentation，再由护士快速 review and approval 后传入 EHR。[Dragon Copilot][dragon-copilot]因此能够证明“嵌入工作流、先生成、再复核、再转入 EHR”是成熟产品模式，但不能证明其使用何种页面快照、版本控制或内部 Agent runtime。

[CDS Hooks 2.0][cds-hooks]明确把 context 定义为当前 EHR workflow 特定的上下文，并把建议建模为用户可接受或拒绝的 Actions；规范还单列 stale guidance 风险。[SMART App Launch][smart-launch]把 patient、encounter 和授权 scope 作为 EHR launch 的结构化上下文。[FHIR R5 HTTP][fhir-http]则规定版本可由 `meta.versionId`/弱 `ETag` 表达，`If-Match` 不一致时返回 `412`。这三者共同支撑 ClinMesh 的结构化上下文、建议草稿和提交时版本复核，但具体 `PageContextSnapshot` 与 `UI Action Bridge` 是 ClinMesh 推论。

## 助手与自主 Agent 的边界

### 产品模式

| 模式 | 发起者与节奏 | 主要对象 | 可否直接成为 Agent Run |
| --- | --- | --- | --- |
| 嵌入式 HIS 助手 | 医生逐条发送；医生保持控制 | `AssistantThread`、`AssistantTurn`、草稿和复核记录 | 否 |
| 显式自主任务 | 用户明确给出目标、预算、权限、终止条件 | `AgentRun`、Runtime Profile、attempt 和评测输入 | 是 |
| 页面内自动建议 | 页面事件触发只读提示或草稿 | `PageContextSnapshot`、`DraftActionSet` | 否 |

**ClinMesh 推论：** 每次侧栏发送都创建 `AssistantTurn`，但不会创建 `AgentRun`。只有用户明确点击“交给 Agent 执行”并确认目标、能力范围、预算和终止条件时，系统才创建独立 Agent Run，并按[Agent 运行时与评测融合研究](./agent-runtime-and-evaluation-integration.md#自主运行的五个分离对象)冻结输入。自主运行不能悄悄继承侧栏线程的全部历史、临时页面选择或人类 cookie。

首个嵌入式助手推荐只支持：

- 查询当前患者、Encounter、已授权历史和目录；
- 导航到类型化页面或面板；
- 填写尚未签发的临床草稿；
- 请求服务端生成命令预览；
- 解释校验错误和展示来源。

首个版本不允许模型直接签发医嘱、签署病历、提交处方、收费、退费、结算或执行其他不可逆 Command。最终提交由医生在 ClinMesh 原生 review UI 中完成，审计上的最终 Actor 是人类，助手提案作为 Provenance 和关联记录保留。

### 对象与生命周期映射

| 对象 | 所有者 | 生命周期 | 关键不变量 |
| --- | --- | --- | --- |
| Better Auth session | ClinMesh / Better Auth | 浏览器登录到过期或注销 | 只证明 User Account 会话；不能直接交给 DSH |
| `AssistantThread` | ClinMesh | 可跨页面和浏览器连接，但不跨患者/Encounter scope | 绑定 owner、Actor、Practitioner Role、Location、Patient、Encounter、Workspace/Epoch 和 runtime profile |
| DSH process | Assistant Runtime | 可短于线程；启动、空闲回收、崩溃均是运行问题 | 不能成为产品线程身份，也不能持有 Better Auth cookie |
| DSH Session | DSH | 与一个 `AssistantThread` 1:1 | 追加式运行时日志和模型历史；不拥有临床状态 |
| `AssistantTurn` | ClinMesh | 从发送被服务端接受到归档结果 | 绑定一个 PageContextSnapshot 和 DSH message receipt；可能尚未映射到 DSH Turn |
| DSH Turn | DSH | `turn/start` 到 `turn/end` | 是实际模型循环边界；结局包括 completed、aborted、blocked、error、max-tokens、interrupted |
| DSH Step | DSH | `step/start` 到 `step/end` | 一次模型调用及其要求的工具执行 |
| `AgentRun` | ClinMesh | 一次自主 attempt | 不由普通侧栏消息创建；运行结果与临床结果分离 |

**来源事实：** DSH Session event map 是追加式事实源，消息历史从日志派生；Turn 和 Step 的边界及终局在[Session 类型][dsh-session-types]和[生命周期图][dsh-lifecycle]中明确。SDK `session/prompt` 只返回 queued message id，[高层 `run()`][dsh-sdk-client]在 receipt 后收集整个 session tree，直到根 Agent 下一次 idle。独立请求可以继续向同一 Session 排队，wire 不会给该 prompt 分配专属 assistant message 或 `turn/end`。[SDK server 合同][dsh-sdk-server]因此不能支持“一个 `run()` 就是一条产品消息结果”的假设。

**ClinMesh 推论：** `AssistantTurn` 应先记录 DSH `messageId`，等相同消息真正进入 `user/message` 且位于某个 DSH Turn 后，再补充 `dshTurnNumber`。首版每个线程同一时间只允许一个 active turn；后续消息进入可见队列，不使用 steering。这样能保留清晰交互，又不会假装 SDK 已提供 prompt-specific completion。

## Session、进程与恢复

### 生命周期必须分离

浏览器侧栏、AssistantThread、DSH Session 和 DSH process 是四个不同生命周期：

```text
浏览器断线 ───── 不删除 Thread，不自动取消已提交的 Command
侧栏关闭 ─────── 不等同于删除 DSH Session
进程空闲回收 ─── 不等同于结束产品 Thread
患者/Encounter 切换 ─ 必须切换 Thread，不能静默复用模型历史
Workspace reset ── 新 Epoch 使旧 Thread、snapshot 和 grant 全部失效
```

推荐让一个临床 `AssistantThread` 只绑定一个 Patient + Encounter。患者级历史仍可通过受限查询读取，但当前就诊边界不可由模型切换。用户打开另一患者或 Encounter 时，客户端应打开或创建另一线程；旧线程仍归档在原 scope 下。不得把新患者页面上下文注入旧患者 Session 后继续对话。

### 首版进程策略

| 方案 | 判断 | 原因 |
| --- | --- | --- |
| 一个 active Thread 一个 DSH process + 一个 DSH Session | 首个 spike 采用 | scope、取消、凭据、日志和故障边界最清晰 |
| 一个固定 process 多路承载多个 Session | 后置 | SDK server 可按 session id 建多个 Agent，但 initialize 固定 cwd/provider/model，且没有 per-session close；需要容量和隔离 spike |
| 浏览器直接持有 DSH process | 排除 | 浏览器连接不是可靠运行边界，也不能安全持有临床 capability |
| ACP 作为侧栏协议 | 排除首版 | ACP 有 prompt cancel，但只支持 fresh session，connection 拥有 session lifetime，且自身明确不是 UI integration |

[SDK wire 类型][dsh-sdk-protocol]当前只有 `initialize`、`session/prompt` 和 `shutdown` 三类 client request。[SDK server 已知限制][dsh-sdk-server]明确没有 per-session close 或 prompt cancel；SDK 创建的 Agent 一直存活到 process shutdown。DSH 的[持久化 seam][dsh-persistence]已经有 `prepare/load/inspect/readFrom/list`，冷恢复会保留崩溃前事件并追加 synthetic closers，把未闭合 Turn 标记为 interrupted，但现有 SDK wire 没有暴露 load/resume。

因此首个 read-only spike 必须明确写成“活动期会话”：进程只在一个受控空闲窗口内保活；进程退出后可以展示已归档的 ClinMesh transcript，但不能声称原 DSH Session 已跨进程恢复。要实现耐久侧栏，需要在固定 DSH composition 中新增窄化 ClinMesh runtime transport，至少提供：

- `thread/open`：创建或通过 persistence `prepare` 恢复指定 DSH Session；
- `turn/prompt`：返回稳定 message receipt，并流式发送 tagged events；
- `turn/cancel`：取消指定 Session 当前活动，不影响其他 Session；
- `thread/close`：达到 quiescence、flush、释放 Agent；
- `runtime/shutdown`：只负责整个 process。

这个 transport 应作为 ClinMesh 的 DSH 插件/adapter 独立维护，不修改 Session 核心语义。其协议必须版本化，并用固定 commit 的兼容测试证明恢复、取消和事件顺序；在这项 spike 通过前，不做共享 process pool。

### DSH 不变量如何映射

- DSH Session 是追加式模型历史，不是患者病历、页面状态或最终审计。
- DSH Session 与 `AssistantThread` 1:1；线程记录 DSH commit、composition hash、provider/model 和 persona 版本。
- DSH plugin composition 决定工具、prompt 和 provider 能力；助手线程应固定 Runtime Profile，composition 变化要新建线程或走显式迁移，不能后台静默替换。
- DSH [permission preset][dsh-presets] 在 Session 创建时固定，resume seed 保留原设置；它只组合 sandbox mode 与 approval policy，不是 ClinMesh 用户授予助手的临床权限。
- DSH [user approval][dsh-approval] 只在 open Turn 内有效，只有 allowed-once/rejected/cancelled/unavailable，没有耐久 grant、撤销或跨 Turn 授权；ClinMesh 必须拥有自己的 `AssistantPermissionGrant` 和 `ReviewDecision`。
- DSH [ACP adapter][dsh-acp] 支持 fresh session、cancel 和 one-shot permission request，但不支持 load/list/resume/delete/fork，也不提供 transcript replay、导航或 tool presentation；不能因为它有 cancel 就把它当成侧栏宿主。

## 结构化页面上下文

### 两段式信任边界

浏览器知道当前路由、面板、焦点和本地草稿；服务端知道登录身份、Actor、Membership、Practitioner Role、Patient、Encounter、Workspace/Epoch、资源版本和实际授权。Page Context 必须经过两段构造：

1. 浏览器发送类型化 `PageContextClaim`，只声明 route/view id、active section、选中资源引用和 draft id/revision。
2. Assistant Gateway 根据 Better Auth session 和服务端状态解析、校验并签发短期 `PageContextSnapshot`；身份、患者范围、资源版本和 capability 由服务端填充或确认。

模型只看到签发后的最小快照。禁止发送整页 DOM、任意 CSS selector、整个 TanStack Query cache、浏览器存储、自由文本页面 dump、隐藏 Scenario Fact、其他患者后台标签页或未授权字段。

建议的合同形状如下；它是设计输入，不是当前已实现类型：

```ts
interface PageContextSnapshot {
  version: 1
  id: string
  threadId: string
  workspace: { id: string; epoch: string }
  actor: {
    actorId: string
    practitionerRoleId: string
    locationId: string
  }
  scope: { patientId: string; encounterId: string }
  view: {
    viewId: string
    viewRevision: string
    activeSection?: string
    selectedResource?: VersionedResourceRef
  }
  resources: VersionedResourceRef[]
  draft?: {
    id: string
    kind: string
    revision: string
    baseResourceVersions: VersionedResourceRef[]
  }
  allowedOperationIds: string[]
  allowedUiActionTypes: string[]
  issuedAt: string
  expiresAt: string
}
```

`VersionedResourceRef` 对 FHIR 资源携带 `resourceType/id/meta.versionId`，对领域原生对象携带 `type/id/revision`。`viewRevision` 表示浏览器当前页面投影世代，不能替代服务端资源版本。snapshot 是一次 Turn 的输入证据，不是长期权限；新 Turn 必须取得新 snapshot。

### Context 变化规则

| 变化 | 处理 |
| --- | --- |
| 同一患者/Encounter 内切换 tab 或选中项 | 新建 snapshot；旧建议仍可读，但应用前重新检查 view/draft revision |
| 草稿被用户或另一页面修改 | 旧 `DraftActionSet` 标记 stale，不自动 rebase |
| 资源 `versionId`/revision 变化 | 预览或提交返回 stale conflict，要求重新读取并生成建议 |
| Practitioner Role 或 Location 切换 | 新建 Thread 或显式关闭旧 Thread；旧 grant 失效 |
| Patient 或 Encounter 切换 | 切换 Thread；旧 Session 不接收新 scope |
| Workspace reset 产生新 Epoch | 旧 Thread、snapshot、runtime lease、draft action 和 review grant 全部拒绝 |
| Better Auth session 过期或 Membership 被撤销 | 停止新 Turn 和工具调用；当前未提交建议保留只读审计状态 |

CDS Hooks 的 context 与 SMART launch context 证明结构化、工作流特定上下文是可行模式，但 ClinMesh 不能把这些标准误读成“客户端传来的 identity 可以直接信任”。身份和 capability 必须由 Gateway 重新绑定。

## 前端状态暴露与事件同步参考

### CopilotKit 的 state/action 模式

**来源事实：** CopilotKit 的 [`useCopilotReadable`][copilot-readable]把 app-state 和其他信息显式提供给 Copilot，并可通过 `parentId` 保留父子层级；[`useCopilotAction`][copilot-action]注册命名 action、参数、handler 和可选 render，文档说明参数类型可推导。当前 v1 文档同时建议迁移到 v2 `useFrontendTool`，因此这里核验的是模式，不是建议 ClinMesh 采用已后置的具体 hook。

**ClinMesh 推论：** `PageContextClaim` 可以借鉴 readable registry：由每个临床 view 注册自己允许暴露的语义字段和层级，侧栏只收集当前 active view 的 allowlisted values。`UI Action Bridge` 可以借鉴 action registry：每个 action 有稳定名称、参数 schema、handler 和专用呈现。但 ClinMesh registry 必须由 contracts/catalog 驱动，不能接受组件任意传入 `value: any`，也不能让浏览器 handler 成为最终医院 Command owner。

### AG-UI 的 snapshot/delta 与 tool events

**来源事实：** AG-UI 的 [State Management][agui-state]定义 `STATE_SNAPSHOT` 为完整 state baseline，断线或不一致时以前者整体替换；`STATE_DELTA` 使用 RFC 6902 JSON Patch 传递增量。[Events][agui-events]把工具调用拆成 `ToolCallStart -> ToolCallArgs* -> ToolCallEnd -> ToolCallResult`，并用 `toolCallId` 关联同一 logical stream。官方文档明确要求实现者处理 state conflict、resynchronization 和 security。

**ClinMesh 推论：** Assistant Gateway 可以借鉴 snapshot/delta 的同步形态和 `toolCallId` 关联方式：首次连接或 gap repair 发送完整只读投影，此后发送带 seq/base revision 的增量事件；检测缺口时重新取 snapshot。它不能直接采用 AG-UI 的通用 JSON Patch 作为临床草稿写协议，因为任意 JSON Pointer 无法表达字段级授权、Patient/Encounter scope、expected version 或业务不变量。

| 可借鉴 | ClinMesh 必须补充的边界 |
| --- | --- |
| 组件显式注册可读状态 | allowlist、字段脱敏、active view 选择、Gateway 重签名 |
| 命名 action + 参数 schema + handler | catalog owner、风险分级、只允许 view/draft proposal、最终服务端 Command |
| full snapshot + ordered delta | thread seq、snapshot/base revision、gap repair、stale rejection |
| `toolCallId` 关联 start/args/end/result | DSH callId、AssistantTurn、idempotency key、Command receipt 和审计关联 |
| human-in-the-loop render | ClinMesh `ReviewDecision`、一次性 grant、提交时重新鉴权 |

CopilotKit 和 AG-UI 都不提供 ClinMesh 所需的 Better Auth 身份解析、Workspace Membership、Practitioner Role、Patient/Encounter/Epoch 隔离、Hidden Fact 防泄漏、FHIR `If-Match` 或 domain expected-version 合同。它们是前端 state/action 与 event sync 的一手参考，不是服务端授权或临床并发控制方案，也不构成本项目引入依赖的决定。

## 类型化 UI Action Bridge

### Action 分类

DSH 不能执行浏览器 JavaScript、CSS selector、任意 URL 或任意表单 patch。模型只能提出 catalog 中注册的语义动作：

| Action | 示例 | 自动应用边界 |
| --- | --- | --- |
| `navigate` | 打开当前 Encounter 的检验申请页 | 仅允许 catalog target，且 scope 未变化 |
| `focusPanel` | 聚焦“诊断”面板 | 纯视图动作，可在 revision 匹配时应用 |
| `openResource` | 打开指定版本的 Observation | 先验证资源仍属于 scope 且用户可读 |
| `setDraftField` | 设置诊断草稿的疾病编码和主次标记 | 只写本地/服务端草稿，不触发临床 Command |
| `applyDraftPatch` | 应用 catalog 定义的多个字段变更 | patch 字段和类型由表单 schema 限定；禁止任意 JSON Patch |
| `requestPreview` | 请求检验申请或处方预览 | 调用只读 preview handler，返回校验、费用和风险信息 |
| `proposeCommand` | 创建待人工复核的 Command proposal | 只生成 review card；模型不能触发最终 submit |

每个动作必须携带 `actionId`、`threadId`、`assistantTurnId`、`contextSnapshotId`、`expectedViewRevision`，涉及草稿时再携带 `draftId` 和 `expectedDraftRevision`。浏览器 Action Bridge 只接受已注册 action type 和 target id；字段值通过该表单专用 schema 验证。

`submitReviewedCommand` 不是模型可调用的 UI Action。它是医生在 review card 上确认后，由 ClinMesh host 产生的受信事件：host 使用当前 Better Auth session 换取一次性 review grant，再调用 CommandExecutor。这样可以把“助手建议”和“人类提交”在权限与 Provenance 上分开。

### Draft 到提交的竞态合同

```text
Turn accepted with PageContextSnapshot C7
  -> DSH tool proposes DraftActionSet A4 based on draft revision R12
  -> Browser verifies C7, view revision and R12
  -> User applies A4 to draft, producing R13
  -> Server creates Command Preview P3 for R13 + resource versions
  -> User reviews P3 and confirms
  -> Host obtains one-shot ReviewGrant G2
  -> CommandExecutor re-authenticates and executes with expected R13/versions
  -> Receipt and Effect refs append to Assistant execution log
```

任何阶段发现 snapshot、draft、resource、role、scope、Epoch 或 grant 变化，都返回结构化 `stale_context`、`stale_draft`、`version_conflict` 或 `permission_changed`，保留原建议供阅读，但不静默套用到新状态。FHIR-native 写入使用 `If-Match`/`meta.versionId`；domain-native Command 使用同等语义的 expected version。客户端不得捕获 `412` 后自动把旧 patch 重放到新资源。

## HIS Operation Catalog 与 DSH Cordis 装配

### 一个定义源，多个窄 adapter

“CLI 风格 HIS 操作”应表现为稳定、可发现、可组合的命令语义。任务 Agent 通过当前 `clinmesh` CLI 执行这些操作；未来嵌入式临床助手可直接投影同一 `hisOperationCatalog`，无需获得通用 shell。每个定义至少声明：

- 稳定 `operationId` 和 schema version；
- `query / draft / preview / command` mode；
- 输入、结果和结构化错误 schema；
- 所需 Patient/Encounter/Page Context；
- 允许的 Practitioner Role 和风险级别；
- 幂等与 expected version 要求；
- 唯一 handler owner 标识；
- 可否暴露给 human CLI、Web、DSH tool。

示意定义：

```ts
defineHisOperation({
  operationId: 'outpatient.diagnosis.draft.set',
  mode: 'draft',
  input: diagnosisDraftInput,
  result: diagnosisDraftResult,
  context: ['patient', 'encounter', 'diagnosis-editor'],
  risk: 'draft-only',
  owner: 'outpatient-diagnosis',
})
```

Catalog 只拥有可跨运行时使用的合同和 adapter metadata，不引用 handler，也不拥有状态机。服务端医院业务模块把同一 operation definition 显式绑定到唯一 Query handler 或 Command handler；写入仍通过共享 CommandExecutor 执行。这个拆分让 `packages/contracts` 保持无平台依赖，同时用 server composition 检查每个可执行 operation 恰有一个 handler owner。建议从同一 catalog 生成或装配：

| Adapter | 面向消费者 | 责任 |
| --- | --- | --- |
| Human CLI | 开发、测试和受控运维 | 提供 `his encounter diagnosis draft-set ... --output json` 等命令；解析参数后调用 HTTP typed client |
| HTTP Gateway | Web、CLI、Assistant Runtime | 绑定认证上下文、验证 schema、执行 handler、返回统一 receipt/error |
| DSH Cordis tool adapter | 嵌入式助手 | 根据本 Turn capability 只注册/暴露允许的工具，用 typed client 直调 Assistant Gateway |
| Web typed client | ClinMesh 原生页面 | 由 contracts 生成或复用请求/响应类型；最终仍进入同一 Gateway/CommandExecutor |

**ClinMesh 推论：** “同一 catalog 派生 CLI + HTTP + Cordis”是 ClinMesh 的改进设计，不是 Multica 已有机制。Multica 的 Cobra commands、HTTP paths/bodies 和 daemon runtime registry 是分别维护的，不应把它描述成 schema-first catalog。

### Cordis 插件必须直接调用 typed client

推荐的 DSH tool 执行路径是：

```text
DSH ToolExecution.callId
  -> ClinMesh Cordis plugin
  -> AssistantGatewayClient.execute(operationId, typed input,
       runtimeLease, turnCapability, callId)
  -> HisOperationCatalog definition
  -> Query handler / CommandExecutor
  -> typed receipt or typed error
```

临床 Agent 不调用 `bash -c "his ..."`，也不由 shell 启动 CLI 子进程。直接 typed client 有以下必要优势：

- 不需要 shell、filesystem 或继承用户环境变量；
- 避免 quoting、命令注入和平台差异；
- 嵌套临床输入保持结构化 schema，不经过字符串序列化；
- DSH `callId`、AssistantTurn、idempotency key 和 Command receipt 可端到端关联；
- deadline、取消和“已发送但结果未知”可以保留机器可判定状态；
- Gateway 能覆盖并拒绝模型伪造的 identity/scope 字段。

Cordis plugin 可以把 catalog definition 转成窄 DSH Tool schema，并在 execute 中调用 client；`packages/contracts` 和医院业务核心不依赖 DSH。关于 stock MCP 丢失 Harness `callId` 的证据和为什么首选 Cordis adapter，详细事实归属在[Agent 运行时与评测融合研究](./agent-runtime-and-evaluation-integration.md#tool-adapter身份与授权)，本文不重复定义另一套工具协议。

首期工具名应按临床意图命名，例如 `read_patient_summary`、`search_diagnosis_catalog`、`set_diagnosis_draft`、`preview_lab_order`，不要暴露任意 method/path/body、FHIR Bundle、SQL、URL、DOM selector 或通用 `execute_his_command`。CLI 可以有层级命令体验，模型工具仍应保持一项意图一个窄 schema。

### 动态能力装配的限制

Runtime Profile 可以装配 catalog 的候选工具集合，但模型实际看到和能调用的集合必须按 Turn 再收窄。推荐由 Cordis plugin 读取受信 Turn Capability，把允许定义投影为本次请求的 tool list；DSH 会把实际 request header 和 tool schema 记入 Session 日志。[Session 类型][dsh-session-types]允许 `request/header` 记录 initial、resume 和 change。

**未决问题：** 需要 spike 验证 session-scoped 动态 tool filtering 与 DSH prompt/tool assembly 的顺序、cache 影响和并发隔离。无论模型侧 tool list 是否能动态收窄，Gateway 都必须再次计算权限交集；Harness 内过滤只能改善模型体验，不能成为最终授权。

## 多用户认证、授予和审计

### 权限交集

每次工具调用和每次 review submit 都重新计算：

```text
Authenticated User permissions
∩ User-granted Assistant permissions
∩ Workspace Membership
∩ Practitioner Role + Location
∩ Patient + Encounter + Workspace + Epoch scope
∩ current PageContextSnapshot
∩ HisOperation definition + Tool Risk Policy
∩ current object state + expected versions
= Effective Assistant Capability
```

任何一项缺失都拒绝。`AssistantPermissionGrant` 是 ClinMesh 对象，记录用户明确授予该助手线程的能力类、scope、有效期和撤销状态；它默认只读和 draft-only，不能由 DSH preset、system prompt 或模型参数扩大。

### 身份链

1. 浏览器使用 Better Auth session 调用 Assistant Gateway。
2. Gateway 解析 User Account、Workspace Membership、Actor、Practitioner Role 和 Location，不信任客户端传入的身份 header。
3. Assistant Runtime 使用独立 Agent client 身份和短期 `RuntimeLeaseToken`，不接收人类 cookie、refresh token 或 Better Auth session token。
4. 每个 Turn 再签发更短的 `TurnCapabilityToken`，绑定 thread、DSH Session、AssistantTurn、PageContextSnapshot、Patient、Encounter、Workspace/Epoch、operation allowlist、policy version 和真实时间期限。
5. 模型参数中的 `userId`、`actorId`、`patientId`、`encounterId` 或 `workspaceId` 只能作为与 token 一致的断言，不能切换身份或 scope；更好的 schema 是完全不暴露这些字段。

`AssistantThread` 默认是 owner-private 对话。同一患者上不同用户的临床状态可以共享，但 transcript、草稿建议和权限 grant 不自动共享。线程恢复时必须再次验证当前用户仍拥有原 Workspace Membership 和 Practitioner Role；离职、角色切换、患者脱敏规则变化或 Epoch reset 都使旧 lease 失效。

审计至少区分：

- `requestedByUserAccountId`：谁发送了侧栏消息；
- `runtimeActorId`：哪个 Assistant runtime client 执行了查询或草稿工具；
- `delegatedBy`：该 runtime 权限来自哪个用户和 grant；
- `representedPractitionerRoleId`：当前岗位上下文；
- `proposedByAssistantThread/Turn`：哪个建议产生了草稿或 preview；
- `submittedByHumanActorId`：谁最终复核并提交 Command。

首版人工复核提交时，最终 Command Actor 是人类；助手只作为提案来源。未来若允许自主 Agent 直接提交，则必须使用独立 Agent Actor 和 AgentRun capability，不能沿用侧栏的 human-reviewed Provenance 语义。

## Assistant Gateway、事件与重连

### 双日志

| 日志 | 所有者 | 内容 | 用途 |
| --- | --- | --- | --- |
| DSH Session log | DSH / Assistant Runtime | 原始 Session events、Turn/Step、工具调用和结果 | 模型历史、运行时诊断、恢复 |
| Assistant execution log | ClinMesh | 归一化 user/assistant message、turn status、tool proposal、draft/review/Command receipt refs | 产品 transcript、重连、审计和权限安全视图 |
| ActionTrace / AuditEvent / Provenance | ClinMesh 医院内核 | 实际 Query/Command 访问和 Effect | 权威业务与安全审计 |

Assistant execution log 不保存 Hidden Fact，也不把 chain-of-thought 当作产品数据。DSH event 可通过 `dshSessionId + eventSeq` 引用；临床业务结论必须来自 Command receipt 和医院权威状态，而不是 assistant 文本。

### Realtime 与 catch-up

建议每个 `AssistantEvent` 有线程内单调 `seq`、稳定 event id、AssistantTurn id、可选 DSH event ref 和服务端时间。WebSocket/SSE 只负责低延迟推送；同一 payload 同时可由 `GET /assistant/threads/{id}/events?afterSeq=` 补齐。客户端发现断线、seq gap 或重连时先 catch-up，再继续消费 live stream。

这吸收了 Multica 把 execution messages 持久化、通过 `since` 补齐并同时广播的机制，但 ClinMesh 事件类型和授权范围独立定义。TanStack Query 拥有线程和事件服务端状态；Zustand 只保存侧栏开合、选中 thread、composer draft 等视图状态，不镜像完整 transcript。

DSH 的 [ConversationNode contract][dsh-conversation]和[client runtime][dsh-client-runtime]证明可以把事件按稳定 `{kind,id}` 聚合为增量 view nodes，并在 open/resync/gap repair 时替换窗口。ClinMesh 可以借鉴稳定 node identity 和 gap repair 思路，但 ConversationNode 是 DSH 客户端投影层，不是临床状态、权限或 runtime control 合同；ClinMesh 侧栏应投影自己的 `AssistantEvent`，不直接把 DSH Web client package 嵌入产品。

## 取消、故障与不确定结果

### 取消边界

- 关闭侧栏或浏览器断线不自动回滚或删除 Turn；Runtime 可以继续到受控终点。
- 用户显式 cancel 表示停止后续模型决策，不表示撤销已提交的医院事实。
- stock SDK wire 没有 prompt cancel。首个一线程一进程 spike 可通过终止整个 process 实现粗粒度取消，并把 Turn 标记 interrupted；它会结束该活动会话，不能假装是可继续的 prompt cancel。
- 耐久版本必须通过前述 `turn/cancel` transport 调用 DSH 的 Session/Agent 取消能力，并等待 quiescence；ACP 的 cancel 语义可作源码参考，但 ACP 本身不承担侧栏协议。
- Patient/Encounter 切换时，旧 Turn 输出仍只进入旧 Thread；所有基于旧 context 的 UI action 和 Command proposal 都失效。无法立即取消时也不能污染新页面。

### 写调用的不确定结果

每次有副作用的 adapter 调用由受信端根据 `assistantTurnId + dshCallId + operationVersion` 派生 idempotency key，并携带 expected version。若 transport 能证明请求未发送，可以重试；若请求可能已到达但响应丢失，则状态是 `ambiguous`，不能换 transport 或立即重发。

处理顺序是：

1. 记录 ambiguous receipt 和 correlation id；
2. 查询 Command receipt / ActionTrace / canonical state；
3. 已 committed 则返回原 receipt；
4. 已 rejected 则返回结构化拒绝；
5. 仍未知则停止自动决策并要求人工确认或后台 reconciliation。

Multica 的 [WebSocket RPC][multica-wsrpc]明确区分 definitely-not-sent 与 sent-but-uncertain：后者不能立即 HTTP fallback，否则可能 double claim。ClinMesh 应吸收这个语义到所有 Command adapter，而不是照搬其任务 claim 代码。

进程崩溃后，DSH persistence 会把无结果 tool call 标成未知并引导验证副作用；但 ClinMesh 仍以自己的 idempotency receipt 和 ActionTrace 为权威。恢复模型历史不能自动重放最后一个写工具。

## Multica 可借鉴与不可照搬

### 来源事实

- Multica human CLI 使用 Cobra [手工注册 issue 命令][multica-issue-cli]，并由 [APIClient][multica-api-client]统一附加 Bearer、Workspace、Agent、Task 和 client identity headers；issue 等命令各自构造 HTTP path/body。它不是统一 schema catalog。
- `mat_` task token 由服务端在 claim 时绑定 user、agent、task、workspace；[auth middleware][multica-auth]覆盖客户端伪造的 Agent/Task/Workspace headers。人类本地命令另有 guard，task API command 仍可用。
- [daemon runtime registry][multica-runtime-registry]把 runtime identity、protocol family 和 command name 分开；[Multica DSH adapter][multica-dsh]使用自定义 versioned JSONL stdio，execute 可携带 cwd、prompt、resume session id、model 和 MCP，并为每个 task 启动进程。它不是 stock DSH SDK wire 已支持 resume 的证据。
- [task_message 表和 handler][multica-task-messages]把 execution messages 追加持久化、广播，并支持 `since` catch-up。
- [WebSocket RPC][multica-wsrpc]复用与 HTTP 相同 request/response body，并对已发送但响应未知的请求延迟 fallback。

### ClinMesh 推论

| 机制 | 取舍 |
| --- | --- |
| 服务端 handler 拥有业务校验和授权，多入口只做 adapter | 采用 |
| 人类身份与 runtime 短期身份分离，服务端覆盖受信 context | 采用 |
| execution event append + realtime + catch-up | 采用 |
| definitely-not-sent 与 ambiguous outcome 分离 | 采用 |
| 一个 schema-first HIS catalog 派生 CLI/HTTP/Cordis | ClinMesh 新设计，不归因于 Multica |
| 临床 Agent 通过 shell 调通用 CLI | 排除 |
| 复制 Multica daemon、task queue 或 DSH custom wire | 排除；只借鉴合同 |
| 复制 Multica UI 或源码 | 排除；当前许可证含 hosted/embedding/branding 附加条件 |

## ClinMesh 原生侧栏

首个嵌入式助手应使用 ClinMesh 自己的 shadcn/Base UI 组件、路由和临床设计 token，作为医生工作站右侧可收起面板；不 iframe 或复用 DSH Web UI。DSH client UI 面向通用 workspace/session、model、tool 和 permission preset，无法拥有患者横幅、Encounter scope、临床草稿 diff、Command preview 和人工签署责任。

侧栏首个可用信息结构：

- 顶部固定显示当前 Patient、Encounter、Practitioner Role 和 context freshness；患者切换会切线程；
- transcript 只显示用户内容、已提交 assistant 内容、来源和受控工具状态，不展示 chain-of-thought；
- action card 显示“建议修改什么、基于哪个版本、将影响什么”，draft change 采用字段 diff；
- review card 把 preview、校验、风险和最终提交按钮放在 ClinMesh host，不放在模型消息 Markdown 中；
- composer 在 running 时提供可见 queue 和 cancel；首版不提供 steer；
- stale、permission changed、ambiguous outcome 都有独立状态，不用普通红色 toast 掩盖；
- 普通医生不看到 DSH process、Session id、provider、permission preset 或 composition 配置。

这个侧栏可以在没有模型的情况下先用 deterministic fixture 验证 Page Context、draft patch、review 和 stale race。这样 UI/UX 与业务合同先稳定，后续 DSH 只替换建议来源，不反向决定临床交互。

## 分阶段路线

### Phase 0：Agent 无关的业务基础

完成医生门诊闭环、诊断/医嘱/检验/病历草稿、Command preview、expected version、ActionTrace 和权限模型。建立最小 `HisOperationCatalog`，先服务 Web typed client 和测试 CLI。此阶段不启动 DSH。

### Phase 1：Context 与 Action Bridge 原型

实现 `PageContextClaim -> PageContextSnapshot`、类型化 navigate/open/draft actions、字段 diff、review card 和 stale rejection。使用固定 fixture 或规则引擎产生建议，覆盖患者切换、草稿并发修改、Epoch reset 和权限撤销。

### Phase 2：ClinMesh 助手侧栏壳

实现 `AssistantThread`、`AssistantTurn`、execution log、realtime/catch-up、队列和取消 UI。仍可使用 fake runtime，确保断线重连和多用户隔离不依赖 DSH。

### Phase 3：DSH read-only/draft-only spike

一个 active Thread 一个 process/Session，固定 DSH commit 和 composition；Cordis plugin 用 typed client 调 Assistant Gateway，只开放查询、导航和草稿工具。明确不支持跨进程 resume，不提供自主 Agent Run，不做评分。

### Phase 4：人工复核的临床草稿

接通诊断草稿、检验申请预览、病历草稿等 golden path。模型只能 propose；医生通过 ClinMesh host review 后提交。验证 callId、AssistantTurn、preview、ReviewGrant、Command receipt、Effect 和 Provenance 全链路。

### Phase 5：耐久恢复与运行治理

完成 `thread/open` resume、`turn/cancel`、`thread/close`、persistence 加密与保留策略、容量限制、idle suspend、进程故障和 ambiguous reconciliation。之后再根据测量决定是否一个 process 多 Session。

### Phase 6：显式自主 Agent

只有人类闭环和嵌入式助手稳定后，才按[Agent 运行时与评测融合研究](./agent-runtime-and-evaluation-integration.md)设计独立 Agent Run、Runner 和 evaluator。侧栏线程不会自动升级成 Run。

## 实施前验证 Spikes

| Spike | 必须证明 | 失败时的保守选择 |
| --- | --- | --- |
| DSH message receipt 到 Turn 关联 | queued message id 可稳定关联实际 `user/message`、Turn 和 terminal reason | AssistantTurn 只展示 runtime interval，不宣称 prompt-specific outcome |
| Cordis catalog projection | 每 Turn 工具过滤、request/header 记录和并发 Session 隔离正确 | 固定最小工具集，Gateway 逐次拒绝越界调用 |
| persistence resume transport | `prepare`、synthetic interrupted close、恢复后新 Turn 和权限 preset 不变量 | 新建 DSH Session，旧线程只读归档 |
| cancel transport | 只取消目标 Session，等待 quiescence，不影响其他线程 | 一线程一进程并终止整个 process |
| Page Context race | 页面、草稿、资源、角色和 Epoch 任一变化都 fail closed | 只允许只读回答，不提供 draft action |
| typed Action Bridge | 无任意 selector/JS/JSON Patch，所有字段由 form schema 约束 | 只显示文字建议，不自动填表 |
| uncertain command outcome | sent/not-sent 可区分，idempotency receipt 可重查 | 停止自动重试并转人工 reconciliation |
| process capacity | active/idle process 的内存、启动时延和并发上限可接受 | 限制同时 active thread 数，不提前共享 process |

## 未决问题

1. `AssistantThread` 默认应严格绑定 Encounter，还是允许一个 patient-level 线程在 Encounter 间只读浏览。推荐首版 Encounter-bound。
2. 用户可授予的首版能力是否只到 read + draft + preview。推荐是；任何 direct command 都后置到独立风险设计。
3. DSH raw Session log、assistant transcript 和临床审计分别保留多久，哪些字段需要加密、脱敏或禁止进入模型 provider。
4. 模型 provider 的部署地域、数据出境和合成数据边界如何固定到 Runtime Profile；在确定前不接入真实数据，仓库继续只使用合成患者。
5. Thread runtime profile 或 tool catalog 升级时，是强制新建线程还是提供显式 migration。推荐首版强制新建。
6. 同一用户是否允许多个浏览器 tab 同时控制一个 Thread。推荐单 active controller、其他连接只读，避免重复发送和 review race。
7. 长期是否需要共享 process pool。只有 resume/close、session-level resource accounting 和通知隔离 spike 通过后再决定。

## 固定源码与官方来源

### DeepSeek Harness

- [源码树][dsh-tree]
- [Session event、Turn/Step 与 request header][dsh-session-types]
- [Agent Turn/Step 生命周期][dsh-lifecycle]
- [SDK client `run()` 活动区间][dsh-sdk-client]
- [SDK server 合同与限制][dsh-sdk-server]
- [SDK wire request/notification 类型][dsh-sdk-protocol]
- [Session persistence seam][dsh-persistence]
- [ConversationNode contract][dsh-conversation]
- [Client runtime 的 queue、projection 和 assembly][dsh-client-runtime]
- [ACP adapter 合同与限制][dsh-acp]
- [One-shot user approval][dsh-approval]
- [Permission presets][dsh-presets]

### Multica

- [源码树][multica-tree]
- [Cobra issue 命令注册][multica-issue-cli]
- [CLI APIClient 和 context headers][multica-api-client]
- [daemon runtime registry][multica-runtime-registry]
- [DSH custom runtime adapter][multica-dsh]
- [task execution message 持久化和 catch-up][multica-task-messages]
- [WebSocket RPC uncertain outcome][multica-wsrpc]
- [task token 认证上下文覆盖][multica-auth]
- [Multica License][multica-license]

### 医疗产品与标准

- [Microsoft Dragon Copilot][dragon-copilot]
- [CDS Hooks 2.0][cds-hooks]
- [SMART App Launch][smart-launch]
- [FHIR R5 HTTP][fhir-http]

### 前端 Agent 交互

- [CopilotKit `useCopilotReadable`][copilot-readable]
- [CopilotKit `useCopilotAction`][copilot-action]
- [AG-UI State Management][agui-state]
- [AG-UI Events][agui-events]

[dsh-tree]: https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
[dsh-session-types]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/src/types.ts#L152-L308
[dsh-lifecycle]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/agent-lifecycle.md#L19-L80
[dsh-sdk-client]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/sdk/client/src/api.ts#L82-L228
[dsh-sdk-server]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/sdk/server/README.md#L5-L45
[dsh-sdk-protocol]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/sdk/protocol/src/types.ts#L33-L104
[dsh-persistence]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-persistence/README.md#L5-L38
[dsh-conversation]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/runtime/src/client/contract/conversation.ts#L104-L227
[dsh-client-runtime]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/runtime/README.md#L43-L55
[dsh-acp]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/acp/acp/README.md#L20-L81
[dsh-approval]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/interaction/user-approval/README.md#L5-L13
[dsh-presets]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/interaction/permission-presets/README.md#L5-L13
[multica-tree]: https://github.com/multica-ai/multica/tree/722bde9d1818dbe5c49e60a8c57a283712646457
[multica-issue-cli]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/cmd/multica/cmd_issue.go#L166-L340
[multica-api-client]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/internal/cli/client.go#L46-L215
[multica-runtime-registry]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/pkg/agent/builtin_runtimes.go#L8-L158
[multica-dsh]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/pkg/agent/dsh.go#L18-L270
[multica-task-messages]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/internal/handler/daemon.go#L4380-L4642
[multica-wsrpc]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/internal/daemon/wsrpc.go#L15-L365
[multica-auth]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/internal/middleware/auth.go#L51-L111
[multica-license]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/LICENSE
[copilotkit-tree]: https://github.com/CopilotKit/CopilotKit/tree/e9387e04835545c45744b791aee7c9c03520be31
[copilot-readable]: https://github.com/CopilotKit/CopilotKit/blob/e9387e04835545c45744b791aee7c9c03520be31/showcase/shell-docs/src/content/reference/v1/hooks/useCopilotReadable.mdx#L1-L65
[copilot-action]: https://github.com/CopilotKit/CopilotKit/blob/e9387e04835545c45744b791aee7c9c03520be31/showcase/shell-docs/src/content/reference/v1/hooks/useCopilotAction.mdx#L13-L32
[agui-tree]: https://github.com/ag-ui-protocol/ag-ui/tree/e42bdbedc27cdf982ed9b5de904215acd73a17fb
[agui-state]: https://github.com/ag-ui-protocol/ag-ui/blob/e42bdbedc27cdf982ed9b5de904215acd73a17fb/docs/concepts/state.mdx#L33-L138
[agui-events]: https://github.com/ag-ui-protocol/ag-ui/blob/e42bdbedc27cdf982ed9b5de904215acd73a17fb/docs/concepts/events.mdx#L279-L479
[dragon-copilot]: https://www.microsoft.com/en-us/health-solutions/clinical-workflow/dragon-copilot
[cds-hooks]: https://cds-hooks.hl7.org/2.0/
[smart-launch]: https://hl7.org/fhir/smart-app-launch/app-launch.html
[fhir-http]: https://hl7.org/fhir/R5/http.html
