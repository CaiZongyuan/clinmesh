# Agent Note: 冻结院后复诊来源并按临床白名单读取住院摘要

Status: implemented

## Problem

合成患者第一次物化关联原门诊或直接住院 Encounter；出院后普通挂号会创建新的 Encounter，但仅凭新病例 ID 无法找到 Patient Persona、外部可见历史与检查真值。把住院读模型直接并入门诊病例库又会扩大其责任医生规则和返回体，暴露门诊无须读取的住院内部状态。

## Decision

新挂号在当前 Workspace/Epoch 的同患者来源唯一时，使用带复合外键的独立 `outpatient_case_source` 关系冻结 Synthetic Case materialization，并建立新的 Consultation。初次物化仍保留原关联；再次就诊的来源不依赖后续查询时的动态猜测。历史、Persona 与共享申请来源投影读取同一冻结引用，旧 Epoch 的关系只属于旧 Epoch。

门诊 `local-completed` 历史以当前医生对当前病例的责任为入口，纳入同患者已出院住院记录的显式临床字段。住院摘要拥有判别字段 `record.kind = 'inpatient'`；原门诊 `record` 形状保留。门诊完诊病例库继续只拥有门诊记录。摘要作为诊疗推荐必读证据并保留标题、临床日期和状态，避免将历史停用药物误当作当前处方。当前行为详见[临床业务流程](../../../architecture/clinical-workflows.md#门诊闭环)。

## Alternatives considered

- 每次读取按 Patient 动态选择最近一次来源：后续物化会改变已经开始复诊的病史和真值，来源多义时也会产生不可追溯选择。
- 为复诊复制 Synthetic Case、Profile 或 Persona：复制会绕过病例普通流程只能开始一次的约束，并生成可漂移的私有事实副本。
- 直接返回完整住院读模型或改造门诊完诊库：将科室、护理、结算、病案等内部信息带入门诊，且改变现有门诊列表和权限合同。

## Consequences

只有唯一合法来源可以自动建立独立合成问诊；普通人工建档及多义来源保持原挂号流程。住院历史可跨原经治医生读取，但必须先具有当前门诊病例责任，且持续受 Patient、Workspace/Epoch 和实际出院状态限制。HTTP、页面与 Agent 历史读取共用同一读模型，推荐证据按 UTF-8 字节拆包；复查报告等集合可在完整成员之间拆分，避免一组报告超限导致整次住院安全事实丢失。不可分割的超大成员继续沿原有缺证据说明处理。
