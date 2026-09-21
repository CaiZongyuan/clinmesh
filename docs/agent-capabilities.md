# DSH 页面操作与视觉反馈

本文说明 DSH ClinMesh 工作台实际接入的页面控制、业务操作及反馈。可执行工具名称、岗位与页面范围由 [Tool Catalog](../packages/contracts/src/agent.ts) 定义，输入约束由 [Tool 输入 schema](../packages/contracts/src/agent-tool-input.ts) 定义；本文不复制参数 schema。

## Tool 绑定与恢复

每次页面 Tool 调用都必须在 JSON 中显式传入当前工具 schema 的 `contextId`、`scopeKey` 的 `const` 值；`const` 只限制取值，不会自动填入。读取不消耗 Page Context，无须让写入成为新回合的第一次调用。绑定值可能随页面状态或续签更新，不从历史对话复制。

绑定诊断发生在页面业务动作执行前，不代替业务结果核对：

| 诊断 | 含义与恢复 |
| --- | --- |
| `CLINMESH_BINDING_ARGUMENTS_INVALID` | 调用缺少或包含无效绑定字段；按错误列出的字段补齐当前 schema 的值后重试。 |
| `CLINMESH_HOST_SESSION_REQUIRED` | 宿主未关联 DSH Agent 会话；从打开 ClinMesh 工作台的会话调用，补参数不能恢复会话关联。 |
| `CLINMESH_BINDING_MISMATCH` | 参数与当前页面绑定不匹配；使用当前 schema 的值并重新读取页面状态。 |
| `AGENT_CONTEXT_EXPIRED` / `AGENT_CONTEXT_INVALID` / `AGENT_CONTEXT_STALE` | 服务端授权拒绝过期、无效或资源已变化的上下文；等待页面更新工具定义，按当前绑定读取状态后决定是否重试。工具持续未更新时重新打开工作台。 |

宿主和页面不会自动补入缺失绑定，也不会自动重放写入。网络中断、执行失败或回执失败仍按下述结果确认规则处理，不能套用绑定拒绝的“尚未执行”结论。

## 读取与编辑边界

原生 DSH Session 经 React Surface 与 browser-tools 调用当前授权岗位、页面和病例的窄 Tools。连接状态 active 只表示通道可用，不表示模型正在思考或操作；读取不会触发目标流光。模型 transcript 由 DSH 拥有，ClinMesh 不显示推测的模型活动。

`ui.context.read` 显式返回页面注册的状态与当前挂载表单的结构化值。挂号包含患者和挂号草稿，分诊包含主诉、分级与生命体征，医生包含当前病历、检验选择以及已挂载的初诊、诊断、处方或复诊表单，药房包含审核意见、批次与数量。未保存输入以当前编辑值返回；局部表单仅在所属页面和所选病例一致时纳入结果，离开表单后移除。它不是自动实时同步，不提供任意 DOM、跨患者读取或 Case Truth。

发布给模型的 Tool 描述约定：填写或保存草稿前先读取当前页面内容，包括未保存输入，再结合用户指令判断是否询问覆盖。该约定不提供程序强制的覆盖授权、独占编辑、并发编辑保护或自动合并。人工始终可以编辑；Agent 保存与人工编辑仍可能互相覆盖。正式医院 Command 继续要求应用内人工审阅，聊天中的同意不能替代该审阅。

## 反馈时序

输入通过校验且取得服务器授权后，页面动作开始执行时才发出执行反馈。执行超过 200 毫秒才显示缓慢流光与动作提示；快速动作直接进入完成反馈，不延迟业务，不模拟逐字输入。成功结果确认后停止流光，轮廓与完成提示保持约 300 毫秒，再用约 500 毫秒一起淡出。字段使用贴合控件圆角的细轮廓和低透明度柔光，记录与新消息使用浅底色；单目标显示小型渐变落点和一次短脉冲，批量目标同时强调，不模拟顺序执行。草稿动作明确显示“草稿已更新，尚未正式提交”。同一目标上的并发动作独立结束，仍在执行的动作保留流光。

普通反馈不移动焦点或滚动页面，也不锁定输入。明确导航或聚焦保留动作本身的视线移动；导航完成强调工作区标题，医生分区切换强调目标标签，不描出整块内容区。目标按视口、所属 Surface 和滚动容器裁剪。目标未挂载或在滚动区域外时仍显示动作状态。紧凑提示固定在页头下方，不占正文布局；并发调用显示数量，详情按钮可用键盘展开每项状态。失败、拒绝和结果未知的说明保留到关闭提示或上下文失效，不能呈现为成功。装饰层不接收输入，详情控件可正常操作。浅色与深色使用主题变量和不同柔光强度；减少动态效果偏好禁用流动、脉冲与淡出动画，保留静态提示并按同一期限清理完成状态。

病历草稿工具仍提交完整病历，但高光只覆盖本次输入与当前病例页面值不同的字段。比较在执行开始时进行，包含尚未保存的人工输入；本次字段集合保留到动作结束，保存后的表单刷新不会使完成高光消失。多个字段变化时同时突出，无字段变化或病历表单未挂载时只显示动作状态。该比较不阻止覆盖，也不提供执行期间的并发编辑保护。

问诊反馈覆盖发送中的消息、患者输入提示，以及执行期间新出现的文本消息气泡，不包住整个消息区域、标题、输入框或发送按钮；执行开始前已渲染的消息不高亮。诊断与处方草稿反馈同时覆盖相应目录入口；目录已打开时强调弹窗标题和已映射控件，反馈在弹窗内部绘制，并暂停强调被弹窗遮住的页面目标。Surface 目录和审阅框预留固定提示位，保留标题与关闭按钮的可达性；关闭弹窗后，未关闭的异常详情回到页面提示位。反馈不主动打开目录，直接保存草稿仍使用既有动作路径。

proposal 返回 `awaiting-human-review` 后，Tool 调用已经返回，但审阅仍可独立等待。审阅框使用静态轮廓并显示“待人工确认”；人工批准后按真实审批与提交过程显示状态，拒绝显示拒绝结果。打开预览、填写草稿和打开审阅框均不代表正式业务提交成功。

明确业务拒绝立即停止流光并显示原因。Abort、网络中断、超时、服务端错误、无法解析的响应或执行后回执失败显示结果尚未确认；视觉清理不表示请求已经取消、保存已经撤销或业务未发生。需要通过当前状态和既有 Command 恢复流程核对结果。

切换页面、病例、岗位、Workspace/Epoch、DSH Session，或 Surface 通道失活会清理旧目标。旧调用的晚到结果不能在新上下文重新点亮；主动导航和选择只允许对应动作的完成反馈转到其明确指定目标，病例详情加载期间仍以界面已选病例限定反馈。同一 Surface 与 Session 内重新注册工具时的短暂 `connecting` 不提前清理反馈。表单内容变化不会单独清除普通动作反馈；既有人工审阅仍按其页面版本与上下文合同失效。

## 当前操作

以下可见动作均先经过 Tool 输入校验、当前 Page Context 授权和页面可用性检查。填写列举的字段同时反馈；复杂结构替换强调对应行或业务区域。所有 `.propose` 动作都以人工审阅框为目标，采用上节独立审阅时序。

| Operation | 额外前提 | 目标与实际效果 |
| --- | --- | --- |
| `ui.navigate` | 目标工作区在当前岗位允许列表内 | 切换工作区；完成时强调目标页标题 |
| `ui.panel.focus` | 当前工作区面板存在 | 聚焦面板并强调页面标题 |
| `registration.synthetic-case.search` | 挂号页面 | 更新待诊病例搜索与列表；强调搜索框 |
| `registration.synthetic-case.select` | 病例在当前结果页中 | 选择目标病例行 |
| `registration.patient.search` | 挂号页面 | 更新患者搜索与列表；强调搜索框 |
| `registration.patient.select` | 患者在当前结果页中 | 选择目标患者行 |
| `registration.patient.draft.set` | 挂号页面 | 填写姓名、标识、出生日期与性别；不建档 |
| `registration.draft.set` | 挂号目录可用且选择有效 | 填写科室、地点与就诊类型；不挂号 |
| `registration.patient.create.propose` | 患者草稿必填内容完整 | 人工审阅创建患者档案 |
| `registration.outpatient.propose` | 已选患者及有效挂号目录项 | 人工审阅门诊挂号 |
| `registration.synthetic-case.start.propose` | 已选合成病例及有效挂号目录项 | 人工审阅开始病例 |
| `triage.case.select` | 病例在当前分诊队列页中 | 选择目标病例行 |
| `triage.draft.set` | 已选分诊病例 | 同时填写并强调主诉、分级及生命体征；不提交分诊 |
| `triage.record.propose` | 已选病例且主诉非空 | 人工审阅分诊评估 |
| `outpatient.case.select` | 病例在读取结果的 `queue.items` 中 | 选择目标病例，并切到其所属的待诊或在诊分组 |
| `outpatient.section.select` | 当前病例有相应可见诊疗页 | 选择并强调目标诊疗标签 |
| `outpatient.consultation.ask` | 当前病例允许问诊 | 发送问题，等待患者回答；强调本次新消息 |
| `outpatient.consultation.reply.retry` | 当前回复可重试 | 重试患者回答；强调本次新消息 |
| `outpatient.first-visit.draft.set` | 初诊草稿阶段 | 保存现病史和评估草稿；强调两个字段 |
| `outpatient.diagnosis.draft.set` | 独立诊疗流程且就诊进行中 | 保存诊断草稿；强调诊断行、添加或更换入口，以及已打开的疾病目录 |
| `outpatient.laboratory.draft.set` | 独立诊疗流程且就诊进行中 | 保存检验项目与指征；不下达申请 |
| `outpatient.prescription.draft.set` | 当前尚无正式用药结论 | 保存处方条目；强调药品名称、剂量、频次、疗程、数量、目录入口及处方区域；药品目录打开时覆盖目录和包装控件 |
| `outpatient.revisit.draft.set` | 兼容复诊草稿阶段 | 保存诊断、评估、计划与用药草稿 |
| `outpatient.record.draft.set` | 独立诊疗流程且就诊进行中 | 保存结构化病历；同时强调本次病历字段 |
| `outpatient.preview.request` | 已有可预览草稿 | 生成签署预览；强调病历区域 |
| `outpatient.visit.start.propose` | 病例可开始接诊 | 人工审阅开始接诊 |
| `outpatient.diagnosis.confirm.propose` | 诊断满足当前确认条件 | 人工审阅诊断确认 |
| `outpatient.laboratory.issue.propose` | 已有检验草稿 | 人工审阅开立检验申请 |
| `outpatient.laboratory.cancel.propose` | 申请可撤销 | 人工审阅撤销申请 |
| `outpatient.report.acknowledge.propose` | 有已签发报告 | 人工审阅报告已阅确认 |
| `outpatient.report.correct.propose` | 当前报告允许更正 | 人工审阅报告更正 |
| `outpatient.prescription.issue.propose` | 已有可开立处方草稿 | 人工审阅开立处方 |
| `outpatient.prescription.withdraw.propose` | 当前处方可撤回 | 人工审阅撤回处方 |
| `outpatient.medication.none.propose` | 尚无正式用药结论 | 人工审阅无需用药结论 |
| `outpatient.record.sign.propose` | 已有可签署草稿 | 生成预览并人工审阅签署 |
| `outpatient.record.revise.propose` | 存在已签署文书 | 人工审阅文书更正 |
| `outpatient.encounter.complete.propose` | 就诊进行中；提交时重验完成条件 | 人工审阅完成就诊 |
| `billing.item.select` | 费用在当前收费队列页中 | 选择目标费用记录 |
| `billing.payment.preview` | 已选费用 | 生成缴费预览；强调缴费详情区 |
| `billing.payment.confirm.propose` | 已有缴费预览 | 人工审阅缴费；页面展示成功、拒绝或结果不明 |
| `pharmacy.prescription.select` | 处方在当前药房队列页中 | 选择目标处方行 |
| `pharmacy.review.draft.set` | 已选处方 | 填写审核意见；不完成审核 |
| `pharmacy.dispense.draft.set` | 已选处方且批次属于其药品 | 填写批次和数量；不发药 |
| `pharmacy.review.propose` | 已选待审核处方且意见非空 | 人工审阅处方审核 |
| `pharmacy.dispense.propose` | 当前处方满足调剂前提 | 人工审阅发药 |
| `scenario.reset.propose` | 管理员场景页面 | 人工审阅重置；新 Epoch 清理旧反馈 |

只读操作包括 `ui.context.read`、`triage.queue.read`、`outpatient.case.read`、`billing.queue.read`、`pharmacy.queue.read`、`scenario.status.read`、`scenario.providers.read` 和 `scenario.generation.status.read`。它们读取授权范围内的页面或服务端结果，不显示执行边框，也不复制 Case Truth。

医生页面的 `clinmesh_read_current_context` 在 `data.pageState.queue` 返回已加载的医生队列页；`clinmesh_read_doctor_context` 保留当前病例详情字段，并在 `data.queue` 返回同一队列。`queue.items` 包含可用于切换的 `caseId`、患者身份和病例状态，`page`、`pageSize`、`total` 描述分页。该队列包含待诊与在诊病例，不等同于当前标签筛选后的列表；`queueCount` 保留为总数，不能据此推断已返回全部条目。队列尚未加载时 `queue` 为 `null`，空队列的 `items` 为 `[]`。选择工具只接受这份已加载队列中的病例，不提供任意患者查询、按姓名全库搜索或跨页选择；同名时应结合队列返回的身份字段消歧。

## 上游能力与接入限制

[React Surface](../vendor/dsh-react-surface/docs/ag-ui.md) 提供 Session-scoped capability lease、原生 Tool 注册和会话集成；ClinMesh 使用该 lease 与 browser-tools 的授权链路，不把 capability active 当成执行事件。上游 AG-UI 还支持 Gateway 与模型事件流，但当前 ClinMesh 未接入 Gateway，也不从模型 thinking、token 流或 transcript 推断字段动画。反馈只覆盖本表实际接入的页面动作，不是任意网页自动化或桌面控制。

standalone Web 保留相同人工编辑与业务 Command 流程，不发布 DSH Session Tools。反馈状态仅存在于当前客户端，不保存为医院事实、字段来源标记或可回放的编辑差异。设计取舍见 [Agent 操作反馈与编辑控制边界](../.agents/notes/implemented/architecture/2026-09-20-agent-action-feedback.md)。
