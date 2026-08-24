# Agent Note: 多岗位发热门诊首期闭环

Status: implemented

## Problem

ClinMesh 已有的普通门诊发热 Web 原型用于比较信息架构，使用客户端内存状态且不验证真实认证、持久化、FHIR、Command、审计或多用户并发。若把该原型直接扩成正式产品，岗位交接顺序、Encounter 完成条件、费用生成、处方边界和 Scenario Run 终止条件会继续由页面状态隐式决定。

首期还需要一个足够窄但能证明基础设施成立的业务范围。按 HIS 模块分别建设患者、收费、LIS 和药房会产生水平切片，任何单个阶段都无法由真实岗位完成可观察工作，也无法证明它们共享同一个 Workspace/Epoch 和业务事实。

## Decision

首期发布是一个 Web-only、多账户共享的普通门诊发热流程。人类 Actor 为挂号员、分诊护士、门诊医生、收费员和药师；LIS 是受控系统 Actor。只有管理员可以安装或重置 Scenario。每个账户通过服务端认证与 Workspace Membership 解析受信岗位上下文，普通用户不能在请求中自行指定 Actor、Workspace 或 Epoch。

一次门诊使用一个 Encounter 贯穿挂号、分诊、首诊、检验、复诊和完诊，不为复诊创建第二个 Encounter。正式流程为：

```text
挂号
  -> 分诊与候诊
  -> 医生首诊并开具检验申请
  -> 检验计费与支付
  -> LIS 接单、检验并签发结构化结果
  -> 医生复诊、诊断、处方和临床文书签署
  -> Encounter completed
  -> 药品计费与支付
  -> 药师调剂并发药
  -> Scenario Run completed
```

Registration 是独立持久业务事实。挂号 Command 同一事务创建或关联 Patient、Registration、Encounter、候诊 Queue Task、Account 和挂号 Charge Item；它不能把“页面进入下一步”当作挂号成功。分诊记录主诉、生命体征和分诊级别，并把同一 Encounter 加入医生候诊队列。

首诊签发检验 Clinical Request，并按目录规则产生 Charge Item。只有检验支付成功，LIS 才能接收任务并通过持久 outbox 推进 Specimen、Observation 和 DiagnosticReport。医生复诊读取已签发结果，记录诊断，创建 Prescription 及其 MedicationRequest，签署结构化 FHIR 临床文书，并完成 Encounter。签署件不可原地覆盖；后续更正必须形成 Clinical Document Revision。

Prescription 是处方号和业务规则下的持久聚合，不等同单个 MedicationRequest 或 RequestOrchestration。药品 Charge Item 在处方签发时生成，Encounter 完成后仍可由收费员支付并由药师调剂。药房只处理已签处方且药品支付成功的项目；发药创建 MedicationDispense 和最小库存移动。发药完成 Scenario Run，但不回写已完成 Encounter 作为终止开关。

当前提供使用同一 schema 和不变量的 `candidate` 与 `density` 场景。两者 `clinicalReview` 都是 `null`，因此都不能标记为 `golden`；数据库约束要求未来 `golden` 定义必须具有临床审核元数据。Scenario 拥有初始事实、Hidden Fact、Reveal Policy 和模拟器行为，不拥有评分规则；Action Trace、Audit Event 与 Provenance 分别记录命令过程、安全写入和事实来源。

首期不实现 Agent、AG-UI、Evaluation Spec 或评分基础设施。未来 AG-UI 只能作为人机交互 adapter：它从服务端受信 Actor context 获得窄权限，调用与 Web 共用的 Command，通过 CAS/expected version 保存草稿，并在签署临床文书前要求人类确认，不能拥有独立状态机或绕过审计。

本 Note 取代原型对正式流程顺序和技术实现的任何暗示；[普通门诊发热 Web 交互原型](../../proposed/feature/2026-08-21-outpatient-fever-web-prototype.md)仍只用于界面设计参考，不复用其内存状态或假 API。

## Alternatives considered

**先建设通用 HIS 基础模块，再组合流程。** 这会产生不能由岗位独立验收的水平工作，并推迟真实事务、授权与交接问题的暴露。基础设施先完成后，后续阶段仍按可观察的纵向岗位交付推进。

**复诊创建新的 Encounter。** 它能让两次医生操作分开，却会把同一门诊挂号下的检验等待与复诊拆成两次就诊，增加费用、队列和文书关联歧义。首期一个 Encounter 覆盖整个门诊过程。

**发药后才完成 Encounter。** 这种线性状态容易实现，但会让医生对 Encounter 的临床责任依赖收费与药房操作。首期由医生签署文书并完成 Encounter，发药只决定 Scenario Run 是否结束。

**把处方等同 MedicationRequest 列表。** 它省去聚合，却无法稳定承载处方号、审核、收费和调剂边界。Prescription 因此作为持久领域事实拥有这组请求。

**首期同时交付 Agent 与评分。** 它能更早展示最终愿景，但会在 Command、Actor context、持久化和 Web 人工闭环尚未稳定时固化额外协议。AG-UI 边界先记录，实现在基础设施与人类流程之后另立 spec。

## Consequences

五个人类岗位在同一 Workspace/Epoch 中依次推进同一名合成患者，所有交接由服务端队列、Command 和持久事实决定。挂号原子建立 Registration、Encounter、Task、Account 和 Charge Item；LIS 只处理成功支付的检验；Prescription 稳定关联 MedicationRequest、药品费用、Payment Transaction、MedicationDispense 和库存移动。

医生签署结构化 Composition/document Bundle 和 Provenance 时完成 Encounter。药品尚未支付或发药并不阻止临床完诊；药房只在已签、已支付且库存条件成立时发药，全部处方行完成后独立把 Scenario Run 设为 `completed`。维护者必须保留这两个完成状态，不能把它们压成一个页面步骤或 status。

已签文书不接受普通覆盖，修订创建新的业务资源和 Clinical Document Revision。当前不保存图片、PDF 或其他附件，也不接入真实 LIS、支付或医保网络。

单个发热路径可能使领域模型过度贴合一个病例。`density` 与故障矩阵使用同一 schema 覆盖分页、空态、冲突、支付拒绝/ambiguous、LIS 重试、未支付门禁、部分发药和 Epoch 隔离，但不借机宣称住院、完整医保或完整库存能力。没有临床审核元数据的场景始终保持 `candidate` 或 `density`，不能作为临床认可的 `golden` 证据。

Web 是唯一产品入口。Desktop、Mobile、Agent、AG-UI、评分和 AI 助手没有导航、协议或 capability 声明；未来 adapter 必须复用同一 Actor context 与 Command，而不能拥有第二套状态机。
