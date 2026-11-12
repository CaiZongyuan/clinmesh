# Agent Note: 心血管核心检验默认定价基线与多支冠脉造影生理学报告扩展

Status: implemented

## Problem

新 Epoch 在未显式运行 PCI 准备接口时，五分类血常规组合键与参考库 `CN-LAB-CBC-5DIFF` 存在漂移，高敏心肌肌钙蛋白 I（`hs-cTnI`）、`NT-proBNP`、血脂、肌酐、电解质、`HbA1c` 与 D-二聚体等心血管核心检验缺少统一的门诊／住院默认合成定价、LOINC 备选编码、按项目约束的真值单位换算与定量危急值标记，导致普通胸痛／心内科门诊与住院流程无法开箱完成完整检验闭环。同时，住院冠脉造影报告仅抽取支架选型所需的三项单病变 QCA 测量，当病例属于“多支冠脉造影伴阴性 FFR／iFR、无需实施 PCI”时会被误判为 `unavailable`，也无法向临床展示各冠脉节段狭窄、TIMI 血流与生理学结论。

## Decision

建立精确按 `system + version + code` 匹配的门诊／住院共享默认合成检验价目表，对齐参考库 `CN-LAB-CBC-5DIFF` 并保留 `CN-LAB-CBC` 测试夹具兼容，覆盖五分类血常规、心肌损伤组合与单项、血脂、肾功能、电解质、`HbA1c` 及凝血与 D-二聚体。在不改动锁定的参考库文件前提下，当 `laboratory-cn` 数据集包含心肌组合或 `2100404A` 时，于默认服务发布阶段幂等增补可由医生开立的 `hs-cTnI`（`wst-886-2026` 补充码 `2100404B`、LOINC `89579-7`、性别分层成人参考上限与危急值上限）并纳入 `CN-LAB-CARDIAC`；无 `laboratory-cn` 候选的轻量性能场景不注入额外服务以保持基线行数稳定。为参考库缺少 `alternateCodings` 的核心项目补齐 LOINC 编码，并在检验结果解析层按具体分析物编码执行确定性单位换算（肌酐、胆固醇与甘油三酯、心肌标志物、电解质、D-二聚体），避免不同摩尔质量项目混用换算系数；在保持 `interpretation` 严格三态枚举不变的前提下，为定量结果定义增加可选 `criticalMinimum`/`criticalMaximum`、为报告结果与 FHIR Observation 扩展投影布尔 `critical`，在门诊和住院检验报告表中紧凑展示“危急值”徽标。默认发布策略版本为 `clinmesh-laboratory-defaults-v2`，既有数据库与重置后的 Epoch 在初始化时整体重发默认服务，使 LOINC 备选编码、危急值阈值与 `hs-cTnI` 组合成员一次到位；编码与单位以锁定参考库为准（`0100401A` 血红蛋白 `g/L`、`0100501A` 红细胞比容 `L/L`、心肌标志物 `ng/mL`），真值换算覆盖 `%`↔`L/L` 与 `ng/L`/`pg/mL`↔`ng/mL`。读取上述字段的 Agent Operation 已升版并同步对应 `clinmesh-*` Skill。

在住院冠脉造影合同 `inpatientAngiographyReportSchema` 上保留原有 `targetSite` 与最多三项支架选型 `measurements` 不变，向后兼容追加默认空数组的 `vessels`（`LM`/`LAD`/`LCX`/`RCA`、节段、狭窄比例、TIMI 0–3 血流、病变特征、可选 `FFR`/`iFR`）与默认 `null` 的 `conclusion`。造影后台任务从隔离的 `Case Truth` 确定性解析 QCA 测量、多支节段所见与结论且零模型调用：纯单病变 QCA 旧病例维持原输出与 FHIR `DiagnosticReport.conclusion`；纯诊断性多支造影伴阴性 FFR 且无支架选型 QCA 的病例签发 `status=final` 正式报告；存在缺项或生理学数值越界时降级为 `partial` 并记录 `missing`，完全无造影来源时维持 `unavailable`。前端保持 React 18/19 共享 API 兼容，在 `InpatientSurgery` 中仅当本次住院存在 `88.5500`/`88.5600` 或 PCI 术式计划、进行中或已完成记录时才查询 `angiography-reports`，并在已完成造影区域及既有 PCI 选型参数与预计依据折叠区复用紧凑表格展示，不新建独立专题看板；已完成造影但报告仍在生成时按 3 秒轮询直至终态，病案岗位可只读查看。只有含靶部位或 QCA 测量的报告才预填 PCI 选型草稿，诊断性阴性 FFR 报告不生成空草稿。

## Alternatives considered

- 直接修改锁定参考库产物补充 `hs-cTnI` 与 LOINC：违反参考数据发布锁定边界，增加跨环境产物重制成本。
- 将 `'critical'` 并入 `laboratoryResultInterpretationSchema`：破坏既有三态解释合同与历史回执校验，独立布尔 `critical` 可无损兼容全部存量快照与 CLI 目录。
- 要求所有冠脉造影病例必须提供三项支架选型 QCA 才能进入 `final`：会把阴性 FFR、无需支架置入的诊断性造影错误标为不完整或不可用。
- 在住院手术页无条件拉取 `angiography-reports` 或新增独立冠脉工作台：给非冠脉普通外科手术引入多余请求并造成界面信息膨胀。

## Consequences

新 Epoch 无需先执行固定 PCI 数据准备即可在门诊与住院开立核心心血管代谢检验、经成人参考基线或 Case Truth 零模型生成报告并标识危急值，同时完整支持多支冠脉造影与阴性 FFR 不行 PCI 的临床闭环；存量检验快照、PCI 选型草稿预填、耗材预计及性能基线保持兼容。当前业务合同见[临床业务流程](../../../architecture/clinical-workflows.md#pci-参数与候选依据)。
