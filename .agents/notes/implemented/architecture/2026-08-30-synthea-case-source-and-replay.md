# Agent Note: Synthea 来源病例与跨 Epoch 重放

Status: implemented

## Problem

Synthea 的本地化 FHIR R4 Bundle、参与者待诊断的本次病例、本院实际产生的诊疗事实和中国临床参考目录具有不同生命周期与可见性。把它们编译为可安装 Dataset/Package 会让生成患者依赖三病种手写真值、术语映射和目录闭包，也会把外部病史误表示为本院 FHIR R5 活动。Reset 若重新调用 Synthea 或外部模型，又无法保证同一病例、患者表现和检查结果可重复。本决策由 [issue #52](https://github.com/CaiZongyuan/clinmesh/issues/52) 交付，并保留[可选 Synthea 生成 Provider](./2026-08-26-optional-synthea-provider.md)与[cn-health 数据和 Synthea 中国本地化](./2026-08-30-cn-health-synthea-localization.md)仍然有效的来源边界。

## Decision

系统为四类事实设置唯一 owner。`Synthetic Patient Profile` 保存合成身份、生成参数、本地化 provenance 和完整不可变 R4 Bundle；`Synthetic Case Instance` 与私有 Case Truth repository 保存确定性选出的 Index Encounter、隐藏资源清单、病例类型和 Visible Source History 清单；Operational SQLite 与 FHIR R5 repository 只保存 ClinMesh 本次就诊中由挂号、分诊、医生、LIS、收费和药房实际产生的本院事实；独立只读 Reference SQLite 保存一个系统级当前 Release，医生搜索全部疾病、药品和检验概念，业务事实只冻结被选择行当时的 coding/display snapshot。

Index Encounter 是来源时间线上最后一个具有 Condition、Observation、MedicationRequest、Procedure 或明确 reason 的临床 Encounter。其关联资源属于 Case Truth，不能通过普通 HIS、FHIR、来源历史详情或普通 Agent DTO 返回；此前资源形成按临床时间排序的 Visible Source History，详情接口在可见清单上逐项授权。Claim 与 ExplanationOfBenefit 不进入病例历史。来源 R4 资源不转换或复制为本院 R5 Encounter、Condition、医嘱、收费、库存或审计记录。

`ScenarioGenerationJob` 只接受 Synthea，默认运行全部模块并允许使用 Provider `/health` 返回的模块清单做高级过滤。Provider provenance 同时固定中国身份依赖与 experimental-preview clinical-display catalog；任何翻译 gap 拒绝整份患者 Bundle，不允许生成英中混合病历。任务成功时在一个 Command 中创建 Profile 与 Case IDs；没有合格 Index Encounter 时使用派生 seed 有界重试十次，失败不留下部分 Profile、Case 或 truth。Dataset、Package、安装、Hospital Reference Selection、三病种 Case builder、Synthea 诊断/药品映射和 Scenario Catalog closure 不再是生产合同。

Patient Brief 使用 Server 固定模型、prompt 和 strict Zod schema异步生成，成功结果形成不可变 Brief Revision；诊断泄漏或无效输出不会覆盖已有 revision。普通开始要求显式选择成功 Brief，并通过共享物化内核创建新的 Patient、Registration、Encounter、Queue Task 和 Case materialization；来源历史不会随开始动作写入本院 FHIR。普通 Case 只能开始一次。

检验模拟先按请求的精确 LOINC coding 查找 Case Truth Observation，缺失时才调用 Investigation Agent。首次成功结果连同请求 coding、模型和 prompt provenance 保存为 workspace-global Investigation Result Snapshot；失败进入可重试状态且不生成正常兜底。管理员 Reset 关闭旧 Epoch、创建新 Epoch，并通过同一病例物化内核重建上一 Epoch 已开始的 Synthetic Case。新物化继续引用相同 Case revision、Profile revision、Brief revision、Case Truth 和 Investigation snapshot，但 Patient、Registration、Encounter 与 Queue Task 使用新 ID；Reset 和新 Epoch 下再次申请同一检验都不调用外部模型，也不改变 workspace-global Case 生命周期。

Operational migration 是有意的开发期破坏性边界：存在旧 Dataset、Package、Profile、Case 或生成任务时要求先删除本地 operational database 后重建，不实现旧 Package 兼容读取。独立 Reference SQLite 不在该迁移范围内。

## Alternatives considered

**把完整 R4 Bundle 导入本院 FHIR R5。** 这会让来源版本、机构、医务人员、账单和历史活动看似由本院产生，还会为同一事实建立来源 R4 与本院 R5 两个 owner，因此只保留只读来源详情和明确的新就诊事实。

**保留 Dataset/Package 并自动把 Synthea 编码映射到中国目录。** 这种方式可以沿用安装和目录闭包，但翻译显示、来源编码和本院选码不是同一问题；模糊或手工映射会阻塞随机全模块患者并静默改变病例，因而生成与参考目录完全解耦。

**Reset 时重新调用 Synthea、Brief 模型或 Investigation Agent。** 这可以减少 snapshot 持久化，但相同 seed 之外的服务版本、模型输出和网络状态仍会漂移，也会让演示重放产生不同患者表现或检验结果，因此 Reset 只复用不可变 revision 和 snapshot。

**为管理员复制一套无门禁开始流程。** 这会让正常开始与重放的 Patient/Registration/Encounter/Task 结构逐渐分叉；当前实现只把一次性状态推进留在普通 Command，两条路径共享同一个物化内核。

## Consequences

患者生成只依赖可选 Synthea/localizer 服务，不依赖 Reference SQLite、映射文件或活动 Epoch；Provider 不可用只影响生成能力。患者库成为管理员唯一模拟数据入口，生成、历史详情、Brief 和直接接诊不再要求理解安装概念。

Case Truth 的私有边界和 Visible Source History 的 allowlist 必须随新资源类型继续做负向测试。任何新 Agent 工具只能读取已授权历史或本院事实，不能接受任意来源 reference、Bundle、SQL 或 truth 查询。

Reference Release 可以独立升级；既有诊断、处方和检验请求保留创建时的 coding/display snapshot。Synthea 来源编码只用于显示原病历，不声称已经映射为中国国家或本院编码。

重放产生新的本院业务和 FHIR 标识，因此跨 Epoch 比较必须按 Case/Profile/Brief/snapshot revision 关联，而不能要求 operational ID 相同。Reset Command 的审计属于关闭中的旧 Epoch；新 Epoch FHIR 事实不作为旧 Epoch AuditEvent 的本地 FHIR reference effects 返回。

普通测试使用注入式 Provider，不访问外部模型。可选 live smoke 只提交一份硬编码合成 Brief，终端不输出 prompt、模型正文、Authorization 或 API key；容器 smoke 使用固定 Synthea commit、本地化 provenance 和 all-module 请求。
