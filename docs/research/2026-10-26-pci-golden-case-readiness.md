# PCI 黄金病例端到端演示就绪度核查

核查日期：2026-10-26。当前主分支基线为 `91f3cce7`；另只读核对 PR [#308](https://github.com/CaiZongyuan/clinmesh/pull/308) 的精确 head `ed83da0388c6e039f1c81d7918321289ad2e3ef3` 与本地 `issue-279-pci-acceptance@dc2aebec`。未合入分支的能力不计入当前主分支可用能力。本记录是带基线的源码核查，不替代[总体规格](../spec/2026-10-15-drg-prescription-budget.md)、[临床流程](../architecture/clinical-workflows.md)或[DRG 合同](../architecture/drg-grouping.md)。未读取患者明细、影像像素或运行库；未运行真实模型或压测。

## 就绪度结论

当前已有住院、临床执行、共享资金与患者医保、归档冻结、完整条件分组的基础能力；完整 PCI 黄金病例仍需完成数据合入、v2 规则与既有整链分支适配、病例物化、在院支付参考和核定对账、岗位页面及固定版本联合验收。主要剩余工作集中在接入与验收，不应重新开发已交付内核或另建一套病例/费用状态机。

| 交付 | 本次实际核对状态 | 后续责任 |
| --- | --- | --- |
| [#305 完整条件分组](https://github.com/CaiZongyuan/clinmesh/issues/305) / PR #307 | 已关闭并合入当前 HEAD；受限程序、v2 规则、主次编码和条件解释已经存在 | 消费其当前接口与完整规则产物；既有13,784例零差异、825终端命中记录见[固定核验](2026-10-25-drg-condition-verification.md)，本次未重跑全量oracle |
| [#303 PCI 数据与共享目录](https://github.com/CaiZongyuan/clinmesh/issues/303) / PR #308 | Issue仍OPEN；PR已Ready、MERGEABLE，精确head的plan/checks/unit/browser/e2e/verify均成功，尚未合入 | 合入后验证实际运行库的幂等准备与目录可用性；本次只核对源码与远端CI状态 |
| [#279 联合验收](https://github.com/CaiZongyuan/clinmesh/issues/279) | Issue仍OPEN；本地已有未推送的整链接入，规则仍为v1 | 复用本地成果，适配当前v2和#303新目录；在同一固定集成提交完成全链证据 |
| [#225 总体需求](https://github.com/CaiZongyuan/clinmesh/issues/225) | 仍OPEN；既有支付、医保、DRG各切片证据不能代替最终联合验收 | 同次住院覆盖正常、未知恢复、归档后更正及辅助回归后，才具备整体验收条件 |

Issue正文还存在未随#305关闭更新的依赖描述，本表按本次API返回的状态和实际HEAD判断，不据旧文字认定完整条件内核仍未完成。

## 演示范围与完成口径

既定目标是一例非急诊、无复杂并发症的冠心病患者：评估入院、冠脉造影、实际植入一枚支架、术后用药、稳定出区、费用结清及清床、病案审核归档、冻结 DRG 分组及医保岗模拟核定。总体规格还要求在同一次住院演示收退款未知恢复、归档后的受控财务更正与相关医保重结算，另外回归心衰、肺炎与冻结历史；见[总体规格](../spec/2026-10-15-drg-prescription-budget.md)。

“黄金病例”至少应有固定版本底稿、可重复建立的病例来源与就诊、预期临床及账务事实、独立分组预期和真实岗位验收证据。现有 Scenario 合同虽然允许 `golden`，内置可安装蓝图只有发热门诊的 candidate/density，初始安装仍选 candidate，不能仅把现有患者改名就视为已安装 PCI 黄金病例。来源：[蓝图](../../apps/server/src/application/scenario-service.ts#L128)、[初始安装](../../apps/server/src/application/scenario-service.ts#L321)。

## 临床与数据：主分支实际具备什么

| 范围 | 当前基线的可复用能力 | 对 PCI 演示的含义 |
| --- | --- | --- |
| 住院环境与岗位 | 启动幂等补环境、手术目录、住院医生/护士/病案/医保岗，一个默认病区、三张床；不建立完整诊疗旅程 | 可复用住院骨架；仍需固定 PCI 病例和真实业务动作。[环境准备](../../apps/server/src/application/inpatient-environment.ts#L9) |
| 造影与介入术式 | 八条固定术式包括 PTCA `00.6600`、药物球囊、药物洗脱支架 `36.0700`、冠脉造影 `88.5500`/`88.5600`，均有独立合成收费定义 | 无需重建手术引擎，但要按真实先后执行造影和支架两项，并明确主要操作。[目录](../../apps/server/src/application/scenario-data/inpatient-surgery-catalog.ts#L5) |
| 实施与材料 | 术前核对、知情同意确认后才能实施；实际 `Procedure`、材料用量、费用在同一 Command 产生；预留按业务引用替换 | 计划不会自动变成已完成 PCI。支架/球囊/导丝/导管要逐项形成实际用量和收费，验证预留不重复计费。[实施](../../apps/server/src/application/inpatient-surgery.ts#L98) |
| 住院药品 | 默认对乙酰氨基酚、二甲双胍和氨氯地平，住院剂量、适应症按有界示例启用 | 无法以这三项示例展示固定 PCI 用药路径。不能以合并高血压的氨氯地平发药代替 PCI 术后用药。[药品基线](../../apps/server/src/application/scenario-data/hospital-baseline.ts#L567)、[住院启用](../../apps/server/src/application/inpatient-environment.ts#L16) |
| 检验/检查 | 住院目录要求开展条件、正数且明确的住院价目；申请、送检、报告和签收有独立流程 | “参考库有检验概念”不等于本院已可开，也不等于已有本次报告。[目录与申请](../../apps/server/src/application/inpatient-investigations.ts#L44) |
| 病案 | 首页收集正式诊断、已实施操作、出区、费用及来源版本；主操作必须显式选定，当前修订审核通过、结算及清床后才能归档 | 可以复用现有审核归档；不能直接插入孤立首页或用术式申请替代实际操作。[来源](../../apps/server/src/application/inpatient-records.ts#L27)、[审核/归档](../../apps/server/src/application/inpatient-records.ts#L113) |

主分支的 231 条心血管参考耗材不构成可执行 PCI 材料套装。按归一化 JSON 直接聚合，52 条可收费记录全部属于起搏类；179 条冠脉记录全部缺计价单位，服务端明确拒绝执行。原有两项通用合成耗材是缝合材料与导管，也没有可直接替代的冠脉支架、球囊、导丝。来源：[材料读取及启用规则](../../apps/server/src/application/scenario-data/cardiovascular-materials.ts#L45)、[缺单位拒绝](../../apps/server/src/application/inpatient-surgery.ts#L119)、[已实现规格](../spec/2026-10-22-cardiovascular-surgical-materials.md)。

| 来源类别 | 条数 | 单位明确、可收费 | 缺单位、不可收费 |
| --- | ---: | ---: | ---: |
| 常规起搏类 | 35 | 35 | 0 |
| 无导线起搏类 | 2 | 2 | 0 |
| 电极导线类 | 15 | 15 | 0 |
| 冠脉导引导丝 | 42 | 0 | 42 |
| 冠脉导引导管 | 20 | 0 | 20 |
| 冠脉扩张球囊 | 89 | 0 | 89 |
| 药物球囊 | 12 | 0 | 12 |
| 冠脉支架 | 16 | 0 | 16 |

## 已实现但未合入的数据前置：PR #308

不能把上述主分支缺口都理解成需要从头开发。已按 PR #308 精确 head 核对到以下数据与准备逻辑，合入并消费后可填补首例大部分目录缺口；这些文件目前不存在于本次核查主分支中，以下引用固定到该 head。

| 数据前置 | PR #308 已提供的内容 | 仍需整链接入的部分 |
| --- | --- | --- |
| 单枚支架底稿 | `pci-elective-single-stent-v1`，固定人口信息、症状、非急诊/无复杂并发症边界、九项合成基线检验；`intendedUse: authoring-only` | 通过正式病例来源与业务入口建立 Patient、就诊、入院和实际证据，不能把底稿当本院诊断/报告。[数据底稿](https://github.com/CaiZongyuan/clinmesh/blob/ed83da0388c6e039f1c81d7918321289ad2e3ef3/apps/server/src/application/scenario-data/pci-data.ts#L46) |
| 五项药品 | 阿司匹林、氯吡格雷、阿托伐他汀、肝素、碘海醇，具体产品身份与独立合成院内单位/价格/库存/规则 | 真实开立、护士校对、药师发药、护士给药及停止；核对数量和费用，不将默认建议当临床处方指南。[药品定义](https://github.com/CaiZongyuan/clinmesh/blob/ed83da0388c6e039f1c81d7918321289ad2e3ef3/apps/server/src/application/scenario-data/pci-data.ts#L20) |
| 九项检验 | 白细胞、血红蛋白、血小板、肌酐、INR、ALT、AST、钾、钠；LOINC、标本、单位、合成区间与住院价目 | 以已绑定来源生成当前就诊的正式报告并签收；历史和底稿值不能冒充此次实施。[检验定义](https://github.com/CaiZongyuan/clinmesh/blob/ed83da0388c6e039f1c81d7918321289ad2e3ef3/apps/server/src/application/scenario-data/pci-data.ts#L34) |
| 四种冠脉耗材 | 独立合成院内导丝、导引导管、预扩球囊、药物洗脱支架；沿用来源金额，合成规格/计价单位分别保存 | 使用新合成院内 ID 形成预留与实际使用；保留原表缺单位事实，不覆盖179条原来源。[材料定义](https://github.com/CaiZongyuan/clinmesh/blob/ed83da0388c6e039f1c81d7918321289ad2e3ef3/apps/server/src/application/scenario-data/pci-data.ts#L67) |
| 编码目标与参数 | 临床主诊断 `I25.103`，造影 `88.5500`、支架 `36.0700`；目标 `FM39`；独立合成基础费率500000分、权重24000bp，即目标病组模拟支付1200000分（12000元） | v2完整程序对实际主次诊断和全部实际操作重新分组，独立核对后由既有核定算法消费参数；`target-only`不是计算结果。[目标](https://github.com/CaiZongyuan/clinmesh/blob/ed83da0388c6e039f1c81d7918321289ad2e3ef3/apps/server/src/application/scenario-data/pci-data.ts#L55)、[参数](https://github.com/CaiZongyuan/clinmesh/blob/ed83da0388c6e039f1c81d7918321289ad2e3ef3/apps/server/src/application/scenario-data/pci-drg-payment-parameters.ts#L1) |
| 目录录入 | 共享目录搜索、缺项说明、医生填写本次合法用量和精确换算，沿用原医嘱/发药/计费 Command | 与 #279 的工作台和推演指纹集成后，验证两侧剂量合同、旧回执和并发失效。[规格](https://github.com/CaiZongyuan/clinmesh/blob/ed83da0388c6e039f1c81d7918321289ad2e3ef3/docs/spec/2026-10-25-inpatient-shared-catalog-pci.md) |

该 PR 的 `inpatient.pci-data.prepare` 是管理员补目录/库存的幂等动作，显式不创建患者、门诊、住院、挂号费用、正式诊断、手术、归档或核定；来源：[prepare实现](https://github.com/CaiZongyuan/clinmesh/blob/ed83da0388c6e039f1c81d7918321289ad2e3ef3/apps/server/src/application/inpatient-pci-data.ts#L66)、[数据包边界](https://github.com/CaiZongyuan/clinmesh/blob/ed83da0388c6e039f1c81d7918321289ad2e3ef3/apps/server/src/application/scenario-data/pci-data.ts#L88)。因此 #303 合入后仍不能直接宣布完整 PCI 演示已打通。

## 临床与数据剩余验收清单

1. 消费固定底稿，建立可重复的合成病例与来源清单，绑定 `source_case_id`。当前入院从 `synthetic_case_materialization` 解析来源，多来源必须明确门诊 Encounter；手工建 Patient 虽可入院，但没有来源不能证明检查链可用。应明确复用既有门诊来源还是增加受控病例物化入口，并核对有无附带挂号费用，不能通过伪造 SQL 来源解除门禁。[入院来源解析](../../apps/server/src/application/inpatient-service.ts#L211)
2. 用实际岗位完成造影后单枚支架路径：正式主次诊断及四态入院病情、必要检验送检/报告/签收、造影、PCI术前核对及同意、实际支架植入、四类材料数量、术后用药；底稿中的外院资料与本院实际证据分别展示。[诊断合同](../../packages/contracts/src/inpatient-clinical.ts#L6)、[实际手术合同](../../packages/contracts/src/inpatient-surgery.ts#L34)
3. 固定虚拟时间线与每阶段预期。预留只计预计，实施替换后只计实际；发药计药费、服务/操作按各自执行触发，跨日床费按医院日期核对；同日出院和跨日住院至少应有明确脚本，不依赖真实等待。已发生费用、已签署待执行、预留和草稿分层的现有计算可复用。[现有费用分层](../../apps/server/src/application/inpatient-drg.ts#L145)
4. 按实际诊疗记录选择首页主要操作：单支架主操作应由有权岗位明确选择，冠脉造影作为另一个实际操作保留。需要将包括造影在内的实际完整码列表送入 v2 程序作独立对照；仅用 `I25.103 + 36.0700` 单码片段产生 `FM39` 不能证明整个病例输入已核对。[首页主操作](../../apps/server/src/application/inpatient-records.ts#L120)、[完整输入合同](../architecture/drg-grouping.md#来源与计算)
5. 配置合成医保方案及参数版本，分别核对逐项费用、患者基金/账户/现金、医院模拟DRG支付；参数的存在不代表核定入口已消费。缺成本应继续明确显示不完整，不以零成本伪造盈亏；演示不要求扩建真实全成本系统。当前推演仍明确 `costMissing: true`、`paymentReferenceMissing: true`。[不完整标记](../../apps/server/src/application/inpatient-drg.ts#L186)
6. 确定黄金病例预期账本：逐项数量、单位、冻结价、费用净额、预交金、医保分配、补退金额、初次结算、归档前后差异均可复算。只展示一个最终总额不足以验收。预期费用由独立脚本/底稿计算，避免测试直接拿产品结果生成预期。
7. 正式诊疗结束后完成停嘱及核停、在途检查/手术处理、医生出院、护士出区、确定资金结果、首次财务完成、清床、病案审核/归档；归档冻结结果不能随规则/目录升级漂移。当前归档已有这些门禁，后续工作应接线和验证。[归档门禁及冻结](../../apps/server/src/application/inpatient-records.ts#L160)

本地 `issue-279-pci-acceptance@dc2aebec` 已有 PCI HTTP fixture，但其规则构造仍使用旧成员表格式，样例 `preparePciAdmission` 使用手工 Patient 入院且未产生病例来源，并用氨氯地平演示合并高血压发药。它可作支付/材料局部参考，尚不能替代消费 PR #308 的药品、检验和病例来源后的完整验收；该本地提交没有公开固定链接，不将其列为当前主分支能力。

## DRG 与支付：需要补齐的接入

| 缺口 | 当前源码证据 | 可验收的完成结果 |
| --- | --- | --- |
| 常规启动没有装载规则 | [Runtime](../../apps/server/src/runtime.ts#L286)支持`drgRulesDirectory`，但[配置](../../apps/server/src/config.ts)及[启动入口](../../apps/server/src/index.ts#L14)未传入；预分组/推演无规则返回409 | standalone Web、DSH、LAN及生产入口均选定同一已核验v2包，显示规则身份；缺失/损坏明确失败或显示不可用；准备和重启不执行临床或核定 |
| 离线资料没有自动成为运行规则 | [离线清单](../../apps/server/src/infrastructure/reference-data/offline-reference-inventory.ts#L161)保留`offline-review`、`integrity-only`、`runtimeEnabled=false`；[部署合同](../deployment.md#离线-drg-资料核对)明确不启用计算 | 运行配置消费固定来源、病例编码及适用范围核验结果，保持仿真标识；不把校验下载字节当作规则启用、地方结算或使用条件核验 |
| v1/v2交接不兼容 | 当前[装载器](../../apps/server/src/infrastructure/reference-data/drg-rules-package.ts#L12)仅接受v2；#279本地准备器与fixture仍依赖v1和旧prepare导出 | 启动准备、人工核验引用、manifest哈希及fixture一起升级；重新绑定v2产物身份，不复用v1核验记录；旧归档仍读原结果 |
| 预分组尚未读取当前事实 | [预分组](../../apps/server/src/application/inpatient-drg.ts#L71)要求已提交首页并取`revision.snapshot`；当前模拟的主操作也从最近首页修订读取 | 无首页修订时可展示当前正式事实及明确缺项；新增诊断/实际执行后旧评估过期，重新计算使用最新事实；主操作选择必须有明确来源 |
| 多个计划操作全被标为主操作 | [推演](../../apps/server/src/application/inpatient-drg.ts#L139)把所有待实施申请设为`primary:true`后追加 | 造影与支架双计划、造影已完成后计划PCI、PCI已完成等阶段，主次和替换语义明确；不能用计划覆盖正式事实或生成多个主操作 |
| 在院支付参考尚未计算 | [推演返回](../../apps/server/src/application/inpatient-drg.ts#L174)没有参考额，`paymentReferenceMissing`恒true；主分支[核定参数](../../apps/server/src/application/scenario-data/drg-payment-parameters.ts#L5)只覆盖RA15 | 依实际分组和参数身份计算参考额、预计总收费、剩余空间及预计超参考额；FR59/FM59/FM39各阶段有参数或明确缺项，不以零填充 |
| 收费进度被命名为成本覆盖 | [推演](../../apps/server/src/application/inpatient-drg.ts#L186)直接以收费净额除推演总额；[合同](../../packages/contracts/src/inpatient-drg-simulation.ts#L64)也沿用“已覆盖成本” | 改为收费进度口径；有可靠成本资料时单列覆盖范围，没有则保持缺失。收费、患者基金/账户/现金、医院DRG参考及成本分别展示 |
| 正式开具前缺少服务端重验 | [签发输入](../../packages/contracts/src/inpatient-clinical.ts#L21)和[订单Command](../../apps/server/src/application/inpatient-orders.ts#L113)未带已审阅评估指纹；[模拟](../../apps/server/src/application/inpatient-drg.ts#L129)仍由调用方比指纹 | 依赖变化时拒绝消费旧审阅，要求更新预览；覆盖其他岗位费用、执行、剂量/草稿、目录、参数、规则、病例切换与迟到响应 |
| 核定差额缺少原预估基线 | [归档冻结](../../apps/server/src/application/inpatient-drg.ts#L108)只冻结分组；[核定](../../apps/server/src/application/inpatient-drg.ts#L358)的difference是核定减归档收费；[核定合同](../../packages/contracts/src/inpatient-drg-payer.ts#L21)无原支付预估 | 归档绑定原支付预估及参数身份；核定单独展示“核定减原预估”和“核定减收费”；由受控规则产生，人工仅审阅确认，不手填返回金额 |

本地#279分支已经实现启动配置、受核验装载、live revision 0、审阅指纹重验、支付基线冻结、核定预览、读取审计等大部分接线，应先与当前v2和#303目录整合，再按上表逐项复核，不能把整张表算成从零开发。主分支已有归档与首页同事务冻结、归档后读原持久结果的机制，需要保留。默认无规则时归档冻结为null，这类旧归档不能在后来装载规则后补称为“原归档冻结分组”。

## 完整 v2 规则的五组输入探测

本轮用当前HEAD的`loadDrgRules`与`groupDrgCase`，只读装载既有物化包`clinmesh-chs-drg-30-2026-10-25.conditions-v2`，来源`opendrg-chs-drg-3.0@2026-10-20`。输入固定为61岁男性、唯一主诊断`I25.103`、无次诊断、住院3天，逐例只改变操作及主操作标志；下表是本次实际输出。它验证该固定输入的阶段及主次操作敏感性，不是完整住院业务验收，也不是此次重新执行原程序oracle。

| 阶段输入 | 实际状态 | 实际DRG |
| --- | --- | --- |
| 无操作 | grouped | FR59 |
| 仅`88.5500`造影，主操作 | grouped | FM59 |
| `36.0700`支架为主，`88.5500`造影为次 | grouped | FM39 |
| `88.5500`造影为主，`36.0700`支架为次 | grouped | FM59 |
| 两项实际操作均无主操作标记 | invalid-input | 无；原因“存在操作但缺少主操作标记” |

因此黄金病例应保留造影与PCI的完整实际编码，在正确主操作下验证FR59→FM59→FM39的阶段变化，并增加“主操作选错仍可能成功入另一组”的负例。不能因为结果状态是grouped就判病例通过。最终完整病例若新增次诊断或其他操作，应重新给出独立预期，不沿用此最小输入结论。

支付参数还存在明确集成差异：#303提供`clinmesh-synthetic-pci-payment@2026-10-25.r1`，FM39权重24000bp、基础500000分，结果12000元；#279本地`clinmesh-synthetic-hospital-drg-payment@2026-demo-2`的FM39权重40000bp，同基础结果20000元。两个版本分别有身份，不应静默混用；按#303数据owner和#279消费职责选定适用参数并冻结引用。PR #308只补FM39，#279本地扩充表也没有FM59；如果演示造影阶段的支付参考，需补该阶段的明确合成参数，或显式展示缺参数并在PCI完成后重新计算。不能用两套未声明切换的参数差异冒充医保核定差异。

## 页面、Agent 与真实入口证据

当前[Web岗位入口](../../apps/web/src/app/role-workspaces.tsx#L21)只向住院医生、护士及病案渲染住院工作台；医保办虽然被[导航](../../apps/web/src/app/workspace-shell.tsx#L121)映射到住院，最终落到空容器。当前[住院病例工作台](../../apps/web/src/app/inpatient-patient-workspace.tsx#L27)没有DRG阶段或面板。因此后端接口存在尚不能形成医生与医保办可操作的完整演示。

| 入口 | 剩余可观察内容 |
| --- | --- |
| 住院医生 | 正式事实分组与计划推演分开；四类费用、参考额、单位和缺项可追溯；剂量/预留变更、其他岗位执行和费用变化使旧评估及审阅失效；可重新计算再开具 |
| 病案人员 | 查看审核修订对应的主诊断、主要及其他实际操作；归档后显示冻结规则/来源/分组/支付预估，并与当前财务调整分开 |
| 医保办 | 有真实工作台、归档病例列表、核定预览/人工确认/历史及两类差额；取消无写入，越岗拒绝，丢响应按原回执恢复 |
| 收费员 | 患者基金、账户、现金与预交金/补退分别核对；首次未知资金阻断财务完成和清床；归档后更正与首次结算分开展示 |
| CLI/Agent | 复用已有[Operation Catalog](../../packages/contracts/src/his-operations.ts#L2615)及[住院Skill](../../skills/clinmesh-inpatient/SKILL.md#L376)；新增预览、指纹或错误合同同步Catalog/Skill/示例漂移测试，验证context binding、人工审阅与receipt恢复 |

本地#279已有DRG医生页面、医保办页面及专项Playwright E2E，可复用；其浏览器fixture仍用`I10.x09→RA15`的合成小规则，不能替代完整PCI数据和完整v2规则的端到端证据。该分支还已有`apps/dsh-web/src/client/inpatient-drg.browser.test.ts`，覆盖React 18/19 ShadowRoot内医嘱、耗材预留与医保核定审阅的焦点、窄屏、取消及提交，应在最终集成版本适配并回归。本轮未查到原生DSH PCI整链smoke，实际DSH岗位入口证据仍需按[总体测试要求](../spec/2026-10-15-drg-prescription-budget.md#测试策略)补齐；CLI/Agent只验证适配边界，不重复所有业务矩阵。

## 建议的集成顺序与最终验收

1. 固定主线v2、PR #308和#279已有实现的集成基线，保真保留各工作区；优先合入数据前置，再适配旧规则准备/装载与全部fixture，不重复建设既有引擎。
2. 明确参数集选用和阶段覆盖，接入启动就绪检查、病例来源绑定与幂等物化；准备仅建立目录/底稿，实际病例及就诊由明确动作建立。
3. 固定黄金病例输入、虚拟时间、逐项预期账本和原程序/人工独立分组预期；验证无操作、造影后、PCI后、主操作错误及缺参状态。
4. 登记入院、护士入床、医生确认诊断、必要检查与报告签收；双操作按真实顺序实施，术前核对和同意有效，四类材料预留转实际不重复计费，术后药品走完整执行链。
5. 医生查看实际与推演分组和四类费用；制造一次外部费用/执行变更，证明旧审阅失效，刷新计算并重新人工审阅后继续。
6. 收费员完成待遇分配、预交金抵扣和组合补退；制造一次结果未知，核对首次财务完成和清床被阻断；查询原尝试取得确定结果后继续，不另起重复收退。
7. 医生出院、护士出区、财务完成、清床，病案人员审核归档；冻结来源、主次操作、分组、规则、费用及原支付预估。规则/参数更新后旧结果及原回执保持原义。
8. 医保办预览并确认模拟核定，分别核对核定减原预估和核定减收费；取消不写入、丢回执恢复不重复核定。
9. 同一归档住院追加一笔费用更正、医保补偿/重结算和关联原款退款；退款未知在重启后恢复，旧病案、首次结算及清床不回退，其他就诊的账户和年度累计不被覆盖。
10. 在同一最终集成提交保留公开HTTP/临时SQLite证据、standalone Web真实岗位旅程、受影响React 18/19合同、DSH岗位入口与CLI适配证据；另回归门诊、心衰、旧肺炎、冻结历史、越岗、并发、迟到和缺参。用户要求演示媒体时，再绑定精确提交录制WebM。

该范围不要求补齐全院目录、全部病组支付参数、完整手术排班/麻醉设备/供应链、真实医保接入或完整成本会计；首例及其辅助回归用到的项目应完整，其他明确缺项如实展示。依据：[总体范围外](../spec/2026-10-15-drg-prescription-budget.md#范围外)及[PCI数据范围外](https://github.com/CaiZongyuan/clinmesh/blob/ed83da0388c6e039f1c81d7918321289ad2e3ef3/docs/spec/2026-10-25-inpatient-shared-catalog-pci.md#范围外)。

## 本轮验证范围

已完成主分支、PR #308 精确 head 与上述本地 #279 分支的静态源码核对，运行 PowerShell 只读聚合公开材料 JSON，得到上述231条的类别/单位统计；未检查或修改运行库。

本次实际运行以下检查，均使用合成输入和临时数据库，未运行真实模型、负载或正式运行库写入：

| 检查 | 本次结果 | 范围限制 |
| --- | --- | --- |
| `pnpm --filter @clinmesh/server test tests/drg-program.test.ts tests/drg-rules-package.test.ts tests/drg-rules-builder.test.ts --maxWorkers=1` | 3文件34项全部通过，5.11秒 | 条件解释器、规则包及构建回归；不是重跑完整来源oracle |
| `pnpm --filter @clinmesh/server exec vitest run tests/inpatient-drg-http.test.ts tests/inpatient-drg-simulation-http.test.ts tests/inpatient-drg-payer-review-http.test.ts tests/inpatient-drg-age.test.ts tests/inpatient-financial-acceptance-http.test.ts tests/inpatient-insurance-archived-http.test.ts --maxWorkers=1` | 6文件32项全部通过，127.28秒 | 分散HTTP/年龄/财务/归档待遇机制；各DRG测试使用合成小规则，不代表PCI联合验收 |
| `pnpm --filter @clinmesh/server test -- inpatient-surgery-http.test.ts` | 1文件18项，16通过、2失败，71.16秒；实际输出确认只运行这一文件 | 两失败报告临时SQLite删除锁定，未重跑 |
| `pnpm exec tsx .data/drg-delivery/2026-10-26-pci-readiness-probe.mts` | 上表5组固定输入实际输出 | 当前HEAD解释器只读装载完整v2包；没有HTTP、数据库或原程序oracle |

两项失败完整名称分别为“住院手术公共 HTTP 与真实 SQLite > 已有Epoch重启只补缺失目录，不覆盖已冻结的院内配置”和“住院手术公共 HTTP 与真实 SQLite > 心血管目录重启补缺不调旧价，旧耗材实施快照与原receipt仍可恢复，新Epoch重新安装全量”。已报告错误为Windows删除临时`hospital.sqlite`时`EBUSY: resource busy or locked`，日志不足以证明所有业务断言已通过，也不能确定仅afterEach出错；本文件本轮不能计为全通过。已有[SQLite清理经验](../memory/testing.md#范围快照与资源争用)要求先关闭连接再删除，不以扩大重试掩盖句柄问题。本轮未修改测试或业务代码。

PR #308的远端CI全成功属于该精确head的既有证据；本轮没有执行未合入分支的测试、真实浏览器旅程或最终PCI整链，不能声称演示已验收。

文档实际执行`pnpm doc-sync`，在`verify:docs`因已有`docs/decisions/implemented/CLAUDE.md`缺文件末换行而停止，尚不能报告通过；该文件不在本任务改动中。随后单独执行`pnpm docs:check`通过：文档投影2文件10项测试通过，VitePress构建成功。`git diff --check -- docs/research/README.md docs/memory/clinical-data.md`通过。本任务只新增本报告、研究索引入口和一条复用排障经验，保留了任务开始前的全部工作区修改。
