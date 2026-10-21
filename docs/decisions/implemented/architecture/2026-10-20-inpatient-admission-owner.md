# Agent Note: 住院建档与床位事实独立拥有

Status: implemented

## Problem

门诊 Registration、支付和病例表的外键以 outpatient_case 为归属，直接复用会把一次住院错误地绑入门诊状态机。床位互换、预交金与虚拟时间收费又要求跨事实原子提交，不能由页面拼接多个写请求实现。

## Decision

InpatientService 通过既有 CommandExecutor、FhirRepository 与同一 SQLite 事务拥有住院登记、预交金、床位占用和场景时钟床日费。住院行政、财务及病案状态独立保存；FHIR Encounter 生命周期保持 R5 标准值，location 反映占用的起止历史。活动床位及活动住院占床均有数据库唯一约束，互换同时校验两侧 Encounter 版本，任何投影或审计失败整体回滚。当前合同见[住院流程](../../../architecture/clinical-workflows.md#82-住院闭环后续)。

合成来源以可空外键引用同一 Epoch 的既有 materialization，保留来源身份且不复制隐藏事实；门诊转收通过住院证固定来源 Encounter，直接登记仅接受唯一或明确指定的来源。没有来源的手工患者保持空值，后续检查不制造依据。

场景控制手动推进医院虚拟时间，按上海午夜展开床日费，以住院与日期去重；推进、费用、审计和 clock_revision 同事务提交。单次最多366天，以限制事务内逐日展开的输入规模；仍可分段抵达任意未来住院日。医院岗位不拥有推进权限，见[时钟合同](../../../architecture/simulation.md#102-虚拟时钟)。

SQLite 岗位 CHECK 扩展使用前向迁移重建约束表，保留原主键和全部引用。仅该迁移临时关闭外键，事务中核验 foreign_key_check，退出时恢复；运行时升级在活动 Epoch 补齐新的环境和 FHIR 人员，不改写旧患者或旧审计。

## Alternatives considered

- 在 outpatient_case 增加住院类别：现有门诊状态、支付外键和生成来源语义会同时改变，独立住院与多次住院难以表达。
- 让 Encounter.location 直接充当占床权威：FHIR JSON 无法以唯一约束保护床位互斥，也无法在两次普通写入之间保证互换原子性。
- 依赖真实时间定时器收费：场景重放失去确定性，闲置服务也会改变业务事实。

## Consequences

住院具有独立事实及共享的事务、认证、幂等和审计内核。Web 与 CLI 调用同一窄 schema，临床岗位受 Organization/Location 作用域约束。长期医嘱及后续住院阶段在此 owner 上扩展，不把当前建档入科能力等同于完整住院闭环。公共 HTTP、旧库 file-backed SQLite 升级和真实 Web 岗位入口分别验证业务不变量、持久恢复和用户操作。
