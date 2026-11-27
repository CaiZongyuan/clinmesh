# 临床决策支持

医生在就诊的「决策支持」页签查阅六项评分、当前年龄适用的指南逐字条款及页码，或将已预筛的组套成员灌入草稿。`cds.scores`、`cds.guidelines`、`cds.order-sets` 是 Operation Catalog 中限责任岗位的只读查询。床旁评估通过 `cds.risk-assessment` 签署，新修订使用就诊版本及评估版本控制。缺失指标列于 `missingInputs`，初次 ECG 已明确的 ST 偏移优先于床旁值。

质控模块在原临床命令事务中复核正式事实。`CLINICAL_QUALITY_RED_LINE` 会回滚该次命令。`CLINICAL_QUALITY_ALERT` 返回 `details.ruleCodes`。医生可在工作台选择受控理由并填写医学说明，使用新幂等键重提交 `clinicalOverride` 的 `ruleCodes`、`reasonCode`、`note`。每条成功放行的警示关联医嘱命令、操作人、岗位和审计事件。近期肌酐窗口使用虚拟时间的 30 天。

组套版本随当前医院数据包固定。成员的判定优先级依次为目录不可用、禁忌排除、在执或在途跳过、需核实、可灌入。医生在相应开单页完成签发确认。
