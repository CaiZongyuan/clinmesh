# Agent Note: 医生核心临床业务流

Status: implemented

## Problem

普通门诊中的问诊、正式病历、检查申请、诊断报告、诊断、处方和完诊条件分别拥有独立生命周期。若把这些事实压缩为页面状态或 Scenario 进度，医生无法连续承担同一 Encounter 的诊疗责任，正式事实、纠错窗口和审计关系也会相互混淆。

ClinMesh 同时保留既有多岗位发热闭环和医生直达核心临床链路。医生直达不能伪造分诊、收费或检验岗位行为，也不能破坏既有闭环资源和状态机，因此两类入口必须共享正式 FHIR 事实，并由各自领域 owner 管理草稿、命令和进度。

## Decision

普通门诊发热病例由连续的医生核心链路处理：选择 Virtual Patient、开始接诊、记录 Consultation Record、编辑并签署结构化病历、开具检查、接收和查看报告、确认诊断、开具处方或明确无需用药、完成 Encounter，并在已完诊病例中查看只读详情和统一业务时间线。一个 Encounter 贯穿整条诊疗链，不因检查等待、报告返回或再次进入医生工作台而新建 Encounter。

医生可以直接从 Virtual Patient 列表开始接诊。底层仍建立 Registration 和 Queue Task 以保持 HIS 业务事实完整，但医生工作台不要求手工扮演挂号、分诊、收费、检验和药房岗位。Virtual Patient 使用版本固定的病例事实和确定性回答规则，不依赖 LLM；Consultation Record 与正式 Clinical Document 分别保存，医生必须手工整理结构化病历。

Virtual Patient 是独立于 Patient Identity 和 Encounter 的候选病例事实。候选列表只暴露临床可见摘要和服务端认证加密的 opaque version；该 version 绑定当前上下文和可复用病例的资源版本，使浏览器无需读取 Encounter 或 Queue Task 技术状态。医生开始接诊时复用其绑定的合成 Patient，避免产生第二个活动 Encounter，同时不伪造分诊或费用事实。当前原子创建或复用、版本冲突、幂等回执和可见字段合同由[门诊闭环](../../../../docs/architecture.md#81-门诊闭环)拥有。

开始 Virtual Patient 接诊时同时建立病例级 Consultation。医生只能选择 Scenario 提供的受控问题，每次回答作为有序、不可变、带版本的 Consultation Record 追加；重试、并发冲突、规则保密与读取合同由[门诊闭环](../../../../docs/architecture.md#81-门诊闭环)拥有。问答记录与 `clinical_draft` 分别持久化，刷新后可恢复，但不会自动成为医生负责的正式病历。

临床文书支持草稿、版本、签署和签署后 Clinical Document Revision。检查请求支持草稿、开具、受理、执行中、已报告和医生已阅；当前独立检查目录包含血常规和 C 反应蛋白。Observation 保存结构化结果，DiagnosticReport 保存可读报告并引用结果；已签发报告不可删除，更正创建新版本和替代关系。诊断与 Prescription 分别支持草稿和正式状态，不把页面切换当作签发。

带 Consultation 的医生病例由独立检查申请聚合拥有草稿版本和正式状态。草稿删除与开具都递增同一个单调版本，开具才创建 ServiceRequest 和以该请求为 `focus` 的执行 Task；同一病例中同项目只允许一个未取消申请。LIS 通过持久 outbox 推进受理与执行，只有尚未受理的 `issued` 申请可普通取消，晚到受理事件不能恢复已取消申请。详细生命周期和 FHIR 映射由[门诊闭环](../../../../docs/architecture.md#81-门诊闭环)拥有。

执行中的独立申请由下一条持久 outbox 事件签发报告。确定性结果属于 Scenario Hidden Fact；LIS Command 为每个申请创建关联的 Specimen、数值 Observation、DiagnosticReport 和 Provenance，并完成 ServiceRequest 与执行 Task，但保留 Encounter、医生 Queue Task 和 Report Acknowledgement 的独立生命周期。申请只保存 DiagnosticReport 关联，医生读模型从已签发 FHIR 资源还原数值、UCUM 单位、参考范围、异常标识和结论，避免目录或后续模板变化改写历史报告。稳定资源 ID 与申请级终态检查共同覆盖同 event ID 重放和不同 event ID 重复投递。

既有多岗位发热闭环继续使用带收费的 `issue-laboratory-order` 兼容命令和发热检验组合。独立入口只接受血常规与 C 反应蛋白，不创建 ChargeItem，也不完成医生 Queue Task；两条路径共享 FHIR 资源类型，但不共享草稿、领域状态机或计费触发点。

Encounter Completion Policy 只汇总各 owner 已确认的事实，不复制其状态机。医生只有在主诊断已确认、病历已签署、必要检查已报告且完成 Report Acknowledgement、处方已开具或明确无需用药、没有未处理草稿、处置和随访完整时才能完成 Encounter。完诊后病例进入只读查询入口，展示 Consultation Record、病历版本、检查、报告、诊断、处方和业务时间线；更正通过原模块的受控命令产生新事实，不解锁并覆盖历史内容。

[最小临床纠错](https://github.com/CaiZongyuan/clinmesh/issues/32)提供删除未开具草稿、取消尚未执行的检查、撤回尚未调剂的处方、签署后更正病历和签发后更正报告。五类入口统一展示待处理对象、要求显式确认并反馈结果，服务端仍按 owner 状态机重新校验 expected version、幂等、身份和可逆窗口。可向用户解释的冲突返回 strict `conflict` 对象，以受控 `owner`、本地资源引用、当前状态、当前版本和预期版本表达服务端已知事实；Web 只从验证后的字段生成本地化反馈，不解析或显示服务端英文诊断。每个纠错 Command 在 expected version 校验前执行岗位、作者和病例责任预检，未授权请求不能借过期版本探测资源状态，失败尝试仍进入 Command 审计。Web mutation error 同时绑定病例和目标对象，切换病例后不显示上一病例的失败。每个成功动作生成 Audit Event，病历和报告更正还生成适用 Provenance 与替代关系。退费、退药、医保和库存等跨部门逆向流程另立范围。

一个 Super Administrator 账户可以从全局顶栏选择 Acting Practitioner Context，项目显示“岗位 · 人员”，并直接进入对应工作台。页面持续显示当前操作身份；Command、Audit Event 和 Provenance 同时记录超级管理员 Actor 与被选择的 Practitioner/Practitioner Role，跨身份重放服从[幂等合同](../../../../docs/architecture.md#65-idempotency)。该能力不增加独立代理页面、原因输入或限时授权，也不允许普通账户任意指定行动身份。

Web 使用高信息密度的临床工作台：204px 任务侧栏、54px 顶栏、患者上下文条、临床 tabs、紧凑表格和固定提交区。`packages/ui` 拥有 token 与实际组件，`docs/ui/design.md` 保存设计合同，真实 `/components` 页面直接渲染组件的尺寸、variant、交互状态、明暗主题和长中文。静态 UI 原型只作为冻结参考，不拥有产品行为。

正式事实沿用 FHIR R5 `5.0.0`：Encounter 表达就诊，Composition、document Bundle 和 Provenance 表达签署病历及修订，ServiceRequest 表达正式检查申请，Observation 与 DiagnosticReport 表达结果和报告，Condition 表达正式诊断，MedicationRequest 表达正式用药请求，Task 表达候诊和报告待阅工作。草稿由领域 owner 保存，不伪装成正式 FHIR 资源。

## Alternatives considered

**先继续扩展完整多岗位闭环。** 这能增加收费和药房演示范围，却不能解决医生临床事实过薄、状态互相压缩和频繁换账号的问题，因此这些跨部门模块暂不扩展。

**让超级管理员直接覆盖登录用户。** 这种实现简单，但会丢失真实 Actor 与所代表工作人员的审计关系。Acting Practitioner Context 保留两者，同时把产品交互收敛为一个直观选择器。

**把问诊对话直接作为病历。** 这减少一次录入，却混淆原始问答和医生负责的正式文书，也无法支持结构化签署与修订。两类事实必须独立存在并可关联查看。

**把 Virtual Patient 等同于 Patient Identity，或为直接接诊伪造分诊。** 前者会把病例协议、可用状态和稳定患者身份混为同一事实，后者会记录实际从未发生的护理观察。候选病例保持独立，直接入口只建立真实发生的医生接诊事实。

**用一个 Encounter 或页面状态推进全部临床步骤。** 这会让报告更正、病历修订、处方撤回和检查取消失去各自前置条件。各模块拥有独立生命周期，Completion Policy 只读取其正式状态。

**让 Web 解析服务端错误消息中的状态和版本。** 这会把本地化和行为判断绑定到英文诊断文本，文案调整即可破坏客户端，也会诱导页面显示未经验证的服务端内容。冲突因此使用受控结构化字段，诊断消息只保留给协议调用方和排障。

**先校验 expected version，再在 Command handler 中授权。** 这保留较短的 Command 接口，却会向无权操作目标的岗位暴露资源是否存在及其版本变化；把授权移到 Command 外又会丢失失败审计。Command 内的授权预检先于版本校验，并复用原有失败 Audit Event。

**复用既有带收费的检验签发命令承载医生直达检查。** 该命令会创建 ChargeItem、完成医生 Queue Task 并把病例推进到待缴状态，无法表达医生仍在同一首诊中连续开具多个独立项目。保留兼容命令并新增独立 owner 避免改变既有多岗位闭环，代价是维护者必须按业务入口和领域聚合判断 ownership，不能只按 ServiceRequest 资源类型推断状态机。

**同时加入 AI Agent、自动病历和复盘评分。** 这些能力会在临床基础设施尚未可信时引入第二套交互和评价语义。本阶段不提供 Agent、自动生成或评分入口。

## Consequences

- 医生可以在一个 Web 登录上下文中完成 Virtual Patient 接诊、问诊、病历签署、检查与报告已阅、诊断、用药结论、完诊和只读回看。临床岗位页面使用业务术语，不显示 Agent、评分、Scenario 或 Epoch 标识。
- Consultation Record、临床文书、检查请求、报告、诊断和处方分别持久化状态与版本；刷新或重新登录可恢复，纠错只能通过各 owner 的受控命令产生新事实。
- Encounter Completion Policy 只汇总正式事实。门禁满足后只完成 Encounter；检查、报告、文书、处方和 Scenario Run 保留各自状态。
- Virtual Patient 直达接诊由共享 Command 原子建立 Registration、Queue Task 和病例责任，不记录未发生的分诊、收费或检验岗位行为。
- 既有带收费检验与独立检查都产生 ServiceRequest。报告、取消和计费逻辑必须先解析 owner，不能依据资源类型隐式推进另一条业务路径。
- Super Administrator 的 Acting Practitioner Context 同时保留真实 Actor 与所代表的 Practitioner Role；普通账户不能指定行动身份。
- 正式资源通过 FHIR R5 current、history 和白名单 Search 读取；草稿与仿真私有事实不进入公开 FHIR API，CapabilityStatement 不声明未实现写入。
- Web 产品页与 `/components` 共同使用 `packages/ui` 的实际组件。验证从公开 Server/Web seam 驱动真实持久化流程，不以组件内部状态作为完成证据。
