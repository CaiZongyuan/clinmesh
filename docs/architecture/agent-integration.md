# Agent 接入与能力边界

本文拥有 DSH Surface、Page Context、Tool、人工审阅与 Agent CLI 的接入及信任边界。系统总入口见[系统架构](../architecture.md)，业务验证要求见[测试策略](../testing.md)。

<a id="7-agent-适配器与能力边界"></a>

## 7. Agent 适配器与能力边界

页面控制、结构化表单读取、真实执行反馈和人工审阅的详细行为见 [DSH 页面操作与视觉反馈](../agent-capabilities.md)。

当前 DSH 集成只服务 Web Profile 中的原生 Session。`dsh-react-surface` 提供 React Surface、布局和 Session-scoped capability lease，`dsh-ag-ui/browser-tools` 提供 always-on browser Tool broker；AG-UI Gateway 不参与该链路，也不需要单独的 model route 或 shared secret。DSH 拥有模型 transcript，ClinMesh 不复制 Assistant message 或 reasoning。

ClinMesh Profile 通过 `apps/dsh-web/cordis.patch.yml` 声明业务 preset `clinmesh-assistant`，并将其设为 registry 默认值；用户保存的 `selectedDefault` 优先。该 preset 挂载医院 persona、`ask_user_question` 与 compaction，业务 Tools 仍由当前 Surface 动态发布，不挂载 Bash、文件读写或工程 `AGENTS.md` 加载器。`standard` 保留用于开发排障。Preset 是能力装配与运行指引，服务端授权和人工审阅仍独立执行；更改 preset 后须以新会话验证，既有运行 Agent 不自动替换组合。业务使用与恢复见 [DSH 页面操作](../agent-capabilities.md#业务会话)，设计取舍见 [业务 Agent Harness](../decisions/implemented/architecture/2026-10-07-dsh-business-agent-harness.md)。

<a id="71-surface-与-host-边界"></a>

### 7.1 Surface 与 Host 边界

`apps/dsh-web` 把完整 `apps/web` application 作为第二个 adapter：

- Surface 使用 Memory Router，应用位置不修改 DSH document pathname。
- 每个 mount 创建独立 QueryClient；服务端状态仍只由 TanStack Query 拥有。
- DSH 拥有 Surface 的生效语言，adapter 订阅宿主语言并传入 Web runtime。中文语言标识使用 `zh-CN`，其他有效标识使用 `en-US`，缺失或无效标识回退到 `zh-CN`。ClinMesh 保留业务翻译字典，页面、宿主医院导航、浮层、登录与错误界面统一使用生效语言；隐藏期间持续同步，切换保留路由与草稿。Surface 不提供独立语言选择，不改写宿主文档语言或独立 Web 的本地语言偏好；独立 Web 保留原有语言设置。决策理由见[宿主语言归属](../decisions/implemented/architecture/2026-09-16-dsh-host-locale-ownership.md)。
- DSH 设置的通用页通过官方 slot 提供“ClinMesh 字号”，标准、较大、大三级只影响 ClinMesh，独立于会话字号。设置可在 Surface 打开前使用，已挂载和隐藏的工作台即时更新并保留页面、登录及草稿。医院导航移除通用入口，旧 Surface `/settings` 地址回到当前岗位，组件开发入口保留；独立 Web 继续提供原有字号控件。浏览器持久化、旧偏好继承及失败回退见 [DSH 字号设置](../decisions/implemented/architecture/2026-09-16-dsh-font-size-settings.md)。
- ClinMesh 插件在 Profile 加载时通过官方 `sidebar.brand.mark` / `sidebar.brand.name` 插槽固定左侧栏的现有 ClinMesh Logo 与名称，不依赖应用是否打开；新会话中央标志使用 `conversation.hero.brand.mark` 插槽，标题沿用 ClinMesh 的中英文产品标语；插件卸载后释放插槽并恢复宿主标题。DSH 拥有 Light/Dark/System theme；ClinMesh Surface 始终应用宿主 resolved theme，不提供独立主题选择，也不改写已保存的 Web 主题偏好。宿主底部按钮为“医院工作台”，打开后的菜单标题为“设置”。主题样式只作用于 Surface root，所有浮层通过注入 Portal 留在 ShadowRoot。
- DSH 左栏默认收起，允许手动展开；两种形态只保留品牌、已授权岗位及底部入口。原生会话与工作区操作由对话区标题栏的历史弹层提供，读写和搜索由 DSH 公共控制器拥有；界面、错误边界和显示兼容规则见[紧凑侧栏与会话历史](../decisions/implemented/architecture/2026-10-06-dsh-workspace-session-history.md)。
- 默认 `workspace` 左右分屏，窄空间按比例收缩并由应用内部响应式适配；全屏仅由用户手动选择，现有页头提供返回分屏入口。会话可独立收起，原生文件栏随之隐藏并保留状态，左侧宿主导航仍可使用，详见[Surface 会话整体收起](../decisions/implemented/feature/2026-09-15-surface-conversation-collapse.md)。切换保留原生侧栏状态、分栏偏好与应用草稿，详见[手动全屏与容器响应式](../decisions/implemented/bug-fix/2026-09-11-surface-responsive-layout.md)。
- `/clinmesh-api` Host 代理只连接配置固定的 loopback Hono，保留 Cookie/Origin，限制路径、方法、请求体、响应体和超时，不记录患者正文。

该模式只信任安装在同一 DSH Web Profile 的插件，并只处理合成数据。它不是不可信 marketplace 插件或真实患者数据的安全边界。

<a id="72-page-context"></a>

### 7.2 Page Context

浏览器提交由 `packages/contracts` 验证的 `PageContextClaim`，以及当前 DSH Session、Surface client ID 和单调递增的 client revision。Claim 只包含 view、active section、单个选择、草稿引用、加载/错误状态和受限搜索文本。Hono 从当前 session 重新解析 User Account、Actor、Practitioner Role、Workspace/Epoch、Scenario Run 和岗位允许 view，并在同一个 SQLite 写事务中重新读取 selection、Patient/Encounter 版本和资源状态，再签发五分钟 `PageContextSnapshot` 与不可伪造 token。旧请求晚于新 revision 到达时返回 superseded，不撤销较新的 context。

snapshot 包含短期 context ID、DSH Session 和 page scope。Actor、岗位、Workspace/Epoch、DSH Session、view、active section、selection 或受信资源版本变化会改变 scope 并移除旧 Tools；其他页面状态或 TTL 续签只替换 context，但同样关闭绑定旧 context 的 pending review。首次 Page Context 和 registration 不等待 capability status，因为 registration 是 DSH bridge 开始可用性探测和 lease 获取的前提。lease 曾进入 `active` 后，`contended`、`error`、`unavailable` 或 `idle` 会撤下当前 binding，并以同一 Surface client 的下一 revision 重签和重新注册；publisher 自身替换 registration 产生的 `connecting` 只关闭 pending review，不再次重签刚发布的 context。每条 Surface client revision 链只撤销自己的旧 context；浏览器 Web Lock 与 DSH lease 决定哪个 client 可以取得 execution proof，因此尚未取得 leadership 的 contender registration 不会撤销 leader context。前端在到期前一分钟携带 AbortSignal 续签，失败时有界重试，并在真实到期时主动注销 Tools。普通已授权 pending call 可以在旧 context 被正常替换后提交结果；人工批准必须先在线性化的 decision gate 中重新验证 active context、当前资源、当前人类身份和 active Epoch。

Claim 和 snapshot 不包含 DOM、Query cache、浏览器存储、任意页面 dump、其他患者标签页、完整患者档案、Case Truth、Hidden Fact、Reveal Policy、Scenario authoring truth 或生成 prompt。

模型参数使用稳定 `scopeKey` 与语义 `pageRevision`。`agentPageBindingRevision` 由 claim 的 `viewRevision` 与草稿引用 `[kind, id, revision, dirty]` 序列化生成；没有草稿时使用 `null`。短期 Context ID、TTL 与 `ui.loading/ready` 不参与该值，因此只续签或切换加载状态时，模型绑定 schema 不变。岗位、会话、对象与资源版本仍受 page scope 限定，医生当前病例的纯查询由执行桥接绑定，允许同病例栏目、草稿与内容更新；其他操作仍精确绑定。医生 Surface 的 `taskEpoch` 在账户、岗位、Session、病例或页面对象变化时更新，正常内容更新与同病例栏目切换保留；切走再切回也不能恢复旧任务。人工审阅继续按短期 context 与页面版本严格失效。

<a id="73-tool-目录与风险"></a>

### 7.3 Tool 目录与风险

`packages/contracts/src/agent.ts` 是 Tool 名称、operation、岗位、view、诊疗栏目、模式和风险的可执行目录，`agent-tool-input.ts` 拥有每项 operation 的完整输入 schema。每个岗位、view 与当前栏目动态获得不超过 32 个 Tools（DSH browser Tool broker 的单次注册上限）：通用读取/导航/真实聚焦，加上当前管理员、挂号、分诊、医生、收费或药房页面的窄动作。医生“接诊”页按当前诊疗栏目发布：目录中声明栏目的 Tool 只在 claim 的 active section 等于该栏目时进入 Page Context，Server 授权与 Surface 注册调用同一个 `agentToolsForContext`；栏目归属见 [DSH 页面操作](../agent-capabilities.md#医生诊疗栏目与-tool-发布)。管理员只能读取 Scenario Run、Provider 可用性和当前 generation job 状态；导航 enum 只包含当前岗位主页和共享设置页。

报告更正 Tool 只在当前账户通过服务端 membership 仍持有 active administrator role 时进入 outpatient-doctor Page Context；普通医生即使面对可更正报告也不会取得该 operation。管理员账户可在 acting-doctor 页面准备更正，Page Context 的当前 Practitioner Role 必须继续匹配最终 Command receipt 与 Audit Event。

| 模式 | 当前行为 |
| --- | --- |
| `query` | 读取当前 Page Context、岗位队列或当前受权对象；不返回隐藏真值 |
| `ui` | 在允许页面内导航、选择对象或聚焦区域 |
| `draft` | 填写或保存未提交患者、分诊、临床、收费或药房草稿；页面 action 保留完整格式与范围校验 |
| `preview` | 调用既有只读 preview，不提交正式业务 Effect |
| `proposal` | 打开 ClinMesh 原生人工审阅；Agent 不提交正式 Command |

不提供通用 `execute_action`、任意 method/path/body、FHIR write、Bundle、SQL、URL、DOM selector、JavaScript、JSON Patch 或 `runAs`。DSH Tool runtime 只接受其强制 JSON Schema 子集；医生已选病例时的当前页面、病例与授权历史纯查询只接收业务参数，Context 与任务由桥接核对；其余 Tool 的 `scopeKey` 与 `pageRevision` 以单值 `const` 绑定，模型显式传入，短期 `contextId` 由执行桥接管理。Surface adapter 投影 broker 支持的关键词，Web action 和 Hono 在 authorization 持久化前都使用同一 operation/input schema 执行完整长度、格式、数组和数值范围校验；action result 先按标准 JSON 语义省略对象中的 `undefined` 再验证，不可序列化结果仍失败且不能用超长二次错误覆盖原因。

<a id="74-execution-proof-与调用记录"></a>

### 7.4 Execution proof 与调用记录

DSH Host 将受信医生 RPC 输入与 inbox、原生回合、Session header 和 `tool/call` 关联，在 `tools/pre-execute` 核对原请求目录、Tool 名及已记录输入，再捕获执行时绑定。Header 或 `source.kind === 'user'` 单独不能证明真实来源。只保留消息引用、正文 hash 和绑定元数据，不复制 transcript 或 reasoning，不修改 arguments；来源与许可状态有界且在结束、取消或卸载时清理。

Proof 协议为 `version: 3`，包括原请求绑定、原医生任务锚点与实际执行 Context；Page Context token、snapshot 和 receipt 保持 `version: 1`。Hono 验证签名、当前身份、Session、岗位/view、Tool catalog 与防重放；医生接诊工具必须带原任务来源，医生 Context 必须有 `taskEpoch`，旧客户端明确拒绝。纯查询外层 broker 允许历史字段抵达 Surface，内层只剥离两项旧绑定并继续严格校验业务输入。原任务、原请求和当前对象必须一致；同病例内容更新可以读取最新状态。现有 Command 建立的 Case 在同 Workspace/Epoch/Scenario Run 内固定关联 Patient/Encounter；换病例或任务 `taskEpoch` 后暂停，即使新 header 已发布或页面切回也不自行迁移任务。无病例页面保留精确绑定的选择动作；选择成功不把该任务转为新病例任务。

医生病例及历史读取通过窄 `doctor-queries` 入口执行，从当前受信 Context 解析病例，核对 pending receipt、输入 hash、任务来源、责任医生、资源状态和当前 operation policy。异步目录准备后及结果 completion 前再次核对，Surface 返回前也复验当前 frame。未保存表单、action 与绑定来自当前已提交 frame；病例读取中的队列来自该 frame 已加载页，选择范围不扩大。授权历史复用本院完诊与 Visible Source History 投影，单项详情限于当前患者、当前责任医生及合法物化索引；隐藏真值、Persona 全文、raw Bundle、URL 和像素不进入结果。

医生代问来自现有右侧助手聊天中的明确任务。Client 观察原生新提交快照，用原文与原 requestId 签发并登记输入凭证，不重复发消息。Host 在首次工具执行前有界等待并核对凭证，再按原请求模型独立识别本条输入；每个已选病例任务识别一次，普通讨论、含糊或识别失败均不授予代问许可。凭证 version 2 只证明输入来源，execution proof 的代问 ID 与输入 hash 表示 Host 核实的委托；许可和原任务不能从模型声明、历史或工具结果取得。完成、取消、叫停、对象变化或重启后失效。问诊继续精确绑定并复用既有 Command、版本与幂等，正式操作继续人工审阅；详细输入、授权与生命周期合同由 [#176 规格](../spec/2026-10-08-doctor-agent-context-execution.md)拥有，取舍见 [聊天代问 Agent Note](../decisions/implemented/architecture/2026-10-10-doctor-agent-chat-delegation.md)。

页面动作的原生结果与新工具目录通过 `/clinmesh-agent-handoff` 交接。浏览器先返回业务结果，保留旧 registration；页面已提交且取得匹配的 Page Context 后，用该调用实际签发的 proof 提交目标 scope、语义 revision 和完整工具名称集合。Host 等待该 Session 同批已开始的 ClinMesh 调用都收到原生结果后才允许浏览器发布，避免撤销旧结果通道，也避免并行调用按顺序 finalize 造成死锁。Host 的 `tools/post-execute` 等待当前 Agent 实际完整工具集合及每项绑定精确匹配目标后才继续下一模型请求；只读或无操作的目标可直接匹配现有目录，不要求版本必须变化。等待有界并响应取消与卸载；同步失败停止当前回合，保留原业务结果，禁止自动重放写入。该交接使用官方公开 hooks，不修改 DSH。

同病例纯查询因 Context 正常更新而在 body 执行前被明确拒绝时，可用 `previousProof` 后台重签一次，保留 call ID 与原任务，并由服务端防重放。对象变化、取消、业务拒绝、网络或结果不明不自动重试；结果不明时，Surface 以本次 proof 提交 `phase: pause`，Host 失效原任务并停止回合；原生 `isError/error.message` 的执行标记在暂停 HTTP 丢失时兜底，普通结果文本不具有控制含义。旧任务的晚到结果不能取消新任务。写入参数不改写。其他精确绑定调用的诊断可附当前只读恢复入口，仍须核对原患者与意图，诊断不构成写入授权。

读取、UI 和草稿动作完成后写入结构化 Tool result。proposal Tool 在打开审阅框后立即向 DSH 返回 `awaiting-human-review`，不让人工等待占用 browser lease；Hono 中的 Tool call 与 proposal 保持 pending。人类点击决定时，浏览器先用原 receipt 调用 decision gate；Hono 只在 context、DSH Session、当前资源和 Tool 仍有效时原子记录 `approved` 或 `rejected`，随后 Web 才能调用既有 Command。

批准 completion 必须引用同一个已完成 Command receipt 中显式保存的 `requestId`、`auditId` 和 `traceId`。Hono 联结该 receipt、Audit、Action Trace 和 review decision，要求 Actor、Acting Practitioner Role、Workspace/Epoch、Scenario Run、operation、outcome、标识和决定时序全部一致；拼接两个 Command 的标识、切换岗位后执行 Command、使用 proposal 不允许的 operation 或引用决定前的 Command 都会被拒绝。持久表的主键和外键均携带 Workspace/Epoch，不保存 DSH transcript。

<a id="75-人工审阅语义"></a>

### 7.5 人工审阅语义

正式挂号、分诊、临床、支付、药房和 Scenario Command 始终由 ClinMesh 原生审阅框提交，最终 Actor 是登录人类，Agent 只记录为 proposal 来源。明确点击取消写入人类 `rejected` decision；批准执行既有 Command，并保留其 idempotency、expected version、preview token、审计和状态机语义。

Surface 隐藏、DSH Session/lease 失效、page scope、selection、资源版本、页面 revision 或 context ID 改变，以及 context/receipt 过期或 action 错误，都会关闭尚未决定的 review，并把 proposal 标记为 `stale`，不伪造人类拒绝。签名有效且明确 `ok:false` 的 completion 可以越过 receipt 到期或旧 Epoch 只执行这项清理；它不能关联 Command 或产生 Effect。decision gate 是批准的线性化点；gate 失败时不会调用 Command。Agent call 已失败或 stale 时不能留下仍可提交的孤立审阅框。拒绝、stale、冲突和取消都不自动重放，也不产生正式业务 Effect。

### 7.6 内容与能力边界

病历、患者备注、术语 display、历史 Tool result、外部错误和模拟器消息都是不可信数据，不能改变 Tool catalog、岗位权限、page scope 或 Command 状态机。当前结果只返回完成动作所需的结构化可见事实，不返回 server prompt、secret、access token、reasoning 或仿真私有事实。

共享 bridge secret 至少 32 bytes，只存在于 DSH Host 与 Hono 环境，不进入浏览器、日志、Tool result 或版本库。当前没有 MCP、Agent OAuth/SMART、自治 Agent Run、跨进程 DSH Session 恢复、Evaluation Spec、评分或 Agent 专用医院角色；这些能力不能从 React Surface 的存在推断出来。
<a id="77-agent-cli-与-operation-catalog"></a>

### 7.7 Agent CLI 与 Operation Catalog

`apps/cli` 发布可安装的 `clinmesh` 命令。它是现有 HTTP/FHIR adapter 的 schema 驱动消费者，不直接访问 Repository、SQLite 或业务状态机。模型 runner、AG-UI、MCP、Agent OAuth/SMART、Evaluation Spec 和评分入口仍不属于当前能力。

### 7.8 HIS Operation Catalog

`packages/contracts/src/his-operations.ts` 导出的 `hisOperationCatalog` 是 CLI/Capability Grant 直接 HIS 操作面的唯一合同 owner。每项 operation 显式声明稳定 ID、版本、`cliPath`、`query/draft/preview/command` mode、输入/输出/错误 Zod schema、HTTP method/path adapter、唯一 handler owner、human/agent identity、岗位 allowlist、风险、幂等、expected version 与 preview token 要求；既有 Command 的持久 operation 名称不同时，Catalog 还保存 receipt adapter 名称。DSH 页面 Tools 由独立的 `agentToolCatalog` 拥有，并在当前人类 Session 内投影 UI action 与 proposal，不能作为 Capability Grant operation 使用。两个 Catalog 都不依赖 Hono、Node.js、环境变量或 handler。

CLI 命令树、`operations list/schema`、服务端 Agent route matching、Grant 的 Catalog hash 和 Skill 命令示例测试都读取同一 Catalog。HIS route coverage test 要求每条 `/api/his/v1` route 恰好属于 canonical operation 或带原因的排除项。医生页面的诊疗建议状态读取、生成及准备清单确认在 `excludedHisRoutes` 登记，限定现有医生 Session 与页面操作，不增加独立 CLI 命令或 Agent tool 授权。管理员 Laboratory Service 候选搜索、发布和 job 查询属于 `clinmesh-administrator`；医生病例级目录属于 `clinmesh-doctor`，只返回可开立 Hospital Service。全局 Reference 检验搜索不能替代服务发布，也不能把 Reference Concept ID 作为申请项目。FHIR 部分只投影 metadata、read、vread、instance history 和资源能力注册表允许的 search；资源类型与 SearchParameter 白名单和 CapabilityStatement 共用一份注册表。包括 metadata 在内的每个 FHIR 入口都先解析受信身份，Agent 还必须在 Grant allowlist 中拥有对应 operation。

CLI 没有通用 invoke、任意 URL、method/path/body、SQL、JSON Patch、FHIR write 或 Bundle write。兼容组合 route 不进入命令树，Agent 使用独立 diagnosis、prescription、laboratory request、clinical document 和 Encounter Completion 生命周期。

### 7.9 输入、输出与恢复

标量、ID、分页和查询条件使用 typed flags；嵌套临床输入使用 `--input @<workspace-file>` 或 `--input -`。文件路径必须留在当前 workspace，单次输入上限为 1 MiB，同一 operation 不能同时使用 typed flags 和结构化输入。所有输入和服务端结果在边界通过 Catalog schema 验证。

成功默认向 stdout 写版本化 JSON envelope；`--output table` 只为 human mode 渲染成功结果。错误只向 stderr 写版本化 JSON，调用者按稳定 `type/code/outcome` 分支。FHIR `OperationOutcome` 映射到同一错误合同。Commander、配置、文件和 schema 错误不混入非结构化诊断文本。

每个 write 要求调用者提供同一业务意图稳定复用的 idempotency key；修改既有事实还要提供 Catalog 声明的 expected versions。CLI 不自动重发 write。连接在结果返回前中断或 write 收到 5xx 时返回 `ambiguous_outcome`，调用者用公开 operation ID 和原 key 执行 `command receipt get`；服务端把公开 ID 映射到既有持久 Command receipt 名称，并保持 Actor、Acting Practitioner Role、Workspace 和 Epoch 隔离。receipt 示例只能指向实际产生 Command receipt 的 write operation。

### 7.10 Human 与 Agent 身份

Human mode 使用 Better Auth profile。登录密码只从 stdin 读取，不进入 argv 或 profile；profile 只保存 Server origin 和 session cookie，配置目录使用 `0700`，文件通过同目录原子替换并保持 `0600`。human write 发送同源 `Origin`，高风险命令还要求本地显式 `--yes`；服务端仍重新执行岗位、状态与版本授权。

Operation Catalog 将住院首次及后续收退款的确认、原尝试恢复、结算后费用更正与首次封账声明为 `high-risk-write`，由 CLI 统一执行人工确认。首次封账包含默认现金结清兼容路径，同样要求 `--yes`；读取与预览沿用原风险分级。

Human administrator 通过 `/api/agent/v1` 和对应 CLI 命令创建、查看、禁用 Agent Client，创建、查看和撤销 Agent Capability Grant。账户拥有 administrator 岗位不自动授权控制面；请求时选中的 Acting Practitioner Role 必须是 administrator，并以该岗位审计。每个控制面 mutation 使用幂等键并通过共享 CommandExecutor 原子写 receipt、AuditEvent 和 Action Trace；控制面响应丢失或返回 5xx 时 CLI 返回 ambiguous 并要求先检查当前状态。Grant 创建的原 token 只返回一次，持久 receipt 脱敏且重放被拒绝；若创建结果未知，管理员必须检查并撤销可能已经创建的 Grant，再用新幂等键签发替代 Grant。SQLite 只保存 token SHA-256。Grant 主事实以 Workspace/Epoch/Grant 复合键保存，operation allowlist 使用同一隔离键下的关系行，operation ID 在 contracts 边界按当前 Catalog 验证。每个 Grant 绑定一个 Agent Client、Workspace、Epoch、Scenario Run、一个 Practitioner Role、Catalog hash、Workspace policy version 和真实过期时间；write allowlist 自动加入 receipt 查询。

Agent task 由 runner 注入 `CLINMESH_SERVER_URL`、`CLINMESH_TOKEN` 和 task 标识。CLI 只接受完整短期 token，缺失或格式错误时在发网前失败；Agent context 不能读取、创建或选择 human profile。服务端从 token hash 重新解析 Actor context并忽略客户端自报的 Actor、Workspace、Epoch、Scenario Run 或岗位。Agent Client 与 Human Membership 都投影到 `workspace_actor`，领域事实因此保留真实 Agent Actor，而不伪造 User Account。撤销、过期、Client 禁用、Epoch reset、Scenario Run 关闭、岗位停用、Catalog hash 或 policy version 变化都会使 token 失效。

Agent 高风险 command 不使用 `--yes` 作为授权；operation 必须在单岗位 Grant allowlist 中，Command handler 仍重新验证业务状态和 expected versions。跨岗位流程由 runner 签发多个不同 Grant，不能在一个 token 内切换 Practitioner Role。

<a id="711-agent-skills"></a>

### 7.11 Agent Skills

仓库在根 [`skills/`](../../skills) 提供九个 model-invoked 运行时 Skills：`clinmesh-shared`、`clinmesh-administrator`、`clinmesh-registration`、`clinmesh-triage`、`clinmesh-doctor`、`clinmesh-billing`、`clinmesh-pharmacy`、`clinmesh-inpatient` 和 `clinmesh-fhir`，供项目启动后操作 HIS 的 Agent 使用。`clinmesh-shared` 拥有 context、Catalog discovery、幂等、结构化错误和 ambiguous receipt 恢复；领域 Skills 只说明意图路由、前置状态、岗位交接、风险和反例，并在执行前读取 shared Skill。

Skills 不复制 flags、输入 schema 或完整命令目录，Agent 对不熟悉的 operation 使用 `operations schema` 读取当前合同。临床 Skills 不包含 Agent Client/Grant 控制面。测试收集每个 bash 示例并要求其命令路径存在于真实 Catalog 或共享 CLI manifest，从而让命令重命名和文档漂移直接失败。

### 7.12 后续 Agent 传输与内容安全

后续嵌入式助手、AG-UI、tool adapter 或 MCP 只能投影同一 Catalog 并保留受信 context、幂等、expected version、receipt 与审计语义。MCP 是可选传输协议，不是业务领域模型；新增 adapter 不能提供比 CLI 更宽的 raw escape hatch。

病历、患者备注、术语 display、历史命令结果、外部错误和模拟器消息都是不可信数据。调用侧用固定指令隔离这些字段，权限与状态机只接受结构化参数和服务端解析的资源引用；自由文本不能决定 operation、role、URL、SQL 字段或授权范围。Case Truth、token、内部 prompt 和未授权字段不进入 CLI schema、Skill 示例或普通结果。
