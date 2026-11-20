# Agent Note: 处方医嘱、完诊、介入计划与出院节点的双层事中临床质控

Status: implemented

## Problem

既有药事校验仅覆盖目录静态适应证前缀、过敏、互斥类别与剂量上限，门诊完诊与住院出院仅校验流程收口（如未完成检查或未停医嘱），缺少跨检验结果、功能检查、冠脉造影生理学指标与专病路径的事中临床质控。若将所有质控规则做成一刀切硬阻断，外院已检、高出血禁忌、知情拒绝或急症优先等真实临床个体化场景会导致人类医生与 Agent 死锁；若全部降级为纯提示，则严重肾功能不全禁用药、明确过敏、超极量或药理互斥等药事红线可能被误放行，且缺少可追溯的结构化越权依据。

需求与范围见 [双层事中临床质控（Issue #473）](https://github.com/CaiZongyuan/clinmesh/issues/473) 及父需求 [专科指南与确定性临床评分体系（Issue #464）](https://github.com/CaiZongyuan/clinmesh/issues/464)。

## Decision

1. **纯函数双层评估引擎与只读预检分离**：在 `@clinmesh/contracts/clinical-quality` 与 `@clinmesh/core/clinical-quality` 定义零模型调用的确定性双层质控契约与纯函数，复用 `ckd-epi-2021-egfr` 与声明式 `medication-safety` 规则；通过只读预检操作供页面与 Agent 事前读取，正式门禁统一挂载在四个临床责任关口的既有共享 Command 写事务内（挂载点与质控代码见[临床决策支持与质控](../../../architecture/clinical-decision-support.md)），不新增旁路状态机或独立越权审批单，且禁止跨命令静默豁免后续受控写动作的审计留痕。
2. **红线硬阻断与路径警示受控越权严格分层**：第一层药事与生理安全红线即使附带 `clinicalOverride` 也一律以 `409` 硬性拒绝（既有药事冲突码保持向后兼容并同步携带 `error.clinicalQuality` 阻断明细），零正式事实落库；第二层临床路径与指南偏离严格区分“已证实 `eGFR < 30`”硬阻断与“尚无近期血肌酐记录”条件警示，未附覆盖当前全部警示代码的合规 `clinicalOverride`（受控枚举 `reasonCode` 与医学说明 `note`）时返回 `409` 结构化警示，合规越权则在同一事务原子提交业务事实、写入 `0117_clinical-quality-override.sql` 建立的 `clinical_quality_override` 表，并在 Command 回执、`AuditEvent` 实体详情及 `Action Trace`（`ClinicalQualityOverride/<id>`）完整留痕，原幂等键重放直接返回已保存回执。
3. **紧凑原位交互与 DSH 提案无死锁透传**：四个 Web 关口统一以紧凑内联警示条渲染结构化 `409` 原因、受控原因枚举下拉、医学说明输入与重提按钮（红线仅显示不可越权原因），并在确定性 `409` 拒绝后释放冻结写意图以允许新幂等键附带 `clinicalOverride` 重提；门诊处方与完诊 DSH `.propose` 提案在现有 `AgentReviewProvider` 确认条内支持透传预填或遇到 `409 CLINICAL_QUALITY_ALERT` 时保留已通过的单次提案审批门禁并原位补充 `clinicalOverride`，保持全岗位各上下文 `agentToolsForContext <= 32`。

## Alternatives considered

- **把所有临床质控都做成不可越权的硬性拦截**：实现简单，但外院已做检查、出血禁忌无法双抗或患者知情拒绝等合法个体化场景无法推进完诊、介入或出院，造成人机流程死锁。
- **允许单一布尔强制标记或自由文本跳过全部拦截**：无法区分药事生理红线与指南路径偏离，既可能放行肾功能禁忌药等安全事故，也无法按受控原因分类审计越权决策。
- **建立独立的越权预审批工作流与新增表面 Agent 工具**：拆碎既有单事务业务意图、引入过期审批状态同步复杂度，且挤压受限的页面 Agent 工具配额预算。
- **同住院周期内跨命令静默豁免已确认警示**：虽然少传一次参数，但会让只读预检隐藏真实风险，并使后续耗材选型确认或离院病案提交回执缺失独立审计留痕；改为每个挂载 Command 独立校验并留痕。

## Consequences

门诊与住院关键写入口在保持零模型调用、既有错误码向后兼容与幂等回执合同的前提下具备统一的双层事中质控与结构化越权审计留痕；既有未触发警示的正常路径无需修改调用参数。新增质控规则须先归类至不可越权红线或可登记原因的路径警示，并同步维护纯函数单测与公开 HTTP 集成测试。完整业务合同见[临床决策支持与质控](../../../architecture/clinical-decision-support.md)。
