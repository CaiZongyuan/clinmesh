# Agent Note: 已完诊病例责任归属与统一时间线

Status: implemented

## Problem

[已完诊病例与业务时间线](https://github.com/CaiZongyuan/clinmesh/issues/31)要求医生在病例离开当前队列后继续检索自己负责的已完成 Encounter，并从同一详情查看各临床 owner 的权威事实和修订链。医生 Queue Task 是当前工作交接资源，状态和 owner 会随流程变化；活动病例 DTO 还包含草稿、expected version 和编辑能力。若归档从 Task 或页面状态推断责任、复用活动 DTO，或让客户端拼接时间线，就会使授权随工作流状态漂移、向只读页面泄露草稿，并产生第二套临床状态和事件排序。

当前查询协议、排序、失败和 owner 范围由[门诊闭环](../../../../docs/architecture.md#81-门诊闭环)拥有。本 Note 记录责任归属持久化、归档读模型和服务端时间线的取舍。

## Decision

`outpatient_case_responsibility` 按 Workspace、Epoch 和病例保存唯一 Practitioner Role 与首次分配时间，并通过复合外键引用病例和岗位绑定。直接建立接诊上下文与从既有队列开始接诊调用同一分配逻辑；第一次分配后不普通改写，重复分配给同一岗位无副作用，另一岗位尝试分配返回授权错误。迁移从已有病例医生 Task 的 `owner` 回填责任，使升级前病例继续由原主接诊岗位读取。

归档列表把责任条件、Workspace/Epoch、Encounter 完成条件和患者、业务日期、诊断目录筛选合并在同一数据库查询中，不先读取全量病例再由应用过滤。排序固定为 Encounter `actualPeriod.end` 降序，再按病例 ID 升序；总数和分页数据使用相同过滤条件。详情在读取任何临床内容前同时验证责任与已完成 Encounter，未完诊、未分配和非责任岗位使用同一业务冲突响应。

归档拥有独立 strict DTO，只包含 Patient、已完成 Encounter 和各 owner 的正式事实。Consultation 只返回不可变记录，Clinical Document 返回完整签署修订链，检查返回正式申请、报告修订和版本级确认，诊断与用药返回确认或签发事实；任何草稿、表单状态、expected edit version 或写入 action 都不进入该 DTO。归档页面使用 TanStack Query 管理列表和详情，活动诊疗与归档用同级页签分隔。

业务时间线由服务端从同一批正式事实组装。事件以稳定 kind、发生时间、主资源引用和关联资源引用表达，按发生时间、主引用、kind 的顺序确定性排列；客户端按给定顺序渲染，不重新遍历 owner 数据决定哪些事件存在或哪个版本有效。归档本身没有写入口；后续病历或报告更正继续调用原 owner 的受控 Command，重新读取归档即可看到新版本和对应事件。

## Alternatives considered

**从医生 Queue Task 的当前 owner 推断归档权限。** 这不需要新表，但把长期病例责任绑定到会完成、替换或重新分配的工作资源。Task 适合当前交接，不是完成后授权关系的稳定 owner。

**把 Practitioner Role 直接加到 `outpatient_case`。** 这能少一次连接，但 SQLite 需要重建已有核心表才能补充所需复合外键，也会把病例生命周期和责任关系压进同一宽表。独立一对一关系保留约束并降低升级风险。

**复用活动病例详情并在 Web 隐藏编辑控件。** 隐藏控件仍会把草稿和 expected version 传给客户端，并让归档合同随活动工作台演化。独立 DTO 在服务端排除非正式事实。

**由 Web 从详情各区段生成时间线。** 这减少一个服务端字段，却会在不同客户端复制事件识别、版本关系和并列时间排序。服务端拥有正式 owner 读取能力，因此同时拥有唯一时间线组装规则。

## Consequences

迁移 `0019_outpatient-case-responsibility.sql` 新增一对一责任表、责任岗位查询索引和旧病例回填，数据库 schema version 为 `20`。没有可解析医生 Task owner 的旧病例不会被猜测分配，必须在形成正式责任后才能进入某位医生的归档。

归档授权不依赖 `outpatient_case.status`、当前 Queue Task 状态或客户端传入的医生标识。列表只接受窄筛选参数并稳定分页；详情不暴露属于其他岗位或未完成病例是否存在。

正式 owner 增加修订事实时，归档详情和时间线随下一次查询反映新事实，不需要复制或更新归档快照。时间线不是新的状态 owner，调用方仍从各区段读取当前诊断、文书、报告和用药事实，不能只凭事件序列判断当前临床有效性。
