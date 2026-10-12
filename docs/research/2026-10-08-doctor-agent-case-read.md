# 医生 Agent 当前病例与历史资料读取研究

## 范围与证据

核验日期：2026-10-08。代码基线：`4a3e1cf065f086f4b1aeca572272f25cb1a6d7c2`。本文为医生助手 Issue #176 的设计提供事实与建议，不替代[正式规格](../spec/2026-10-08-doctor-agent-assistant.md)，不表示以下建议已经批准或实现。证据来自仓库实现和现有测试，本轮未运行生产业务测试，不把测试文件存在表述为本轮验证通过。

已确认的读取目标是：现有 DSH `clinmesh-assistant` 可在后台读取当前患者中医生有权查看的本次就诊与既往资料，不切换医生正在操作的页面，不读取 Case Truth、隐藏档案或生成输入。本文不设计全病历自动整理、质控或诊疗建议，不重做 #166–#172。

## 当前实现事实

### 当前病例读取已经跨栏目

[`outpatient.case.read`](../../packages/contracts/src/agent.ts:303) 对应 `clinmesh_read_doctor_context`，只限制医生岗位和接诊 view，没有声明诊疗栏目。相反，问患者、填写诊断、处方和病历等动作分别声明栏目。[`agentToolsForContext`](../../packages/contracts/src/agent.ts:355) 明确让没有声明栏目的 Tool 在所有栏目发布。因此，“后台读取病例不切换栏目”已有部分能力；问题不是整个病例读取被栏目裁剪。

该 Tool 的[页面 action](../../apps/web/src/app/doctor/doctor-case-controller.tsx:1161) 不接受 `caseId`，直接用当前 `activeCaseId` 调用 `getDoctorCase`，并行获取放射、病理可选目录，返回完整病例与岗位队列。它不点击栏目、不抢焦点，且对两类目录读取失败返回 `null`，不把整个病例读取判为失败。[普通页面 Query](../../apps/web/src/app/doctor/doctor-case-controller.tsx:438)也使用同一个 `getDoctorCase` 入口。

当前绑定仍包含栏目与页面语义版本：[`pageScopeKey`](../../apps/server/src/application/agent-integration-service.ts:946) 纳入 `activeSection`、选择及其版本、view、Actor、Practitioner Role、Workspace/Epoch、Scenario Run 和 DSH Session；[`authorizeToolCall`](../../apps/server/src/application/agent-integration-service.ts:336)校验真实 proof、绑定、允许 operation 和当前资源。因此栏目变化虽然不改变该读取 Tool 的业务内容，仍改变模型需要提交的绑定。本文只指出事实，不建议直接放宽所有写入绑定。

### 当前就诊资料与既往资料不是一份数据

| 可复用投影 | 现有内容 | 实际边界 |
| --- | --- | --- |
| [DoctorCaseDetail](../../packages/contracts/src/his.ts:1751) | 患者基本信息、过敏摘要、分诊、问诊记录、临床草稿和已签文书、诊断、检查申请及文本报告、处方及用药结论 | 当前就诊主要入口；不同患者及场景不保证每个字段都存在 |
| [`priorFacts`](../../apps/server/src/application/workflow-service.ts:3008) | 本地当前 Epoch 同患者 `Condition` 摘要，排除本次 Encounter | 固定 `_count=100`，没有继续分页；不包括完整既往用药、报告、文书或外部 Synthea 来源病史，不能称为完整既往档案 |
| [问诊记录投影](../../apps/server/src/application/workflow-service.ts:9393) | 已保存的 Consultation turns 与版本 | 不返回完整 Patient Persona；医生和患者已经说出的内容属于可见信息 |
| [Visible Source History 列表](../../apps/server/src/application/scenario-data/scenario-data-service.ts:430) | 按日期分组的外部来源历史索引，现有 HTTP 每页最多 20 组 | 独立 `synthetic_case_*` 数据，不是本地 R5 HIS 历史；当前医生病例 Tool 没有接入它 |
| [Visible Source History 详情](../../apps/server/src/application/scenario-data/scenario-data-service.ts:452) | 指定 `sourceReference` 的外部可见资源，标记 `synthea-r4-external` | 只从 visible resource 表取值，不能读取 hidden resource |
| [已完诊列表](../../apps/server/src/application/workflow-service.ts:2635)与[详情](../../apps/server/src/application/workflow-service.ts:2705) | 既往完诊的问诊、文书、诊断、检查报告、用药结论及临床时间线 | 当前 Epoch、当前责任医生；列表可按患者筛选，详情联表验证责任医生及完诊状态，不是全院历史通用查询 |
| [当前可见 UI 状态](../../apps/web/src/app/doctor/doctor-case-controller.tsx:2272) | 当前病例摘要、客户端正在编辑的临床病历内容、检验草稿、栏目与队列 | 客户端未保存内容不能被后台服务端 Query 自动当作已保存事实；读取 UI 的用途与读取服务端病例资料不同 |

现有[病例 HTTP](../../apps/server/src/app.ts:1407)调用 `workflow.doctorCaseDetail`，由[受信身份解析](../../apps/server/src/app.ts:1127)提供 Actor；CLI 的 [`doctor.case.get`](../../packages/contracts/src/his-operations.ts:1306)也复用此 Query。这里不需要再建一套跨栏目诊疗 Query。

## 授权与隐藏事实的真实 seam

### 当前选择授权比裸病例 Query 更窄

[`resolveSelection`](../../apps/server/src/application/agent-context-policy.ts:278)对当前接诊 case 检查 Workspace/Epoch、Scenario Run、Encounter 当前版本与 `in-progress` 状态，以及责任医生。`awaiting-doctor` 允许接诊前查看；其他状态要求责任医生与当前 Practitioner Role 一致。`resolveAgentPageContext` 和 `validateAgentToolInputForContext` 在[签发及每次调用时](../../apps/server/src/application/agent-context-policy.ts:115)重新执行这项检查。[`#assertCurrentCaller`](../../apps/server/src/application/agent-integration-service.ts:803)另外匹配当前 User Account、Actor、Practitioner Role 与 Workspace/Epoch。

相比之下，[`doctorCaseDetail`](../../apps/server/src/application/workflow-service.ts:2841)本身先校验医生角色，再按 Workspace/Epoch/caseId 查数据；该方法没有调用 `#assertCaseResponsibility`，查询也没有 Scenario Run 或责任医生条件。因此复用它时必须保留受信当前病例检查，不能把现有方法的存在理解为已经满足“Agent 只访问当前患者”的合同，也不能新增让模型传任意 `caseId` 的读取 Tool。

### 外部历史必须从当前病例的服务端关联进入

`outpatient_case.case_id` 与 `synthetic_case_instance.case_id` 是两种标识。[`synthetic_case_materialization`](../../apps/server/src/application/workflow-service.ts:2058)持久保存 Workspace/Epoch、Synthetic Case、Patient、Outpatient Case 和 Encounter 的关联。读取外部历史前，应由服务端从已经授权的当前 Outpatient Case 解析这条关联，使用 Workspace/Epoch 与当前病例限定查询；不得采用模型或客户端自报的 synthetic case ID、profile ID 或 Patient ID 替代它。

现有 [`getSyntheticCase`](../../apps/server/src/application/scenario-data/scenario-data-service.ts:415)对普通医生要求当前 Workspace/Epoch 已有该 Synthetic Case 的物化记录，[`hasMaterialization`](../../apps/server/src/infrastructure/sqlite/synthetic-case-repository.ts:361)以这三个值查询。但这一检查证明“本轮存在该合成病例”，不证明“它是当前病例”。所以列表/详情可复用可见投影，但仍需先补上当前病例关联限制。

[`casePersonaBinding`](../../apps/server/src/application/workflow-service.ts:9698)也读这张关联表，但它会同时读取完整 Patient Persona，且其 SQL 没有 Epoch 条件。它是虚拟患者运行的内部输入，不应作为临床资料读取捷径；本票只复用关联表的事实，不复用该方法返回内容。

### 可见来源与隐藏真值已物理分开

[`compileSyntheaIndexCase`](../../apps/server/src/application/scenario-data/synthea-index-case.ts:229)先计算 Index Encounter 及关联闭包为隐藏资源，其余历史只在临床时间早于 Index Encounter 时进入可见集合，共享资源另按类型纳入。创建病例时[校验 visible/hidden 清单不交叉](../../apps/server/src/infrastructure/sqlite/synthetic-case-repository.ts:222)，随后分别存入 [`synthetic_case_visible_resource`](../../apps/server/src/infrastructure/sqlite/synthetic-case-repository.ts:270)和 `synthetic_case_truth`。

[`getVisibleResource`](../../apps/server/src/infrastructure/sqlite/synthetic-case-repository.ts:523)只查询 visible resource 表；[`getTruthForSimulator`](../../apps/server/src/infrastructure/sqlite/synthetic-case-repository.ts:543)是另一条私有读取路径。管理员[真值接口](../../apps/server/src/app.ts:754)执行[administrator-only 检查](../../apps/server/src/application/scenario-data/scenario-data-service.ts:438)。医生 Agent 不应因为同一账户另有管理员岗位而取得它，也不能读取来源 raw Bundle、Patient Persona 全文或 generation prompt。该边界与[领域词汇中的 Case Truth / Visible Source History](../../CONTEXT.md:71)一致。

现有[来源历史测试](../../apps/server/tests/synthetic-case-http.test.ts:383)核对公开 profile/case 不含 Index Encounter 等隐藏值，并验证隐藏 reference 经历史详情返回 404；[管理员真值测试](../../apps/server/tests/synthetic-case-http.test.ts:471)覆盖普通医生等岗位 403、未登录 401 和跨 Workspace 失败。它们是可复用测试 seam，本轮只检查了测试源码。

## 最少改动的读取设计建议

1. 保留现有 `outpatient.case.read` 作为当前病例快照入口，继续复用 `doctorCaseDetail`。Tool 不接受任意 Patient/Case/Workspace/Actor 标识；执行时由服务端从真实 DSH Session、登录身份与当前绑定选择解析目标，并重新验证授权。先修复绑定管理，不因后台读取复制一套业务 Query。
2. 对资料集合使用两个按需读取动作：当前患者历史索引，以及从索引选择的单项详情。索引可复用 Visible Source History 分组与当前责任医生的同患者完诊列表；详情复用 visible-only resource 或已完诊详情 Query。输入仅为有界分页或从索引取得的 reference，服务端把 reference 约束到当前患者的授权集合；不暴露任意 URL、resource type/id、SQL 或通用 FHIR 读取能力。
3. 在病例快照及历史结果中明确实际覆盖范围、分页、来源类型、业务时间与已有资源版本。没有 Synthetic Case 关联时返回明确不适用/空索引；目录读取失败、未记录信息和查询失败不能合并成“患者没有这些事实”。来源 R4 与本地 R5 不混装，不重建通用转换器。
4. 保留现有历史权限：当前 Epoch、相应可见来源及当前医生能够查询的既往完诊记录。当前实现没有已授权的“同患者跨 Epoch 全量档案” Query，不应借本票扩大到其他医生或其他轮次。如果需求确实要增加这类能力，由主任务提出具体权限取舍。
5. 将测试 seam 放在当前病例授权后的读取 Module interface，服务端调用真实现有 Query 与可见历史投影，Surface 只负责桥接与客户端未保存状态。对象切换或授权失效后，迟到结果不得交给新患者任务；读取可按当前任务安全恢复，写入仍执行原有版本、执行结果与人工确认合同。跨栏目稳定只读与旧写入意图失效必须分别验证。

现有 Tool 数量受 DSH 单次注册 32 项限制，当前[栏目目录](../../packages/contracts/src/agent.ts:298)已有较多检查类动作。新增历史动作前应统计最密集的检验/放射/病理栏目，不把所有读取与写入全集无条件发布。这是实现约束，不需要为本票增加通用 Tool router。

## 建议验收与最窄验证入口

| 可观察行为 | 推荐入口与关键断言 |
| --- | --- |
| 在任一病例栏目读取本次就诊 | 扩展[医生页面真实 Tool 测试](../../apps/web/src/app/role-workspaces.test.tsx:3209)：问诊、病历、诊断、处方和检查栏目均能读取相同当前病例、无需栏目切换；读取不改变焦点、tab 或未保存草稿 |
| 防止越过当前患者授权 | 扩展[Agent Context HTTP](../../apps/server/tests/agent-context-http.test.ts:391)：伪造其他 case、其他医生责任病例、Workspace/Epoch/Scenario Run、旧 Session 或已失效岗位不得返回正文；等待接诊规则仍有效 |
| 读取真实可见历史 | 复用[来源历史 HTTP](../../apps/server/tests/synthetic-case-http.test.ts:424)和完诊 Query测试：服务端关联正确、分页可继续、详情属于索引、没有来源时明确为空；不同来源标记与业务时间可追溯 |
| 不泄漏隐藏答案 | 验证 hidden reference、其他患者 reference、管理员真值、Persona 全文和生成输入均不可读；用不同的合成哨兵事实断言结果、错误、日志和模型输入都不含它们 |
| 旧结果不进入新任务 | 在读取进行中切换患者/岗位/Session，断言迟到结果被废弃或暂停；同患者仅栏目变化后，安全只读仍可继续，草稿写入及正式提案不因只读放宽而绕过原校验 |
| 真实 DSH 使用 | 通过真实医生入口验证主聊天可综合问诊、报告和可见历史，当前页面保持不动；资料不足时提示补充，不自行问患者，不产生正式 Command |

本文未修改生产代码，没有运行上述验收。文档检查由主任务对集成后的文档 diff 统一执行；没有新增依赖、数据库事实或泛化读取框架。
