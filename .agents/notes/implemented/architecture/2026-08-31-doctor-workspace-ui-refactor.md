# Agent Note: 门诊医生工作台 UI 重构

Status: implemented

## Problem

门诊医生工作台同时承载候诊队列、Virtual Patient 直达接诊、Consultation Record、结构化 Clinical Document、独立诊断、处方或无需用药、检验申请与报告确认、Encounter Completion、已完诊病例和受控纠错。生产 Web 需要在高密度桌面工作面中稳定呈现这些 owner，而不能把 Query、Command、版本、局部草稿和视觉组合继续集中在单个浅页面中。

`/ui-dev` 医生工作台验证了“全局导航、统一候诊栏、患者横幅、中央业务页签、固定右栏”的信息架构，但只包含 mock 数据和本地交互。[普通门诊发热 Web 交互原型](../../proposed/feature/2026-08-21-outpatient-fever-web-prototype.md)禁止把原型状态机和无来源字段迁入生产页面。

生产 UI 必须保持[医生核心临床业务流](../feature/2026-08-24-doctor-clinical-core-workflow.md)、[结构化临床文书独立生命周期](../feature/2026-08-25-structured-clinical-document-lifecycle.md)、[独立诊断生命周期](../feature/2026-08-25-independent-encounter-diagnosis-lifecycle.md)、[独立处方与用药结论生命周期](../feature/2026-08-25-independent-prescription-and-medication-conclusion-lifecycle.md)、[检验报告确认与不可变修订](../feature/2026-08-25-laboratory-report-acknowledgement-and-revision.md)和 [Encounter 完诊门禁](../feature/2026-08-25-encounter-completion-policy.md)拥有的业务事实。

## Decision

本决策由 [issue #65](https://github.com/CaiZongyuan/clinmesh/issues/65) 实施。医生工作台保持在 `apps/web`，复用 `@clinmesh/ui` primitive，不提前提升到 `packages/views`。`/ui-dev` 继续作为隔离视觉参考，生产入口不读取其 mock 数据。

宽屏工作台使用全局岗位导航、统一候诊栏、当前病例主区和病例上下文右栏。候诊栏以 tab 区分真实候诊病例与 Virtual Patient 候选；有候诊病例时默认候诊队列，队列为空时默认候选患者。患者横幅固定在业务页签上方，只展示 Doctor Case 已有的身份、主诉、分诊、过敏、生命体征、Encounter 与只读状态。

生产模块结构是：

```text
DoctorWorkspace
  -> DoctorCaseController
       -> DoctorQueueModule
       -> PatientBanner
       -> ConsultationPage
       -> ClinicalDocumentPage
       -> LaboratoryPage
       -> DiagnosisPage
       -> PrescriptionPage
       -> DoctorCaseContextRail
       -> EncounterCompletionPanel
  -> DoctorCompletedCaseLibrary
```

`DoctorCaseController` 是 Doctor Case 与诊疗流程 Query、Command、expected version、幂等键、错误映射和精确失效的 seam。页面模块只接收当前 owner 的状态与动作切片，不拼 query key、版本或跨 owner 失效列表。全局 Reference Catalog 仍是独立系统 owner；controller 只拥有目录搜索 Query 与带 Workspace、Epoch 的缓存键，不把目录结果复制进 Doctor Case 状态。`DoctorQueueModule` 只组合 controller 提供的分页快照和选择/接诊动作，不拥有病例 DTO 副本。病例为 `awaiting-doctor` 时，controller 在接诊成功前把全部临床页设为只读，并把开始首诊动作放在页签外的稳定位置；`awaiting-revisit` 仍按各 owner 的现有纠错合同开放受控修订。

页面责任如下：

| 页面 | 当前生产责任 |
| --- | --- |
| 问诊记录 | 展示 `consultation.questions` 与按序追加的 `consultation.records`，只调用受控提问动作 |
| 病历记录 | 编辑 Clinical Document 草稿，预览和签署正式版本，按授权创建 Revision |
| 检验 | 在同一工作面分离病例级可生成项目、自动保存草稿、开立、取消、生成重试、报告、已阅和修订 |
| 诊断 | 选择主次目录项、自动保存草稿并创建不可覆盖但可继续修订的确认版本 |
| 处方 | 选择药品产品、编辑剂量/频次/疗程/数量、自动保存草稿、正式开具、无需用药和受控撤回 |
| 已完诊病例 | 展示只读正式事实、统一时间线和服务端声明允许的纠错导航 |

药品 picker 按通用名、规格、剂型、生产企业和批准文号组成临床产品组。组内包装变体保留独立产品 ID、停用状态和“已加入”状态，医生必须明确选择具体包装；页面不自动加入第一项。产品选择后，处方编辑器使用与 `/ui-dev` 相同的紧凑行结构，但不显示 Contract 未拥有的给药途径、费用、库存或药房状态。

检验页统一使用“检验”术语。内容容器达到 672px 时显示申请/结果双栏，窄容器纵向排列；正式申请、报告和纠错继续由 `LaboratoryRequest` owner 驱动。Doctor Case 尚未拥有 Hospital Service 检查读模型、报告和纠错规则，因此生产导航不显示独立“检查”页。

右栏消费当前 Doctor Case 快照和 Encounter Completion 预览，展示过敏、主诉、生命体征、病例状态、完诊门禁和页签相关的问诊、病历、检验、诊断或处方概况。它不提交临床 Command，也不显示 AI 建议、置信度或生成动作。右栏在 1536px 及以上与主区并排，在中等桌面宽度下移并保留折叠入口。

以下业务合同保持不变：

| 范围 | 不变量 |
| --- | --- |
| 身份与责任 | 所有写入使用服务端解析的 Actor、Practitioner Role、Workspace 和 Epoch |
| 服务端状态 | TanStack Query 是唯一缓存；Zustand 不镜像病例 DTO；病例与目录查询按 Workspace 和 Epoch 隔离 |
| 并发 | 每个写 Command 保留 expected version、草稿版本、幂等键和冲突刷新 |
| Encounter | 同一病例使用同一个 Encounter；页签切换不推进状态 |
| Consultation Record | 问答按序追加且不可覆盖，不自动成为正式病历 |
| Clinical Document | 草稿可恢复；签署件不可覆盖；更正创建 Revision |
| 诊断 | 草稿与确认分离；确认版本不可覆盖，本次 Encounter 内的修改创建新 revision |
| 用药结论 | 正式处方与无需用药互斥；撤回保留原事实和下游状态 |
| 检验报告 | 报告签发、医生已阅和报告修订是独立事实；修订后重新确认当前报告 |
| 完诊 | Completion Policy 只读取各 owner 的正式事实 |

## Alternatives considered

**直接把 `/ui-dev` 组件接入真实 DTO。** 视觉交付更快，但会把 mock 状态、无来源字段、自由输入问诊和静态 AI 文案伪装成生产能力。

**只在原 `doctor-workspace.tsx` 中替换 class 和布局。** 改动较小，但 Query、Command、业务页和视觉组合继续耦合，无法形成 controller 与 owner page 边界。

**让每个页面直接拥有 Query 和 mutation。** 页面表面独立，却会重复 active case、expected version、幂等键、错误映射和跨 owner 失效策略。

**立即移动到 `packages/views`。** 当前没有第二个真实平台消费者，会产生假共享 seam 和不必要的平台 adapter。

**把右栏实现为 AI 助手。** 当前没有受信助手 Contract、来源引用、生成版本和审计闭环；静态建议会制造不存在的能力。

**同时上线独立检查和检验页面。** Doctor Case 只完整投影检验请求；在 Hospital Service 读模型与纠错策略完成前开放检查页会形成可写占位能力。

## Consequences

生产工作台现在按 owner 拆分，Consultation Record 与 Clinical Document 在页面、持久化和动作上独立。切换病例时 controller 继续按 case ID 绑定局部反馈，旧病例的 pending、success 或 error 不进入当前上下文。

药品分组发生在服务端返回的有界分页内，分页总数仍表示真实产品行而不是临床产品组；同一临床产品若跨越页边界，可能在不同页各出现一次，但每页内不再平铺重复公共信息，也不会丢失包装产品 ID。

1280×800 下右栏位于主区下方，候诊栏和主要动作保持可达；1680×941 下右栏固定并排，检验使用申请/结果双栏。两种宽度都不要求主流程水平缩放。

生产仍不声明独立 Hospital Service 检查或临床 AI 能力。新增这些能力需要独立受信 interface、Doctor Case 投影、责任规则和纠错合同。
