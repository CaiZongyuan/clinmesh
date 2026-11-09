# 重复逐项操作与批量入口盘点

核验日期：2026-11-09。调查基线为 `9777288dbd9ca063dcffbd178536d0bc674e085f`，覆盖当前工作区的 Web 页面实现、Surface 共享入口与已有测试源码；Mobile 仍为骨架，不纳入本次主范围。本文记录候选问题，供决定正式需求范围；不是已批准规格、实施方案或验收结论。没有修改业务代码、创建 GitHub Issue、调用模型、操作业务数据或执行浏览器实测，既有测试仅作为静态证据阅读。[S20]

## 判断口径

- **多项必须重复正式提交**：每次只处理一项，要做下一项必须重新走选择、加入、开具或确认。
- **可以统一提交，但只能单项加入**：能积累多条再一次提交，重复劳动发生在目录选项和编辑阶段。
- **逐项处理需要单独评估**：例如报告已阅、取消申请、发药、给药与资金操作，批量入口不能省略每项业务核对或把尚未执行的事实一键标成完成。
- 目录选项看起来像复选框，不代表能同时保留多个选择；相反，后端以单项 Command 执行，也不能据此推断 UI 没有批量提交。以下结论均核对页面状态和按钮行为。

## 优先候选：多项重复开立或审核

| 编号 | 岗位与入口 | 当前要重复做什么 | 已有能力与缺口 | 优先建议 |
| --- | --- | --- | --- | --- |
| A1 | 住院医生 → 检查检验 → 开立住院检查 | 选一个项目 → 核对适应证/指征 → 开立成功关闭并清空弹窗 → 重开选下一项。 | 只有单个 `selectedId`，成功即关闭，没有多项待开清单。PCI 演示源码确实循环开立九项检查检验。[S9] | 最高，直接对应用户在最新版录像看到的操作。 |
| A2 | 门诊医生 → 检验/放射检查/病理会诊 → 添加 | 选一个项目及适应证、指征或会诊信息 → 加入并关闭弹窗 → 正式开具 → 再添加下一项。 | 每种申请只保留一个手动草稿；已有草稿时改选别项被拦截，须先开具或删除。不能先手选一组项目再统一开。AI 准备的多项建议已有统一提交入口。[S1–S4] | 高，优先检验和放射；病理频率较低且每项关联送检手术，单独确认是否纳入。 |
| A3 | 住院医生 → 医嘱 → 开立医嘱 | 每次选一个药品或护理治疗项目，填时效/用法/剂量后正式开立，成功后清空选择。 | 无多条医嘱草稿列表或统一签发入口；每条用法仍须核对。[S10] | 高。 |
| A4 | 病区护士 → 医嘱校对/停嘱核对 | 对每条医嘱点击校对；顶部「校对下一条医嘱」「核对下一条停嘱」仍每次只处理一条。 | 有剩余条数与下一条入口，没有多选后统一核对；停嘱核对与新医嘱校对应分别选择。[S10] | 高，属于重复审核候选，须保留每项核对信息。 |
| A5 | 病区护士 → 检查检验 → 送检 | 同一患者的每条已开申请各点一次送检。 | 没有多选送检；PCI 演示九项申请对应九次送检。批量入口仍须说明标本、项目状态与部分失败。[S11] | 高，可与开单一起梳理上下游，不能把开单成功等同送检完成。 |

A2 的缺口是医生**手动选很多项目时无法积累一个待开清单**。门诊页面上虽然写有「开具选中项目（n）」，手工草稿仍只有一个槽位，因此这个按钮不能解决手工多项选择的问题。住院没有同样的 AI 多项待开清单，不能套用门诊已经支持的能力。

最新版 PCI 录像的编排直接引用既有准备旅程：九轮开立、九次护士送检、九次医生确认已阅。这个数量来自循环与实际页面操作的脚本，未换算成未经实测的总点击数。[S9][S11]

## 已有统一提交，但单项添加仍繁琐

| 编号 | 岗位与入口 | 当前重复操作 | 已有能力与缺口 | 优先建议 |
| --- | --- | --- | --- | --- |
| B1 | 门诊医生 → 处方 → 添加药品 | 选一个药、填写剂量/频次/疗程/数量 → 加入处方后弹窗关闭 → 下一个药重复。 | 可累积最多 8 条，最后整张处方统一开具。缺少一次选多药、留在同一编辑界面连续补全的入口；不是每药都正式开一次处方。[S5] | 中，优化目录选择与连续编辑，仍需核对每药用法用量。 |
| B2 | 门诊医生 → 诊断 → 添加诊断 | 选一条诊断、填写主次与备注 → 加入后弹窗关闭 → 下一条重复。 | 可累积最多 8 条，最终「确认选中诊断」一次提交。缺少目录多选/连续添加；不能省去唯一主诊断等约束。[S6] | 中低。 |
| B3 | 住院医生 → 手术 → 整台补录 → 耗材 | 从下拉框每次加一种耗材，再逐项填写用量、关联预留。 | 已支持最多 20 项和整台一次提交；缺口是目录多选和连续填写，不是每种耗材必须提交一次。PCI 手术旅程四项耗材循环加入后只有一次整台 POST。[S12] | 中，保留每项实际用量与预留引用。 |

## 需要单独设计的候选

| 编号 | 岗位与入口 | 当前操作 | 讨论边界 |
| --- | --- | --- | --- |
| C1 | 住院药房 → 待发药执行单 | 每次选一个执行单，发药后确认，再到下一单；成功自动选下一条，但不是批量。 | 无同患者多执行单多选发药。可考虑分组核对后一次提交，仍需按每单明确药品、数量和执行时间。[S13] |
| C2 | 门诊收费 → 同一患者的多个收费项目 | 每个收费项目分别预览并确认收款。 | 统一账单只汇总展示；支付预览仍绑定一个 `chargeItemId`。同一处方可含多药，并非每药收费一次；多支付方式也不是多收费项目合并支付。若优化，需单独设计合并预览、收款与原交易退款边界。[S14] |

除上述十个主要场景，还有以下逐项入口，建议作为后续分项讨论，避免把不同业务的“确认”合成一个无边界的批量按钮：

- **报告确认已阅**：门诊与住院均逐份操作。可以讨论阅读队列、阅读后连续确认或已读报告批量确认；设计时应保留实际阅读语义。放射/病理还要求影像或切片成功显示后才能确认。本次没有读取影像或切片像素。[S7][S11]
- **停嘱、取消申请与失败重试**：住院医生每条停嘱单独填写理由、确认，出院时剩余多条医嘱也逐条停；门诊检验取消每条有确认弹窗，住院检查取消/失败重试则是逐行直接操作，不应误述成都有二次确认。需明确哪些可共享理由、哪些项目不可处理，以及部分失败如何展示。[S8][S15]
- **护士实际给药/健康教育、PRN 发起**：每个执行单分别记录事实，PRN 还逐条填理由；批量 UI 不能把尚未给药或未开展的教育直接标成完成。[S10]
- **释放剩余预留与术后耗材更正**：完成手术时，剩余预留耗材逐项勾选但已能统一提交，可评估全选便利性；术后耗材更正逐笔处理，手工预留维护也为单笔，频率较低。它们与 [#406](https://github.com/CaiZongyuan/clinmesh/issues/406) 的“漏记耗材补登记”是不同问题。[S16][S17]
- **跨患者低频操作**：病案审核归档、医保核定、患者库开始就诊均为单个病例/患者入口，不与同一患者多项开单混为一类；是否需要队列批处理应另行评估。[S18]

## 已核实存在的批量能力

门诊共享的待开具面板支持逐行复选和统一提交，按钮按类型显示为「开具选中项目（n）」「确认选中诊断（n）」或「开具处方（n）」；完整项目默认勾选，一次最多 8 项。检查检验的手动草稿可以与不同的自动建议一起提交，但不支持同时积累多个手动检查草稿。各类型仍在独立页签、独立提交，不等于跨检验、放射、病理、诊断和处方的一次总提交。[S1][S2]

- 门诊药房已按整张处方审核/发药，不能因处方含多药就误列为每药一确认。[S19]
- 住院诊断已支持整组确认；PCI 耗材主清单可一次确认全部预留；完成手术可一次预览、确认整张用量表。[S16]
- 影像与病理素材准备已有批次入口；Synthea 患者生成也支持一批最多 10 人。[S19]
- 门诊待开具面板没有全选/全不选控件，但完整项目默认已选，属于小便利性候选，不是必须逐项勾选才能开具。[S2]

现有开放 [#400](https://github.com/CaiZongyuan/clinmesh/issues/400)、[#397](https://github.com/CaiZongyuan/clinmesh/issues/397) 的范围不包含本清单新增的完整批量流程；[#406](https://github.com/CaiZongyuan/clinmesh/issues/406) 只处理术后漏记耗材。后续若采纳，先确定场景与批次边界，再建立正式规格和关联执行 Issue，不把本次调查视作实施授权。

## 证据

以下为当前工作区的仓库相对源码链接，标注起始行，调查基线见文首。当前行为的详细 owner 仍是实现、[临床业务流程](../architecture/clinical-workflows.md)和对应规格，本文不替代它们。

- [S1] 门诊检验单项弹窗、确认关闭、草稿冲突：[laboratory-page.tsx:137](../../apps/web/src/app/doctor/laboratory-page.tsx:137)；手工项单槽及统一提交接线：[laboratory-page.tsx:658](../../apps/web/src/app/doctor/laboratory-page.tsx:658)；既有测试：[laboratory-page.test.tsx:567](../../apps/web/src/app/doctor/laboratory-page.test.tsx:567)。
- [S2] 门诊待开具默认选中条件：[doctor-recommendations.tsx:437](../../apps/web/src/app/doctor/doctor-recommendations.tsx:437)；8 项上限：[473](../../apps/web/src/app/doctor/doctor-recommendations.tsx:473)；统一提交按钮：[567](../../apps/web/src/app/doctor/doctor-recommendations.tsx:567)；逐行复选与移除：[612](../../apps/web/src/app/doctor/doctor-recommendations.tsx:612)。
- [S3] 门诊放射单项弹窗与草稿冲突：[imaging-page.tsx:339](../../apps/web/src/app/doctor/imaging-page.tsx:339)；手工项单槽：[593](../../apps/web/src/app/doctor/imaging-page.tsx:593)；第二项目未加入的既有测试：[imaging-page.test.tsx:346](../../apps/web/src/app/doctor/imaging-page.test.tsx:346)。
- [S4] 门诊病理单项弹窗、送检手术/目的与草稿冲突：[pathology-page.tsx:346](../../apps/web/src/app/doctor/pathology-page.tsx:346)；手工项单槽：[638](../../apps/web/src/app/doctor/pathology-page.tsx:638)。
- [S5] 门诊药品单项确认关闭：[catalog-picker-dialogs.tsx:779](../../apps/web/src/app/doctor/catalog-picker-dialogs.tsx:779)；多药累积与添加入口：[prescription-page.tsx:526](../../apps/web/src/app/doctor/prescription-page.tsx:526)。
- [S6] 门诊诊断多条累积与单项添加：[diagnosis-page.tsx:303](../../apps/web/src/app/doctor/diagnosis-page.tsx:303)；确认关闭：[catalog-picker-dialogs.tsx:651](../../apps/web/src/app/doctor/catalog-picker-dialogs.tsx:651)。
- [S7] 门诊检验逐份确认已阅：[laboratory-page.tsx:843](../../apps/web/src/app/doctor/laboratory-page.tsx:843)；放射成功显示门禁：[imaging-page.tsx:193](../../apps/web/src/app/doctor/imaging-page.tsx:193)；病理成功显示门禁：[pathology-page.tsx:198](../../apps/web/src/app/doctor/pathology-page.tsx:198)。
- [S8] 门诊检验逐项取消与确认：[laboratory-page.tsx:786](../../apps/web/src/app/doctor/laboratory-page.tsx:786)；放射当前申请取消：[imaging-page.tsx:290](../../apps/web/src/app/doctor/imaging-page.tsx:290)；病理当前申请取消：[pathology-page.tsx:296](../../apps/web/src/app/doctor/pathology-page.tsx:296)。
- [S9] 住院检查单值选择、成功清空关闭与单项签发：[inpatient-investigation-composer.tsx:33](../../apps/web/src/app/inpatient-investigation-composer.tsx:33)；PCI 旅程九项循环开立：[inpatient-pci-preparation.journey.ts:67](../../apps/web/e2e/inpatient-pci-preparation.journey.ts:67)。
- [S10] 住院药品/护理医嘱单项选择与成功清空：[inpatient-clinical.tsx:53](../../apps/web/src/app/inpatient-clinical.tsx:53)；开立表单：[163](../../apps/web/src/app/inpatient-clinical.tsx:163)；护士下一条校对：[113](../../apps/web/src/app/inpatient-clinical.tsx:113)；逐条校对、停嘱/PRN 理由：[137](../../apps/web/src/app/inpatient-clinical.tsx:137)；逐执行单给药与健康教育：[150](../../apps/web/src/app/inpatient-clinical.tsx:150)。
- [S11] 住院检查逐项已阅与影像门禁：[inpatient-investigations.tsx:56](../../apps/web/src/app/inpatient-investigations.tsx:56)；逐项送检、取消和重试：[64](../../apps/web/src/app/inpatient-investigations.tsx:64)；PCI 旅程九次送检和九次已阅：[inpatient-pci-preparation.journey.ts:81](../../apps/web/e2e/inpatient-pci-preparation.journey.ts:81)。
- [S12] 整台补录的单项加入、数量、预留和整表提交：[inpatient-surgery.tsx:856](../../apps/web/src/app/inpatient-surgery.tsx:856)；四项耗材循环加入及单次 POST 的既有旅程：[inpatient-pci.journey.ts:63](../../apps/web/e2e/inpatient-pci.journey.ts:63)。
- [S13] 住院药房单选状态：[inpatient-pharmacy.tsx:45](../../apps/web/src/app/inpatient-pharmacy.tsx:45)；成功选下一条：[125](../../apps/web/src/app/inpatient-pharmacy.tsx:125)；单执行单发药确认：[145](../../apps/web/src/app/inpatient-pharmacy.tsx:145)。
- [S14] 门诊收费单项目选择：[billing-workspace.tsx:92](../../apps/web/src/app/billing-workspace.tsx:92)；预览与确认绑定单个收费项目：[287](../../apps/web/src/app/billing-workspace.tsx:287)；收费入口：[694](../../apps/web/src/app/billing-workspace.tsx:694)；统一账单的汇总展示：[billing-case-panel.tsx:30](../../apps/web/src/app/billing-case-panel.tsx:30)。
- [S15] 住院逐条停嘱与理由：[inpatient-clinical.tsx:138](../../apps/web/src/app/inpatient-clinical.tsx:138)；出院逐条停嘱：[inpatient-discharge.tsx:144](../../apps/web/src/app/inpatient-discharge.tsx:144)；出院操作入口：[206](../../apps/web/src/app/inpatient-discharge.tsx:206)。
- [S16] 住院诊断整组确认：[inpatient-diagnosis-editor.tsx:55](../../apps/web/src/app/inpatient-diagnosis-editor.tsx:55)；PCI 主清单全部预留：[inpatient-surgery.tsx:532](../../apps/web/src/app/inpatient-surgery.tsx:532)；完成手术剩余预留逐项勾选：[inpatient-surgery-completion.tsx:97](../../apps/web/src/app/inpatient-surgery-completion.tsx:97)；整表预览确认：[148](../../apps/web/src/app/inpatient-surgery-completion.tsx:148)。
- [S17] 术后耗材逐笔更正：[inpatient-surgery-materials.tsx:33](../../apps/web/src/app/inpatient-surgery-materials.tsx:33)；手工预留逐笔维护：[inpatient-surgery-reservations.tsx:30](../../apps/web/src/app/inpatient-surgery-reservations.tsx:30)。
- [S18] 病案审核归档：[inpatient-record.tsx:301](../../apps/web/src/app/inpatient-record.tsx:301)；医保核定：[inpatient-drg-payer.tsx:94](../../apps/web/src/app/inpatient-drg-payer.tsx:94)；患者库单人开始就诊：[synthetic-patient-library.tsx:452](../../apps/web/src/app/synthetic-patient-library.tsx:452)。
- [S19] 门诊药房整张处方审核/发药：[pharmacy-workspace.tsx:143](../../apps/web/src/app/pharmacy-workspace.tsx:143)；影像批次准备：[imaging-preparation.tsx:302](../../apps/web/src/app/imaging-preparation.tsx:302)；病理批次准备：[pathology-preparation.tsx:322](../../apps/web/src/app/pathology-preparation.tsx:322)；Synthea 批量生成：[synthetic-patient-library.tsx:171](../../apps/web/src/app/synthetic-patient-library.tsx:171)。
- [S20] Surface 复用 Web 工作区：[apps/dsh-web/src/client/index.tsx:2](../../apps/dsh-web/src/client/index.tsx:2)；现有岗位合同：[contracts/his.ts:19](../../packages/contracts/src/his.ts:19)，没有独立检验技师/影像技师工作台，不能为其虚构缺少批量的页面。
