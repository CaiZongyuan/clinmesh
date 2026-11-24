# Agent Note: 住院检验目录分类快捷开立与病区护士按采血管合管送检

Status: implemented

## Problem

真实公立医院住院诊疗中，医生常规按临床组合（如五分类血常规、肝功能、肾功能、凝血功能、尿常规）或术前常规分类快捷下达检验医嘱，病区护士则按真空采血管规格（紫头 EDTA-K2 全血、黄头促凝血清、蓝头 1:9 枸橼酸钠抗凝血浆、黑头 1:4 血沉管、清洁尿管）执行同管合并采血与条码送检。此前住院检验开立器存在两处临床摩擦：一是 `laboratory-cn` 中肝功能、肝肾功能、尿常规、空腹血糖、甲状腺功能、乙肝五项、炎症指标与基础肿瘤标志物等常用组合默认未配置医院价目而显示不可开立，且百余项检验以无分类平铺列表展示，固定 PCI 演示仍需逐项搜索 9 次；二是病区护士「集中送检」将全部待送检检验按独立申请平铺勾选，9 项术前常规检验呈现为 9 张分散卡片而非临床真实的 3 支真空采血管，与护士床旁合管采血心智脱节。

需求与范围见 [住院检验常用组合分类快捷开立与病区护士按标本管合管集中送检（Issue #517）](https://github.com/CaiZongyuan/clinmesh/issues/517)。

## Decision

1. **保持 `Order Set Template` 专病组套职责纯粹，检验筛选与快捷加入下沉至目录层**：跨模态、含患者生理指标与药物过敏禁忌预筛的临床路径模板继续由 [心血管专病医嘱组套](2026-11-18-cardiology-order-set-templates.md) 独立拥有，不将单模态常规检验组合或 PCI 演示单项混入 `orderSetTemplateIds`；补齐 `laboratory-cn` 全量 15 个检验组合与全部原子检验项目的默认合成价目，并在 `inpatient.investigation.catalog` 中投影 `isPanel`、`memberCount`、`laboratoryCategory`（含 `preop-routine`）、`specimen` 与 `specimenContainer`，由 `InpatientInvestigationComposer` 左侧目录提供默认聚焦「常用组合」的专科分类页签及单分类（`<= 20` 项）一键整类加入待开清单，底层签发仍逐项走 `inpatient.investigation.issue`。
2. **零 SQLite DDL 迁移的采血管容器元数据与纯函数确定性合管内核**：在 `LaboratoryServiceSnapshot`（存储于既有 `hospital_service_catalog.config_json` 并冻结入已签发申请的 `service_snapshot_json`）新增结构化 `specimenContainer`，在 `@clinmesh/core/laboratory-specimen-container` 集中维护容器推导与合管分组纯函数：严格区分同为「全血」但抗凝比例不同的 `0300101A` 红细胞沉降率（黑头 1:4 枸橼酸钠管 `esr-black`）与紫头 EDTA-K2 全血管（`edta-k2-purple`），并将 `混合标本`（如炎症指标组合 `CN-LAB-INFLAMMATION`）与未知特殊体液显式标为 `mergeable: false` 独立核对，历史快照缺失容器字段时由纯函数无损回退推导，不改动已归档病案 `sourcesHash`。
3. **护士端按采血管聚类核对、底层逐项独立 `Command` 送检**：`InpatientInvestigationSend` 仅对当前处于 `issued` 且尚未送检的可合管 `laboratory` 申请按 `code + specimenCategoryZh + collectionRequirementZh` 聚类为采血管卡片（整管勾选与整管 20 项上限拦截，杜绝半管勾选），无像素功能检查（`examination`）与放射检查（`imaging`）作为独立非采血卡片并列展示，已送检、已取消或执行中的历史申请保持独立行展示且绝不混入待采血管；护士在核对弹窗确认后，前端将所选采血管展开为底层 `requestId` 序列，继续逐项调用既有 `inpatient.investigation.send` 并绑定各自 `idempotencyKey`，完整复用 [临床批量私稿与原回执恢复](2026-11-10-clinical-batch-draft-and-receipt-recovery.md) 的部分失败隔离与 `command.receipt.get` 恢复能力。当前业务与界面合同见[检验、检查与报告](../../../architecture/examinations-and-reports.md#门诊开立与住院护士送检门禁)与[临床界面设计](../../../ui/design.md)。

## Alternatives considered

- **把血常规、肝肾功能或 PCI 术前 9 项塞入 `Order Set Template`**：常规单模态检验组合不涉及跨模态联合处方或生命体征／eGFR 禁忌剔除，混入专病组套下拉框会稀释急危重症临床路径入口并造成左目录与右组套概念重叠，因此拒绝。
- **新增整管批量送检写接口或数据库标本管物理表**：在 `laboratory_request` 新增物理列或新建整管写 `Command` 既会引入不必要的迁移冲突风险，又会破坏既有单项 `ServiceRequest`/`Task` CAS 版本校验、单项审计事件及逐项幂等回执恢复语义，因此拒绝。
- **仅按粗粒度标本字符串合并采血管**：若仅按 `"全血"` 字符串合并，会把需 1:4 枸橼酸钠黑头管的血沉错误并入紫头 EDTA-K2 管，也会把含混合标本的组合误并，违背临床检验标本采集规范。

## Consequences

- 住院医生打开检查开立器即可直接点选全部 15 个已定价常用检验组合或按专科分类检索，PCI 围术期演示从 9 次重复弹窗搜索收敛为 1 次「术前常规单项」整类加入与集中开立。
- 病区护士在送检环节直观核对管帽颜色、容器规格、混匀要求及每管合并项目（如 9 项术前常规检验自动收敛为紫头、黄头、蓝头 3 支采血管卡片），同时保持底层 `inpatient.investigation.send` 契约、计费触发点与断网原回执恢复零退化。
