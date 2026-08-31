# Agent Note: 就诊诊断独立草稿与确认生命周期

Status: implemented

## Problem

[保存并确认主次诊断](https://github.com/CaiZongyuan/clinmesh/issues/28)要求医生在同一个 Encounter 中恢复诊断草稿、选择主诊断和次诊断，并把确认结果发布为正式 FHIR Condition。首期复诊流把一个自由文本诊断、Prescription、两字段文书和 Encounter 完成绑定在同一组草稿版本与签署动作中；继续扩展该组合无法独立表达多条诊断、唯一主诊断、确认来源和草稿并发，也会把本次编辑与患者既往 Condition 混在一起。

总体医生核心边界由[医生核心临床业务流](./2026-08-24-doctor-clinical-core-workflow.md)拥有；当前接口和 FHIR 映射由[门诊闭环](../../../../docs/architecture.md#81-门诊闭环)拥有。[医生草稿自动保存与诊断确认修订](../architecture/2026-08-31-doctor-draft-autosave-and-diagnosis-revision.md)扩展了确认 revision 和 Web 自动保存，本 Note 继续拥有诊断聚合、FHIR 映射和 legacy 兼容取舍。

## Decision

诊断草稿是病例级 domain-native 聚合。`diagnosis_catalog` 按 Workspace 与 Epoch 保存版本化受控条目；`diagnosis_state` 保存一至八条目录引用、`primary` 或 `secondary` 角色和最长 500 字的可选备注，并以 Encounter expected version 和 `expectedDraftVersion` 做 CAS。目录项不能重复且必须仍为 active。保存只更新草稿，不创建 provisional Condition，也不改变 Encounter、Queue Task、费用或 Scenario Run。

正式确认要求草稿恰有一个主诊断。共享 Command 为每个条目创建一个 FHIR R5 Condition，使用标准 `encounter-diagnosis` category、受控 ICD-10 coding、Patient subject、当前 Encounter、记录医生和可选 note；随后按条目顺序把 Condition 引用与主次角色写入 R5 `Encounter.diagnosis`，并创建以全部 Condition 和更新后 Encounter 为 target 的 Provenance。`diagnosis_confirmation` 保存确认身份、来源、医生、虚拟业务时间、revision 和被替代确认，`diagnosis_entry` 保存有序 Condition 与目录关联及主次角色；确认把草稿状态推进为 `confirmed` 并清除正文。后续保存可重新进入草稿，再次确认创建新 revision 并把旧 Condition 标记为 `entered-in-error`，不覆盖旧确认。所有 FHIR 和领域写入、Command receipt、审计与 Action Trace 在同一事务提交或回滚。

病例读模型将 `diagnosis.draft` 或 `diagnosis.confirmation` 与 `priorFacts` 分开。确认投影从不可变分组关联和对应 Condition 重建，不从当前目录重算已确认 code、display 或 note。FHIR Search 支持 `Condition?encounter=`；Provenance `target` 支持 Condition 和 Encounter，CapabilityStatement 与 Repository 使用同一能力注册表。

Web 只在带 Consultation 的病例中渲染独立诊断编辑器，以 TanStack Query 投影恢复服务端草稿和最新确认；本地表单维持唯一主诊断、避免重复目录项，有效修改自动保存，保存中或有待保存修改时禁止确认。没有 Consultation 的既有病例继续使用首期复诊组合编辑器。独立草稿保存发现既有首期复诊组合草稿时返回业务冲突，防止同一病例由两条编辑路径同时拥有诊断。

## Alternatives considered

**扩展首期复诊组合草稿。** 这可以复用现有 Condition 和签署页面，却会继续把诊断版本绑定到 Prescription、文书和 Encounter Completion，无法让诊断单独保存、确认或被后续完诊门禁查询。

**把草稿直接保存为 provisional Condition。** 这减少一张草稿表，但会让未确认输入进入正式 FHIR 读取和患者既往事实，并把可覆盖编辑版本误作临床事实版本。草稿因此保持 domain-native，确认后才创建 Condition。

**只为主诊断创建 Condition，把次诊断留在备注或数组 JSON。** 这会使次诊断失去标准资源身份、独立编码、Encounter 引用和 Provenance target，也无法通过 FHIR Search 查询完整本次诊断。

**确认时只创建 Condition，不更新 Encounter。** Condition 的 `encounter` 能表达来源就诊，但标准 Encounter 消费者无法从 `Encounter.diagnosis` 读取本次诊断及主次用途。当前实现原子维护双向标准引用，并由同一 Provenance 覆盖确认结果。

## Consequences

迁移 `0017_diagnosis-draft.sql` 新增目录、草稿状态、确认分组和有序条目表，并为现有 Epoch 回填三个合成 ICD-10 条目；`0038_diagnosis-confirmation-revision.sql` 为既有确认回填 revision 1，并允许一个病例保存线性确认历史。目录和关系约束阻止重复编码、非法状态、重复条目及同一确认中的多个主诊断；“至少一个主诊断”仍由共享 Command 返回稳定 `DIAGNOSIS_PRIMARY_REQUIRED`。

确认后的 Condition、Encounter.diagnosis 和 Provenance 可通过 FHIR R5 read、history 与白名单 Search 读取；既往 Condition 不被并入独立草稿。确认 revision 不可覆盖，但本次 Encounter 完成前可以基于最新确认重新保存草稿并再次确认；旧 Condition 保持历史可读，当前 Encounter 只引用最新 revision。

HTTP seam 覆盖受控目录、无 FHIR 草稿、草稿 CAS、唯一主诊断、并发确认、Condition 与 Encounter 映射、Provenance target、既往事实隔离和刷新恢复。Web seam 覆盖真实应用入口中的主次编辑、备注、保存、确认、只读结果、既往事实与本地化服务端校验错误；legacy 复诊测试继续覆盖兼容入口。
