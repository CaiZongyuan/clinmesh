# DRG 分组与资料能力核查证据

核查日期：2026-10-25。当前工作区代码核查基线：`4d0ac1db84da746998a530ada1d70ce6e1cd0a69`，其提交文件树与本次读取的 `main@f8b618e9c5a0448cb96b9ccf33d1aecc5691e65b` 一致。本记录先核对该基线的 DRG 分组内核、规则装载、编码口径、离线资料和相关测试源码，末节另列未合入 #305 与 #279 的内核交接，不评价其前端或资金账务实现。需求归属[共享支付与 DRG 规格](../spec/2026-10-15-drg-prescription-budget.md)，储存与安装合同分别归[DRG 离线资料储存合同](../drg-reference-storage.md)及[部署指南](../deployment.md)。后续提交应重新核对，不将本记录作为当前产品合同。

## 证据范围

本子任务读取仓库源码、固定锁、规格及既有研究；未读取 `references/`、患者数据或影像像素，未下载完整资料，未执行第三方分组程序，也未重新运行下列代码测试。资料条数和既往下载核验引用既有 owner 的记录，不能算作本子任务独立复测。主 Agent 的复测结果由整体核查另行报告。没有从源码得到完整规则覆盖率或正式地区分组准确率的可靠分母，因此不提供这两个百分比。

## 已有能力及其限制

| 能力 | 基线证据 | 能说明什么 |
| --- | --- | --- |
| 可解释的基础分组 | [分组内核](../../apps/server/src/application/drg-grouping.ts)第 80–155 行 | 已实现主诊断或主操作进入核心病组、次诊断 CC/MCC 与排除关系、最终病组和分步解释；返回成功、无法入组、歧义及输入无效四类结果。 |
| 部分组合与年龄条件 | [分组内核](../../apps/server/src/application/drg-grouping.ts)第 41–74 行；[规则构建器](../../apps/server/src/infrastructure/reference-data/drg-rules-builder.ts)第 31–38 行 | 支持“主诊断＋指定星号副诊断”组合及名称中明确识别的 ≥70 岁变体，不能外推为全部条件已实现。 |
| 固定版本规则包 | [规则包实现](../../apps/server/src/infrastructure/reference-data/drg-rules-package.ts)第 46–120 行 | 可将病组层级、提取的成员表和 CC/MCC/CCE 表物化；加载时校验哈希、行数及路径，并传递规则身份与版本。 |
| 住院事实和归档分组 | [住院 DRG 应用](../../apps/server/src/application/inpatient-drg.ts)第 65–115 行；[HTTP 测试](../../apps/server/tests/inpatient-drg-http.test.ts)第 97–163 行 | 提供已提交病案的预分组及归档冻结结果；更换规则包后仍可回看原冻结结果。可运行的前提是已装载独立规则包。 |
| 资料自动安装和精简保存 | [固定分发锁](../../apps/server/reference-data/drg-distribution.lock.json)；[储存合同](../drg-reference-storage.md)第 47–66 行 | 已有固定快照、下载完整性校验、离线复用及损坏恢复；精简包保留 2,335 个逻辑文件，对应 411 个物理文件、347,615,526 bytes 常驻和 36,122,034 bytes 下载。资料完整性与分组正确性分别验收。 |

## 主要未完成项

**联合操作和其他完整条件尚未进入当前规则表达。** [提取器](../../apps/server/src/infrastructure/reference-data/drg-opendrg-extract.ts)第 3–6、43–53 行明确只统计“主要手术或操作＋其他手术或操作”对应的 ADRG，不生成其条件规则；[构建器](../../apps/server/src/infrastructure/reference-data/drg-rules-builder.ts)第 40–44 行也声明此限制。终端条件当前主要由病组名称中的并发症措辞和 ≥70 岁提炼。对这类缺口不能简单用“源资料已有完整程序”替代实现和验证。

**人口及住院字段有合同，尚未全部参与分组。** [输入合同](../../packages/contracts/src/drg.ts)第 17–27 行接受性别、年龄、日龄、出生体重、离院方式和住院天数；当前[内核](../../apps/server/src/application/drg-grouping.ts)只将 `ageYears` 用于终端条件判断，未使用其余这些属性。出生体重在[住院输入构造](../../apps/server/src/application/inpatient-drg.ts)第 47–54 行固定为 `null`。现有年龄测试只能证明年龄计算边界，不能证明新生儿等完整条件分组。

**临床编码与医保编码尚无完整映射。** [住院应用](../../apps/server/src/application/inpatient-drg.ts)第 17–18、43–44 行采用临床版编码直接传入、同码匹配的口径；未匹配编码不做名称近似转换。该实现避免凭名称猜码，但不能证明两个码域整体兼容。

**常规启动尚未接入规则包。** [运行时](../../apps/server/src/runtime.ts)第 149–150、286–287 行只有在调用方显式传入 `drgRulesDirectory` 时才装载规则。该基线的[生产启动入口](../../apps/server/src/index.ts)第 14–47 行未传入该选项；仓库中传入该选项的调用位于 DRG 测试。规则为空时，[预分组与推演](../../apps/server/src/application/inpatient-drg.ts)第 69、125 行返回 `DRG_RULES_NOT_CONFIGURED`，归档分组第 104 行返回空冻结结果。因此“存在可调用的分组类和测试”不能当作默认安装后已经可用。

**离线资料安装继续保持停用状态。** [清单实现](../../apps/server/src/infrastructure/reference-data/offline-reference-inventory.ts)第 161、183 行固定 `approvedUse=offline-review`、`validationScope=integrity-only`、`runtimeEnabled=false`；[固定离线锁](../../apps/server/reference-data/drg-offline.lock.json)保留使用条件、编码兼容、算法和适用性待核验的隔离原因。自动安装没有把这些状态变成已授权的业务规则。

**医院支付参数只有一个演示病组。** [合成参数](../../apps/server/src/application/scenario-data/drg-payment-parameters.ts)第 5–13 行固定 `2026-demo-1`，基础费率 500,000 分，只有 `RA15` 的权重 6,000 万分位，对应合成核定 3,000 元；其他病组由[核定实现](../../apps/server/src/application/inpatient-drg.ts)第 347–352 行报参数缺失。参数属于独立的合成方案，不是浙江或其他地区真实医保支付标准。

## 源资料覆盖与运行时覆盖的区别

[2026-10-21 OpenDRG 静态核验](2026-10-21-opendrg-public-data-inventory.md)记录源包包含 61 个方案、32 套公开程序，选定 CHS-DRG 3.0 表有 825 个病组，其中 818 个有参考权重及参考费用。这些数字描述保管的来源资料，不表示当前 ClinMesh 已实现 825 组的全部条件，更不表示其合成医院支付参数覆盖 818 组。

同份研究明确未执行来源程序、未验证正式分组器一致性；浙江资料缺少完整公开分组程序及配套支付表。当前代码中也未查到全病组、逐条件与固定公开程序或正式地区程序独立对照的测试。源码中出现“官方”字样，不能单独作为医保部门正式授权或算法适用性证据。

## 测试证据及可复测入口

现有测试源码覆盖基础分组的 12 个固定最小规则场景、提取器的 2 个文本片段场景、规则构建器的 4 个最小切片场景及规则包的 3 个物化和损坏场景；住院 HTTP 测试另覆盖预分组、未配置规则及归档冻结。它们能支持这些具体机制的回归，尚不能作为全量 CHS-DRG 3.0 规则准确率证据。

主 Agent 实际运行以下定向复测：

```sh
pnpm --filter @clinmesh/server test tests/drg-grouping.test.ts tests/inpatient-drg-http.test.ts tests/inpatient-drg-simulation-http.test.ts tests/inpatient-drg-payer-review-http.test.ts tests/inpatient-drg-age.test.ts
```

主 Agent 另行实际运行分组、年龄、预分组 HTTP、推演 HTTP、核定 HTTP 五个测试文件：首轮 25 项中 24 项通过、1 项超时，总耗时 46.46 秒。随后以原 15 秒用例预算执行 `pnpm --filter @clinmesh/server test tests/inpatient-drg-http.test.ts -t '病案未提交不能预分组' --maxWorkers=1`：1 项通过、2 项跳过，总耗时 18.27 秒，用例耗时 7.54 秒。该单例通过补充了功能证据，未确定首轮超时根因；没有重跑全套、浏览器或未合入分支的测试。

白话判断：资料的收集、固定版本、下载和保存已经比较完整；分组计算具备能跑合成样例的基础骨架。要把它变成默认安装后医生和医保人员可依赖的能力，还需要补全条件分组与编码兼容证据、发布并接入可用规则包、扩充明确版本的医院支付参数，并完成独立对照及真实岗位入口验收。

## 未合入条件分组分支的补充证据

同日只读核对 `issue-305-drg-conditions` 的 `d1030c21a1e812c240ee0df2f8ce25cc9e10c8da`：工作树无未提交修改，该提交存在远端分支，但当时不被本地 `main` 包含。以下是待集成开发证据，不能计入上文已合入基线的可用能力。

该分支已经把按成员表和名称推断的内核替换为有序声明式条件程序，增加 AST 编译器、封闭解释器、v2 规则包、显式制包和离线对照 CLI。覆盖来源的 26 个 MDC、492 个 ADRG、825 个 DRG，支持联合操作、完整判定顺序、有效操作、CC/MCC 排除、性别、6/70 岁、日龄和出生体重、机器人、产科及多部位创伤条件；正式出生体重从既有 Observation 只读取得并参与首页冻结与推演指纹。完整合同见该固定提交的[分组合同](https://github.com/CaiZongyuan/clinmesh/blob/d1030c21a1e812c240ee0df2f8ce25cc9e10c8da/docs/architecture/drg-grouping.md)，实现见[解释器](https://github.com/CaiZongyuan/clinmesh/blob/d1030c21a1e812c240ee0df2f8ce25cc9e10c8da/apps/server/src/application/drg-program.ts)和[编译器](https://github.com/CaiZongyuan/clinmesh/blob/d1030c21a1e812c240ee0df2f8ce25cc9e10c8da/apps/server/src/infrastructure/reference-data/drg-program-compiler.ts)。

读取该分支既有完整合成报告 `.data/issue305-final-loaded-rules-verification.json`，仅重新统计汇总，未重新执行分组：实际条数与声明条数均为 **13,784**，有差异条数为 **0**，含 **23** 项另行给定的人工预期，选中 **825** 个终端，无未选终端或未解释路由。结果组成是成功分组 12,364、输入无效 1、无法入组 446、歧义 973。摘要绑定实现提交 `3abe20431cb1a8d51be05acf2145f91c2d29a752`，规则身份为 `clinmesh-chs-drg-30-2026-10-25.conditions-v2`。公开留存的[核验记录](https://github.com/CaiZongyuan/clinmesh/blob/d1030c21a1e812c240ee0df2f8ce25cc9e10c8da/docs/research/2026-10-25-drg-condition-verification.md)明确 `WR2_2` 被上游更早的 `WR2_1` 遮蔽，未动态触发，另有源码集合证明；没有把它伪报为已命中。后续 `d1030c21` 的医院当地日期修正不在该旧汇总的提交绑定内，本次未补跑其测试。

这些证据显著提高了待合入内核的实现成熟度，但仍限定于固定公开来源和有限合成输入，不穷举所有组合，也不证明地方医保正式一致性。临床编码直通范围、来源使用条件、本院支付参数、常规启动装载及最终岗位联合验收仍分别确认。锁定来源实际未用 `dischargeMode` 和 `inpatientDays`，新实现如实保留字段而不声称它们参与判定。

### 与 #279 的交接尚不能直接相加

只读核对尚未推送的本地分支 `issue-279-pci-acceptance` 的 `dc2aebecbc94443db47b4b0788b063fe8b766ebc`，其启动准备器 `apps/server/src/drg-rules-prepare.ts`、规则包及人工核验装载器 `apps/server/src/infrastructure/reference-data/drg-rules-package.ts`、PCI 合成 fixture `apps/server/tests/fixtures/pci-payment-drg.ts` 仍依赖 `clinmesh.drg-rules.v1` 成员表。这些证据可从该本地分支读取，尚无对应公开提交链接。#305 则明确只接受 `clinmesh.drg-rules.v2`，将 `DrgRules` 改为 `{ rulesId, version, program }`，并将 `prepareDrgRulesPackage` 移至维护期专用模块。两分支在这些边界存在明确合同变化。

集成时须适配启动准备、受核验装载和各合成 fixture，按新格式生成不可变规则目录，重新绑定人工核验记录所引用的 manifest 哈希；临床病例、主次编码和操作在严格词表与主操作校验下也需重验。已有归档结果不重新计算，但不能把旧 v1 安装目录直接交给 v2 装载器。须在最终集成提交重新验证病例、分组、页面和支付旅程，分支各自的通过证据不足以替代这个交接。
