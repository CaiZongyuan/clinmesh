# Issue #225 及关联任务的数据补齐范围核查

核验日期：2026-10-22。证据为 GitHub Issue 正文、评论、原生子任务及阻塞关系、关联 PR 的交付说明和合并状态，以及正式规格的固定版本；未读取运行数据库。本记录说明任务覆盖和已公布交付，不替代正式规格或证明当前实例已经装载数据。

## 结论

**有数据准备与补齐要求，但本轮未查到覆盖整个住院部的批量补数条款。** [#225](https://github.com/CaiZongyuan/clinmesh/issues/225) 已规划离线资料核对、编码适配、医保及 DRG 参数、独立分组对照、冠心病／PCI 整链病例和心衰回归；[住院闭环规格](https://github.com/CaiZongyuan/clinmesh/blob/56f7e79251a5b37ec87fd9150201a20443aeeb29/docs/spec/2026-10-20-inpatient-closed-loop.md) 则要求一名合成患者通过真实岗位从入院走到归档。

本轮未查到明确拥有以下批量补数工作的任务：导入用户提供的全部 231 条心血管耗材、全面补齐住院药品及服务项目收费价、预先放置待入科／诊疗中／手术中／待结算／待归档／已归档等多阶段常驻患者。不能据此推断这些任务完全不产生业务数据；它们会在流程执行中产生医嘱、费用、交易、病案和分组等事实。

## 核验范围与状态依据

覆盖 21 个 Issue：#225 及其 13 个原生子任务 #267–#279，关联住院父任务 #245 及其 6 个原生子任务 #246／#247／#248／#249／#250／#254。19 个叶子任务均无更深原生子任务。另核对交付 PR [#260](https://github.com/CaiZongyuan/clinmesh/pull/260)、[#280](https://github.com/CaiZongyuan/clinmesh/pull/280)、[#281](https://github.com/CaiZongyuan/clinmesh/pull/281)；[#244](https://github.com/CaiZongyuan/clinmesh/pull/244) 仅作住院规格来源，不作为补数实施证据。

#225 时间线指向上述 13 张子票与 PR #280／#281；#245 时间线指向其 6 张子票、PR #244／#260 及 #225。核验时 #225 的原生 `blocked_by` 仅剩已关闭的 #250，#245 无阻塞项；这些跟踪状态不证明业务数据已装载。

状态使用 GitHub 当前元数据，完成范围结合交付证据判断。#225／#245 正文仍将 #260 称为 draft，已经过时：#260 实际于 2026-10-21 17:06:38 UTC 合并，merge commit 为 `93e79e53822824f7efd22f8aa825ee81ff943b31`。#245 在[关闭说明](https://github.com/CaiZongyuan/clinmesh/issues/245#issuecomment-6335720602)中确认六片交付和自动化验收；人工体验仍由使用者复核。

## #225 全部任务的数据覆盖

以下更新时间均为 UTC。除 #267／#268 外，叶子票没有评论或对应交付 PR 证据，正文仍要求实施后补充验证；表中的“要求”不代表已经完成。

| Issue | 状态／更新时间 | 数据要求与边界 |
| --- | --- | --- |
| [#225 共享支付、医保与 DRG](https://github.com/CaiZongyuan/clinmesh/issues/225) | OPEN；10-21 08:09:51 | 四片沿同一次冠心病／PCI 合成住院联合验收；临床、费用、清床和病案由住院 owner 提供。 |
| [#267 离线参考资料清单](https://github.com/CaiZongyuan/clinmesh/issues/267) | CLOSED；10-22 07:26:24 | 最直接的资料准备票：来源、哈希、版本、计价单位及启用状态回读，隔离编码待核验项、缺参及使用条件未确认内容；已由 #280 交付清单能力。 |
| [#268 门诊共享账单](https://github.com/CaiZongyuan/clinmesh/issues/268) | CLOSED；10-22 07:35:22 | 消费既有药品／检验费用，产生分次及组合支付记录；已由 #281 交付，不负责住院目录补齐。 |
| [#269 部分退款与对账](https://github.com/CaiZongyuan/clinmesh/issues/269) | OPEN；10-21 08:14:46 | 关联原交易、可退余额及渠道模拟结果；产生退款事实，不补基础目录。 |
| [#270 预交金与清床门禁](https://github.com/CaiZongyuan/clinmesh/issues/270) | OPEN；10-21 08:14:47 | “承接已有住院预交金和首次结算实现，保留正式费用来源”；消费住院费用，非价目补数票。 |
| [#271 门诊合成医保](https://github.com/CaiZongyuan/clinmesh/issues/271) | OPEN；10-21 08:14:48 | 明确需要固定版本的职工／居民两套合成待遇，覆盖目录内外、先行自付、起付线、比例、封顶、年度累计和个人账户。 |
| [#272 住院医保与组合结算](https://github.com/CaiZongyuan/clinmesh/issues/272) | OPEN；10-21 08:14:48 | 同次住院承接两套合成待遇、预交金及自付收退；校验年度／账户余额，未承诺全面补药品和项目价目。 |
| [#273 DRG 预分组](https://github.com/CaiZongyuan/clinmesh/issues/273) | OPEN；10-22 07:44:31 | 明确需要“核验后的编码适配、固定规则及独立合成支付参数”和固定输入／独立可解释预期；消费 #247／#254 的正式临床及费用只读投影。 |
| [#274 PCI 处方推演](https://github.com/CaiZongyuan/clinmesh/issues/274) | OPEN；10-22 07:44:32 | 冠心病／PCI 与心衰病例；药品、手术服务、支架／球囊／导丝／导管逐项计量；要求解释缺价／缺成本，未明确承诺建立完整价格目录。 |
| [#275 归档冻结分组](https://github.com/CaiZongyuan/clinmesh/issues/275) | OPEN；10-22 07:44:33 | 消费不可变病案快照、费用基线、来源哈希与规则版本，保存可复现分组；不另建可编辑病例。 |
| [#276 医保办差异复核](https://github.com/CaiZongyuan/clinmesh/issues/276) | OPEN；10-22 07:44:34 | 确定性模拟核定需固定输入、规则、来源和版本；产生核定／复核数据，不补临床价目。 |
| [#277 财务更正与退款](https://github.com/CaiZongyuan/clinmesh/issues/277) | OPEN；10-21 08:14:51 | 追加关联原费用／交易的调整链，保留冻结账及归档基线；不补基础目录。 |
| [#278 医保撤销重结算](https://github.com/CaiZongyuan/clinmesh/issues/278) | OPEN；10-21 08:14:52 | 保留原待遇、补偿和新结算，正确累计年度／账户余额；不补基础目录。 |
| [#279 PCI 联合验收](https://github.com/CaiZongyuan/clinmesh/issues/279) | OPEN；10-21 08:14:53 | 明确要求同一次合成住院贯通临床、药耗费用、支付、医保、分组、归档及更正；另有门诊、心衰和历史回归，不等于预置多个阶段患者队列。 |

### 两张已关闭子票的交付证据

[#267 的 PR #280](https://github.com/CaiZongyuan/clinmesh/pull/280) 于 2026-10-22 07:26:22 UTC 合并，merge commit 为 `a7751f1e60b0e4079ad3216dfbddfd77c215807b`。其固定清单涵盖五目录 r3 与 OpenDRG 2026-10-20；真实本地包核验报告五目录 33 文件／341,353 行、OpenDRG 2,300 文件／154 表／766,146 行，并列出 7 个缺参病组。交付明确限定为 `offline-review`、`integrity-only`、`runtimeEnabled=false`，不生成编码映射、不执行包内程序、不改变临床目录，也未迁移用户现有运行库或启用分组／支付计算。因此“资料清单能力已交付”不能写成“住院临床目录已经补齐”。

[#268 的 PR #281](https://github.com/CaiZongyuan/clinmesh/pull/281) 于 2026-10-22 07:35:20 UTC 合并；#281 是实现 PR，不是替代 Issue。交付分次／组合门诊收款和未知结果恢复，明确不含住院、医保或退款；真实收费与 DSH 证据使用既有检验应收，不证明住院数据已装载。

## 关联住院任务的数据覆盖

六片均由 #260 集成交付；状态不是单独的完成依据，合并及自动化验收说明才支持对应流程能力已经交付。完整验收证据归 PR，不在研究中复制检查流水。

| Issue | 状态／更新时间（UTC） | 数据要求与边界 |
| --- | --- | --- |
| [#245 住院闭环](https://github.com/CaiZongyuan/clinmesh/issues/245) | CLOSED；10-22 07:55:22 | 目标为一名合成患者从登记到归档、真实岗位产生审计事实；环境种子含病区、房床和岗位，不承诺批量预填多阶段患者。 |
| [#246 建档与入科](https://github.com/CaiZongyuan/clinmesh/issues/246) | CLOSED；10-21 17:06:40 | 提供住院建档、登记、床位及入科业务事实；不等于预置待入科患者队列。 |
| [#247 医嘱及执行](https://github.com/CaiZongyuan/clinmesh/issues/247) | CLOSED；10-21 17:06:40 | 提供长期／临时医嘱、执行及费用来源合同；#273 消费其正式事实，不由 DRG 另造病历账。 |
| [#248 检查检验与转科](https://github.com/CaiZongyuan/clinmesh/issues/248) | CLOSED；10-21 17:06:41 | 提供在院检查检验、转科流程和结果事实；不构成各病种检查报告批量装载承诺。 |
| [#249 出院结算与清床](https://github.com/CaiZongyuan/clinmesh/issues/249) | CLOSED；10-21 17:06:42 | 提供费用来源、预交金、结算与床位释放；#270 承接共享资金，不另建费用账。 |
| [#250 病案审核与归档](https://github.com/CaiZongyuan/clinmesh/issues/250) | CLOSED；10-21 17:06:43 | 提供病案首页审核和不可变归档快照；#275 消费归档事实，不等于预置已归档患者库。 |
| [#254 手术最小闭环](https://github.com/CaiZongyuan/clinmesh/issues/254) | CLOSED；10-21 17:06:42 | 已交付申请、术前准备、实际执行及术后医嘱；现有种子为 8 个术式与 2 个合成耗材，没有完整 PCI 数据包或用户的 231 条耗材表。 |

## 正式规格对价格与资料的限制

详细需求只归 [#225 链接的 approved 规格](https://github.com/CaiZongyuan/clinmesh/blob/e322fef689b009cc0175931b4070b8713c8dedff/docs/spec/2026-10-15-drg-prescription-budget.md)，本记录只摘取影响数据覆盖判断的边界：

1. 主演示为冠心病／PCI，辅助为心衰；缺价格、单位、分组、支付参数或成本时应标记不完整，不能以零补齐。
2. 既有浙江医疗服务价目与药耗来源，不会因为引入通用 DRG 自动成为本院收费价、本院成本或患者医保待遇。
3. 资料包和权重参考不能补出患者待遇规则、本院项目价或成本；编码适配须经离线核验与人工审核，再不可变发布。

因此，可沿用 #267／#271／#273／#279 的已批准范围准备各自需要的数据，但不能把它们解释为全部住院价目、231 条外部耗材或多阶段患者种子的默认 owner。运行实例的实际数据缺口另见 [住院流程数据缺口核查](2026-10-22-inpatient-data-gaps.md)；其运行状态证据与本次 Issue 范围核验分开理解。

## 证据限制

本轮只读核验公开任务、固定规格及 PR 交付资料，没有执行分组或结算、重跑 PR 中的测试、读取运行数据库，亦未核实当前实例的部署版本。未查到明确批量补数条款，不等于没有任何住院业务数据，也不排除后续任务新增经确认的补数范围。
