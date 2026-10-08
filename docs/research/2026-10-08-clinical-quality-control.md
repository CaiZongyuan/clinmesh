# 医生 Agent 质控能力研究

## 范围与证据

核验日期：2026-10-08。代码基线：`4a3e1cf065f086f4b1aeca572272f25cb1a6d7c2`。本文为医生 Agent 规划提供输入，不定义当前产品行为，也不替代[医生 Agent 助手规格](../spec/2026-10-08-doctor-agent-assistant.md)。当前行为以[系统架构](../architecture.md)和下面引用的实现为准。

核验范围为当前门诊流程的完诊门禁、结构化病历签署、诊断确认和处方校验。证据来自仓库源码与现有测试；本轮未运行业务测试，不把测试文件存在描述为本轮测试通过。本地没有 `references/` 研究输入，本轮没有取得可直接引用的临床质控官方标准，因此下文的内容质控例子仅用于讨论产品范围，不是监管要求、临床阈值或已实现检查。

## 当前实现能够证明什么

| 能力 | 源码证据 | 实际边界 |
| --- | --- | --- |
| 完诊流程检查 | [`#encounterCompletionPolicy`](../../apps/server/src/application/workflow-service.ts:9728)；[对应 HTTP 测试](../../apps/server/tests/outpatient-workflow-http.test.ts:2560) | 汇总主诊断已确认、病历已签署、必要报告已阅、用药结论已记录、无未处理草稿、处置完整和随访完整七项；正式完诊在 Command 内重新检查，缺项返回 `ENCOUNTER_COMPLETION_BLOCKED` |
| 病历字段完整性 | [`clinicalDocumentContentSchema`](../../packages/contracts/src/his.ts:967)；[签署预览](../../apps/server/src/application/workflow-service.ts:6149) | 主诉、现病史、查体、评估、处置、随访为必填字符串；既往史和辅助检查为可选。检查字段类型、去除首尾空格后的长度与最大长度，不判断正文的医学正确性 |
| 签署内容和版本一致性 | [结构化病历签署](../../apps/server/src/application/workflow-service.ts:6189) | 绑定当前岗位、Encounter 版本、草稿版本、预览正文、token 和有效期，防止把已变化的内容按旧预览签署；这属于执行安全与版本控制 |
| 诊断结构检查 | [诊断确认](../../apps/server/src/application/workflow-service.ts:3523) | 要求恰有一个主诊断，并使用有效编码快照；不证明该诊断被当前症状、查体或检验支持 |
| 处方基本输入检查 | [`prescriptionDraftItemSchema`](../../packages/contracts/src/his.ts:576)；[药品去重](../../apps/server/src/application/workflow-service.ts:11245) | 校验字段类型、数值范围、非空剂量和频次及同一目录药品不重复；这些工程范围不能当作临床安全剂量或疗程 |
| 本地目录处方规则 | [目录用药规则](../../apps/server/src/application/workflow-service.ts:11248)；[正式开具](../../apps/server/src/application/workflow-service.ts:4054) | 对本地目录药品校验允许剂量、频次、药品组合、疗程、数量和已确认诊断的目录适应范围。规则覆盖取决于本地目录配置，不等于完整合理用药审查 |
| 本地目录药物过敏检查 | [有效药物过敏读取](../../apps/server/src/application/workflow-service.ts:11185)；[过敏编码匹配](../../apps/server/src/application/workflow-service.ts:11272)；[拒绝开具测试](../../apps/server/tests/outpatient-workflow-http.test.ts:8493) | 读取 `active`、`confirmed` 且 `category` 包含 `medication` 的 AllergyIntolerance，并匹配药品代码；不证明覆盖成分、药物类别、交叉过敏或全部历史过敏 |

完诊门禁中的“处置完整”和“随访完整”当前只检查最新签署文书对应字符串去除首尾空格后的长度至少为 2，见[实现](../../apps/server/src/application/workflow-service.ts:9784)。所以“已完善随访安排”说明该字段满足结构要求，不能推出它包含合适的复诊时间、警示症状或完整患者教育。

来自参考目录的药品与本地目录规则存在明确能力差异：[`#validatedPrescriptionDraftMedications`](../../apps/server/src/application/workflow-service.ts:11214) 只对 `!external` 药品执行本地目录规则；正式开具时[过敏检查调用](../../apps/server/src/application/workflow-service.ts:4059)也过滤外部目录药品，[适应诊断检查](../../apps/server/src/application/workflow-service.ts:4093)跳过它们。参考目录药品仍受输入格式、去重和已确认诊断存在等约束，但不能宣称当前所有可选药品均已进行过敏、适应证、剂量或相互作用审查。该限制在本轮记录，不涉及生产代码修改。

## 用于澄清的三类质控

以下分类是产品讨论建议，不是正式医学分类，也不表示已经实现。临床内容判断需要进一步确定依据、可获得的信息和医生处理方式。

| 讨论范围 | 可以怎样向医生解释 | 规划例子 | 所需依据 |
| --- | --- | --- | --- |
| 漏项与流程 | 帮医生查看哪些内容尚未记录或处理 | 主诉缺少时间描述、没有核实过敏史、报告尚未确认已阅 | 流程类复用现有门禁；内容是否必须记录需明确模板与适用规则。没有记录不能自动写成“无异常”或“无过敏” |
| 内容矛盾与来源核对 | 对照问诊、医生补充和病历，指出不一致并请医生核实 | 患者说发热三天，病历写一天；问诊中提到某药过敏，草稿写“无药物过敏” | 能追溯的原始文字、时间、医生确认状态和草稿版本；不同时间的事实变化不能简单当作矛盾 |
| 诊疗合理性与风险提示 | 根据明确依据提出需要复核的诊疗问题 | 当前检查缺少相应指征说明、用药需补充肾功能信息、两个药物可能包含相同成分 | 可信且适用的药品知识、诊疗指南和患者信息；不能仅因模型认为有风险就形成确定结论或正式阻断 |

第一类回答“记录和流程是否齐全”，第二类回答“已有信息是否相互一致”，第三类回答“诊疗选择是否需要进一步核实”。当前源码能够证明部分第一类检查及限定目录内的部分处方规则，未发现独立的临床正文矛盾质控、全面合理用药审查或医生 Agent 质控结果合同。

## 与已批准自动记录方案的关系

既有已批准的[问诊病史自动记录规格](https://github.com/CaiZongyuan/clinmesh/blob/4c947b325315d233b355dc19baaa843c54cc1406/docs/spec/2026-10-08-consultation-auto-record.md)和[设计记录](https://github.com/CaiZongyuan/clinmesh/blob/4c947b325315d233b355dc19baaa843c54cc1406/.agents/notes/proposed/architecture/2026-10-08-consultation-auto-record.md)已明确：ClinMesh 编排提取、来源校验、增量合并与共享 Command，DSH 提供辅助模型能力。其来源是已保存的 Consultation Record，范围限于患者自述的主诉、现病史和既往史，排除整个 DSH Session、Assistant reasoning 和隐藏病例事实。全病历扩展应继承局部人工保护、可识别新增提示、来源与撤销、历史首次补录以及签署冻结的合同；新增质控不能代替写入前的来源校验，也不应重复建立已有事实冲突的处理队列。规格批准和设计记录存在均不证明功能已经实施。

## 尚待产品决定

1. 每类质控适用哪些页面和具体临床内容；首期范围以正式规格为准。
2. 检查时机是实时、进入页面、医生主动检查还是签署前；结果过期后怎样重新计算。
3. 明确规则缺项、来源矛盾和模型风险建议分别如何展示，哪些仍由已有服务端门禁阻断。
4. 医生如何核实、采纳、忽略或说明原因，以及是否保留处理记录。
5. 临床内容检查依据由哪个可追溯知识来源提供；缺少必要患者信息时如何表达不确定性。

这些问题仍属于未确认设计。不能把上表例子直接提升为已批准首期要求，也不能将 Agent 质控通过作为正式诊断、处方或病历签署的自动授权。
