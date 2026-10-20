# Agent Note: 住院医嘱计划与实际发药给药分开拥有

Status: implemented

## Problem

门诊处方依赖 outpatient_case、支付与结案状态，不能表达长期每次药量、护士校对和跨日执行。将给药计划直接作为 completed Administration 会制造患者已经用药的假事实；另建库存余额则让门诊与住院无法正确争用同一批药品。

## Decision

InpatientService 继续是公开业务入口，InpatientOrders 在既有 CommandExecutor 事务中拥有住院诊断、医嘱、校对和执行计划。药品与服务分别创建真实请求；Task 只表达计划，MedicationDispense 表达实际交付，MedicationAdministration 引用请求与实际交付表达一次给药。本院首日、QD/BID班次、PRN和停嘱规则由[临床流程](../../../architecture/clinical-workflows.md#83-医嘱生命周期)拥有，场景推进直接在同一事务调用实际任务 owner，不嵌套 Command。

发药以共享 inventory_lot 的数量和版本 CAS 扣减，同时同步 InventoryItem、移动、发药、费用和审计。库存移动通过门诊处方 XOR 住院实际发药单外键表达唯一来源，迁移保留旧行和约束。已发未给在护士核停后明确取消计划任务；发药、费用和消耗不因取消而消失，避免后续转科被无法完成的冻结任务阻塞。

InpatientBilling 由实际床日与发药/服务执行消费者共用。收费员冲正新增关联的反向条目，原费用保留；公开接口只接受原账项与版本及理由，不接受任意记账金额。当前费用净额及后续结算共享这一本账。

正式住院诊断优先解析 ReferenceDataService 的真实条目，冻结编码、来源定位与当时 Release；院内 fallback 显式标识。药品适应症是合成本院已声明的有界映射，按完整真实 coding 与固定 Dataset Release/来源定位匹配，不从诊断文字或码前缀猜测；来源及限制见[研究](../../../research/2026-10-20-inpatient-record-coding-and-recall.md)。

## Alternatives considered

- 复用门诊处方和 paid 队列：每次执行数量与整张门诊处方总量语义不同，还会错误完成门诊病例与 Scenario。
- 为住院建立独立库存余额：门诊看不到住院消耗，同一批次的并发扣减失去共同版本边界。
- 时钟推进直接创建 completed 给药：混淆计划与实际执行，无法验证护士校对、药师交付和漏给药。
- 停嘱自动退库存及冲正：未发生实际退回却恢复药品余额，破坏历史库存与财务事实。

## Consequences

计划、请求、交付、给药和收费有独立身份，通过明确引用衔接。所有运行事实绑定 Workspace/Epoch，临床责任和岗位从当前受信身份校验。真实 HTTP、file-backed SQLite 的失败回滚与幂等，以及真实 Web 岗位旅程分别验证业务、持久一致性与用户入口；班次策略不等同全国统一临床给药规范。
