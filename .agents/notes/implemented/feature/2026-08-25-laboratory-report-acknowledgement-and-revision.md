# Agent Note: 检验报告确认与不可变修订

Status: implemented

## Problem

[报告已阅与签发后更正](https://github.com/CaiZongyuan/clinmesh/issues/27)要求负责医生明确确认已经查看检验报告，并允许受控报告 Actor 纠正已签发结果。DiagnosticReport 的签发状态、医生阅读责任和报告替代关系是三个不同事实；若把它们压缩进申请列、FHIR 技术版本或同一报告内容，重试与纠错会覆盖旧结果、丢失原确认语境，或让读取方无法确定当前有效报告。

总体医生链路与完诊门禁由[医生核心临床业务流提案](../../proposed/feature/2026-08-24-doctor-clinical-core-workflow.md)拥有；当前状态机和接口细节由[门诊闭环](../../../../docs/architecture.md#81-门诊闭环)拥有。本 Note 只记录报告确认与签发后修订已经采用的持久化和协议取舍。

## Decision

Report Acknowledgement 是独立于 DiagnosticReport 的不可变领域事实，按 Workspace、Epoch 和 DiagnosticReport logical ID 唯一。只有原检查申请的开具医生可以对当前 `final` 报告确认已阅；Command 同时校验申请状态、申请 expected version 和 DiagnosticReport expected version。成功确认把申请推进到 `acknowledged`，保存确认者、Practitioner Role、虚拟业务时间和确认后的申请版本，并产生 `ReportAcknowledgement/<id>` effect；DiagnosticReport 保持 `final` 且 FHIR `meta.versionId` 不变。相同命令幂等键由 Command receipt 重放，不同幂等键由报告唯一事实返回第一次确认的完整业务结果。

报告更正只作用于申请当前指向的 `reported` 或 `acknowledged` 报告。输入必须提供原因、结论，以及既有结果代码的完整且无重复数值集合，不能增加、删除或重复项目。每次更正为 DiagnosticReport 和全部 Observation 创建新的 logical ID；旧资源保持 `final`、可直接读取且保留原确认事实。新的 Provenance 同时以新报告和结果为 target，并以 `entity.role=revision` 引用被替代报告和全部旧结果；`laboratory_report_revision` 的新报告唯一约束和被替代报告唯一约束把每个申请限制为 latest-only 线性链。

更正通过申请 expected version 和当前报告关联做 CAS。成功后申请指向新报告、递增版本、回到 `reported` 并清除当前确认投影，因此负责医生必须重新确认新版本；并发更正只有一个提交成功。FHIR R5 DiagnosticReport 没有 Composition 式 `relatesTo`，替代引用由标准 Provenance 和领域修订链共同表达，不向 DiagnosticReport 添加自定义伪标准字段。

公开更正 HTTP adapter 从受信 session 的 `availableRoles` 判断登录账户是否具有 administrator 能力，而不把当前 Acting Practitioner Role 当作账户权限。因此管理员可在门诊医生 Acting Practitioner Context 中打开自己有权查看的病例，再由服务端把更正调用绑定为受信 `lis-system` context；请求 schema 不接受角色或任意 FHIR 内容。共享 Command 仍只授权 `lis-system`，普通医生和请求正文都不能把调用方声明为报告签发系统。

## Alternatives considered

**只在 `laboratory_request` 增加确认人和确认时间列。** 这能快速展示当前状态，却无法在报告更正后保留旧版本由谁确认、何时确认以及重复请求应返回的原业务结果。独立确认事实拥有版本级身份，申请列只保留当前状态投影。

**以同一 DiagnosticReport 和 Observation logical ID 的新 FHIR version 原地更正。** 这可以复用 `_history`，但会把服务器技术版本误作临床修订，并使旧报告不再拥有独立业务身份。当前实现为每次签发后更正创建新的 logical resources。

**在 DiagnosticReport 添加类似 `relatesTo=replaces` 的自定义字段。** Composition 有标准 `relatesTo`，FHIR R5 DiagnosticReport 没有。添加同名结构会形成无法互操作的伪标准合同，因此使用 Provenance `entity.role=revision` 表达标准来源关系，由领域表保证链的唯一性和顺序。

**让 administrator 直接作为报告签发者调用共享 Command。** 这会把平台管理权限与 LIS 业务角色混为一体，也会允许 application service 接受本不拥有报告状态机的角色。HTTP adapter 负责认证管理入口并绑定 `lis-system`；Command 的授权边界保持为报告系统 Actor。

## Consequences

迁移 `0015_laboratory-report-acknowledgement.sql` 和 `0016_laboratory-report-revision.sql` 分别保存版本级确认事实和 latest-only 修订链。报告确认、申请状态变化、FHIR 资源、Provenance、Command receipt、审计与 Action Trace 在同一事务中提交或回滚。

医生病例读模型把最新报告放在 `report`，按业务修订顺序把旧版本放在 `previousReports`；每个版本只展示属于自己的确认事实。Web 仅在当前申请为 `reported` 时提供确认动作，并把当前报告与被替代版本分区展示，不能从旧版本发起新的确认。

已完诊病例库只对标记为 `correctionSupported` 的独立检查申请显示报告更正导航，并同时要求受信 session 的 `availableRoles` 包含 `administrator`；兼容检验报告继续可读但不进入独立报告 Command。更正使用结构化结论、完整结果值和原因字段，并在 `AlertDialog` 中预览确认；成功后 Web 同时失效活动病例与病例库详情查询，病例库从服务端重新读取新报告、旧版本链和 `laboratory-report-revised` 时间线事件。

`previousReports` 在共享响应 schema 中对缺失输入使用空数组默认值，使升级前已经持久化的检查开具或取消 Command receipt 仍可按原幂等键重放；新响应始终显式返回该字段。

调用方不能从 `DiagnosticReport.status=final` 推断医生已经阅读，也不能从旧版本存在确认推断新版本已经阅读。后续 Encounter Completion Policy 必须读取当前申请的 `acknowledged` 状态和当前报告确认事实；报告更正会重新打开这项门禁。
