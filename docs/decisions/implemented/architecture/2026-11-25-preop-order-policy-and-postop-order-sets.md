# Agent Note: 手术通知单停续术前医嘱策略与术后成套医嘱重整

Status: implemented

## Problem

真实中国公立医院中，不同类型手术对术前在执长期医嘱的处置策略截然不同：局麻冠脉介入（PCI）术后通常延续术前口服双抗与他汀等长期内科用药，而全麻普外手术（如腹腔镜胆囊切除术、腹腔镜阑尾切除术、腹股沟疝修补术）因禁食水与生理改变，须在术后自动停用术前常规长期医嘱并按术后路径重新整理医嘱。此前 ClinMesh 的手术通知单没有结构化声明术前医嘱停续策略，手术完成后也缺乏统一的术后重整入口，存在三处闭环断点：

1. 全麻手术完成后医生需手工逐条翻找并停用术前在执长期医嘱，且因旧校验把 `stop-requested` 计入在用重复用药／药理互斥集合，在护士完成 `verify-stop` 前无法立即重新下达术后替代药嘱；
2. 术后检验与功能检查无法关联本次已完成手术（`surgeryExecutionId`），无法在 FHIR `ServiceRequest.supportingInfo` 与临床视图追溯术后复查归属；
3. 专病医嘱组套仅覆盖术前与通用场景，缺少 PCI 术后与普外术后成套模板，也缺少针对病区护理服务（`kind = 'service'`）及“术前已在用药物／同药理互斥类／在途未完成医技”的去重跳过（`skipped`）语义。

## Decision

建立以手术通知单 `preopOrderPolicy` 驱动的围术期医嘱停续闭环，并在共享 `Order Set Template` 引擎与住院界面上提供零新写 Command 的术后医嘱重整统一编排器：

- **手术通知单显式声明术前医嘱停续策略（`preopOrderPolicy`）**：`inpatient.surgery.request`（v5）新增必填字段 `preopOrderPolicy: 'continue-active' | 'stop-on-completion'`，落库至 `inpatient_surgery_request.preop_order_policy`（迁移 `0122_surgery-preop-policy-and-postop-investigations.sql`）并写入 FHIR R5 `ServiceRequest.orderDetail`（`preop-order-policy` 参数），保持与 `inpatient-material-estimate` 基准指纹、`consentConfirmation.document` 及病案首页 `sourcesHash` 严格正交零漂移。前端申请对话框按麻醉方式与术式编码自动推荐默认策略（PCI／局麻推荐 `continue-active`，全麻／普外推荐 `stop-on-completion`）并允许医生显式覆写。
- **手术完成事务内原子执行 `stop-on-completion` 与即时重开解耦**：`inpatient.surgery.preview-completion`（v4）返回 `preopOrderPolicy` 与待自动停用的在执长期医嘱清单 `autoStopPreopOrders` 并纳入核实指纹；`inpatient.surgery.execute`（v6）与 `inpatient.surgery.complete`（v6）在共享完成事务内，若策略为 `stop-on-completion`，原子将本住院全部 `duration = 'long'` 且处于 `signed | verified` 的药品／护理医嘱置为 `stop-requested`（保留全部临时医嘱，同步更新 FHIR `MedicationRequest`/`ServiceRequest` 状态扩展与 `clinmesh-stop-reason` 备注，由病区护士按既有 `verify-stop` 核停取消待执行任务）。同步收窄住院开嘱与事中质控的在用药校验集合为 `signed | verified`，使 `stop-requested` 医嘱不再阻断术后立即重开替代药嘱；`inpatientDischarge` 质控的 `action_trace` 停嘱溯源同步纳入 `inpatient.surgery.complete` 与 `inpatient.surgery.execute`。
- **住院医技关联已完成手术（`surgeryExecutionId`）**：新增 `STRICT` 关联表 `inpatient_postoperative_investigation`，扩展 `inpatient.investigation.issue`（v5）接收可选 `surgeryExecutionId`，写事务内校验其属于本次住院已完成的 `Procedure`，创建 FHIR `ServiceRequest` 时写入 `supportingInfo: [{ reference: { reference: 'Procedure/<id>' } }]`，并在住院检验、检查与影像读模型中投影该关联。
- **术后成套医嘱模板、病区术后护理与 `skipped` 去重分类**：在共享 `order-set-template-registry`（`catalog.order-set-templates.list` v3）新增 `pci-postop-standard`（13 项，含水化、心电监护与穿刺制动护理、术后 4–6 h 高敏肌钙蛋白与心电图、次日肾功与血常规复查等）与 `general-surgery-postop-standard`（6 项，含 0.9% 氯化钠补液——同步将 `K` 纳入 `sodium-chloride` 适应证前缀——及切口与生命体征护理、术后血常规、肾功与电解质复查）；在病区常规服务目录新增三项 `inpatientBillingTrigger = 'execution'` 的病房术后护理项目，严格保持与术中 `surgery-completion` 联动专科护理分离。`inpatient.order-set-drafts.read`（v3）支持可选 `surgeryExecutionId` 按已完成术式编码匹配默认术后组套，纯函数 `@clinmesh/core/order-set-screening` 区分硬禁忌剔除（`excluded`）与术前已在用（同品规／同通用名／同药物概念编码）／互斥在用／在途检查去重跳过（`skipped`，`already-active-order` / `mutually-exclusive-active-order` / `in-flight-investigation`），严格遵循 `unavailable > excluded > skipped > needs-review > ready` 优先级并输出 `counts.skipped`。DSH 住院 `surgery` 阶段同步发布只读 `inpatient.order-set-drafts.read`，不新增任何住院端 DSH 写 Tool。
- **前端统一术后医嘱重整编排器**：新增 `InpatientPostopComposer`（手术完成后在完成引导条与医嘱页直接唤起，零新增批量写 Command），同窗聚合预筛术后药品、病房护理与术后复查医技（展示 `specimenContainer` 采血管标记与 `术前已在用 · 默认跳过`／`已按禁忌剔除`／`待核实` 分区），并允许自由检索补充额外药品／护理／检查，逐项携带独立幂等键与自动绑定的 `surgeryExecutionId` 顺序提交；任一通道发生不确定网络／5xx 错误时立即暂停双通道后续项并保留原回执恢复。
- **与 `#558` 专病包演进的兼容边界**：`preopOrderPolicy`、`inpatient_postoperative_investigation` 与 `OrderSetTemplate.applicableProcedureCodes` 均作为医院底座平台合同保留在核心层，不与心血管或普外单一专病耦合；后续 `#558` 将各专科术后成套模板拆分迁移至可插拔专病包时，只需按 `applicableProcedureCodes` 注册新的模板条目与对应病区护理目录项，即可直接复用 `inpatient.order-set-drafts.read(surgeryExecutionId)` 的去重筛选引擎与 `InpatientPostopComposer` 编排器，无需改写手术通知单停续策略、FHIR 投影或前端重整工作流。

## Alternatives considered

- **新增“术后一键整批提交”服务端写 Command 打包下达多条医嘱与检查**：会把药品药事安全、双层临床质控 `Clinical Override`、采血管检验开立与各自幂等回执耦合到巨型事务，增加部分失败与跨通道不确定状态恢复复杂度；复用意图清晰且逐项幂等的 `inpatient.order.issue` 与 `inpatient.investigation.issue`，既保持单一真相状态机，又支持单项行内越权与精确回执恢复。
- **把术前已在用药物直接归类为 `excluded`（禁忌剔除）**：会混淆“患者已有该药／同药理类在执无需重复开立”与“过敏、心动过缓、低血压或重度肾损等临床硬禁忌”，误导医生认为患者存在用药禁忌；独立引入 `skipped` 处置态并保证 `excluded` 优先级严格高于 `skipped`，在安全与清晰度上均更准确。
- **在手术完成时直接把术前长期医嘱跳步置为 `stopped` 跳过护士核停**：违背 ClinMesh“医生申请停嘱 -> 病区护士核停取消待执行与已发未给任务”的既有责任边界与护理任务取消语义；采用原子置 `stop-requested` + 收窄开嘱冲突校验至 `signed | verified`，既避免阻断医生即时术后开嘱，又完整保留护士核停链路。

## Consequences

- 冠脉介入与普外两类典型围术期路径在通知单申请、完成预览、原子停嘱、术后成套重整、病房护理与护士合管送检全链路形成闭环，且与既往耗材预计、知情同意文档和病案归档来源哈希保持正交。
- 医生在手术完成界面即可一步拉起术后成套重整弹窗，无须在“医嘱”与“检查检验”两页反复切换，且术后医技申请与药嘱均携带可追溯的 `surgeryExecutionId` 与 FHIR `supportingInfo` 引用。
- `inpatient.surgery.request` 新增必填字段 `preopOrderPolicy`，`hisOperationCatalog`、`clinmesh-inpatient` / `clinmesh-doctor` Skills 与迁移列表测试同步升级，不保留旧数据兼容垫片。
