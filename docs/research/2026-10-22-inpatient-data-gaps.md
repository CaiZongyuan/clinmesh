# 住院流程数据缺口核查

核查日期：2026-10-22。问题范围是住院工作台缺少可演示数据。本记录保存下述固定基线的运行聚合快照与补数建议，不构成需求或验收通过声明；患者阶段补数建议尚未实施。心血管耗材目录的当前安装、收费及单位限制由[临床流程](../architecture/clinical-workflows.md#82-住院闭环)拥有，正式要求见[耗材规格](../spec/2026-10-22-cardiovascular-surgical-materials.md)，其余住院范围见[住院规格](../spec/2026-10-20-inpatient-closed-loop.md)。

## 证据范围

- 源码研究基线为当前工作区 `9005ba1577f4d09991fbe9657e3cfeba71e85fa1`；只读核查既有未提交修改，未改动 Web 原型或业务代码。
- 实际运行 Server 来自另一工作区，HEAD 为 `3960c4f`。下列数据库统计只描述该运行实例的活动 Workspace/Epoch，不能证明当前工作区源码已在该实例验收。
- 主 Agent 对 Server 实际绑定业务库使用 Python `sqlite3` URI `mode=ro` 与 `PRAGMA query_only=ON` 读取表结构及聚合数量，耗时 0.193 秒；没有读取影像像素、患者明细或写入业务数据。当前工作区配置指向的另一业务库没有住院表，不能拿它代替正在使用的库作结论。

## 现状与缺口

**当前运行环境已有 1 名在院样本，主要缺口是后续诊疗、财务和病案事实，以及不同阶段的样本覆盖。** 不能据此说整个住院模块完全没有患者，也不能把空表直接解释为功能未实现。

| 层次 | 已有事实 | 数据缺口或限制 |
| --- | --- | --- |
| 环境与人员 | 源码默认提供 1 个住院科、1 个病区、1 间病房、3 张床位及住院医生、病区护士、病案岗位；床位合成价格为 5000 分/床日。运行库有 1 个病区、3 张床位。 | 默认 seed 只建环境与目录，没有预置完整住院业务实例；重新启动只补环境，不会自动走完住院流程。来源：[环境 seed](../../apps/server/src/application/inpatient-environment.ts#L8)、[启动补齐](../../apps/server/src/application/scenario-service.ts#L321)。 |
| 患者与入院 | 运行库有 10 份合成档案、6 个病例物化、1 次住院、1 个有效占床、1 张住院证；住院状态为 `admitted/open/open`，分别表示行政在院、未结算、病案未归档；该次住院 `source_case_id` 非空。 | 缺已登记待入科、待出院、已出区待结算、已清床待归档与已归档等阶段样本。住院清单按本次正式住院事实和受信科室/病区筛选，不能用患者库数量替代。来源：[清单与登记](../../apps/server/src/application/inpatient-service.ts#L115)。 |
| 诊断与医嘱 | 运行库的住院诊断确认、诊断条目、医嘱、校对、执行、发药均为 0；FHIR `MedicationAdministration` 为 0。源码已有正式主次诊断、逐项入院病情、长期/临时医嘱及执行合同。 | 需补匹配病例的正式主次诊断及入院病情，并形成待校对、待发药、已发待给、已执行等可操作事实。单纯增加患者不会填充药房队列。来源：[医嘱合同](../architecture/clinical-workflows.md#83-医嘱生命周期)、[药房筛选](../../apps/server/src/application/inpatient-orders.ts#L67)。 |
| 检查与手术 | 运行库有 1 项检验申请，状态 `issued`、`sent_at IS NULL`，即待护士送检；目前无 `DiagnosticReport`，没有报告不等于生成失败。手术目录有 10 项，即 8 个术式与 2 个耗材；手术申请、实施及耗材使用均为 0，FHIR `Procedure` 为 0。 | 先经护士送检推进已有申请，再补已报告等阶段实例；不能把尚未送检解释为缺来源或直接插入报告。手术需补术前核对、同意确认、实际实施、耗材和术后医嘱。目录项目、来源既往手术与本次实际实施是不同事实。来源：[检查入口与送检](../../apps/server/src/application/inpatient-investigations.ts#L59)、[手术目录](../../apps/server/src/application/scenario-data/inpatient-surgery-catalog.ts#L4)、[手术实施](../../apps/server/src/application/inpatient-surgery.ts#L97)。 |
| 费用与病案 | 运行库的预交金、费用、出院事件、结算、补退资金、首页修订、编码审核、归档均为 0。 | 需补跨日床费、实际诊疗费用、预交金及补退差额，并由真实出院、结算、清床与病案动作推进；首页从正式诊断、实际手术、住院经过与费用账收集，不能孤立伪造首页。来源：[虚拟时钟](../architecture/simulation.md#102-虚拟时钟)、[出院动作](../../apps/server/src/application/inpatient-discharge.ts#L25)、[首页来源](../../apps/server/src/application/inpatient-records.ts#L26)、[归档门禁](../../apps/server/src/application/inpatient-records.ts#L158)。 |

## 优先补充的数据

### P0：先建立一套覆盖岗位与阶段的住院样本

建议先选用适配现有目录的合成病例，经真实岗位 Command 建立以下 6 个样本；不是直接插入孤立 SQL 行，也不是把原型的内存假数据转为正式事实。

| 样本 | 停留阶段 | 应具备的数据 |
| --- | --- | --- |
| A | 已登记、待入科 | 合成 Patient、独立住院号、入院途径、可选预交金；尚未占床。 |
| B | 内科诊疗在院 | 可用合成病例来源、正式主次诊断与逐项入院病情；药嘱分别覆盖待校对、待发药、已发待给与已给药；检查覆盖待送检与已报告。 |
| C | 手术诊疗在院 | 适配当前术式目录的病例；分别有待准备申请与已完成实际操作，含耗材、费用与引用本次实施的术后医嘱。 |
| D | 已出区、待结算 | 已完成或取消在途任务、已停嘱并核停、实际出区事件、原预交金和逐项费用；保留床位，展示补缴或退款差额。 |
| E | 已结算、已清床、待归档 | 床位已释放、正式可审核诊断、完整住院经过、已提交首页；供编码审核与归档操作。 |
| F | 已归档 | 完整费用与资金闭合、当前修订审核通过、不可变归档快照；供只读查看。 |

默认只有 3 张床，B、C、D 已占满；E、F 应先完成并释放床位，再构造当前在院样本。可额外保留一张 `issued` 住院证用于登记转收；已 `received` 的住院证不能充当待转收样本。床位与住院证规则见[临床流程](../architecture/clinical-workflows.md#82-住院闭环)。

### P1：围绕选定病例补目录和来源

1. **可用于本次检查的合成来源。** Synthea 保存的是来源病史与病例资产，开始/replay 创建本院门诊运行事实，不会自动生成住院诊疗。本次住院登记需固定唯一 `source_case_id`；纯手工 Patient 可以登记，但来源为空时检查检验明确拒绝。应先核对已有病例是否适合目标住院场景，再决定是否定向生成。来源：[场景与病例合同](../architecture/simulation.md#103-场景定义)、[来源绑定](../../apps/server/src/application/inpatient-service.ts#L198)、[检验限制 `#laboratoryRequestCaseForAction`](../../apps/server/src/application/workflow-service.ts)、[影像限制](../../apps/server/src/application/imaging-request-service.ts#L1047)。
2. **病例需要的住院用药及规则。** 默认只有对乙酰氨基酚、二甲双胍、氨氯地平三种住院用药，配有界剂量、频次、适应症、组合规则、单价及库存批次；普通执行服务主要是糖尿病健康教育。若选定病种所需用药超出这些项目，需要成套补目录与校验规则，不能只补药名或把原型中的药品当作已可开立。来源：[药品基线](../../apps/server/src/application/scenario-data/hospital-baseline.ts#L567)、[住院启用](../../apps/server/src/application/inpatient-environment.ts#L15)、[医嘱校验](../../apps/server/src/application/inpatient-orders.ts#L120)。
3. **住院检查价目与开展条件。** 已有检验概念不代表住院可开；基础自动补价只覆盖 WBC、HGB、CBC，其他项目须有正数且声明住院适用的医院价。未计价不等于免费。胸片和胸部 CT 平扫另有住院价，但还需核验素材安装、发布及病例匹配，不能由目录存在推断全部可用。来源：[价目规则](../architecture/clinical-workflows.md#82-住院闭环)、[检验补价](../../apps/server/src/application/laboratory-service-publisher.ts#L32)、[可开展判定](../../apps/server/src/application/inpatient-investigations.ts#L43)。
4. **正式病案编码。** 演示到归档需使用带固定 Release 与来源定位的临床版 2022 诊断；院内备用编码不能通过审核。实际手术从本次实施读取，不能把申请或来源既往 Procedure 当作已完成手术。来源：[首页审核](../../apps/server/src/application/inpatient-records.ts#L129)、[编码依据](2026-10-20-inpatient-record-coding-and-recall.md)。

## 验证切入点与边界

既有浏览器场景可复用为补数后验收入口：[入院](../../apps/web/e2e/inpatient-admission.spec.ts)、[医嘱](../../apps/web/e2e/inpatient-orders.spec.ts)、[检查与转科](../../apps/web/e2e/inpatient-investigations-transfer.spec.ts)、[手术](../../apps/web/e2e/inpatient-surgery.spec.ts)、[出院](../../apps/web/e2e/inpatient-discharge.spec.ts)、[病案](../../apps/web/e2e/inpatient-record.spec.ts)。这些文件是现成流程依据，本次没有执行它们，也没有创建上述建议样本。

多病区样本、DRG 分组、完整护理文书、手术室排班、麻醉设备与耗材供应链属于后续功能范围，不能作为当前单病区演示必须补齐的数据。只为当前需求增加阶段样本和所选病种实际需要的目录即可，范围边界见[住院规格](../spec/2026-10-20-inpatient-closed-loop.md#范围外)。

本次未核验运行实例每个目录项的实际可用性、库存有效性、影像素材发布/绑定、模型服务、合成来源匹配及任何新业务写入结果；源码能力与运行版本不同，补数前须在实际目标环境复核。

## 心血管耗材价格参考输入

用户提供的《心血管耗材价格参考表 的副本.xlsx》提供心血管耗材名称、企业、参考价格及来源定位，不能直接补足患者诊疗事实。原始工作簿保留为本地输入，不进入 Git；用于目录安装的[归一化公开来源快照](../../apps/server/src/application/scenario-data/cardiovascular-materials.json)保留全部231条原字段与7组来源。核查使用 Python 标准库 `zipfile` 与 `ElementTree`，未修改原表。取得文件为 38,987 字节，SHA-256 为 `76147edf46552c906750bb2a8697596cd47acf3450c322168f92a5b8e2348cc3`；两张工作表为“心血管价格明细”和“来源与适用范围”，明细范围 `A1:Q238`，第 7 行表头、第 8–238 行共 231 条数据，表内核验日标注为 2026-10-15。

| 类别 | 记录数 |
| --- | --- |
| 常规起搏器／无导线起搏器／电极导线 | 35／2／15 |
| 冠脉导引导丝／导引导管 | 42／20 |
| 扩张球囊／药物球囊／冠脉支架 | 89／12／16 |

表内有 101 种不同产品或类别名称、无完全重复行，但产品名称不能充当去重键。231 条均有名称、企业、金额、来源编号与原表定位，均缺规格；179 条单位为“原表未列”，仅 52 条明确单位（37 台、15 根）；33 条缺原耗材代码，52 条缺注册证。记录数、7 组来源数均与表内声明一致，全部来源引用匹配来源页编号。全部中选价大于零，3 个价格单元格的原始 XML 带二进制浮点尾数，但没有真实分以下计价；后续仍须按明确价格口径规范到整数分。表内另有独立的“基准品拟供应价”列，3 条相关记录不得以该列覆盖“中选价”。只读核查后的文件 SHA-256 保持一致。

**价格适用性仅核对到表内声明。** 表中 7 个来源组里，`HN-PACING-2026` 的 52 条被标注为湖南自 2026-08-01 起执行的联盟中选价，仍须核对实际地区及合同适用性；`TJ2023-1/2/3/4` 分别有 42／20／89／12 条，标注自 2023-04-15 起，现行接续未核实；`ZJ-STENT-1/2` 分别有 14／2 条，原止日 2025-12-31，表内说明浙江自 2026-09-01 已进入新一轮接续。因此，179 条冠脉记录只能作为历史参考。本轮没有联网独立复核这 7 组原附件，不能把表内来源标注写成已经验证的当前有效价格，更不能将中选采购价直接当作患者收费价。

归一化快照与原表逐项核对涵盖231×17个原单元格、E/Q金额、I/J日期和7组来源，均一致；公开价格的安装与合成收费边界统一见[当前临床合同](../architecture/clinical-workflows.md#82-住院闭环)。本研究保留表内来源及适用性证据，不维护另一套当前目录合同。
