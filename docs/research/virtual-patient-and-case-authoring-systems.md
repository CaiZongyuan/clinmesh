# 虚拟患者与病例创作系统研究

## 范围与结论

本文研究虚拟患者、临床推理教学和病例创作系统，重点回答 ClinMesh 在开发前必须确定的病例模型、证据揭示、发布边界和运行留痕。结论来自截至 2026 年 8 月 22 日可核验的官方源码、产品文档、规范和项目论文；它们是设计输入，不定义 ClinMesh 当前行为。数据来源与中国本地化边界由[合成医院数据来源研究](./synthetic-hospital-data-sources.md)维护，真实 HIS 页面与岗位交互参考由[HIS UI/UX 参考研究](./his-ui-ux-references.md)维护。

没有一个被核验的项目同时提供中国公立医院业务、结构化病例真值、真实医嘱与结果生命周期、不可变发布和可重放运行。ClinMesh 不应复制某个虚拟患者产品，而应组合几类经过验证的机制：MedBiquitous 对患者数据、揭示规则和活动流程的分层，OLab 的作者图和运行轨迹，ClinicalReasoningTool 对专家推理与学习者推理的分离，以及 CASUS 对低门槛病例创作的强调。

首期最重要的不是评分、复杂分支、协同编辑或 AI 对话，而是让同一份结构化病例能够驱动真实医生闭环：医生在不知道 Hidden Fact 的前提下获取主诉和查体信息，创建诊断与 Clinical Request，等待模拟检验检查返回，签发药品请求并形成病历。作者侧和学习者侧必须在服务端隔离；只在前端隐藏答案不构成边界。

## 项目状态与证据边界

| 系统 | 截至核验日的状态与许可 | 可证明的核心机制 | 对 ClinMesh 的定位 |
| --- | --- | --- | --- |
| MedBiquitous Virtual Patient | VP XML schema 的内容形成于 2008 至 2009 年，仓库在 2014 年 baseline 后未见该部分继续演进；schema 受 MedBiquitous XML Public License 约束，xAPI VP profile 标注 CC BY | `VirtualPatientData`、`DataAvailabilityModel`、`ActivityModel` 分开描述临床内容、何时可见和节点流程；xAPI profile 定义运行事件 | 历史互换标准和分层设计证据，不作为现代运行时合同，也不直接复制其 XML/XPath 模型 |
| OLab 4.5 | API、Common、Designer 和 Player 仓库在 2026 年仍有提交，均为 GPL-3.0 | Map、Node、Link、Question、Counter、媒体、条件和概率；可视图编辑；User Session、Trace、响应和计数器记录；Map ZIP/JSON 导入导出 | 最完整的开源作者图参考；吸收概念，不在未作 GPL 兼容决策前复制代码 |
| OpenLabyrinth v3 / 旧 OLab4 | OpenLabyrinth v3 README 明确停止主开发；旧 OLab4 README 标记为归档且要求勿用 | 证明虚拟患者图模型的历史连续性 | 排除为新实现基础，研究当前 OLab 4.5 而不是同名旧仓库 |
| CASUS | 官方仍作为商业托管产品提供，未公开源码 | 线性卡片为主并支持跳转或决策树、媒体和多种题型、作者反馈、课程与学习分析 | 参考作者体验和课程管理，不推断其内部数据模型，不把它描述为开源项目 |
| ClinicalReasoningTool | MIT；核验 commit 的最后提交为 2023 年，维护活跃度有限 | findings、鉴别诊断、检查和治疗构成带权有向图；专家图与学习者图分开；动作带阶段和时间记录 | 用来证明“病例内容”“推理状态”“运行轨迹”应分开，不作为完整病例工坊 |
| UoaWDCC/VPS | 2026 年仍有提交；顶层未发现许可证，只有子目录存在许可证文件，因此只能称源码公开 | Scene 图、角色可见性、状态变量、条件资源、共享指针和路径回放 | 参考角色揭示、图预览和路径回放；不复用代码，通用 Scene/boolean flag 也不能承担临床真值 |

提交活跃度只说明观察到的维护时间，不代表安全支持或生产成熟度。CASUS 的公开页面宣称可创建、发布、管理和评估病例，但没有公开足够细节来核验不可变版本、发布审批或一次学习运行是否绑定特定病例 revision。OLab 4.5 可以导出完整 Map 包，`Maps` 也有启用、模板和更新时间字段，但在本次源码范围内同样未核验到“发布后不可变且每次运行固定 revision”的完整合同。后文的不可变发布建议来自 ClinMesh 的确定性和审计要求，不是对这些产品能力的转述。

## 相邻项目类型

| 项目或标准 | 已核验能力 | 取舍 |
| --- | --- | --- |
| [Synthea v4.0.0][synthea-release]、[Generic Module Framework][synthea-gmf]与[Module Builder][synthea-builder] | 用疾病状态机、人口模型和种子生成纵向患者历史；Module Builder 辅助编辑模块 | 作为 `PatientProfile/LongitudinalHistory` adapter。固定 R4 artifact 经清洗和中国本地化后转 R5；不负责单病例真值、按请求揭示或 HIS 运行 |
| [CDC CohGenT backend][cohgent] | 版本化 JSON5 use-case、可组合表单、seed 和 event-set timeline 提供了清晰的作者输入体验 | 只参考表单组合与时间线。当前实现面向 R4/US Core，未提供疾病因果模型，核验 commit 也未见顶层许可证或 release tag，因此不建立代码依赖 |
| [AgentClinic][agentclinic] | 医生、患者、检查测量和 moderator 分角色，患者按医生请求提供信息，并保存完整对话 | 参考角色隔离、按请求揭示和 transcript；患者、measurement 与 moderator 均由 LLM 驱动，结果不确定且没有真实 HIS 状态机，不能作为运行内核 |
| [MedAgentBench][medagentbench] | 300 个医生编写的 FHIR EHR 操作任务，使用可重置环境和隐藏 state assertion | 参考版本化 task、固定时钟、reset 和状态断言；HEAD 的写请求、外置 refsol、未固定 `latest` 镜像及任意 URL 工具存在复现、授权与幂等缺口，不复用其工具合同 |
| [EHRGym][ehrgym] | 浏览器中的 provider chart episode，环境暴露 reset、step、state、seed、trace 和 rubric | 是最接近交互式 EHR 训练环境的参考，但项目很新、面向美国 provider chart，不能替代中国 HIS 业务模型 |
| [Pulse 4.3.0][pulse] | 连续人体生理仿真引擎，可为急救和动态生命体征提供时间演化 | 仅保留未来 `RoleSimulator` 或外部生理 adapter seam；门诊首期不接入 |
| FHIR R5 [Questionnaire][fhir-questionnaire]、[PlanDefinition][fhir-plandefinition]与[TestScript][fhir-testscript] | 分别表达结构化采集、可复用动作定义和 FHIR 实现测试步骤或断言 | 各自保持窄用途，均不能成为 canonical Case Blueprint；运行中的诊断、请求和结果仍由实际业务资源与 Command 创建 |

这些项目共同支持的稳定主线是 `CaseTruth -> DisclosurePolicy -> RoleSimulator -> Command/ExternalOperation -> append-only ActionTrace`。LLM 最多把 DisclosurePolicy 已允许的结构化事实口语化，不能生成检查真值、决定是否揭示或直接修改 HIS 状态。Project TACO、`ptgen`、Medplum mock、EMRBots 和个人 faker 只提供固定样例或浅层随机数据，没有病例因果、揭示与运行合同；EHRAgent 面向受限真实数据上的只读 SQL/code 问答。它们均明确排除为病例工坊或 Agent 工具基础，尤其不引入任意 SQL、代码执行或真实数据依赖。

## 可借鉴的系统机制

### MedBiquitous 的三层分离

[`VirtualPatientData`][medbiq-vpd] 把人口学、叙述、药物、问诊、查体、检查、诊断和干预放在患者内容层。[`DataAvailabilityModel`][medbiq-dam] 再把内容或媒体绑定到可用性节点，并区分 `immediately`、`ontrigger`、`delayed` 和 `ifrequested`。[`ActivityModel`][medbiq-am] 才负责节点、链接、计数器、定时器、条件和概率。这一分层比具体 XML 结构更有价值：临床事实不应因为页面顺序或分支图变化而被改写。

MedBiquitous 的 [xAPI VP profile][medbiq-xapi] 还区分 initialized、arrived、responded、interacted、updated、suspended、resumed 和 completed 等事件。它证明运行轨迹不能只保存最终页面或最终诊断，但这些学习事件粒度不足以替代 ClinMesh 的 Command、Effect、FHIR 资源版本和业务审计。

### OLab 的作者图和运行轨迹

OLab 4.5 的 [`Maps`][olab-maps]、[`MapNodes`][olab-nodes] 和 [`MapNodeLinks`][olab-links] 表达图结构；节点支持 private、probability 和 visit-once，链接支持 probability 和 follow-once。[Designer 的 Graph][olab-graph] 把这些关系变成可操作的可视图。问题可包含反馈、响应选项和重定向，运行侧以 [`UserSessions`][olab-sessions]、[`UserSessionTraces`][olab-traces] 和用户响应保存路径与动态状态。Map 的[导出实现][olab-export]会把定义和媒体写入 ZIP。

这些机制适合作者理解“某项证据在什么条件下出现”和预览可能路径，但 OLab 的 Map 不能直接成为 ClinMesh 临床状态机。医生开立检验后发生的是 ServiceRequest、执行 Task、Specimen、Observation 和 DiagnosticReport 的业务变化，不是从一个内容节点跳到另一个内容节点。

### CASUS 的低门槛创作

CASUS 官方将产品描述为病例式多媒体学习与作者系统，支持创建、发布、管理和分析虚拟患者。[教学设计页面][casus-reasoning]说明默认病例沿卡片序列推进，同时可以跳转或使用决策树；[教师页面][casus-teachers]和[学习者页面][casus-students]展示媒体、题型、作者反馈、自由文本、同行反馈、人工点评、课程管理与学习分析等能力。

ClinMesh 值得吸收的是渐进式作者体验：先完成患者、就诊、证据和预览，再按需进入高级条件。CASUS 的卡片播放器不适合替代医生站；临床学习者应在真实 HIS 页面创建诊断、医嘱和病历，而不是在教学卡片中回答“下一步做什么”。

### ClinicalReasoningTool 的双重表示

ClinicalReasoningTool 的[项目论文][crt-paper]和[源码][crt-script]把 findings、鉴别诊断、检查、治疗和它们之间的关系建成临床推理图，并分别保存专家与学习者表示。学习者可以标记 must-not-miss、排除诊断和最终诊断，系统按病例阶段记录动作；其 xAPI 实现也为新增 finding、diagnosis、test 和 management 写入不同动作语义。[最终诊断动作][crt-diagnosis]显示最终提交是学习者状态变化，而不是修改专家病例。

ClinMesh 因此应把作者真值、医生实际创建的 Condition/Clinical Request 和未来评价模型分开。即使首期不评分，也不能把“医生填写的诊断”写回病例真值，或只保留最终病历而丢失中间推理行动。

### VPS 的角色与路径回放

UoaWDCC/VPS 官方 README 将产品定位为 scene-based branching scenario。[Scenario 模型][vps-scenario]保存 Scene、角色和状态变量，[Scene 模型][vps-scene]保存组件、角色可见性、直接链接和计时操作，[Dashboard 图][vps-graph]可以高亮群组已经走过的路径。它适合证明同一场景可按角色揭示不同信息，并且作者需要看到运行路径。

VPS 的通用状态变量和 Scene 适合演示型情景，不足以表达诊断、医嘱签发、标本采集、报告修订、处方和发药等独立生命周期。ClinMesh 可以提供路径投影，但路径必须从运行事件和业务事实派生。

## 病例工坊的基础模型

下列名称是研究建议。已有领域词汇中的 Scenario、Scenario Run 和 Hidden Fact 继续保持原义；发布产物应映射为现有 Scenario，而不是再创造一个与 Scenario 同义的 `Case Release`。

```text
外部生成器或人工素材
        |
        v
Synthetic Patient Profile --> Case Draft --编译与校验--> Scenario（不可变版本）
                                  |                         |
                                  |                         v
                                  |                  Scenario Run
                                  |                         |
                                  +-- Hidden Fact           +-- 业务事实
                                  +-- Evidence Definition   +-- 追加式运行事件
                                  +-- Reveal Policy         +-- 派生路径与未来评分
```

| 概念 | 所有内容 | 可变性与可见性 |
| --- | --- | --- |
| Synthetic Patient Profile | 可复用的合成身份、人口学和纵向临床历史，以及生成器、种子、输入版本和来源 | 作为作者素材独立版本化；不是病例真值，也不直接成为运行中权威数据 |
| Case Draft | 作者正在编辑的患者快照选择、就诊起点、教学目标、真值、证据、揭示策略和模拟器计划 | 可变；只有作者工作区可见，不能启动正式运行 |
| Hidden Fact | 疾病、病程、关键阳性与阴性、风险和其他只有模拟器或 evaluator 可知的结构化事实 | 发布后固定；普通 FHIR、HIS、Agent tool 和学习者接口永不返回 |
| Evidence Definition | 可由患者回答、查体、既往资料、检验、检查或病程变化呈现的结构化证据及其渲染素材 | 必须引用来源事实；尚未满足策略时不能出现在学习者投影 |
| Reveal Policy | 哪类合规动作、业务状态或虚拟时间使某项 Evidence 可用 | 使用类型化条件并在发布时编译；不接受任意脚本、SQL、URL 或 FHIRPath |
| Scenario | 从 Case Draft、患者快照、Hospital Baseline 和 Reference Data Package 编译出的版本固定初始事实与规则 | 不可变；修订产生新版本，旧运行继续绑定旧版本 |
| Scenario Run | 某个参与者在指定 Scenario 和 Workspace/Epoch 中的行动与结果 | 绑定 Scenario 版本、患者快照、seed、虚拟时间和运行环境版本 |
| 运行事件 | 规范化 Command、结果、Effect 引用、虚拟时间、真实接收时间、Actor/Practitioner Role 和版本信息 | 追加式保存；用于回放、过程分析和未来评分，不保存 chain-of-thought |

Synthetic Patient Profile 只回答“这个虚构患者过去发生过什么”。Case Draft 还要回答“本次就诊为什么发生、真实疾病是什么、哪些证据存在、医生做什么后能获得什么、外部系统何时返回”。Synthea 因而只是可替换的历史素材 adapter，不能生成完整病例规则；它的中国本地化、FHIR R4 到 R5 转换和许可边界见[数据来源研究](./synthetic-hospital-data-sources.md#synthea-能力边界)。

病例真值不应只有一个诊断名称。最小结构还需要事实的主体、类型、标准或本地编码、值与单位、发生或有效时间、阳性与明确阴性、来源关系以及与 Evidence Definition 的引用。叙述文本可以由模板或以后由 AI 从这些事实生成，但文本不能反过来成为剂量、检验值、诊断代码或结果时序的权威来源。

## 揭示、分支与医生交互

### 类型化揭示

MedBiquitous 的四种 display 值可以作为起点，但 ClinMesh 需要映射到医院动作，而不是复用通用 trigger。首期可把揭示收窄为以下类型：

| 揭示类型 | 触发条件 | 学习者看到的结果 |
| --- | --- | --- |
| 初始可见 | Scenario Run 激活 | 患者身份、主诉、已有历史和本次就诊初始资料 |
| 问诊后可见 | 学习者提交受控的问诊主题或问题概念 | 患者回答；必要时可供医生写入病历草稿，但不会自动替医生完成文书 |
| 查体后可见 | 学习者执行允许的查体动作 | 对应体征或明确阴性；结构化 Observation 只在业务语义成立时生成 |
| 请求后可见 | 受支持的 Clinical Request 已签发并满足收费、采集或执行前置条件 | 模拟器按真实生命周期创建结果，不直接从 Hidden Fact endpoint 返回答案 |
| 时间或状态后可见 | 虚拟时间到期，或前置业务事实达到指定状态 | 症状变化、延迟结果、回调或并发事件 |
| 仅 evaluator 可见 | 无学习者触发条件 | 诊断真值、未被发现的证据、禁忌和未来评分事实 |

检验检查的揭示尤其不能简化成“点击项目便显示答案”。作者定义的是与医院目录项目绑定的结果计划，包括前置条件、延迟、状态路径、结构化结果、参考范围、报告文本和可选失败。运行时仍通过 ServiceRequest、Task、Specimen、Observation 和 DiagnosticReport 等正常业务对象推进，医生只能在结果真正签发后从医生站看到它。

真实门诊还存在 HIS 之外的信息通道：患者说话和医生查体。为了模拟完整诊断，医生站需要一个明确标识为“患者交互”的辅助工作区，但它不能成为教学问答页。首期宜使用可审计的结构化问诊主题和查体动作；以后可以让 AI 把自由文本映射到这些受控意图并润色回答，但 AI 不决定事实、不绕过 Reveal Policy，也不能看到不相关 Hidden Fact。

### 图是投影，不是真值

OLab 和 VPS 都证明作者需要图预览，但“选择 A 跳到页面 B”的播放器逻辑与真实 HIS 不同。医生应能开立不必要的检查、给出多个鉴别诊断、等待结果或修改病历；这些动作由业务状态机接受或拒绝，而不是由病例图强迫进入唯一正确分支。

病例工坊可以从 Reveal Policy、虚拟时间事件和业务前置条件派生一张只读图，用于检查不可达证据、循环和终止条件。作者图不能直接写 FHIR 状态，不能携带任意脚本，也不能把某条“标准路径”当作唯一可接受的临床过程。未来评分需要支持等价诊疗策略时，这个边界尤其重要。

## 发布、运行与留痕

Case Draft 可以持续编辑和预览；“发布”必须编译出新的不可变 Scenario 版本。一次 Scenario Run 至少固定 Scenario 内容哈希、患者快照、Hospital Baseline、Reference Data Package、schema/compiler、FHIR IG、应用与策略版本、seed 和初始虚拟时间。修改文字、证据数值、揭示条件或目录映射都不能原地改变已经开始的 Run。

发布校验至少覆盖：

- schema、枚举、数值精度、单位、时间和全部引用有效；
- 患者、Encounter、目录项目、Clinical Request 计划和结果资源满足 FHIR R5 profile 与业务不变量；
- 每个 Evidence Definition 都引用存在的事实，每个 Reveal Policy 都有受支持的触发类型和确定结果；
- 学习者包、普通 API、SPA asset、日志和错误信息中不存在 Hidden Fact 泄漏；
- 图投影没有意外不可达证据、无界循环或依赖永远不能满足的状态；
- 固定输入可产生固定 canonical state hash，压缩时间戳等非业务元数据不参与哈希；
- 全部身份和病历均为合成数据，外部参考输入带来源、地域、有效期、哈希和使用条件。

运行事件应从第一天保存，即使评分延后。至少记录规范化 Command、Actor 与其代表的 Practitioner Role、患者与 Encounter、expected version、幂等键、虚拟时间、结果码、Effect 引用、资源版本和随机或外部模拟决策。只保存最终病历无法恢复医生何时查看结果、是否重复开立、是否在结果前用药或如何处理冲突，后续也无法可靠补建这些证据。

## 首期基础设计

首期按“运行合同先于丰富工坊”推进，而不是先实现一个通用病例编辑器：

1. 先定义 Case Draft、Hidden Fact、Evidence Definition、Reveal Policy 和不可变 Scenario 的版本化 schema，并用一个人工审阅的二型糖尿病合成 `golden` 病例走通 compiler。该病例应覆盖纵向历史、慢病检验、本次 Encounter 和诊疗决策，但首版仍保持单次门诊闭环；普通门诊发热可作为第二个病例，验证同一 schema 也适合急性就诊。
2. 让医生在真实工作台完成接诊、问诊或查体、诊断、开立检查、等待结构化结果、开药、病历签署和完诊。诊断进入 Condition/Encounter.diagnosis，检查进入 ServiceRequest 和结果生命周期，药品进入 MedicationRequest/Prescription；不能用教育系统的选择题替代这些业务对象。
3. 首期不交付病例工坊 UI 或患者生成页面。项目维护者通过受版本控制的结构化输入制作并审核 `golden` 病例，以此先稳定 compiler、运行合同和医生闭环；临时表单或直接编辑数据库不能成为隐性作者接口。
4. 第二个病例证明同一合同可复用后，再交付最小病例工坊：病例列表、复制 Synthetic Patient Profile、编辑本次就诊真值与证据、配置少量类型化揭示、校验、发布，以及“以医生身份预览并重置”。Synthea 导入、批量患者生成、图编辑、媒体、作者协作和更丰富的患者对话继续后置。AI 只在结构化事实之后生成可校验叙述或辅助填写。
5. 评分、课程编排、排行榜、多人同步指针、通用考试题型和复杂概率分支后置。评分虽不实现，运行事件、版本绑定和 Hidden Fact 隔离必须首期存在。

病例工坊与医生站应使用两个服务端 capability surface。病例作者可以读取 Draft 真值并执行校验或发布；医生、普通 Agent 和其浏览器只能读取运行投影并提交真实业务 Command。认证产品可以后选，但这个授权边界不能用前端路由或隐藏组件暂时代替。

## 采用与排除项

| 采用 | 排除或延后 |
| --- | --- |
| 患者素材、病例真值、揭示策略、运行状态和事件轨迹分层 | 把 Synthea Bundle、病历长文本或作者流程图当作完整 Scenario |
| 不可变 Scenario、固定依赖版本、Run 绑定和追加式事件 | 在有运行后原地修改病例，或只记录最终答案 |
| 由正常临床 Command 触发结果模拟器 | 通过隐藏 API、页面按钮或教学题直接返回正确结果 |
| 类型化问诊、查体、请求、时间和状态触发 | 任意 JavaScript、SQL、XPath/FHIRPath 或 URL trigger |
| 作者侧图预览和运行路径回放 | 以节点跳转替代诊断、医嘱、检验和病历状态机 |
| 专家真值、医生事实和未来评价模型分离 | 把医生提交的 Condition 写回 Hidden Fact，或预设唯一“正确路径” |
| 小型、可人工审阅的 `golden` 病例先验证合同 | 首期建设完整疾病库、题库、课程 LMS、协同编辑和 AI 自动出题 |
| 依据明确许可证自行实现机制 | 直接复制 GPL 代码，或把无顶层许可证的 VPS 当作可复用开源代码 |

## 固定版本来源

### MedBiquitous

- [仓库说明与 XML Public License 引用][medbiq-readme]
- [VirtualPatientData v1 schema][medbiq-vpd]
- [DataAvailabilityModel v1 schema][medbiq-dam]
- [ActivityModel v1 schema][medbiq-am]
- [Experience API Virtual Patient Profile][medbiq-xapi]

### OLab

- [OLab 4.5 Common][olab-common]、[API][olab-api]、[Designer][olab-designer]和[Player][olab-player]固定 commits
- [Maps][olab-maps]、[MapNodes][olab-nodes]、[MapNodeLinks][olab-links]、[UserSessions][olab-sessions]和[UserSessionTraces][olab-traces]
- [Map ZIP/JSON 导出][olab-export]与[Designer Graph][olab-graph]
- [OpenLabyrinth v3 停止主开发说明][openlabyrinth-readme]与[旧 OLab4 归档说明][olab4-archive]

### 其他系统

- CASUS 官方[产品页][casus-product]、[临床推理设计][casus-reasoning]、[教师功能][casus-teachers]、[学习者功能][casus-students]和[集成说明][casus-integration]
- ClinicalReasoningTool [固定源码][crt-repo]、[MIT License][crt-license]和[项目论文][crt-paper]
- UoaWDCC/VPS [固定源码][vps-repo]、[Scenario 模型][vps-scenario]、[Scene 模型][vps-scene]和[路径图][vps-graph]

### 相邻项目与标准

- Synthea [v4.0.0 release][synthea-release]、[Generic Module Framework][synthea-gmf]和[Module Builder][synthea-builder]
- CDC [CohGenT backend 固定 commit][cohgent]
- [AgentClinic 固定 commit][agentclinic]、[MedAgentBench 固定 commit][medagentbench]与[EHRGym 固定 commit][ehrgym]
- Pulse Physiology Engine [4.3.0 tag][pulse]
- FHIR R5 [Questionnaire][fhir-questionnaire]、[PlanDefinition][fhir-plandefinition]和[TestScript][fhir-testscript]

[medbiq-readme]: https://github.com/medbiq/medbiq/blob/8f5c74a51bf6721fa1f0b57f2d9c4b51496bb566/README.md
[medbiq-vpd]: https://github.com/medbiq/medbiq/blob/8f5c74a51bf6721fa1f0b57f2d9c4b51496bb566/virtualpatientdata/v1/virtualpatientdata.xsd
[medbiq-dam]: https://github.com/medbiq/medbiq/blob/8f5c74a51bf6721fa1f0b57f2d9c4b51496bb566/dataavailabilitymodel/v1/dataavailabilitymodel.xsd
[medbiq-am]: https://github.com/medbiq/medbiq/blob/8f5c74a51bf6721fa1f0b57f2d9c4b51496bb566/activitymodel/v1/activitymodel.xsd
[medbiq-xapi]: https://github.com/medbiq/medbiq/blob/8f5c74a51bf6721fa1f0b57f2d9c4b51496bb566/xapi/xapi-virtualpatient-profile.md
[olab-common]: https://github.com/olab/OLab45-Common/tree/72942ad5376e5b6c850dec97a0bdfe2e95bcba9c
[olab-api]: https://github.com/olab/OLab45-Api/tree/2ce347eb0134f1d4807e2e6db5e20e137d4c726d
[olab-designer]: https://github.com/olab/OLab45-Designer/tree/23b1f223907eaf46f2575e665571f304355edebb
[olab-player]: https://github.com/olab/OLab45-Player/tree/6be9f6ffaeacd10359f71f38d9adb7d6e0e2c3d2
[olab-maps]: https://github.com/olab/OLab45-Common/blob/72942ad5376e5b6c850dec97a0bdfe2e95bcba9c/Data/BusinessObjects/Maps.cs
[olab-nodes]: https://github.com/olab/OLab45-Common/blob/72942ad5376e5b6c850dec97a0bdfe2e95bcba9c/Data/BusinessObjects/MapNodes.cs
[olab-links]: https://github.com/olab/OLab45-Common/blob/72942ad5376e5b6c850dec97a0bdfe2e95bcba9c/Data/BusinessObjects/MapNodeLinks.cs
[olab-sessions]: https://github.com/olab/OLab45-Common/blob/72942ad5376e5b6c850dec97a0bdfe2e95bcba9c/Data/BusinessObjects/UserSessions.cs
[olab-traces]: https://github.com/olab/OLab45-Common/blob/72942ad5376e5b6c850dec97a0bdfe2e95bcba9c/Data/BusinessObjects/UserSessionTraces.cs
[olab-export]: https://github.com/olab/OLab45-Common/blob/72942ad5376e5b6c850dec97a0bdfe2e95bcba9c/Import/OLab4/Export.cs
[olab-graph]: https://github.com/olab/OLab45-Designer/blob/23b1f223907eaf46f2575e665571f304355edebb/src/components/Constructor/Graph/index.jsx
[openlabyrinth-readme]: https://github.com/olab/Open-Labyrinth/blob/3f9d22371a1f8e69f3680d24364db26874eba278/README.md
[olab4-archive]: https://github.com/olab/OLab4/blob/1f1dc90df8f6040ed7ed2ce1f2912054703847cd/README.md
[casus-product]: https://www.instruct.eu/casus/online-lernsystem/produkt
[casus-reasoning]: https://www.instruct.eu/casus/online-lernsystem/clinical-reasoning
[casus-teachers]: https://www.instruct.eu/casus/online-lernsystem/elearning-lms-dozenten
[casus-students]: https://www.instruct.eu/casus/online-lernsystem/fallbasiertes-lernen-studenten
[casus-integration]: https://www.instruct.eu/casus/online-lernsystem/integration-mit-lti-und-shibboleth
[crt-repo]: https://github.com/clinReasonTool/ClinicalReasoningTool/tree/3360327dd0e1e37124b9f50f90716ac8a63a1807
[crt-license]: https://github.com/clinReasonTool/ClinicalReasoningTool/blob/3360327dd0e1e37124b9f50f90716ac8a63a1807/LICENSE
[crt-paper]: https://doi.org/10.2196/mededu.8100
[crt-script]: https://github.com/clinReasonTool/ClinicalReasoningTool/blob/3360327dd0e1e37124b9f50f90716ac8a63a1807/ClinReasonTool/src/java/beans/scripts/PatientIllnessScript.java
[crt-diagnosis]: https://github.com/clinReasonTool/ClinicalReasoningTool/blob/3360327dd0e1e37124b9f50f90716ac8a63a1807/ClinReasonTool/src/java/actions/beanActions/DiagnosisSubmitAction.java
[vps-repo]: https://github.com/UoaWDCC/VPS/tree/df33442b8e670ac1671310ae5c3cb55e846ca14f
[vps-scenario]: https://github.com/UoaWDCC/VPS/blob/df33442b8e670ac1671310ae5c3cb55e846ca14f/backend/src/db/models/scenario.js
[vps-scene]: https://github.com/UoaWDCC/VPS/blob/df33442b8e670ac1671310ae5c3cb55e846ca14f/backend/src/db/models/scene.js
[vps-graph]: https://github.com/UoaWDCC/VPS/blob/df33442b8e670ac1671310ae5c3cb55e846ca14f/frontend/src/features/dashboard/components/ScenarioGraph.jsx
[synthea-release]: https://github.com/synthetichealth/synthea/releases/tag/v4.0.0
[synthea-gmf]: https://github.com/synthetichealth/synthea/wiki/Generic-Module-Framework
[synthea-builder]: https://github.com/synthetichealth/module-builder
[cohgent]: https://github.com/CDCgov/CohGenT-Synthetic-FHIR-Record-Generator-Backend/tree/32e2821c933b81b1250d306bb7f7c78bbf123818
[agentclinic]: https://github.com/SamuelSchmidgall/AgentClinic/tree/b6570edefb940857a7c334350656b29f9d984f24
[medagentbench]: https://github.com/stanfordmlgroup/MedAgentBench/tree/99260117137b09f04837a8c18d18a1107efa55ae
[ehrgym]: https://github.com/adtserapio/ehrgym/tree/5985db28d44e07d6298dbbb5a4ce00daa4c5a95a
[pulse]: https://gitlab.kitware.com/physiology/engine/-/tree/REL_4_3_0
[fhir-questionnaire]: https://hl7.org/fhir/R5/questionnaire.html
[fhir-plandefinition]: https://hl7.org/fhir/R5/plandefinition.html
[fhir-testscript]: https://hl7.org/fhir/R5/testscript.html
