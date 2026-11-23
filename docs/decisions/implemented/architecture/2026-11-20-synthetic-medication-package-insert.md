# Agent Note: 合成药品说明书摘要的只读目录归属与就地回填

Status: implemented

## Problem

门诊与住院医生在核对适应证、单次／单日剂量、禁忌证与临床质控提示时，缺少不离开当前开方弹窗与待开清单即可对照的药品参考摘要。若抓取或粘贴真实上市产品法定说明书全文，会引入受版权保护文本、品牌商品名、与仿真有界规则冲突的复杂用法条款，并膨胀参考数据库与模型上下文；若将说明书摘要冻结进处方快照、FHIR 资源、病案归档来源或建议指纹，或把缺失摘要算作目录不完整并在回填时递增 `catalogVersion`，则会使文案勘误破坏既有医嘱版本 CAS、建议复用和自定义院内药品可开立性。

## Decision

在共享药事合同上新增可选只读 `packageInsert`（`medicationPackageInsertSchema`），仅随院内药品目录读取接口（`catalog.clinical.read`、`inpatient.catalog.search`、`inpatient.clinical.catalog`）返回，包含通用名、规格剂型、适应证摘要、常规用法用量、禁忌证、注意事项、常见不良反应及固定教学声明「合成教学参考，非真实上市产品法定说明书」。Hospital Baseline 的 22 种常备药与 PCI 前置准备安装的碘海醇注射液统一由受控合成定义生成，数值和临床边界严格对齐[声明式药事规则](2026-11-13-shared-medication-safety.md)、事中临床质控两级门禁与专病医嘱组套筛选阈值，不宣称特定商业商品名或国药准字。

存量活动 Epoch 在 `seedInpatientEnvironment` 与 `inpatient.pci-data.prepare` 中仅对缺失 `packageInsert` 的已登记药品就地补写 `config_json`，单纯补写摘要时不递增 `outpatient_catalog.version`，保持既有草稿与医嘱的 `catalogVersion` 乐观锁有效。自定义院内药品与国家参考目录外延药品允许无 `packageInsert`，不计入住院目录 `missingFields`，页面统一呈现「暂无院内说明书摘要」空态且不阻断开立。`packageInsert` 不写入处方快照、计费记录、FHIR 资源、病案归档来源，也在门诊处方建议目录装配时显式剥离，避免参考文案勘误触发建议指纹失效或占用模型上下文预算。

前端在门诊选药弹窗、处方待开清单与住院开医嘱器中复用单一只读抽屉 `MedicationPackageInsertSheet`；候选行的触发按钮与整行选择按钮保持同级兄弟节点，嵌套于弹窗内打开时强制渲染独立遮罩层，确保通过 `Esc`、遮罩点击或关闭按钮收起抽屉时仅关闭抽屉本身，底层弹窗及未提交草稿保持原状。当前目录与界面行为由[处方、医嘱与药事](../../../architecture/orders-and-pharmacy.md#门诊与住院共享声明式药事安全规则)拥有。

## Alternatives considered

- 导入真实上市药品法定说明书或同步进 Reference Data：引入版权与合规风险，且真实说明书的多适应证分人群条款与仿真有界规则不一致，反而误导开方验证。
- 将 `packageInsert` 写入处方快照、FHIR `MedicationRequest` 或建议输入目录：展示性教学参考不构成临床或计费事实，写入快照和建议输入会放大存储与模型上下文，并让纯文字勘误使既有建议指纹失效。
- 回填摘要时递增 `outpatient_catalog.version` 或将缺失摘要计入 `missingFields`：只读教学文本不改变计价、剂量换算或审方规则，递增版本会导致在途医嘱遇到无意义的 `CATALOG_CONFLICT`，必填化则会阻断未配置摘要的自定义院内药。
- 在每个目录表和行内选择器各自挂载独立抽屉状态：产生重复状态分支并将非开方通用目录表卷入范围，改为由实际开方容器统一持有抽屉目标并通过候选行兄弟动作槽位注入。

## Consequences

22 种常备药与碘海醇注射液在门诊和住院开方链路具备与仿真审方、事中质控、医嘱组套一致的只读参考摘要，后续新增常备药只需在同一合成表中声明并通过规则对齐单测校验。存量环境升级与 PCI 准备重放保持零版本漂移，新 Epoch 安装保持原有 SQL 语句预算。只读摘要始终带有明确合成教学免责声明，不替代真实临床审方或法定药品说明书。
