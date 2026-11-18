# Agent Note: 版本化心血管专病医嘱组套与按患者禁忌预筛的零副作用草稿装配

Status: implemented

## Problem

心血管胸痛急查、冠心病入院基线评估、对比剂肾损围术期水化与冠心病／PCI 二级预防在真实临床中高度依赖成套检查与跨药理类别联合用药（GDMT），但逐项手工检索目录、核对规格与剂量既繁琐又容易遗漏关键检查或二级预防药物。若将组套实现为“一键批量直接签发”写接口，或在患者缺少生命体征、体重及肾功能记录时默认按正常值静默放行，不仅会绕过既有门诊与住院正式开立 `Command` 的版本控制、药事审方、计费冻结与审计链路，还会在合并药物过敏、低血压、心动过缓或严重肾功能不全的患者身上引发用药安全风险。

需求与范围见 [四套心血管专病医嘱组套与按患者禁忌预筛的草稿装配（Issue #474）](https://github.com/CaiZongyuan/clinmesh/issues/474) 及父需求 [专科指南与确定性临床评分体系（Issue #464）](https://github.com/CaiZongyuan/clinmesh/issues/464)。

## Decision

1. **代码内版本与内容指纹双绑定的 `Order Set Template` 注册表**：注册 `chest-pain-stat-workup`、`cad-admission-baseline`、`cin-perioperative-hydration` 与 `cad-pci-secondary-prevention` 四套专病模板，每个模板同时携带显式版本号与覆盖全部条目、目录参考编码及筛选规则的规范 JSON SHA-256 指纹，并通过 `catalog.order-set-templates.list` 向人类与智能体公开只读定义；所有检验、无像素功能检查与药品均绑定本院常备已定价目录编码（检验项目支持组合与单项有序目录回退），无需新增数据库持久化表。
2. **共享纯函数禁忌预筛与“缺项必标待核实”门禁**：将阈值比较、过敏禁忌剔除与门诊规格数量换算沉淀为无平台依赖的 `@clinmesh/core/order-set-screening` 纯函数；`OrderSetDraftService`（`doctor.case.order-set-drafts.read` 与 `inpatient.order-set-drafts.read`）仅从已落库客观记录读取有效确认 `AllergyIntolerance`、确定性 `ckd-epi-2021-egfr`（复用 [确定性临床算子内核](2026-11-17-deterministic-clinical-risk-scores.md)）以及门诊 `triage_record` 分诊体征或住院最新护理生命体征（心率、收缩压与最近一次已记录体重），不接受请求参数覆盖生理指标，也不在过敏时跨药自动改选或按未确认诊断预先降级。命中过敏（`allergy-contraindication` 及结构化过敏原编码／名称）或禁用阈值时直接返回 `disposition: 'excluded'`（`candidate: null`、`matchedCatalogId` 保留命中目录项身份）与带观测值及来源引用的结构化原因；缺少体征、体重或肾功能输入时一律返回 `disposition: 'needs-review'`（`severity: 'pending-verification'`），绝不按正常值静默放行。
3. **零正式副作用与轻量前端内联灌入**：组套预装配接口本身为纯只读查询（`risk: read`），零正式收费、零已签发医技申请、零已签发处方与零住院医嘱写入。前端在既有门诊检验、功能检查、处方页及住院医嘱、住院检查开立器顶部挂载由 TanStack Query 统一管理请求与确定性缓存键的内联「套用专病组套」选择条（遵循 [DSH Surface React API 约束](../bug-fix/2026-09-16-dsh-surface-react-api-surface.md)，不新增独立路由或模态弹窗，不在页面挂载时发起额外请求；住院检查开立器仅展示纯检验／检查模板以避免静默丢弃药物候选），将 `ready` 与默认未勾选的 `needs-review` 候选灌入既有客户端待开清单，并在病情恶化后重套用时凭 `matchedCatalogId` 自动剔除新受限项、取消勾选新待核实项，最终签发继续完整经过既有门诊与住院正式开立 `Command`。当前完整业务合同由[临床业务流程](../../../architecture/clinical-workflows.md)拥有。

## Alternatives considered

- **新增批量直接签发组套写 `Command`**：虽然减少一次点击，但会复制或绕过门诊检验／功能检查预付费冻结、门诊单源处方整单事务以及住院逐项医嘱／检查原回执恢复状态机，且无法在签发前让医生逐条复核 `needs-review` 缺项提示，因此拒绝。
- **药物过敏时自动跨药改选替代品种**：在氯吡格雷或他汀过敏时静默替换为其他品种并返回 `ready` 会掩盖原组套药物的受限剔除事实，且替代品种的出血或肝肾风险须由临床医生显式选择，因此对药物过敏统一按 `excluded` 剔除并提示。
- **新建数据库组套配置表与迁移**：首期四套专病标准组套的编码映射与生理安全阈值均须随代码审阅、版本锁与单测共同演进，新建持久化表只会增加无谓迁移与目录漂移风险。
- **体征或血肌酐未录入时默认按正常生理值放行**：在首诊尚未完成肾功能检测或住院尚未录入护理体征与体重时静默假定正常，会掩盖 β 受体阻滞剂、ACEI、硝酸甘油及按体重计速水化的核查义务，违背临床安全语义。

## Consequences

- 人类医生与 CLI 智能体共用同一套受审计预筛逻辑，能一键装配胸痛急查、冠心病入院基线、围术期水化与二级预防待确认候选，同时保留完整的禁忌剔除理由与缺项待核实提示。
- 调整既有四套组套内的条目或筛选阈值只需更新 `order-set-template-registry.ts` 与纯函数／集成测试（内容指纹自动更新）；若新增新的组套模板 ID，则同步在 `order-set-templates.ts` 枚举与前端 `order-set-selector.tsx` 静态选项列表中登记，无需改动底层正式开立与收费状态机。
