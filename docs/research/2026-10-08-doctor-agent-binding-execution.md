# 医生助手只读绑定与安全恢复

研究日期：2026-10-08。状态：技术研究，未实施。正式产品行为由[医生 Agent 临床助手规格](../spec/2026-10-08-doctor-agent-assistant.md)拥有；本文件只研究 #176 的工具执行 Interface，不替代规格，也不表示新增权限已交付。

## 结论

当前反复拒绝的根因是模型继续提交历史 `scopeKey`、`pageRevision`，而非系统未把新工具交给模型。只读工具可以停止要求模型复制页面版本，但必须同时解决受信执行绑定、生成期间换患者和旧页面闭包三个问题。只在 JSON Schema 中删掉两个字段，不构成完整修复。

最小复用路径是保留现有 `ui.context.read`、`outpatient.case.read`、Page Context、execution proof、Tool receipt 和人工审阅模块；在受信桥接处区分只读查询和有意图的 UI/草稿/proposal 动作。无需新增通用读取 HTTP 入口、Agent 运行器、持久 Task 表或第二套 lease。若要求只读调用完全没有模型可见的动态绑定，需要核对原请求与当前执行对象，并调整 proof 合同。当前正常原生AgentLoop完整执行一批Tools后才构造下一请求，因此 `execution.agent.session.requestHeader()` 可以提供原请求schema，无需先建 `llm/stream` 的call ID sidecar；它单独不证明某个任意手动调用来自该请求，原生调用来源仍须校验。不能改写已经记录的调用参数。

本研究核对仓库源码及已安装 `@deepseek-ai/*@0.2.0-rc.2` 的公开类型和分发源码，并运行一次临时原生探针，没有修改 vendor、依赖、业务代码或 GitHub。已知五次真实会话模式来自既有诊断结论，本研究未重新调用真实模型；[工程记忆](../memory/memory.md)已记录必须对照实际 `request/header` 与 `tool/call` 判断参数复制和生成竞态。

## 当前执行链与失败位置

| Seam | 当前事实 | 对设计的影响 |
| --- | --- | --- |
| Model → DSH Host | `installAgentProofBridge` 的 `tools/pre-execute` 从实际 arguments 读取绑定，再和当前 `ctx.tools.get(name, agent)` 中的 const 比较。不同则在调用 body 前 deny。 | 历史参数无法执行；不能在此简单换成新绑定。 |
| Host → proof issuer | `AgentExecutionProofIssuer.begin` 绑定真实 Session、call ID、Tool、scope、revision；浏览器按 scope/revision/Tool 取得一次 proof。 | 删除模型绑定后，必须明确 issuer 的受信绑定来源。 |
| Browser → Hono | 浏览器用当前 context token 和 proof 授权；Hono验证当前人类身份、Session、scope、semantic revision、operation、资源状态与防重放。 | 浏览器数据不单独构成授权，既有 Server 检查继续保留。 |
| Browser → action | `buildSurfaceAgentTools` 捕获发布时的 action、`readState` 与 pageRevision；`resolveBinding` 只是确认当前绑定仍与旧值相同。 | 允许只读跨版本后，必须同时重新解析当前 read action 和当前状态，不能保留旧闭包。 |
| Action → next model request | 既有 handoff 等待当前 Agent 的完整工具集合及每项绑定匹配，才允许下一次请求。 | 继续复用结果与目录交接；新旧模型参数是否匹配是另一项检查。 |

源码入口：[Host proof bridge](../../apps/dsh-web/src/agent-proof-bridge.ts)、[proof issuer](../../apps/dsh-web/src/execution-proof.ts)、[Surface Tools](../../apps/web/src/app/surface-agent-tools.ts)、[Surface publisher](../../apps/web/src/app/surface-agent-publisher.ts)、[Server Agent Integration](../../apps/server/src/application/agent-integration-service.ts)。具体位置为 Host 第 100–127 行、issuer 第 36–67 行、Surface Tools 第 63–75 行与第 112–161 行、Server 第 336–425 行；本研究的行号按当前检出计算。

`pageScopeKey` 包含 active section、actor、Session、Epoch、岗位、Scenario Run、用户、selection（含版本）、view 和 Workspace，输出不可解释的 hash；它不是患者 ID。`agentPageBindingRevision` 还包括 viewRevision 和草稿引用。医生页 viewRevision 包含问诊、病历、诊断、处方、检验申请及各项版本，因此患者回答或草稿变化也会改变绑定。只比较 scope 是否变化，无法判断是否换了患者；同 scope 也不能替代当前资源版本校验。依据：[Server scope owner](../../apps/server/src/application/agent-integration-service.ts)、[Contracts](../../packages/contracts/src/agent.ts)、[医生页 claim/readState](../../apps/web/src/app/doctor/doctor-case-controller.tsx)。

## 现成读取能力与旧闭包问题

`outpatient.case.read` / `clinmesh_read_doctor_context` 已是医生接诊 view 的跨栏目 Tool，输入业务 schema 为 `{}`。其 action 按 `activeCaseId` 直接调用 `getDoctorCase`，并读取该病例可用的影像、病理目录，不切换当前栏目。病例内容和既往资料的具体投影仍归 Query owner；本研究不把目录读取当成完整病例历史覆盖证据。依据：[Tool catalog](../../packages/contracts/src/agent.ts)、[输入 schema](../../packages/contracts/src/agent-tool-input.ts)、[医生 read action](../../apps/web/src/app/doctor/doctor-case-controller.tsx)第 1161–1174 行。

`ui.context.read` 用 `readState` 返回当前已挂载表单和未保存草稿，这与病例服务端 Query 不同。publisher 的 `toolsForFrame` 明确传入 `publishedPage.actions` 与 `publishedPage.readState`；工具注册函数闭包捕获这一 frame。只把旧 action 的 binding 换成最新值，会出现“新 context 授权、旧患者 action 或旧草稿数据”的混合。依据：[publisher](../../apps/web/src/app/surface-agent-publisher.ts)第 289–325 行、[Surface Tools contextReadAction](../../apps/web/src/app/surface-agent-tools.ts)、[医生 readState](../../apps/web/src/app/doctor/doctor-case-controller.tsx)第 2272–2289 行。

只读执行应从一次当前已提交 frame 中同时解析 binding、operation 可用性、read action 和 readState，捕获后按该 frame 授权和执行；异步返回前再次检查对象与授权身份，遇到变化丢弃晚到结果。没有当前有效 frame、病例尚在加载或 operation 已撤销时，等待有界同步或返回明确的暂停结果；不能读取旧 frame，也不能用旧页面的 enabled 条件为当前 action 授权。具体是否对同病例版本变化再读一次，可在实现时采用一个有界只读重试；不会改变患者、岗位或写入参数。

## 可行 Interface 比较

| 方案 | 模型需填写什么 | 所需改动 | 安全与局限 |
| --- | --- | --- | --- |
| 仅执行时绑定 | 两个读取工具业务输入 `{}`，Host从当前目录取绑定 | 改 Host proof来源、Surface frame解析与handoff匹配 | 能避免复制旧读取版本，但单独无法知道这次模型请求原来指向哪个患者，不能作为最终方案。 |
| 稳定病例意图锚点 | 保留一个病例级锚点，移除读取的 pageRevision；锚点不含栏目与资源版本 | Contracts 与 Server拥有稳定锚点，Host/Surface双重校验 | 同病例读流程稳定，换患者仍拒绝；仍需模型填写一个在换患者时更新的值。 |
| 原请求核对、执行时绑定 | 读取业务输入 `{}`；请求锚点由Host取得 | 正常native调用从Session header读取原request schema，校验调用来源；proof带只读请求锚点，Server比较原对象与当前对象；Surface解析当前frame | 满足完全隐藏动态参数和生成期间换对象暂停；需要跨包proof合同变化，不必另建llm stream sidecar、持久Task或新lease。 |

前两种属于更小的中间方案；若最终目标是读取时模型完全不抄写动态绑定，第三种是权限完整的候选。不要以“所有 Tools 直接绑定最新页面”简化写入，也不要把同一患者的不同就诊视为同一目标。病例锚点至少区分 case/Encounter、Actor、岗位、Workspace/Epoch、Scenario Run、DSH Session；栏目与普通内容版本不决定只读对象身份。

第三种可复用仍严格绑定的同 Session 工具目录来捕获不进入读取输入的 scope/revision。当前医生栏目共有 select-section 等工具，因此不必向上游 Tool descriptor 增加私有 metadata。目录没有有效锚点、多个锚点不一致或原请求没有该读取能力时，拒绝而不是猜测。Host签发的只读proof可以同时携带原request的scope/revision和实际执行binding；Hono从既有 `agent_page_context` 查出原context身份，与当前有效context比较，再执行普通授权。已撤销/过期的原context只用于核对历史意图对象，不能作为新授权。该比较和proof字段尚未实现；若原记录不存在或不可确定，暂停，不自动补签。

`AgentExecutionProofIssuer` 当前按 scope/revision/Tool 唯一 pending；浏览器 Tool execute 只收到 arguments 和 signal，不收到原生call ID。可保持这项唯一性，把请求捕获的call ID保存在Host pending中；浏览器proof请求只能匹配一个当前绑定的pending call。重复/并行相同绑定同Tool必须继续拒绝或按既有exclusive执行，不能靠任选一个pending解决。依据：[issuer](../../apps/dsh-web/src/execution-proof.ts)、[React Surface invocation协议](../../vendor/dsh-react-surface/packages/runtime/src/agent-protocol.ts)、[Surface client执行](../../vendor/dsh-react-surface/packages/runtime/src/client/surface-agent-client.ts)第 325–355 行。

## DSH 公共 hooks 的实际能力

| 公开入口 | 查证结果 |
| --- | --- |
| `agent/request` | 携带agent、turn、step、signal，waterfall结果是`LlmCallConfig`。它在最终request构造前执行，不直接提供工具schema，不能用作完整schema快照。 |
| `llm/stream` | 拿到完整`GenerateOptions`，loop request带`sessionId`、tools、signal，并且deep-frozen。允许读取并包装`next()`返回的AsyncIterable，不能修改原request。 |
| `agent/assistant-stream` | 提供agent及流frame，但属于通知，监听失败被contained，不能代替权限拒绝gate。 |
| `tools/pre-execute` | 可allow/deny/cancel/ask；arguments已记录、deep-frozen，Input rewriting明确排除。 |
| 原生`ToolExecutionInput.schema` | optional schema用于PTC inner call；当前native AgentLoop创建call只传callId、name、arguments、agent、signal，没有schema。不能假定执行事件带请求快照。 |
| `tools/post-execute` | 可保留/替换投影、附加下步context或block，不能把未知结果包装为成功；输入身份仍不可改写。 |
| `Session.requestHeader()` | 公开、增量fold、deep-frozen，返回log中最新header。正常native step中的完整Tool批次共享原request header；这不是按call ID索引的查询。 |
| `session/event` | 公开post-commit追加通知，可识别当前step、已提交assistant批次、真实`tool/call`与结束清理，不需要读取整个聊天历史。 |

一手来源为安装包分发：`apps/dsh-web/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts`第 32–45 行；`dsh-agent/lib/types/runtime-types.d.ts`第 327–365 行；`dsh-tools/lib/types/index.d.ts`第 216–227、275–287、435–482 行；`dsh-agent-loop/lib/index.js`第 505–519、1179–1183、1200–1275 行。版本锁定见[DSH package manifest](../../apps/dsh-web/package.json)及[pnpm lockfile](../../pnpm-lock.yaml)。这些是本地查证的上游分发源码，不是ClinMesh维护文件。

`llm/stream` 仍可用于更一般的request-to-call映射，但当前原生路径已有更小候选，见下一节；不应同时建立两套映射。无论使用哪个入口，都不保存病例正文或reasoning，不改模型参数，也不把最新目录反向当成原schema。

## 直接读取 Session header 的条件

`Session.requestHeader()` 的公开合同是“log最后一个header事件之后的header”，不是“这个call的header”。实现用 `foldRequestHeader` 并deep-freeze；正常native AgentLoop在 `buildRequest` 写入header、完整消费模型stream、提交 `assistant/message`，随后 `await executeToolCalls` 完整批次。scheduler等所有并行body和finalization结束后才返回step，再进入下一次request。因此仅更新tool registry、页面binding或Surface lease不会推进Session header；同一批的后续Tool也仍看到原request schema。依据为安装包 `dsh-session/lib/types/index.d.ts`第 251–259 行与 `lib/index.js`第 1486–1500 行；`dsh-agent-loop/lib/index.js`第 1040–1153 行和第 504–651 行。

| 情况 | 已查事实与要求 |
| --- | --- |
| 生成期间registry由A变B | pre-execute可读到原header A，而 `ctx.tools.get` 已是B；可分别作为原意图锚点和执行binding。 |
| 同批并行Tools | scheduler在一批完整finalize前不构造下一request，header保持A；进入pre时捕获后放入已有pending，后续等待不反复读取latest。 |
| Provider失败重试 | 失败stream记入 `assistant/attempt`，不执行其工具；成功attempt才提交assistant批次。当前retry复用同step assembly.tools，再次buildRequest，pre读到的是成功attempt的header，registry变化并不自动重做assembly。 |
| 暂停、取消、恢复 | 活动driver不重入；取消信号阻止未执行工具，已开始work drain后才结束step。persisted resume先补interrupted closers，再以新loop首次request写 `reason: resume`。不能从idle/restored历史header自动重放旧调用。 |
| 同Session多个Agent | AgentRegistry要求agent.id等于session.id，并拒绝重复注册；SessionStore prepare/enter也拒绝相同live Session。两个普通受支持AgentLoop不能同时向同Session构造request。 |
| 重复call ID | DSH仍可能让同一批两个Tool进入pre；header读取不能消除此问题。继续保留issuer唯一pending及Hono `agent_tool_call` replay校验，不因存在相同header而重复授权。 |
| 非AgentLoop手动调用 | `ctx.tools.execute({ agent, ... })` 可取得任意latest历史header，没有原生 `tool/call`；header存在、Agent对象存在或Agent正在running都不单独证明来自该请求。 |
| 任意插件追加header | Session公开append并不禁止另一个受信插件追加合法header；直接latest策略依赖当前部署中header由native AgentLoop拥有。新增其他header writer/custom driver须重新设计，不静默继承该假设。 |

推荐在当前native scope采用Session header，而不是默认增加流sidecar；同时用 `session/event` 的当前step及已提交assistant Tool身份核对真实 `tool/call`，在pre进入时消费一次来源记录。复用已有pending组织按Session＋call ID＋Tool名称关联的有界临时来源；在源事件时捕获冻结header，pre入口同步消费并核对名称和arguments，后续异步阶段使用已捕获值，不再读取latest。源事件中的raw arguments按AgentLoop `parseArguments`规则解析后须与frozen `execution.arguments`一致，不能因JSON空白不同误拒。只保留call身份、参数的必要校验信息及必要schema，不复制聊天正文；Tool result、取消、step/turn结束、Agent释放或卸载清理。没有来源记录、记录不匹配、未知header writer或旧seed调用则fail closed。该少量来源状态不同于从每个LLM stream建立跨attempt的call ID sidecar，也不是持久Task。

原生scheduler的 `fillPool` 按顺序 `await startCall`，`startCall` 在加入body并行之前先 `await scheduler.prepare` 完整pre链。因此另一个pre hook先异步等待时，正常同批下一条native `tool/call` 不会越过它。每Session仅保留一条待pre在这一纯native顺序下可行，但嵌套手动执行或额外插件调用会让该设计依赖调用顺序；最终候选采用以上键控关联，不依赖hook注册先后或只有一个执行入口。当前实现仍须通过实际pending/proof及Hono负例验证。

不能完全省掉原生来源检查后声称覆盖所有执行入口。`session.eventAt`、`snapshotEvents`、`ownEvents` 已被上游标为deprecated并禁止新增调用，不应为追查header扫描历史log。`deriveMessages` 是公开接口，但为此读取整段聊天及其内容不是最窄方案。依据为安装包 `dsh-session/lib/types/index.d.ts`第 170–202、287–301 行。

可复现的[原生时序探针](../../apps/dsh-web/research/doctor-agent-header-probe.mjs)通过 `node apps/dsh-web/research/doctor-agent-header-probe.mjs` 运行，使用真实Cordis、Session、Llm、registry、AgentLoop及两项concurrency-safe Tools，模拟模型在request A生成期间重新注册B。四个scenario（普通并行、provider失败后retry、重复call ID、排在前面的pre hook异步等待）均通过：每次native pre看到deep-frozen A/current registry B，源 `tool/call` 的header为A且arguments匹配，下一step才看到B；同Session重复create被拒。每个scenario还直接手动调用同Agent Tool，证明它没有 `tool/call` 来源关联却仍能读取latest B。已记录运行约0.19秒、退出0；只证明原生hook时序与关联可用，不验证最终proof/Hono安全、真实模型质量或完整暂停/resume。

医生输入可在公开的 `agent/inbox/inserted` 取得消息 ID 与 source，再由 `agent/inbox/claimed` 关联 turn；`agent/pre-step` 提供可拒绝的步骤 gate。`user/message` 也包含上下文注入，且消息进入可见历史晚于排队，因此不能一概视为新的医生授权，也不能到执行时才用最新病例建立原任务。事实依据为 `dsh-agent/lib/types/runtime-types.d.ts` 第 258–311 行、`dsh-session/lib/types/types.d.ts` 第 287–294 行和 `dsh-agent-loop/lib/index.js` 第 943、1061 行。仅跟踪已确认可信的医生输入来源；无法核实输入时绑定、seed/resume 中缺少临时关联或对象已变化时停止。公开 `tools/pre-execute` 的 `ask` 可以接入宿主批准 seam，但批准能力未挂载时会拒绝；本票更宜复用 ClinMesh 已有人工审阅路径，使许可与登录医生、病例及任务来源一起核对。它仍需新增任务范围的许可合同，并不是当前 ask Tool 已有的能力。

## 安全恢复与写入

恢复优先在只读路径内解决：续签、同病例栏目/普通版本变化不应再迫使模型复制新的读取参数；病例服务端事实与页面未保存草稿分别从其owner读取。写入保持实际模型参数、原意图、预期版本和人工审批。模型沿用旧写入参数时，先确认body未开始且Server未创建可能执行的业务Effect，再读取当前授权状态；确认原对象、任务和权限相同后，由模型根据新事实重新形成下一次调用，不直接重放或修改旧arguments。

“同一任务”不是scopeKey或同患者的同义词。Hono和proof能核对对象与操作，不能证明自然语言任务尚未改变；主聊天需保持原委托，明确代问只对应医生实际委托。后台病史自动记录的任务授权和持久化归 [#166](https://github.com/CaiZongyuan/clinmesh/issues/166)及其 #167–#172 执行票引用的正式规格；当前检出没有该规格文件，因此不建立不存在的仓库链接。#176不复制造成第二套队列或状态机。

| 结果情况 | 允许动作 |
| --- | --- |
| pre-execute或authorize明确拒绝，action body未运行 | 安全只读核对；同对象且任务未变时重新规划，最多一次有界自动恢复循环。 |
| 同对象但医生修改了草稿 | 读取最新草稿；保留手改和CAS，必要时提出建议；不能把旧覆盖意图套到新版本。 |
| 原对象、岗位、Session或Epoch发生变化 | 暂停，简短说明需要确认；不自动改用新患者继续原任务。 |
| 请求超时、body开始后Abort、HTTP 5xx、响应无法解析、action成功但completion失败 | 结果未明；核对现有receipt和业务状态，不套用“尚未执行”，不重放问诊或写入。 |
| 手工取消、人工拒绝、正式业务规则拒绝 | 尊重结果，不自动重试。 |
| action完成而handoff失败 | 保留真实业务结果，停止回合；同步失败不会撤销动作，不重放。 |

现有区分依据：[Surface Tools actionResolved/feedback](../../apps/web/src/app/surface-agent-tools.ts)、[handoff失败](../../apps/dsh-web/src/agent-proof-bridge.ts)、[结果确认规则](../agent-capabilities.md#反馈时序)。安全恢复不等于隐藏真实失败；技术细节可以留在诊断证据中，面向医生说明“需要核对结果”或“任务对象已变化”，不得谎称完成。

## 验证 Seam

1. Host proof与请求捕获：复用[proof bridge测试](../../apps/dsh-web/src/agent-proof-bridge.test.ts)、[issuer测试](../../apps/dsh-web/src/execution-proof.test.ts)，验证旧写拒绝、只读request锚点、一次签发、错Session/Tool、未知snapshot和取消清理。
2. 原生DSH AgentLoop：扩展[native handoff测试](../../apps/dsh-web/src/agent-handoff-native.test.ts)，让模拟模型明确复制历史参数，而不是每次由脚本准确填写当前参数；加入生成期间手动切患者、同患者版本更新、重复call ID和多个Session。该测试真实运行Cordis、registry、AgentLoop，浏览器HTTP与业务响应是替身。
3. Surface：复用[Tools测试](../../apps/web/src/app/surface-agent-tools.test.ts)、[publisher测试](../../apps/web/src/app/surface-agent-publisher.test.tsx)，保留旧注册函数后改变frame，验证只读只使用当前action/current readState，旧患者晚到结果被丢弃，未挂载表单不从旧闭包返回。
4. Hono授权：复用[Agent Page Context HTTP测试](../../apps/server/tests/agent-context-http.test.ts)，用真实SQLite验证同病例跨栏目/资源版本变化可读、跨case/Encounter/Actor/岗位/Epoch不能自动恢复，request锚点不是新授权，正式写入与人工review仍保持原严格条件。
5. 真实模型DSH：从新建业务preset会话连续执行问诊、读取和草稿更新；保存经脱敏的实际request/header、call参数、Tool结果和业务状态证据。观察没有技术绑定错误反复露出、没有切医生页面、唯一问诊轮次、草稿手改保护和正式操作仍需确认。另测模型生成中切病例与结果不明。通过脚本模型不能证明真实模型可靠；通过真实模型一次也不能替代这些负例合同。

已有native测试的 `OneTurnModel.stream` 直接按预定当前binding返回参数，因此证明handoff有效，未证明真实模型不会复制历史参数。第2项必须保留这一原测试并添加能重现报告问题的输入；不可用放松绑定断言使测试变绿。

本研究附带上述合成原生时序探针，不进入应用运行时构建，也不替代产品合同测试。尚未运行本方案的产品代码测试、真实模型或浏览器验收；完整文档和 Note 检查由设计交付统一执行，不把探针成功表述为 C1–C8 通过。
