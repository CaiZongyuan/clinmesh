# HIS UI/UX 一手参考与 ClinMesh 原型建议

## 研究范围与结论

本文研究成熟医疗系统如何组织岗位页面、患者上下文、工作队列、临床录入、收费、药房、检验和异常恢复，为 ClinMesh 后续设计评审提供参考。研究结论不定义 ClinMesh 当前产品行为；正式范围、领域状态和实施顺序仍以[系统架构](../architecture.md)、[领域词汇](../../CONTEXT.md)及获批 issue 为准。

证据来自截至 2026-08-22 核验的一手源码、官方文档和官方演示入口。固定版本包括 OpenHIS `2.0.5`（commit `af34ab973eb4550e785df2f669481a597516d4eb`）、Medplum `5.1.30` 本地快照（commit `e3ab98e55feab99013133e6e3bd92b147cb74d73`）、OpenMRS O3 文档（commit `ca2a84b42a919e534dc2d3e5ed522cacd509b10d`）、Bahmni Apps（commit `b565d1cd3d956e2f24e39dc033b36c5d31e71b04`）和 Bahmni Lab（commit `4e87e4a6b26a1d82be1ef0772b746b2fad8b6d7e`）。官方在线文档可能继续变化，固定源码链接用于保留本研究的证据边界。

核心结论是：成熟 HIS 的必要复杂度主要来自跨岗位状态、并发写入、失败恢复、权限、审计和高吞吐队列，不来自一级菜单数量。ClinMesh 近期应保留当前原型的清晰导航，并按角色选择信息骨架：医生从患者病历和本次就诊进入临床动作，批处理岗位从工作队列进入单个任务；不应先复刻 OpenHIS 的完整菜单、宽表、地方协议和细碎页签。

医生工作台建议以原型方案 B“患者病历优先”为桌面基线，吸收方案 A 的紧凑候诊入口和 OpenMRS O3 的侧边工作区：稳定患者横幅下以纵向病历和本次就诊为主画布，队列收进可展开侧栏，医嘱、表单或任务在就近工作区打开。这样既适合单病例诊断教学，也不妨碍以后连续接诊。方案 C 的流程阶段视图适合监督、教学回放和异常定位，不适合作为医生诊疗的默认界面。移动端不缩放这套布局，而只承载核验、扫码、单次执行、告警确认和轻量记录。

## 来源矩阵

| 系统 | 一手证据 | 最有价值的参考 | 证据边界 |
| --- | --- | --- | --- |
| OpenHIS 2.0.5 | 本地只读源码 `references/openhis-itai-pro/`；[门诊医生站][openhis-doctor]、[住院护士站页签配置][openhis-nurse]、[门诊发药][openhis-dispense]、[收费结算][openhis-settlement]、[LIS/PACS 补传][openhis-resend] | 中国医院岗位链路、队列密度、处方和收费状态、半成功恢复、批次与追溯 | 业务覆盖广，但大量地方医保、银联、票据、院点配置和桌面客户端属于部署历史，不代表 ClinMesh 近期范围 |
| OpenMRS O3 | [Workspace][o3-workspace]、[患者图表配置][o3-chart]、[Service Queues][o3-queues]、[病区管理][o3-ward]、[错误处理][o3-errors]、[加载状态][o3-loading] | 稳定患者横幅、模块化患者图表、桌面侧栏工作区、移动覆盖层、可配置队列和清晰加载反馈 | O3 是可扩展平台，不提供完整中国收费、药房和 LIS；UUID、extension slot 和微前端配置不应暴露给终端用户 |
| Bahmni | [Patient Registration 2.0][bahmni-registration-v2]、[Patient Dashboard 2.0][bahmni-dashboard-v2]、[患者上下文源码][bahmni-patient-context]、[订单履行][bahmni-order-fulfillment]、[床位视图][bahmni-bed]、[待处理检验单][bahmni-lab-pending] | 从挂号、临床、住院、药房到检验的岗位链路，低资源环境中的任务聚焦和班次工作 | 旧版 AngularJS 页面、任意 SQL/JavaScript 配置、OpenERP/Odoo 跳转和二次登录是历史包袱；旧文档只作为工作流证据 |
| OpenELIS Global | 官方[结果录入][openelis-entry]、[结果审核][openelis-validation]和标为 Provisional 的[工作网格样式][openelis-grid] | 按检验号、患者、科室和日期批量定位，结果范围、异常标识、复测退回、内部与临床可见备注 | 高密度和百行批处理只适合实验室工作台；Provisional 样式不能作为稳定产品合同 |
| Medplum | [Encounter 主从页][medplum-encounters]、[就诊 Chart][medplum-chart]、[Task Board][medplum-tasks]、[检验进度][medplum-labs]、[并发更新][medplum-updates]、[访问策略][medplum-access]、[资源历史][medplum-history] | FHIR 上下文、任务与就诊分离、预期版本、审计历史、签名和锁定的独立建模 | Medplum 是 headless FHIR 平台，Provider 示例偏美国门诊；保险、电子处方供应商和通用资源编辑器不是中国综合医院模板 |

这些系统各自只回答问题的一部分。推荐组合是 OpenMRS O3 的壳层、患者上下文和工作区，OpenHIS 的中国岗位状态与异常恢复，Bahmni 的全院流程视角，OpenELIS 的检验高吞吐模式，以及 Medplum 的任务、权限、版本冲突和历史模型。

## 页面、角色与工作流参考

| 角色与页面 | 主要工作流 | 应保持同屏的信息 | ClinMesh 可吸收的模式 | 一手来源 |
| --- | --- | --- | --- | --- |
| 挂号员：患者检索与挂号 | 先查找现有患者，再确认身份、就诊类型、科室或号源并入队 | 患者标识、姓名、性别、年龄、联系方式摘要、重复候选、本次就诊去向 | “先查重再新建”；人口学信息与本次就诊信息分步但连续提交；提交后直接进入下游队列 | [Bahmni Patient Registration 2.0][bahmni-registration-v2]、[挂号检索源码][bahmni-registration] |
| 分诊护士：候诊队列 | 查看等待患者，记录生命体征和主诉，设置优先级，送入医生队列 | 队列号、等待时长、来源、优先级、当前状态、下一动作 | 高密度可扫描表格；常用动作行内呈现，低频动作进入菜单；状态和紧急度不用颜色单独表达 | [O3 Service Queues][o3-queues] |
| 门诊医生：医生站 | 在待诊、在诊和复诊队列间选择患者，接诊，记录病历和诊断，开立请求，查看结果并完诊 | 固定患者身份与风险、本次就诊状态、未保存状态、病历、诊断、请求、结果、费用或下游状态摘要 | 左队列、中患者图表、右任务工作区；切换患者或上下文前保护未保存内容；临床写入前确认已接诊 | [OpenHIS 医生站][openhis-doctor]、[患者信息条][openhis-patient]、[O3 Workspace][o3-workspace]、[Medplum Encounter][medplum-chart] |
| 住院护士：班次任务与执行 | 按班次处理校对、给药、治疗、护理记录和未执行任务，记录完成或跳过原因 | 患者和床位、计划时间、医嘱类型、紧急标签、执行状态、异常原因 | “班次时间轴或任务队列 + 右侧执行面板”；给药与非给药任务统一呈现；不执行必须留下结构化理由 | [OpenHIS 护士站配置][openhis-nurse]、[Bahmni IPD Dashboard][bahmni-ipd]、[Bahmni 给药任务][bahmni-medication-tasks] |
| 收费员：待收费与结算 | 选择患者或账单，核对费用来源，预结算，收款，落账，处理失败、退款或结果未知 | 费用来源、勾选快照、应收与实收、支付渠道、每阶段状态、原交易引用、可恢复动作 | 预结算后冻结本次费用快照；支付和院内落账分阶段；外部已扣款但本地未知时锁定重复付款并提供查询或补结算 | [OpenHIS 结算对话框][openhis-settlement]、[Medplum 并发更新][medplum-updates] |
| 药师：处方审核与发药 | 从待发队列进入患者处方，核对请求，配药，选择批次与追溯码，发药或恢复失败 | 处方状态、患者风险、药品和用法、库存地点、批号、效期、追溯码、配药与发药状态 | “待发/已发队列 + 处方明细”；配药和发药分开；部分发药、多批次和重试不能折叠成一个完成按钮 | [OpenHIS 门诊发药][openhis-dispense]、[Bahmni Pharmacy][bahmni-pharmacy] |
| 检验技师：样本与结果工作台 | 接收申请，采集或接收样本，生成检验号，录入结果，审核，退回复测，发布报告 | 样本和检验号、申请项目、当前环节、正常范围、异常标识、录入人、审核人、退回原因 | 队列以样本或检验单为主，患者作为稳定上下文；录入与审核分岗；退回是可追踪状态；高吞吐页面可提供受控批量保存 | [Bahmni Lab][bahmni-lab-doc]、[OpenELIS 录入][openelis-entry]、[OpenELIS 审核][openelis-validation] |
| 接口运维或模拟器：异常中心 | 查看未对码、发送失败、重复回调和结果未知记录，单条或批量恢复 | 业务对象、外部关联号、失败阶段、次数、最后时间、具体原因、幂等键、当前责任方 | 将失败作为工作队列，不只弹 toast；明确“可重试”“先查询”“需人工修复”“已完成但待落账” | [OpenHIS LIS/PACS 对码][openhis-mapping]、[补传工作台][openhis-resend] |
| 临床人员：患者纵向图表 | 在患者级历史和本次就诊之间切换，查看文书、诊断、用药、检验和任务 | 稳定患者横幅、当前就诊、历史时间线、签名或锁定状态、变更历史 | 患者级摘要和就诊级任务分层；签名、锁定、补记和修订分别建模；空页签可禁用，不通过隐藏制造导航跳变 | [O3 患者图表][o3-chart]、[Medplum Charting][medplum-charting]、[资源历史][medplum-history] |
| 监督者或 evaluator：全院流程 | 查看当前阶段、责任岗位、等待时长、交接历史和异常阻塞 | 跨岗位流程、业务时间线、审计、外部脚本状态、Workspace、Epoch 和虚拟时间 | 保留当前原型的流程阶段视图，但定位为观察与教学页面，不取代岗位工作台 | [O3 队列][o3-queues]、[Medplum Tasks][medplum-task-doc] |

患者流转队列和工作事项不能混为一个实体。前者表示某次就诊等待哪个服务点，后者表示某个 Actor 或岗位需要完成的工作；它们可以互相引用，但拥有不同状态、筛选和完成条件。

## 横切页面模式

### 患者上下文

患者身份必须在所有患者级写页面持续可见，至少包含姓名、稳定患者标识、性别和年龄、本次就诊号、科室或位置、就诊状态和关键风险。费用性质、隔离、过敏、孕产或高风险标识只在业务成立时显示。切换患者要有明显视觉变化；有未保存内容时必须先保存、放弃或取消切换。OpenHIS 的固定患者条、O3 Patient Banner 和 Bahmni patient context 都支持这一方向。[OpenHIS 患者信息条][openhis-patient] [O3 患者图表][o3-chart] [Bahmni 患者上下文][bahmni-patient-context]

### 队列与信息密度

队列首页优先回答“谁在等、等了多久、为什么优先、现在由谁做什么”，患者详情再回答完整历史。桌面表格可固定关键列和表头，行内只放一个主动作，其余进入菜单。批量勾选只给真实批处理岗位，例如护士执行、药房配药、收费和 LIS 审核；医生病历不因“成熟 HIS 看起来很密”而加入无业务依据的批量操作。[O3 Service Queues][o3-queues] [OpenELIS 工作网格][openelis-grid]

### 写入、并发与半成功

每个有副作用的动作至少要能表达 `idle`、`submitting`、`succeeded`、`failed`、`stale` 和 `ambiguous`。`stale` 表示记录已被另一个岗位或请求推进，应说明被改变的业务事实并重新加载；`ambiguous` 表示外部动作可能已发生，必须先查询或对账，不能盲目重试。按钮防重复提交只能解决本页连点，不能替代幂等键和 expected version。[OpenHIS 跨岗位 stale 错误][openhis-stale] [Medplum 并发更新][medplum-updates] [FHIR R5 HTTP][fhir-http]

初次加载和后台刷新要分开：没有内容时使用匹配最终布局的 skeleton，已有内容刷新时保留旧数据并显示局部加载状态。错误反馈应带可行动的标题和原因，成功提示只能在服务端确认成功后出现。[O3 错误处理][o3-errors] [O3 加载状态][o3-loading]

### 权限与审计

后端能力和状态机拥有授权结论，UI 只负责解释。页面应区分“当前岗位不可见”“可以看但不能写”“当前就诊状态不允许”“需要更高授权”以及“记录已签署或锁定”，并给出下一步；只隐藏按钮会让操作者无法判断是权限、状态还是系统错误。高风险临床、收费和库存记录应提供人可读的操作者、时间和变更差异，原始 JSON 仅作为高级入口。[Medplum AccessPolicy][medplum-access] [Medplum 资源历史][medplum-history]

## ClinMesh 采用与拒绝项

| 复杂度 | 近期采用 | 延后或拒绝 |
| --- | --- | --- |
| 岗位队列 | 建立共享 Queue/Task 查询模型，各工作台配置筛选、列和受控动作 | 不让每个页面各自拼一份患者列表，不允许 UI 配置携带任意 SQL |
| 患者与就诊上下文 | 固定患者横幅、当前就诊、风险和状态；切患者保护未保存内容 | 不把 Patient、Registration、Encounter 和 Queue Task 压成一个“患者状态”字段 |
| 业务动作 | 通过共享 Command 暴露可执行动作、预期版本、幂等、审计和结构化失败 | 不从 UI 连续调用通用 CRUD 自行编排签发、收费、发药和退款 |
| 异常恢复 | 每个纵向切片同时设计 stale、forbidden、failed；收费和外部操作还设计 ambiguous 与查询恢复 | 不把错误统一成 toast，不把超时自动等同于失败并直接重试 |
| 权限 | 由服务端 capability 决定，UI 展示原因和申请或切换路径 | 不以菜单路由、组件隐藏或客户端角色变量作为唯一授权 |
| 临床图表 | 使用稳定患者摘要、就诊级文书和任务工作区；表单按真实场景增量增加 | 不先建通用 FHIR 资源编辑器、全专科模板市场或 O3 式微前端配置平台 |
| 收费 | 吸收预结算快照、分阶段支付、原交易引用和半成功恢复 | 不实现真实银联、医保、财政票据和地区协议，不复制 OpenHIS 地方适配 UI |
| 药房 | 吸收处方队列、审核、配药、批次、追溯和部分发药语义 | 不跳转第二套 ERP，不复制完整采购、供应商和财务库存系统 |
| LIS | 近期只用确定性模拟器闭合检验申请与结果回传，并提供失败或补传观察面 | 不建设完整 LIS、设备连接、质控和百行批量工作站；OpenELIS 密度只作为后期专项参考 |
| 住院 | 保留状态和接口边界，门诊闭环稳定后再做床位、长期医嘱和护士班次任务 | 不因参考系统功能完整而提前铺开住院、病案、手术、输血和 ICU 菜单 |
| 配置能力 | 只为确定存在院点差异的列、标签和工作流使用窄、类型化配置 | 不复制任意 JavaScript validator、硬编码 URL、数据库 view 或 extension-slot 拼装 |

近期复杂度预算应优先给业务正确性。一个页面只有在对应状态、失败、恢复和权限都可测试时才算完成；增加菜单和表单字段不等于增加可用能力。

## 桌面端 UX 建议

桌面工作台使用安静、高密度但可扫描的布局。宽屏医生站建议采用约 `14-17rem / minmax(34rem, 1fr) / 18-22rem` 的队列、主任务区和辅助工作区三栏；中等宽度保留队列与主区，将右侧工作区改为可关闭侧栏。固定患者横幅位于全局壳层之下、业务页签之上，不随主内容滚动消失。

左栏只承担搜索、筛选、队列状态和患者选择；中间区拥有本次就诊的病历、诊断、请求和结果；右侧区用于当前动作、患者摘要、任务或冲突处理，不再嵌套第二层导航。主动作靠近其修改的数据，并在固定页脚或局部操作区保持位置稳定；全局顶部不堆放每个模块的写按钮。

医生站采用方案 A 的连续接诊效率，同时把方案 B 的纵向病历放进中间主区。方案 C 的阶段完成条件只在全院流程、首次教学或异常解释中出现。护士、收费、药房和 LIS 采用各自的队列加详情模式，不强求同一套三栏比例。

高频表格使用稳定列宽、sticky header、可见焦点和键盘顺序；默认密度应同时验证 3、30 和岗位合理上限的合成记录，以及长姓名、长药名、多费用、多个风险标签和失败原因。只有 LIS、收费和药房等明确批处理页面提供跨行选择；所有批量动作先显示范围和不可处理项。

## 移动端 UX 建议

移动端首期定位为岗位伴随工具，不是桌面 HIS 的完整替代。建议首屏只提供“我的队列或任务、扫码、告警、当前患者”三至四个入口；一次只处理一个患者和一个动作，稳定患者条常驻顶部，更多身份与风险信息通过 sheet 展开。

首期适合移动端的能力包括查看队列、患者身份核验、腕带或药品扫码、单次给药或采集确认、告警确认、拍照或轻量护理记录。完整病历编辑、复杂开嘱、收费预结算、LIS 对码、批量发药、批量结果审核和冲突合并保留桌面端。

桌面宽表不能通过横向缩放移植到手机。移动列表应改为按优先级排序的行或紧凑条目，点入全屏任务；主动作固定在安全区域上方，危险动作需要明确对象和后果。网络不可用或服务端不可达时持续显示连接状态；首期不支持离线高风险写入，也不把本地“已点击”显示成业务成功。

## 第二轮原型建议

第二轮原型不扩展完整功能树，而用更真实的数据密度和失败路径验证下列问题：

1. 医生站只保留一个混合方案：方案 B 的患者纵向图表作为主画布、方案 A 的队列作为可展开侧栏、O3 式工作区承载当前动作。验证单病例深度诊疗与连续切换初诊、复诊和待完诊患者时，患者身份、未保存状态和当前动作是否始终清晰。
2. 把当前单患者队列扩展为 30 名合成患者，包含同名、长姓名、不同优先级、超时等待、已被其他医生接诊和状态刚刚变化的记录。验证搜索、筛选、行高、状态表达和刷新不跳动。
3. 为每个岗位增加一个可恢复异常，而不是增加新模块：挂号重复患者、分诊高风险升级、医生 expected-version 冲突、收费支付结果未知、LIS 拒绝或延迟、药房已配药但发药失败。
4. 收费原型拆成“待收费列表 -> 费用核对与预结算 -> 支付与落账 -> 结果未知恢复”，明确已扣款时不能再次扫码支付。
5. 药房原型拆成“待发处方 -> 审核 -> 配药与批次 -> 追溯码 -> 发药”，展示部分发药、库存不足和按已配药状态重试。
6. 增加移动伴随原型，只实现患者核验、扫码和单次执行；使用同一业务状态，不复制一套移动端状态机。

第二轮原型的评审产物应是页面信息架构、状态词汇、动作位置和异常恢复选择，不是可复用的生产组件。正式实现仍按[Agent 工程开发](../agent-development.md)形成批准 spec，以测试驱动重写，并让 Web、Desktop 和 Agent tools 调用同一 Command 模块。

## 实施切片建议

[系统架构的分期实施](../architecture.md#15-分期实施)拥有技术与领域顺序。对应到 UI，可按以下可独立演示的纵向结果交付：

| 切片 | 可观察结果 | 必须同时覆盖的 UX 状态 |
| --- | --- | --- |
| 最小正式骨架 | 登录后选择 Workspace、岗位和地点，检索或选择合成患者，创建门诊就诊并进入共享队列 | 加载、空队列、重复患者、无权限、重复提交、版本冲突 |
| 门诊医生闭环 | 医生从队列接诊，记录诊断和请求，查看脚本化结果，签发处方并完诊 | 未接诊禁止写、未保存保护、过敏阻断、stale、签发后只读或修订 |
| 门诊收费 | 收费员从费用队列核对来源，预结算、收款、落账和退款 | 金额变化、支付拒绝、重复请求、外部结果未知、查询或补结算 |
| 门诊药房 | 药师从处方队列审核、配药、选择批次并完成可追溯发药 | 库存不足、部分发药、多批次、重复发药、配药后失败恢复 |
| 门诊闭环验收 | 挂号、分诊、医生、收费、模拟 LIS 和药房在同一 Epoch 中完成发热场景 | 跨岗位刷新、晚到回调、审计时间线、30 人密度、桌面与移动核验入口 |
| 后续住院切片 | 门诊闭环稳定后，再交付入科分床、长期医嘱、护士校对和执行 | 床位冲突、班次交接、跳过原因、停嘱校对和执行追踪 |

每个切片应共享同一服务端状态、Command 和审计事实，并从一开始覆盖它特有的失败与恢复。移动入口在相应桌面动作和接口稳定后加入，不单独创造一条业务流程。

## 官方可视入口

| 入口 | 适合观察 | 注意事项 |
| --- | --- | --- |
| [OpenMRS 官方 Demo][openmrs-demo] | Patient Banner、患者图表、Service Queues、侧边 workspace、响应式切换 | 官方 Demo 数据和配置会变化，具体行为以固定源码与文档为准 |
| [Bahmni 官方 Demo 说明][bahmni-demo] | 挂号、临床、住院、实验室和 ERP 之间的岗位跳转 | latest 环境用于开发或 QA；登录信息以官方页面当前说明为准 |
| [OpenELIS Global Demo][openelis-demo] | 检验工作队列、结果录入、审核和报告 | 只用于 LIS 专项，不推导综合 HIS 导航 |
| [Medplum Provider][medplum-provider]与[组件 Storybook][medplum-storybook] | 患者摘要、主从列表、任务详情、组件空态和加载态 | Provider 是示例应用，不是中国医院成品流程 |

观察这些入口时应记录完成一次真实任务需要保留的上下文、患者切换和未保存保护、失败后的恢复入口、桌面与移动的结构变化，而不是按截图复制配色、菜单和字段数量。

[openhis-doctor]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/views/outpatient/doctor-station/index.vue
[openhis-nurse]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/views/inpatient/nurse-station/workbench-tab.config.ts
[openhis-dispense]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/views/outpatient/dispense/index.vue
[openhis-settlement]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/views/outpatient/charge/charge/settlement-dialog.vue
[openhis-resend]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/views/basic/lis-pacs-resend/index.vue
[openhis-patient]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/components/outpatient/patient-info-bar.vue
[openhis-mapping]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/views/basic/lis-pacs-item-mapping/index.vue
[openhis-stale]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/utils/http/stale-cross-role-error.ts
[o3-workspace]: https://github.com/openmrs/openmrs-contrib-o3-docs/blob/ca2a84b42a919e534dc2d3e5ed522cacd509b10d/content/en-US/docs/workspaces/index.mdx
[o3-chart]: https://github.com/openmrs/openmrs-contrib-o3-docs/blob/ca2a84b42a919e534dc2d3e5ed522cacd509b10d/content/en-US/docs/configure-o3/configure-the-patient-chart.mdx
[o3-queues]: https://github.com/openmrs/openmrs-contrib-o3-docs/blob/ca2a84b42a919e534dc2d3e5ed522cacd509b10d/content/en-US/docs/configure-o3/configure-service-queues.mdx
[o3-ward]: https://github.com/openmrs/openmrs-contrib-o3-docs/blob/ca2a84b42a919e534dc2d3e5ed522cacd509b10d/content/en-US/docs/configure-o3/configure-ward-management.mdx
[o3-errors]: https://github.com/openmrs/openmrs-contrib-o3-docs/blob/ca2a84b42a919e534dc2d3e5ed522cacd509b10d/content/en-US/docs/coding-conventions/error-handling.mdx
[o3-loading]: https://github.com/openmrs/openmrs-contrib-o3-docs/blob/ca2a84b42a919e534dc2d3e5ed522cacd509b10d/content/en-US/docs/coding-conventions/loading-states.mdx
[bahmni-patient-context]: https://github.com/Bahmni/openmrs-module-bahmniapps/blob/b565d1cd3d956e2f24e39dc033b36c5d31e71b04/ui/app/clinical/displaycontrols/patientContext/views/patientContext.html
[bahmni-registration-v2]: https://bahmni.atlassian.net/wiki/spaces/BAH/pages/5442240513/Patient+Registration+2.0
[bahmni-dashboard-v2]: https://bahmni.atlassian.net/wiki/spaces/BAH/pages/5442240665/Patient+Dashboard+2.0
[bahmni-order-fulfillment]: https://github.com/Bahmni/openmrs-module-bahmniapps/blob/b565d1cd3d956e2f24e39dc033b36c5d31e71b04/ui/app/orders/views/orderFulfillment.html
[bahmni-bed]: https://github.com/Bahmni/openmrs-module-bahmniapps/blob/b565d1cd3d956e2f24e39dc033b36c5d31e71b04/ui/app/bedmanagement/views/ward.html
[bahmni-lab-pending]: https://github.com/Bahmni/bahmni-lab-frontend/blob/4e87e4a6b26a1d82be1ef0772b746b2fad8b6d7e/src/patient-lab-dashboard/table/pending-lab-orders/pending-lab-orders.tsx
[bahmni-registration]: https://github.com/Bahmni/openmrs-module-bahmniapps/blob/b565d1cd3d956e2f24e39dc033b36c5d31e71b04/ui/app/registration/views/search.html
[bahmni-ipd]: https://bahmni.atlassian.net/wiki/spaces/BAH/pages/3719102466/IPD+Dashboard
[bahmni-medication-tasks]: https://bahmni.atlassian.net/wiki/spaces/BAH/pages/3719561222/Medication+Administration+And+Non+Medication+Tasks
[bahmni-pharmacy]: https://bahmni.atlassian.net/wiki/spaces/BAH/pages/32604205/Pharmacy+Management
[bahmni-lab-doc]: https://bahmni.atlassian.net/wiki/spaces/BAH/pages/32014460/Using+Lab+Dashboard
[openelis-entry]: https://uwdigi.atlassian.net/wiki/spaces/oeg/pages/451346457/ENTERING+LAB+TEST+RESULTS
[openelis-validation]: https://uwdigi.atlassian.net/wiki/spaces/oeg/pages/451641345/RESULTS+VALIDATION+BIOLOGICAL+VALIDATION
[openelis-grid]: https://uwdigi.atlassian.net/wiki/spaces/oeg/pages/1514700804/Style+guide+Workplan+grids
[medplum-encounters]: https://github.com/medplum/medplum/blob/e3ab98e55feab99013133e6e3bd92b147cb74d73/examples/medplum-provider/src/pages/encounter/EncountersPage.tsx
[medplum-chart]: https://github.com/medplum/medplum/blob/e3ab98e55feab99013133e6e3bd92b147cb74d73/examples/medplum-provider/src/components/encounter/EncounterChart.tsx
[medplum-tasks]: https://github.com/medplum/medplum/blob/e3ab98e55feab99013133e6e3bd92b147cb74d73/examples/medplum-provider/src/components/tasks/TaskBoard.tsx
[medplum-labs]: https://github.com/medplum/medplum/blob/e3ab98e55feab99013133e6e3bd92b147cb74d73/examples/medplum-provider/src/components/labs/LabOrderDetails.tsx
[medplum-updates]: https://github.com/medplum/medplum/blob/e3ab98e55feab99013133e6e3bd92b147cb74d73/packages/docs/docs/fhir-datastore/updating-data.md
[medplum-access]: https://github.com/medplum/medplum/blob/e3ab98e55feab99013133e6e3bd92b147cb74d73/packages/docs/docs/access/access-policies.md
[medplum-history]: https://github.com/medplum/medplum/blob/e3ab98e55feab99013133e6e3bd92b147cb74d73/packages/docs/docs/fhir-datastore/resource-history.md
[medplum-charting]: https://github.com/medplum/medplum/blob/e3ab98e55feab99013133e6e3bd92b147cb74d73/packages/docs/docs/charting/designing-charting.md
[medplum-task-doc]: https://github.com/medplum/medplum/blob/e3ab98e55feab99013133e6e3bd92b147cb74d73/packages/docs/docs/provider/tasks.md
[fhir-http]: https://hl7.org/fhir/R5/http.html
[openmrs-demo]: https://openmrs.org/demo/
[bahmni-demo]: https://bahmni.atlassian.net/wiki/spaces/BAH/pages/61997323/Bahmni+Online+Demo
[openelis-demo]: https://openelis-global.org/getting-started/demo/
[medplum-provider]: https://provider.medplum.com/
[medplum-storybook]: https://storybook.medplum.com/?path=/docs/medplum-introduction--docs
