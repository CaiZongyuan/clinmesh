# 合成医院数据来源、病例真值揭示与参考映射研究

本文汇总 ClinMesh 在合成患者生成之外获取与编译诊断、药品、检验、检查影像、服务价格、耗材与组织主数据的分层方法，以及虚拟患者真值隔离（`Case Truth` / `Reveal Policy`）和外部参考标准映射边界。现行存储、仿真与术语合同归 [`storage.md`](../architecture/storage.md)、[`simulation.md`](../architecture/simulation.md) 与 [`fhir-and-commands.md`](../architecture/fhir-and-commands.md)。

## 一、六层离线编译模型与核心原则

中国公立医院仿真不存在可直接整包下载的现成公开数据集；患者纵向病程、国家编码目录、本院启用项目、地方价格、库存批次与病例真值具有不同权威方与许可边界，必须在离线编译期分层组装，运行时与 Epoch reset 只读已安装的不可变快照：

| 层级 | 内容与所有权 | 仓库与许可边界 |
| --- | --- | --- |
| `Source Artifact` | 官方公开标准、已获使用权的本地数据包、固定 commit Synthea 输出或自有作者定义 | 原样只读并记录 SHA-256 与许可；未获再分发授权的原始行不入 Git |
| `Normalized Reference Release` | 保留原编码、名称、版本、有效期与行级 `sourceLocator` 的规范化参考目录 | 领域专用 adapter 导入；不含本院价格、库存或患者事实 |
| `Terminology & ConceptMap` | `system + version + code` 固定绑定及有方向、等价度与审核状态的显式映射 | 区分精确等价、上位近似、一对多与无法映射，严禁按中文名称相似静默替换 |
| `Hospital Baseline Overlay` | 虚构医院、科室病区、人员岗位、本院启用目录、整数分合成价格与库存批次 | 完全合成，固定 `jurisdiction + hospital class + effective date` |
| `Case Truth & Persona` | 患者纵向病史、分阶段检查真值、隐藏诊断及仅含患者自知症状的 `Patient Persona` | 临床角色与 Agent 严禁直读 `Case Truth`；由出口防泄漏与 `Reveal Policy` 保护 |
| `Scenario / Authored Case Pack` | 编译校验通过的不可变病例与初始事实快照 | 跨 Epoch 重放确定性一致；准备病例不产生本院已签发报告、医嘱或费用 |

## 二、各业务域外部数据源与许可边界

- **诊断与手术操作**：参考国家医保疾病诊断/手术操作分类代码与 [GB/T 14396-2016](https://openstd.samr.gov.cn/bzgk/gb/newGbInfo?hcno=8127A7785CA677952F9DA062463CBC41)；Synthea（固定 commit `d9d07a6`，Apache-2.0）仅提供纵向时间骨架，其美国机构、Medicare/Medicaid 理赔与英文姓名在编译期剥离并转为 FHIR R5 `5.0.0`。
- **药品与药事**：[NMPA 药品查询](https://www.nmpa.gov.cn/datasearch/home-index.html)与[国家医保药品分类与代码数据库](https://code.nhsa.gov.cn/search.html?sysflag=1386)（23 位西药码 / 20 位中成药码，网页内部 jqGrid 接口无公开批量重分发许可）区分注册产品、医保编码与本院启用药品；批号、供应商与库存流转完全合成，不把真实企业批准文号与合成库存拼成伪造交易。
- **检验、检查与公开像素窄豁免**：检验结合 [LOINC](https://loinc.org/license/) 与 [UCUM](https://ucum.org/license)（单位换算与维度校验）及 [OpenELIS Global](https://github.com/DIGI-UW/OpenELIS-Global-2/tree/0d22a2101957db7219671bb10c8727103ad06b24) 的面板/标本模型，结果按精确 `Case Truth` 快照或版本化 `Adult Reference Baseline` 确定性生成。真实数据禁令的唯一窄例外是 [影像素材清单](../../imaging-assets/README.md)（TCIA LIDC-IDRI 等）与 [病理切片素材清单](../../pathology-assets/README.md)（NCI IDC TCGA-BRCA）登记的公开许可去标识像素——仓库只提交清单与复核报告，像素本地按清单同步且永不进入模型输入或日志；MIMIC 等真实患者临床病历严禁导入（`forbidden`）。
- **服务价格与医用耗材**：[国家医保局医疗服务价格立项指南](https://www.nhsa.gov.cn/col/col201/index.html)定义项目与计价单位边界而非全国统一价；[NMPA 医疗器械唯一标识（UDI）](https://udi.nmpa.gov.cn/download.html)提供产品标识 ZIP/RSS，本院采用显式标注的合成整数分价目与合成批次。
- **外部开源系统参照边界**：OHDSI CDM/Athena、OpenMRS/OCL（`6a4204c`）、Bahmni（`f6db31d`）与 HAPI FHIR 的软件开源许可证不覆盖其托管的第三方医学术语或种子数据；未知许可一律按 `reference-only` 隔离。

## 三、虚拟患者真值隔离、揭示策略与编译校验

借鉴医学模拟与虚拟病人创作系统（VP Player / Script Concordance / 分支病例模型），高可信 Agent 临床环境必须分离三类事实：
1. **可见来源历史（`Visible Source History`）与患者自述（`Patient Persona`）**：患者只表达自身感知的症状、病程与已知慢病史，不直接说出尚未确诊的本次隐藏诊断（由确定性出口检查拦截诊断词泄漏）。
2. **合规观察触发揭示（`Reveal Policy`）**：隐藏的体征、化验异常、心电/超声所见、放射与病理结论只能通过对应岗位实际执行分诊、检验、检查或会诊 Command 后，转化为不可变 `Investigation Result Snapshot` 与正式 `DiagnosticReport` 暴露给医生与 Agent。
3. **九步确定性编译门禁**：离线编译依次校验原始字节哈希与许可等级 → 保留原码规范化 → 显式 `ConceptMap` 映射 → 生成 `Hospital Baseline` 与 `Case Truth` → R4 至 R5 白名单转换与引用闭合 → 目录编码与单位维度校验 → 年龄/性别/疾病/检验医学一致性校验 → 执行科室与计费映射完整性 → 固定种子双次编译 canonical hash 一致性。
