# Agent Note: 首次冻结结算与后续财务更正分离

Status: implemented

## Problem

住院首次结算、清床及病案归档表达已完成的临床和财务事实。多收费或漏计在这些阶段之后发现时，改写原 ChargeItem、结算或归档快照会丢失原始含义；把未知退款重新映射为未结算，又会错误恢复床位或开放临床写入。已完成 Scenario Run 还需要保留当前 Epoch 内的窄财务办理能力。

## Decision

`InpatientFinancialAdjustments` 拥有追加费用补计、冲减及关联收退款的策略，在共享 Command 事务内核对当前账目指纹、收费岗位、住院归属和依据额度。普通 InpatientBilling、出院和归档锁继续守护原临床与首次账目；后续调整只影响当前财务差异，不写 Encounter、Account、原费用或原结算。

后续补收复用 `InpatientPayments` 的预览、尝试与追加结果，后续退款复用 [RefundLedger](2026-10-22-original-payment-refunds.md) 的原交易、原方式及跨依据余额。`adjustment_id` 显式区分首次和后续收款；首次资金投影和归档核验排除后续资金，同一成功原款仍只有一套可退余额。相反方向的未处理更正先抵消应收退差额，未知资金保留预占，必须查询原尝试取得确定结果。

后续 Command 使用 current context，额外限制人类收费会话只能在 active/completed Run 新写；closed Run、旧 Workspace/Epoch 及失效 Agent Grant 不取得例外。其他临床 Command 继续要求 active，病案人员只读原冻结账与当前差异。真实时间五分钟的预览绑定原岗位、金额、渠道规则与当前指纹；确认重验，回执丢失沿用原输入和幂等键恢复。

当前合同由[住院财务更正](../../../architecture/clinical-workflows.md#结算后的财务更正)拥有；CLI/Agent 操作由 `clinmesh-inpatient` Skill 与 Operation Catalog 同步发布。

## Alternatives considered

- 直接解除普通封账或归档锁：使临床、库存及诊断操作也可能重新开放，无法保留原冻结来源，未采用。
- 覆盖首次结算或维护可任意编辑的当前账：原费用和资金历史无法核对，且会形成第二套余额，未采用。
- 后续退款复用首次未结算状态：未知结果会倒退清床或归档事实，未采用。
- 全局允许 completed Run 写入：扩大临床和 Agent Grant 权限，未采用；只在财务 owner 的窄 Command 放行当前人类收费上下文。

## Consequences

页面同时展示首次冻结费用、首次净资金、当前费用及净资金、待补收退款和未知预占。费用更正与资金动作分别确认和审计；后续拒绝、未知、查询及重启不会改变既有清床和归档。

公共 HTTP 与临时 SQLite 覆盖更正幂等、原款限额、未知恢复和首次快照保真；独立归档验收从正式诊断、结算、清床、首页提交审核及归档进入，核对归档前后追加资金。真实 Web 入口验证丢回执恢复，Surface 合同覆盖 React 18/19 的审阅弹窗。患者医保撤销重结算继续由其后续业务 owner 承接，本决策不声明已实现该能力。
