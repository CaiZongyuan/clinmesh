# Agent Note: 同源专病临床内核与像素暂缓边界

Status: implemented

## Problem

心内科与肾内科慢病专病流程横跨门诊首诊、急查功能检查与生物标志物、住院接诊分床、风险评分、指南核对、医嘱组套预筛、多支冠脉造影与 FFR 生理学决策、围术期水化、双层临床质控门禁、品规级甲乙丙医保结算以及出院后门诊随访。若把评分公式、指南检索、组套禁忌剔除或质控规则分散在前端组件、DSH 页面工具或 CLI 脚本中各自实现，人类工作台、DSH Surface 与 Agent CLI 将出现不一致的临床结论或越权空洞；同时 DSH browser Tool broker 严格限制单次注册不超过 32 个 Tool，门诊“检验检查”栏目已达 31 个 Tool，且客户端单文件包 `apps/dsh-web/lib/client.js` 受 5,500,000 字节硬上限约束（[DSH 客户端语法压缩与体积预算](../testing/2026-11-13-dsh-client-syntax-compaction.md)）。此外，心电图波形、超声心动图动态切面与冠脉造影电影序列缺乏像放射 DICOM 或乳腺 H&E 切片那样已完成公开许可核验、去标识与报告逐项核对的真实像素资产链，若强行伪造合成波形／造影图像或依赖多模态模型看图判读，既破坏确定性验收，也会引入未经核实的医学视觉信号。

## Decision

1. **三端同源的确定性专病临床内核与零模型强耦合边界**：
   - 将生命体征与 `Clinical Risk Assessment`、`Clinical Score`（CKD-EPI 2021 eGFR、Cockcroft-Gault CrCl、GRACE、TIMI UA/NSTEMI、PRECISE-DAPT、ASCVD 风险分层与 LDL-C 目标值）、确定性 `Guideline Topic` 原文与患者客观指标对照、`Order Set Template` 个体化预筛、双层事中临床质控（不可越权的药事安全红线与可审计留痕的 `Clinical Quality Alert` / `Clinical Override`）、品规级甲／乙／丙医保结算以及五例 `Authored Case Pack` 统一收敛在 `@clinmesh/contracts`、`@clinmesh/core` 与 `@clinmesh/server` 共享业务服务及 `CommandExecutor` 内。
   - Web 工作台、DSH React Surface 与 Agent CLI／`Agent Capability Grant` 全部消费同一套 HTTP／Operation 合同，不在客户端复制评分、禁忌、质控或结算公式；未配置外部 AI Provider 时，五例专病全链路（含模板 `Patient Persona`、分阶段 `Case Truth` 解析、结构化检查检验、造影生理学报告、质控拦截与越权留痕、医保结算及院后随访）均以零模型调用确定性运行，且所有公开 DTO、Page Context、DSH Tool 结果、CLI 输出、历史接口与医患对话载荷保持零 `Case Truth` 泄漏。

2. **`hisOperationCatalog` 收口与 DSH 多栏目窄只读工具预算**：
   - 在 `hisOperationCatalog` 正式登记住院冠脉造影报告只读查询 `inpatient.angiography-reports.read`（`clinmesh inpatient angiography-reports`）以及专病病例包管理操作 `admin.authored-case-pack.read`（`clinmesh admin authored-case-pack get`）与 `admin.authored-case-pack.prepare`（`clinmesh admin authored-case-pack prepare`，通过 `commandOperationAliases` 统一映射持久回执名 `synthetic-case.authored-pack.prepare`），使管理员页面持久写意图恢复与 Agent CLI 共享同一 `command.receipt.get` 回执链。
   - 将 `AgentToolDefinition` 从单栏目 `section` 扩展为多栏目数组 `sections`，在严格维持每个岗位、视图与栏目／阶段总注册数 `<= 32` 且不改动 `apps/dsh-web/src/compact-client.ts` 压缩语义的前提下：门诊专病只读工具（`outpatient.clinical-scores.read`、`outpatient.guideline-topics.read`、`outpatient.clinical-quality.read`、`outpatient.order-set-drafts.read`）仅挂载于 `diagnosis`、`prescription`（质控另含 `record`）决策栏目并经 `/api/agent/v1/doctor-queries` 核验责任医生与任务锚点，保持 `laboratory` 栏目稳定在 `31 / 32`；住院端保持零新增 DSH 写工具，仅按阶段（含病案 `record` 环节只读浏览）挂载 `inpatient.angiography-reports.read`、`inpatient.clinical-scores.read`、`inpatient.guideline-topics.read`、`inpatient.clinical-quality.read` 与 `inpatient.order-set-drafts.read` 窄只读查询；检验、功能检查与影像报告已阅提案均绑定当前住院、申请与报告版本交由医生行内确认，含 `studyId` 的放射影像报告额外要求实际帧显示证明。`isDoctorReadOperation` 保持纯函数体内自包含字面量比较，兼容 `verify-artifact.ts` 的独立 VM 沙箱校验。

3. **功能检查与冠脉造影的像素暂缓边界**：
   - 与拥有独立公开许可清单和离线像素包的 `Imaging Asset`（放射平片／CT）及 `Slide Asset`（乳腺病理 H&E 切片）明确区分：常规十二导联心电图、经胸超声心动图（`Functional Examination`）及诊断性冠脉造影（`88.5500/88.5600`）暂缓引入心电波形图、超声动态／静态图像或冠脉造影 DICOM 电影像素。
   - 心肾专病决策所需的全部客观依据通过受校验的结构化定量指标与正式报告结论表达：ECG 报告承载心律、心室率、间期与分导联组 ST-T 偏移，TTE 报告承载 LVEF、左室内径、室壁运动与瓣膜／舒张功能，冠脉造影报告承载多支节段狭窄比例、TIMI 血流、`FFR`/`iFR` 功能学阈值与可选支架选型 QCA 测量。临床评分（如首份已签发 ECG 优先判定 ST 段偏移）、PCI 血运重建门禁（如临界病变 `FFR > 0.80` 触发 `409 PCI_NON_ISCHEMIC_LESION` 拦截）与人类／Agent 审阅均建立在该结构化报告事实之上，不创建 `ImagingStudy` 像素块，也不把多模态看图作为临床闭环前置依赖。未来若引入真实心电波形或造影影像，须另行建立与 `imaging-assets` 同等级的公开授权、去标识、哈希锁定与报告核对清单。

## Alternatives considered

- **在 DSH Surface 新增专病评分录入、住院医嘱套用或临床越权直写 Tool**：会突破住院端“仅保留阶段导航、报告已阅／医嘱校对提案与窄只读查询”的人工审阅边界，同时挤压 32 Tool 上限与 `lib/client.js` 产物体积预算；保留正式写命令在工作台与受控单岗位 CLI Grant 中执行更安全且职责清晰。
- **把门诊专病只读 Tool 设为跨栏目全局发布**：会使原本已达 31 个 Tool 的 `laboratory` 栏目直接突破 DSH broker 的 32 Tool 硬上限；改为 `sections` 多栏目精确挂载后，决策栏目按需获得完整专病读取能力而 `laboratory` 保持 31 个 Tool。
- **程序化合成心电波形 SVG／超声伪图或未核验的冠脉造影样例图**：伪造医学波形与造影图像容易出现导联形态、血流时相与文字结论不一致的失真风险，且对确定性临床评分与 FFR 血运重建决策并无额外领域增益，因此明确采用无像素结构化定量报告边界。

## Consequences

- 人类工作台、DSH Surface 与 Agent CLI 在五例代表性心肾专病全链路（NSTEMI 急诊转住院血运重建与随访、择期缺血性 LAD 单支架 PCI、临界病变阴性 FFR 拦截转保守 GDMT、CKD G3b 围术期水化护肾 PCI、2 型糖尿病合并 CKD G4 红线拦截与甲乙丙混合处方结算）上共享完全一致的领域规则、审计链与回执恢复语义。
- DSH 全角色全栏目／阶段 Tool 数量保持 `<= 32`，`apps/dsh-web/lib/client.js` 保持在 5,500,000 字节上限内，且不依赖外部模型即可完成端到端回归验收。
- 当前词汇归 [领域词汇](../../../../CONTEXT.md)，Agent 能力与目录边界归 [Agent 集成](../../../architecture/agent-integration.md)与 [DSH 页面操作](../../../agent-capabilities.md)，临床与仿真规则归 [临床决策支持与质控](../../../architecture/clinical-decision-support.md)、[检验、检查与报告](../../../architecture/examinations-and-reports.md)与 [仿真、病例与素材](../../../architecture/simulation.md)。
