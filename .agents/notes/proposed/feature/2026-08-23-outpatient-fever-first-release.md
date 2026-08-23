# Agent Note: 多岗位发热门诊首期闭环

Status: proposed

## Problem

ClinMesh 已有的普通门诊发热 Web 原型用于比较信息架构，使用客户端内存状态且不验证真实认证、持久化、FHIR、Command、审计或多用户并发。若把该原型直接扩成正式产品，岗位交接顺序、Encounter 完成条件、费用生成、处方边界和 Scenario Run 终止条件会继续由页面状态隐式决定。

首期还需要一个足够窄但能证明基础设施成立的业务范围。按 HIS 模块分别建设患者、收费、LIS 和药房会产生水平切片，任何单个阶段都无法由真实岗位完成可观察工作，也无法证明它们共享同一个 Workspace/Epoch 和业务事实。

## Proposal

首个可验收发布实现一个 Web-only、多账户共享的普通门诊发热流程。人类 Actor 为挂号员、分诊护士、门诊医生、收费员和药师；LIS 是受控系统 Actor。只有管理员可以重置 Scenario。每个账户通过服务端认证与 Workspace Membership 解析受信岗位上下文，普通用户不能在请求中自行指定 Actor、Workspace 或 Epoch。

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

Scenario package 同时提供经过临床人员审核后才能标记为 `golden` 的小型发热病例，以及使用相同 schema 和不变量的 `density` 数据集。Scenario 拥有初始事实、Hidden Fact、Reveal Policy 和模拟器行为，不拥有评分规则；Action Trace、Audit Event 与 Provenance 分别记录运行过程、安全访问和事实来源。

首期不实现 Agent、AG-UI、Evaluation Spec 或评分基础设施。未来 AG-UI 只能作为人机交互 adapter：它从服务端受信 Actor context 获得窄权限，调用与 Web 共用的 Command，通过 CAS/expected version 保存草稿，并在签署临床文书前要求人类确认，不能拥有独立状态机或绕过审计。

本 Note 取代原型对正式流程顺序和技术实现的任何暗示；[普通门诊发热 Web 交互原型](./2026-08-21-outpatient-fever-web-prototype.md)仍只用于界面设计参考，不复用其内存状态或假 API。

## Alternatives considered

**先建设通用 HIS 基础模块，再组合流程。** 这会产生不能由岗位独立验收的水平工作，并推迟真实事务、授权与交接问题的暴露。基础设施先完成后，后续阶段仍按可观察的纵向岗位交付推进。

**复诊创建新的 Encounter。** 它能让两次医生操作分开，却会把同一门诊挂号下的检验等待与复诊拆成两次就诊，增加费用、队列和文书关联歧义。首期一个 Encounter 覆盖整个门诊过程。

**发药后才完成 Encounter。** 这种线性状态容易实现，但会让医生对 Encounter 的临床责任依赖收费与药房操作。首期由医生签署文书并完成 Encounter，发药只决定 Scenario Run 是否结束。

**把处方等同 MedicationRequest 列表。** 它省去聚合，却无法稳定承载处方号、审核、收费和调剂边界。Prescription 因此作为持久领域事实拥有这组请求。

**首期同时交付 Agent 与评分。** 它能更早展示最终愿景，但会在 Command、Actor context、持久化和 Web 人工闭环尚未稳定时固化额外协议。AG-UI 边界先记录，实现在基础设施与人类流程之后另立 spec。

## Acceptance criteria

- 五个人类岗位账户在同一 Workspace/Epoch 中依次推进同一名合成患者，刷新或服务端重启不丢失已提交事实。
- 每个阶段只向当前岗位队列暴露允许的任务；越权动作、伪造 Workspace/Epoch、旧 expected version 和重复幂等请求得到稳定结果并写入审计。
- 一个 Encounter 贯穿挂号、分诊、首诊、检验和复诊；医生在药品支付与发药前签署文书并将其设为 `completed`。
- 挂号原子创建 Registration、Encounter、Queue Task、Account 和挂号 Charge Item；失败不会留下部分事实。
- LIS 只处理已支付检验，重启后可以恢复待处理任务，重复或晚到结果不会产生第二份最终报告或污染新 Epoch。
- Prescription 与 MedicationRequest、药品 Charge Item、Payment Transaction、MedicationDispense 和库存移动具有可追踪引用；未支付处方不能发药。
- 已签署 FHIR 文书为 SQLite 中的结构化 JSON，不包含附件，不能通过普通 update 覆盖。
- 发药完成后 Scenario Run 转为 completed；Encounter 状态保持已完成，不由药房再次推进。
- `golden` 与 `density` 数据使用相同 schema；没有临床审核的病例不会标记为 `golden`。
- Web 真实入口覆盖五个岗位和管理员 reset；Desktop、Mobile、Agent、AG-UI 与评分能力不存在伪入口或虚假 capability 声明。

## Risks

一个发热病例可能让领域模型过度贴合单一路径。`density` 数据和异常分支应覆盖空队列、并发冲突、支付拒绝、LIS 重试和处方未支付，但不借机扩展到住院或完整医保。

医生先完成 Encounter、随后收费发药与部分医院实现不同。状态机、队列和查询必须明确区分临床完诊与 Scenario Run 完成，避免把它们压成同一个 status。

LIS 作为系统 Actor 仍会引入异步结果与恢复复杂度。首期限制为结构化检验结果和确定性模拟规则，不实现真实 LIS 协议或外部网络集成。
