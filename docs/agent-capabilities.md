# DSH 页面操作与视觉反馈

本文说明 DSH ClinMesh 工作台实际接入的页面控制、业务操作、栏目发布边界及视觉反馈时序。可执行工具名称、岗位／页面／栏目归属由 [`agentToolCatalog`](../packages/contracts/src/agent.ts) 唯一权威定义，输入参数约束由 [`agent-tool-input.ts`](../packages/contracts/src/agent-tool-input.ts) 定义；本文不复制逐项 schema 或完整工具清单。

## 业务会话

新建医院业务会话使用“ClinMesh 医院助手”（`clinmesh-assistant` preset；开发排障使用 `standard`），装配与授权边界见[Agent 接入与能力边界](architecture/agent-integration.md#7-agent-适配器与能力边界)。每个用户回合先按当前发布的工具 schema 读取授权页面，核对岗位、患者与目标资源，再调用 `clinmesh_*` Tools 并重读业务状态确认结果；意图冲突或缺必要临床输入时通过 `ask_user_question` 向人类澄清，正式业务动作一律交工作台人工审阅，人工拒绝后不重复提交。

向虚拟患者提问使用 `clinmesh_ask_virtual_patient`（不在问诊栏目时先调 `clinmesh_select_doctor_section` 切到 `consultation` 并等待工具目录更新）；问诊超时后先重读轮次，仅当末轮仍为未答医生提问且页面开放重试时调用 `clinmesh_retry_patient_reply`，结果不明时停止自动重试并交人类核对。读取失败不得推断患者无历史记录，业务会话也不得查询内部 Persona 或数据库。

## Tool 绑定与恢复

医生已选病例时，`clinmesh_read_current_context`、`clinmesh_read_doctor_context` 与授权历史纯查询仅提交业务参数并由服务端核对当前任务与病例；其余页面 Tool 必须在 JSON 中显式传入当前工具 schema 中 `scopeKey`、`pageRevision` 的 `const` 值（`const` 仅作校验，不会自动注入）。短期 `contextId` 由执行桥接托管，只读调用不消耗 Page Context；换岗位、会话或病例后旧任务自动暂停且切回不自恢复。

| 诊断码 | 含义与恢复动作 |
| --- | --- |
| `CLINMESH_BINDING_ARGUMENTS_INVALID` | 缺失或错填绑定字段；按诊断列出的当前 schema `const` 补齐后重试。 |
| `CLINMESH_HOST_SESSION_REQUIRED` | 未关联打开 ClinMesh 工作台的 DSH 会话；须从绑定工作台的会话发起，补参数无效。 |
| `CLINMESH_BINDING_MISMATCH` | 原调用尚未执行；先用只读 Tool（医生已选病例传 `{}`，其余页传当前读取绑定）核对患者、岗位与原任务，再用最新写 Tool 的 `const` 重新构造调用，严禁自动重放原写请求。 |
| `AGENT_CONTEXT_EXPIRED` / `AGENT_CONTEXT_INVALID` / `AGENT_CONTEXT_STALE` | 服务端拒绝过期、无效或资源版本已变的上下文；等待页面刷新工具定义并重读状态后再决定是否重试，持续未更新时重开工作台。 |
| `AGENT_OPERATION_NOT_ALLOWED` | 调用超出当前 Session、scope 或诊疗栏目授权；等待最新工具目录并重读页面状态，不沿用旧意图。 |

同一回合页面动作完成后，Host 与页面显式交接确认新工具目录就绪后才发起下一模型请求；网络中断或执行后回执失败仍按正式 Command 回执流程核对，不能套用绑定拒绝的“尚未执行”结论，绑定合同见 [Page Context](architecture/agent-integration.md#72-page-context)。

## 读取与编辑边界

原生 DSH Session 经 React Surface 与 browser-tools 调用窄 Tools；通道 `active` 仅表示连接可用，只读查询不触发界面流光，ClinMesh 也不渲染推测的模型思考状态。`ui.context.read` 仅返回当前页面注册的状态与已挂载同病例表单的编辑值（如挂号草稿、分诊体征、医生病历／检查／诊断／处方表单、药房审核与批次数量），离开表单即移除，不暴露任意 DOM、跨患者数据或 `Case Truth`。

填写或保存草稿前，模型须先读取含未保存人工输入在内的当前页面值以决定是否询问覆盖；该约定不提供独占锁或并发自动合并，人工编辑始终可用。正式医院 Command 必须经应用内人工审阅框确认，聊天文字同意不能替代审阅。

## 反馈时序

输入校验与服务端授权通过后，非 proposal 页面动作执行期间在临床工作区边缘渲染蓝色环绕柔光，并为可见目标绘制淡边框与菱形标记（快速动作合并渲染时仍保留一帧静态结果，不人为延迟业务或模拟逐字打字）。最后一项动作完成时立即停止持续绘制，静态柔光与目标标记保持约 1.5 秒后用约 600 毫秒淡出，随后释放 Canvas、文字完成提示保留约 4 秒；减少动态效果偏好或 WebGL2 不可用时自动降级为无 Canvas 静态边缘。草稿保存明确提示“草稿已更新，尚未正式提交”，普通反馈不抢焦点、不滚动页面、不锁定人工输入。

局部高亮遵循精确业务范围：病历草稿仅高亮本次输入与执行前页面值（含未保存手改）实际不同的字段；问诊反馈覆盖消息滚动区与执行期新增气泡；诊断与处方草稿同步覆盖已打开的目录弹窗内部并暂停被遮挡背景目标。所有 `.propose` 动作从发起即保持纯静态，返回 `awaiting-human-review` 后审阅框独立等待人工批准或拒绝，全程不触发流光。业务拒绝立即停止流光并展示原因；网络中断、超时或回执丢失提示“结果尚未确认”，视觉清理不代表请求已撤销。切换页面、病例、岗位、Workspace/Epoch 或 DSH Session 立即清理旧目标，防止迟到结果跨上下文点亮。

## 当前操作

可执行操作按工作区与岗位严格收窄，完整 operation 列表、前提与目标字段映射以 [`agentToolCatalog`](../packages/contracts/src/agent.ts) 为唯一事实源：

| 工作区／岗位 | 只读查询能力 | 页面导航与草稿能力 | 人工审阅提案（`.propose`） |
| --- | --- | --- | --- |
| 通用壳层 | `ui.context.read` 读取当前页与已挂载表单 | `ui.navigate` 切换授权工作区、`ui.panel.focus` 聚焦面板 | — |
| 挂号（`registrar`） | 页面上下文读取当前患者与合成病例页 | 搜索并选中患者或待诊合成病例，填写建档与挂号草稿 | 创建患者档案、普通门诊挂号、开始合成病例就诊 |
| 分诊（`triage-nurse`） | `triage.queue.read` 读取分诊队列 | 选中队列病例，同时填写主诉、分级与生命体征草稿 | 提交分诊评估 |
| 门诊医生（`outpatient-doctor`） | 病例与已加载队列页、`local-completed`/`visible-source` 历史检索与详情、临床风险评分、指南专题、事中质控预检、专病医嘱组套预筛 | 选队列病例、切换诊疗栏目（含展开检查报告／阅片器）、受控虚拟患者提问与补答重试、保存病历／诊断／内外延处方／检验／功能检查／放射／病理草稿、签署预览 | 开始接诊、确认诊断、签发／取消／重试各类检查申请、报告已阅与受控更正、开立／撤回处方与无需用药、签署／修订病历、完成就诊 |
| 收费（`cashier`） | `billing.queue.read` 与 `billing.case.read`（含按页原款历史，见[预览与提交](architecture/fhir-and-commands.md#66-预览与提交)） | 选中待收费用、生成门诊分次／组合缴费预览，填写住院补交草稿并生成收款／结算预览 | 确认门诊缴费、查询恢复 `ambiguous` 原支付结果（规则见[收费、结算与医保](architecture/billing-and-insurance.md)） |
| 药房（`pharmacist`） | `pharmacy.queue.read` 读取处方队列 | 选中处方、填写审核意见及同药品批次与发药数量草稿 | 提交处方审核、执行发药 |
| 住院各岗位 | 住院医生与护士按阶段读取多支冠脉造影、临床评分、指南专题、事中质控与医嘱组套预筛 | `inpatient.stage.select` 切换授权住院阶段（不开放住院端 DSH 临床草稿写 Tool） | 病区护士 `inpatient.order.verify.propose` 医嘱校对、住院医生 `inpatient.report.acknowledge.propose` 报告已阅 |
| 仿真管理（`administrator`） | 读取场景状态、Provider 健康与生成任务状态 | —（不开放直接触发患者生成或无审阅重置的写 Tool） | `scenario.reset.propose` 二次确认重置新 Epoch |

关键运行时约束：

- **队列与历史读取边界**：医生队列选择仅接受当前已加载页 `queue.items` 中的病例，不开放全库按名搜索或跨页盲选；`clinmesh_search_doctor_history`／`clinmesh_read_doctor_history` 仅访问 `local-completed`（含门诊完诊与已出院 `inpatient` 临床摘要，见[门诊业务流程](architecture/outpatient-workflows.md)）和 `visible-source`，明确区分 `no-data`、`no-materialization` 与查询失败。
- **医生授权代问**：仅当医生在右侧「ClinMesh 医院助手」聊天明确下达代问任务（`<= 2000` 纯文本字符、无附件）并通过服务端输入许可校验后，助手才可在本任务与当前病例连续追问虚拟患者；切换病例、取消或失权即刻终止许可，详见 [Execution proof 与调用记录](architecture/agent-integration.md#74-execution-proof-与调用记录)。
- **零像素阅片门禁**：Agent 仅读取检查报告文字，返回载荷不含素材 ID、来源 UID 或像素；`outpatient.section.select` 携带申请 ID 仅替人类展开阅片器，放射影像或病理切片未在人类视口成功渲染前，已阅 `.propose` 一律被拒绝。

## 医生诊疗栏目与 Tool 发布

DSH browser Tool broker 单次注册上限固定为 32 个 Tool。门诊医生“接诊”页将跨栏目 Tool（上下文与历史读取、工作区／病例／栏目切换、开始接诊、兼容初复诊草稿、完诊提案）与绑定 `sections` 集合的栏目专属 Tool 组合发布：`consultation` 发布问诊与重试，`record` 发布结构化病历草稿、预览、签署／修订与质控读取，`diagnosis` 与 `prescription` 分别发布诊断或处方操作并共享临床评分、指南专题、质控预检与组套预筛只读查询，`laboratory` 集中承载检验、功能检查、放射与病理草稿及生命周期提案（将三类报告已阅收敛进 `outpatient.report.acknowledge.propose`、定位阅片收敛进 `outpatient.section.select`，保持不超过 32 个上限）。

Server 签发 Page Context 时按受信当前栏目收窄 `allowedOperationIds`，Surface 据同一 [`agentToolCatalog`](../packages/contracts/src/agent.ts) 注册工具；切换栏目会重签 Page Context 并刷新工具列表，跨栏目越界调用返回 `AGENT_OPERATION_NOT_ALLOWED`。住院工作台同样按 `sections` 阶段集合仅挂载阶段导航、护士校对／医生已阅／收费预览及专病只读查询，不新增住院端 DSH 写 Tool，合同测试逐岗位、逐视图与逐栏目强制断言注册数 `<= 32`，详见[同源专病临床内核与像素暂缓边界](decisions/implemented/architecture/2026-11-19-shared-specialist-clinical-kernel-and-pixel-deferral.md)。

## 上游能力与接入限制

[React Surface](../vendor/dsh-react-surface/docs/ag-ui.md) 提供 Session-scoped capability lease 与 browser-tools 注册链路；ClinMesh 尚未接入 AG-UI Gateway，也不从模型 token／thinking 流推断界面动画。standalone Web 保持纯人工编辑与相同 Command 链路，不发布 DSH Tools；所有视觉反馈仅存于当前浏览器内存，不落库为医院事实，设计取舍见[Agent 操作反馈与环绕柔光决策](decisions/implemented/architecture/2026-09-20-agent-action-feedback.md)。
