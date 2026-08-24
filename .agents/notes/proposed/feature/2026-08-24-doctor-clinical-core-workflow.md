# Agent Note: 医生核心临床业务流

Status: proposed

## Problem

当前首期闭环证明了多岗位认证、持久化、FHIR 读取和基本门诊交接，但医生必须来回切换多个普通账户才能获得患者，问诊、病历、检查、报告、诊断和处方仍被压缩在少量步骤中。页面状态和 Scenario 进度不足以表达每类临床事实的独立生命周期，医生也缺少可连续完成诊疗责任的工作台和已完诊病例入口。

继续扩展收费、药房、医保或 Agent 功能会放大这个缺口。下一阶段必须先建立可执行的医生核心临床基础设施，让同一个 Encounter 中的问诊过程、正式病历、检查申请、诊断报告、诊断、处方和完诊条件各自拥有清晰边界，同时保留可审计的关联和纠错路径。

## Proposal

下一阶段聚焦普通门诊发热病例的医生核心链路：选择 Virtual Patient、开始接诊、记录 Consultation Record、编辑并签署结构化病历、开具检查、接收和查看报告、确认诊断、开具或明确无需处方、完成 Encounter，并在已完诊病例中查看只读详情和统一业务时间线。一个 Encounter 贯穿整条诊疗链，不因检查等待、报告返回或再次进入医生工作台而新建 Encounter。

医生可以直接从 Virtual Patient 列表开始接诊。底层仍建立 Registration 和 Queue Task 以保持 HIS 业务事实完整，但首期医生体验不要求手工扮演挂号、分诊、收费、检验和药房岗位。Virtual Patient 使用版本固定的病例事实和确定性回答规则，不依赖 LLM；Consultation Record 与正式 Clinical Document 分别保存，医生必须手工整理结构化病历。

Virtual Patient 是独立于 Patient Identity 和 Encounter 的候选病例事实。候选列表只暴露版本和临床可见摘要；医生开始接诊时复用其绑定的合成 Patient，若该 Patient 已有可进入首诊的活动门诊病例则复用同一底层上下文，避免产生第二个活动 Encounter，同时不伪造分诊或费用事实。当前原子创建或复用、版本冲突、幂等回执和可见字段合同由[门诊闭环](../../../../docs/architecture.md#81-门诊闭环)拥有。

临床文书支持草稿、版本、签署和签署后 Clinical Document Revision。检查请求支持草稿、开具、受理、执行中、已报告和医生已阅；首批交付血常规和 C 反应蛋白。Observation 保存结构化结果，DiagnosticReport 保存可读报告并引用结果；已签发报告不可删除，更正创建新版本和替代关系。诊断与 Prescription 分别支持草稿和正式状态，不把页面切换当作签发。

Encounter Completion Policy 只汇总各 owner 已确认的事实，不复制其状态机。医生只有在主诊断已确认、病历已签署、必要检查已报告且完成 Report Acknowledgement、处方已开具或明确无需用药、没有未处理草稿、处置和随访完整时才能完成 Encounter。完诊后病例进入只读查询入口，展示 Consultation Record、病历版本、检查、报告、诊断、处方和业务时间线；更正通过原模块的受控命令产生新事实，不解锁并覆盖历史内容。

首期提供最小纠错能力：删除未开具草稿、取消尚未执行的检查、撤回尚未调剂的处方、签署后更正病历和签发后更正报告。退费、退药、医保和库存等跨部门逆向流程另立范围。

一个 Super Administrator 账户可以从全局顶栏选择 Acting Practitioner Context，项目显示“岗位 · 人员”，并直接进入对应工作台。页面持续显示当前操作身份；Command、Audit Event 和 Provenance 同时记录超级管理员 Actor 与被选择的 Practitioner/Practitioner Role，跨身份重放服从[幂等合同](../../../../docs/architecture.md#65-idempotency)。该能力不增加独立代理页面、原因输入或限时授权，也不允许普通账户任意指定行动身份。

Web 使用高信息密度的临床工作台：204px 任务侧栏、54px 顶栏、患者上下文条、临床 tabs、紧凑表格和固定提交区。`packages/ui` 拥有 token 与实际组件，`docs/ui/design.md` 保存设计合同，真实 `/components` 页面直接渲染组件的尺寸、variant、交互状态、明暗主题和长中文。静态 UI 原型只作为冻结参考，不拥有产品行为。

正式事实沿用 FHIR R5 `5.0.0`：Encounter 表达就诊，Composition、document Bundle 和 Provenance 表达签署病历及修订，ServiceRequest 表达正式检查申请，Observation 与 DiagnosticReport 表达结果和报告，Condition 表达正式诊断，MedicationRequest 表达正式用药请求，Task 表达候诊和报告待阅工作。草稿由领域 owner 保存，不伪装成正式 FHIR 资源。

## Alternatives considered

**先继续扩展完整多岗位闭环。** 这能增加收费和药房演示范围，却不能解决医生临床事实过薄、状态互相压缩和频繁换账号的问题，因此这些跨部门模块暂不扩展。

**让超级管理员直接覆盖登录用户。** 这种实现简单，但会丢失真实 Actor 与所代表工作人员的审计关系。Acting Practitioner Context 保留两者，同时把产品交互收敛为一个直观选择器。

**把问诊对话直接作为病历。** 这减少一次录入，却混淆原始问答和医生负责的正式文书，也无法支持结构化签署与修订。两类事实必须独立存在并可关联查看。

**把 Virtual Patient 等同于 Patient Identity，或为直接接诊伪造分诊。** 前者会把病例协议、可用状态和稳定患者身份混为同一事实，后者会记录实际从未发生的护理观察。候选病例保持独立，直接入口只建立真实发生的医生接诊事实。

**用一个 Encounter 或页面状态推进全部临床步骤。** 这会让报告更正、病历修订、处方撤回和检查取消失去各自前置条件。各模块拥有独立生命周期，Completion Policy 只读取其正式状态。

**同时加入 AI Agent、自动病历和复盘评分。** 这些能力会在临床基础设施尚未可信时引入第二套交互和评价语义。本阶段不提供 Agent、自动生成或评分入口。

## Acceptance criteria

- 医生可以在一个真实 Web 入口中选择发热 Virtual Patient，并在同一 Encounter 内连续完成问诊、病历、检查、报告已阅、诊断、处方和完诊。
- Consultation Record、临床文书、检查请求、报告、诊断和处方分别具有持久状态、版本与受控纠错行为，刷新或重新登录不会丢失。
- Encounter Completion Policy 对缺失的正式事实给出可操作阻塞原因，满足全部条件后只完成 Encounter，不混淆其他业务完成状态。
- 已完诊病例以只读详情和业务时间线展示全部相关临床事实与修订链。
- Super Administrator 可以选择任意合成 Practitioner Role 与 Practitioner 执行业务，界面持续显示操作身份，审计同时保留两层身份。
- Web 采用 `docs/ui/design.md` 约束的高密度临床布局，`/components` 展示 `packages/ui` 的真实组件及关键状态。
- FHIR R5 读取、history 和已声明 Search 能查询本阶段产生的正式资源，能力声明不包含未实现写入。
- 自动化验收从公开的 Server/Web seam 驱动真实持久化流程，并覆盖完诊门禁、版本冲突、最小纠错、授权与审计，不以组件内部状态作为完成证据。

## Risks

- 当前首期实现把复诊草稿、处方和签署完诊紧密组合，拆分独立生命周期时容易破坏已经可执行的多岗位发热闭环；实施必须用兼容迁移和纵向切片保持每个 checkpoint 可运行。
- Virtual Patient 的医生直达体验可能绕过必要的 Registration 和 Queue Task 事实；创建或选择病例时必须由共享 Command 原子建立底层业务上下文。
- 组件目录若复制示例 markup 会与产品组件漂移；页面必须导入并渲染实际组件。
- 报告和病历修订若允许普通覆盖会破坏审计链；持久化和 API 必须以新版本、替代关系和预期版本约束更正。
