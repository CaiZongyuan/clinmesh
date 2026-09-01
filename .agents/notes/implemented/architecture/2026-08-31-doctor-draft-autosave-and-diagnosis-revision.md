# Agent Note: 医生草稿自动保存与诊断确认修订

Status: implemented

## Problem

门诊医生在诊断、检验和处方页填写结构化内容时，手动“保存草稿”是系统持久化步骤，不是临床决策。把它作为主动作会迫使医生记忆内部状态机，并让正式确认或开具依赖一次额外点击。原有诊断确认还把本次 Encounter 内的确认结果永久锁定，医生发现新证据后无法增加、移除或调整诊断，只能保留错误结论。

全局 Reference 检验目录表达项目定义，不保证某个 Synthetic Case 能产生该项目的结果。Doctor Case 曾只声明整个病例接入了报告流程，Web 因而允许开具无法命中 Case Truth、缺少生成 metadata 或没有可用 Investigation Agent 的项目，最终形成不可恢复的 `generation-failed`。

本决策修订[医生临床目录选择与草稿确认](../feature/2026-08-31-doctor-clinical-catalog-dialogs.md)中的手动保存和确认后只读规则，并补充[门诊医生工作台 UI 重构](./2026-08-31-doctor-workspace-ui-refactor.md)的草稿与检验能力合同。任务来源是 [issue #65](https://github.com/CaiZongyuan/clinmesh/issues/65)。

## Decision

诊断、检验和处方编辑器在有效内容静止 800 ms 后自动保存。Web 显示等待、保存中和已保存状态，不显示普通“保存草稿”按钮。自动保存仍调用各 owner 的既有 Command，携带 Encounter expected version、草稿 expected version 和新幂等键；页面用提交内容指纹区分已保存响应和保存期间产生的新修改。确认、开具、删除草稿或切换病例会重置对应保存状态，不能让旧 success 阻止下一轮相同内容保存；当前输入尚未同步或保存请求仍在进行时，删除、确认、开立和无需用药等终结动作等待 owner 返回最新草稿。没有病例责任人的 `awaiting-doctor` 病例在接诊 Command 成功前保持临床只读，开始首诊动作位于业务页签上方，切换页签不会提前触发草稿保存；`awaiting-revisit` 保留既有受控修订能力。

诊断确认是不可覆盖的 revision，不是本次 Encounter 的编辑锁。已确认诊断仍可重新打开为草稿；再次确认创建新的 `diagnosis_confirmation` 和 Condition 集合，以递增 `revision_number` 和 `supersedes_confirmation_id` 连接上一确认。旧 Condition 保持可读并改为 `verificationStatus=entered-in-error`，Encounter 当前诊断引用只指向最新 Condition；每次确认创建独立 Provenance。完诊门禁只接受没有待处理诊断草稿的最新确认。

`InvestigationService` 通过 `generationCapabilityForCase` 统一判断一个病例与检验概念能否产生结果。完全匹配 Case Truth 的 Observation 使用 `synthea-exact`；数值项目具备 UCUM 单位，并从 Reference metadata 或受控 LOINC 本院检验映射取得合成参考范围，且运行时配置结构化模型时使用 `investigation-agent`；其余情况返回稳定的不可生成原因。Agent payload 只包含最近 20 条 Visible History 和按临床时间选择的最多 20 条 Condition、Observation 或 Procedure 证据，避免无界病例上下文破坏结构化响应。病例级检验目录携带 capability，Web 展示查询到的唯一项目并禁用 `supported=false` 的行，不复制 Case Truth、模型或 profile 判断；`WorkflowService` 在保存草稿、正式开立和重试生成时重新调用同一判断，绕过 picker 不能提交不可生成项目。

Reference 检验项目当前只有内部适应证 `clinical-evaluation`，Web 将单一适应证显示为只读“临床评估”；只有目录真实提供多个合法适应证时才显示选择控件。永久 `INVESTIGATION_UNSUPPORTED` 失败不再提供无效重试，医生可以取消该申请并重新选择；瞬时或输出校验失败仍可重试。

## Alternatives considered

**保留手动保存并加强提示。** 能减少代码变化，但没有消除医生承担持久化步骤的问题，正式动作仍会因漏点保存而不可用。

**确认诊断后直接覆盖原记录。** 操作简单，但会丢失先前临床判断、Condition 版本和责任 Provenance，无法解释何时由谁修正。

**取消确认后删除旧诊断。** 可以重新编辑，但把正式事实降级为可删除草稿，破坏审计和 FHIR 历史。

**在前端推断检验能否生成。** 可以少一个病例级读接口，但会复制 Case Truth、模型配置和 Reference metadata 规则，且无法随运行时能力变化保持一致。

**生成器不可用时自动给出正常结果。** 能避免失败状态，却会把没有病例证据的正常值写成临床事实，因此禁止。

## Consequences

医生只负责选择、填写、确认和开具；草稿持久化成为可观察的后台行为。无效或不完整内容不会自动提交；同一内容与 owner 草稿版本组合失败后不会循环重试，CAS 冲突刷新到新 owner 版本后可以再次尝试当前有效内容并显示原错误。

一个病例可以拥有多条诊断确认历史，但 Doctor Case、处方适应规则、病例库筛选和 Encounter 当前诊断只读取最高 revision。旧 Command receipt 缺少 revision 字段时按 revision 1 解析，升级前确认记录由 migration 赋值为 revision 1。

病例级检验目录保留全局 Reference 项目的可发现性，但只有 Case Truth 精确结果或受控生成 profile 与可用 Investigation Agent 支持的项目可以选择。既有永久失败申请可以取消，不再阻塞完诊，但失败事实和取消审计继续保留。
