# DSH 页面操作与视觉反馈

本文说明 DSH ClinMesh 工作台实际接入的页面控制、业务操作及反馈。可执行工具名称、岗位与页面范围由 [Tool Catalog](../packages/contracts/src/agent.ts) 定义，输入约束由 [Tool 输入 schema](../packages/contracts/src/agent-tool-input.ts) 定义；本文不复制参数 schema。

## 读取与编辑边界

原生 DSH Session 经 React Surface 与 browser-tools 调用当前授权岗位、页面和病例的窄 Tools。连接状态 active 只表示通道可用，不表示模型正在思考或操作；读取不会触发目标流光。模型 transcript 由 DSH 拥有，ClinMesh 不显示推测的模型活动。

`ui.context.read` 显式返回页面注册的状态与当前挂载表单的结构化值。挂号包含患者和挂号草稿，分诊包含主诉、分级与生命体征，医生包含当前病历、检验选择以及已挂载的初诊、诊断、处方或复诊表单，药房包含审核意见、批次与数量。未保存输入以当前编辑值返回；局部表单仅在所属页面和所选病例一致时纳入结果，离开表单后移除。它不是自动实时同步，不提供任意 DOM、跨患者读取或 Case Truth。

发布给模型的 Tool 描述约定：填写或保存草稿前先读取当前页面内容，包括未保存输入，再结合用户指令判断是否询问覆盖。该约定不提供程序强制的覆盖授权、独占编辑、并发编辑保护或自动合并。人工始终可以编辑；Agent 保存与人工编辑仍可能互相覆盖。正式医院 Command 继续要求应用内人工审阅，聊天中的同意不能替代该审阅。

## 反馈时序

输入通过校验且取得服务器授权后，页面动作开始执行时才发出执行反馈。可见目标出现蓝、紫、青渐变边框和简短动作提示；快速动作直接进入完成反馈，不延迟业务，不模拟逐字输入。成功结果确认后停止流光，短暂亮起并在约 800 毫秒内淡出。草稿动作明确显示“草稿已更新，尚未正式提交”。同一目标上的并发动作各自结束，仍在执行的动作保留流光。

普通反馈不移动焦点或滚动页面，也不锁定输入。明确导航或聚焦保留动作本身的视线移动；导航完成强调目标工作区标题。目标未挂载或在滚动区域外时，工作区提示区显示动作名称和状态。提示区位于内容之外，不覆盖表单错误；边框不接收点击。减少动态效果偏好禁用流动与淡出动画，保留静态边框和文字，完成提示仍按同一时限清理。

问诊反馈覆盖消息滚动区域、发送中的消息和患者输入提示，以及执行期间新出现的文本消息气泡，不包住标题、输入框或发送按钮；执行开始前已渲染的消息不单独高亮。诊疗标签切换完成后强调目标内容区。诊断与处方草稿反馈同时覆盖相应目录入口；目录已打开时，边框在弹窗内部绘制，并暂停强调被弹窗遮住的页面目标。反馈不主动打开目录，直接保存草稿仍使用既有动作路径。

proposal 返回 `awaiting-human-review` 后，Tool 调用已经返回，但审阅仍可独立等待。审阅框打开时短暂强调，等待期间保持静止并显示“待人工确认”；人工批准后按真实审批与提交过程显示状态，拒绝显示拒绝结果。打开预览、填写草稿和打开审阅框均不代表正式业务提交成功。

明确业务拒绝立即停止流光并显示原因。Abort、网络中断、超时、服务端错误、无法解析的响应或执行后回执失败显示结果尚未确认；视觉清理不表示请求已经取消、保存已经撤销或业务未发生。需要通过当前状态和既有 Command 恢复流程核对结果。

切换页面、病例、岗位、Workspace/Epoch、DSH Session，或 Surface 通道失活会清理旧目标。旧调用的晚到结果不能在新上下文重新点亮；主动导航和选择只允许对应动作的完成反馈转到其明确指定目标。表单内容变化不会单独清除普通动作反馈；既有人工审阅仍按其页面版本与上下文合同失效。

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
| `outpatient.case.select` | 病例在当前医生队列页中 | 选择目标病例行 |
| `outpatient.section.select` | 当前病例有相应可见诊疗页 | 选择目标诊疗标签；完成时强调目标内容区 |
| `outpatient.consultation.ask` | 当前病例允许问诊 | 发送问题，等待患者回答；强调问诊记录区 |
| `outpatient.consultation.reply.retry` | 当前回复可重试 | 重试患者回答；强调问诊记录区 |
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

## 上游能力与接入限制

[React Surface](../vendor/dsh-react-surface/docs/ag-ui.md) 提供 Session-scoped capability lease、原生 Tool 注册和会话集成；ClinMesh 使用该 lease 与 browser-tools 的授权链路，不把 capability active 当成执行事件。上游 AG-UI 还支持 Gateway 与模型事件流，但当前 ClinMesh 未接入 Gateway，也不从模型 thinking、token 流或 transcript 推断字段动画。反馈只覆盖本表实际接入的页面动作，不是任意网页自动化或桌面控制。

standalone Web 保留相同人工编辑与业务 Command 流程，不发布 DSH Session Tools。反馈状态仅存在于当前客户端，不保存为医院事实、字段来源标记或可回放的编辑差异。设计取舍见 [Agent 操作反馈与编辑控制边界](../.agents/notes/implemented/architecture/2026-09-20-agent-action-feedback.md)。
