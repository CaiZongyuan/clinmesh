# 住院端文案降噪、按钮交互收敛与全站工作台视觉整理

Status: superseded

> 本规格已由 [全站原型偏差收口与住院 AI 融合](2026-11-05-ui-audit-and-inpatient-ai-fusion.md) 合并接替。

## 问题与目标

住院线在历次功能迭代中将规格边界条款、环境免责声明与底层校验字符串直接渲染为界面正文（36 个住院前端文件含 1,266 条中文文案、102 条 20 字以上长句；「手术」与「DRG 与费用推演」单页可见文字分别超过 1,400 字和 1,500 字），导致核心临床操作被淹没在制度说教与免责说明中。

同时，住院端按钮与表单交互存在系统性反模式：检索与选择割裂成两步且按 `Enter` 会误提交正式数据；列表顶部单个“理由/说明”输入框同时控制下方全部行级破坏性按钮（禁用时不说明原因、激活后无二次确认、提交后不清空导致理由串台）；同一手术并列两套主按钮与三套耗材预留入口；医保办已归档队列与内嵌核定面板之间存在重复说明与层级割裂；收费表单暴露测试故障注入器；全局工作台共用单一写入 mutation 导致冻结预览被覆盖、跨工作区恢复锁静默阻塞全部操作。此外，全站外层导航、患者横幅与数据表格仍存在双重底栏、硬编码状态色及空状态缺失等视觉粗糙问题。

目标是清理无临床价值的制度说教与重复长篇免责段落，统一检索选择与行级确认交互，收敛手术、耗材与医保工作台层级，补齐禁用门禁说明与写入恢复上下文，并同步完成外层工作台导航与列表视觉整理，使医护、药师、收费、病案与医保办在保持既有 Command、门禁与审计合同不变的前提下获得清晰、防误触的操作体验。

## 范围

- 适用端：standalone Web 与 DSH Surface 共用的住院工作台（`apps/web/src/app/inpatient-*.tsx`、`insurance-panel.tsx`、`virtual-time-control.tsx`）及共享外层工作台壳层（`workspace-shell.tsx`、`workspace-navigation.tsx`）。本规格在[住院线结构重构（第一批）](2026-10-26-inpatient-paper-restyle.md)已建立的 7 岗位结构、床位格与聚合提醒基础上，进一步收敛文案、表单检索、行级确认和多重入口。
- 住院端文案降噪：移除阶段顶部的岗位职责 SOP 说教、“不…也不…”式架构边界免责声明、冗余铺开的“合成/仿真/权威性未验证”长段免责说明（保留正式住院 DRG 规格要求的精简合成参数、来源缺口与适用范围边界标识）、未实现指标占位段落，以及临床视图中默认铺开的机器报文串与模型计费会计规则。
- 检索与表单提交收敛：住院诊断、医嘱药品、住院检验检查及入院患者检索取消分体式二次点击查询，消除检索框按 `Enter` 误触发正式业务提交的缺陷。
- 行级操作与理由输入解耦：废除列表或卡片顶部共用单一理由输入框遥控多行按钮的模式（医嘱停嘱与按需执行、费用冲正、手术申请准备与取消、术中耗材更正与撤销、DRG 预留释放、出院四步推进、DRG 待办处置），改为行级弹层或确认框内独立填写并在成功后重置。
- 多重入口与主次层级收敛：手术卡片区分“术中逐笔登记”与“术后一次性补录”路径；28 字段的 PCI 选型参数后置并折叠来源元数据；去除已有自动保存下的手动保存草稿按钮与无状态接收语义的冗余刷新按钮（保留 DRG 评估 `stale` 时用于重新接收最新指纹并解锁审阅的显式 `重新计算` 动作）；收敛医保办工作台已归档队列与内嵌 DRG 模拟核定面板的层级；将收费表单中的支付模拟器规则移出常规业务流。
- 门禁反馈与写入恢复隔离：为所有带业务门禁的禁用按钮提供明确的未满足条件提示；将收退款冻结预览保存在组件本地状态以免被其他写入覆盖；写入恢复横幅展示具体患者与操作名，并避免跨工作区静默锁死。
- 外层导航与列表基础体验：修复阶段分组 `病案 | 病案` 重复标签、医生左栏切换患者与顶栏切换器状态脱节、服务类医嘱执行按钮写死为“完成健康教育”、病案队列不可点击、窄屏双重底栏、硬编码颜色及表格空态缺失问题。

## 用户故事

1. 作为住院医生，我希望打开「诊断医嘱」「手术」「DRG 与费用推演」时直接看到当前患者状态与可操作表单，而不是大段岗位职责定义、架构边界免责声明与重复打印的机器校验串，以便快速完成诊疗决策。
2. 作为住院医生或登记员，我希望在诊断、药品、检验或患者搜索框输入关键词并按 `Enter` 时直接执行检索并点选条目，而不会误触底部的正式确认诊断或办理住院提交。
3. 作为住院医生、病区护士或收费员，我希望点击某条医嘱的「申请停嘱」、某笔费用的「冲正」或某台手术的「取消手术申请」时，在针对该条目的确认弹窗内核对对象并填写本次理由，以免因顶部共享输入框未填而找不到禁用原因，或因提交后未清空而把上一条的理由误带入下一条不可逆操作。
4. 作为住院医生，我希望在记录手术时清楚选择「术中逐笔登记」或「术后一次性补录」，且只在存在 PCI 计划时填写必要的冠脉参数，以免在同一张卡片上面对两个同时亮起的主按钮和 28 个前置输入框无所适从。
5. 作为病区护士、住院医生或病案员，当「确认报告已阅」「给药」「清床」「归档病案」等按钮不可用时，我希望直接看到缺哪一项前置条件（如“请先展开查看影像”“待住院药房发药”“待收费处出院结算”），以便明确下一步去向。
6. 作为医保办人员，我希望在医保办工作台（`InpatientInsuranceReview`）的已归档病案队列与内嵌的 DRG 模拟核定面板（`InpatientDrgPayer`）之间直接衔接预览与审阅确认，不再被重复的角色说明和冗余表单区块打断。
7. 作为收费员，我希望在院预交金与出院结算入口命名清晰、冻结预览不会因其他操作消失，且日常收退款界面不夹杂“未知后查明成功”等开发测试开关。

## 验收条件

### A. 解释文案与环境免责清理

- [ ] A1：住院患者详情 8 个环节顶部不再常驻渲染 `负责岗位：…` 与医院流程制度说明段落；非当前岗位负责且无只读协作价值的环节按角色收敛，不再展示“请由上述负责岗位从自己的工作台进入本环节办理”的空态说教面板。
- [ ] A2：全面清理界面中的“不…也不…”防御性架构边界文案（含术前耗材确认不自动开启跟进、特病单议四不声明、交接不恢复临床分析、耗材更正不代表取出器械、推演主操作不改病案首页、医院模拟核定不自动产生患者退款、待遇确认不代表已收款）。
- [ ] A3：收敛重复的合成数据与来源免责长段落（如手术目录说明、病案首页来源免责声明、DRG 参数说明、检验报告正文末尾提示中的长篇免责声明），改为精简徽标或默认收起的详情说明；同时保留正式住院 DRG 规格要求可见的合成病例/演示参数标识、来源缺口与适用范围限制提示。
- [ ] A4：「DRG 与费用推演」移除专门声明功能未实现的 `预计收入：尚未取得完整收入组成，暂不估算` 与 `已覆盖成本：…暂不估算` 段落；仅展示已实现的分组、支付标准、费用、预留与差额指标。
- [ ] A5：「手术耗材预计」不再将包含英文 schema 字段名（`scope`、`compatibility`、`quantityBasis`、`expectedQuantity`、`eligibility`）与 UUID 的长串在同一卡片中重复渲染两次；依据摘要改为简洁结构化字段，详细来源移入默认收起的 `<details>`。
- [ ] A6：临床医生与护士视图中的「本次住院模型用量」默认收起为单行摘要（请求数与估算费用），不再在手术页与 DRG 页默认铺开 Token 缓存子集计算规则与保留期说明；病区护士进入「手术」页且已完成术前检查核对时，不再展示仅供医生操作的耗材预计工作稿与模型用量面板。

### B. 目录检索、表单提交与按钮层级收敛

- [ ] B1：住院诊断检索、入院登记患者检索与主提交表单解耦；在搜索框按 `Enter` 仅触发目录/患者检索，绝不隐式触发 `确认住院诊断`、`办理住院` 或 `确认 PCI 参数` 提交。
- [ ] B2：住院诊断、医嘱药品与住院检验检查统一采用“搜索即见候选列表、点选直接带入或弹窗内确认”的单步选择体验，废弃先点顶部 `搜索共享药品/检验目录` 展开双栏大面板、点选后面板不收起且只悄悄修改下方下拉框的割裂交互。
- [ ] B3：表单提交成功后（含签发医嘱、开立检查、办理住院、接诊分床、转床、登记术中耗材、收款、退款），自动重置当前表单的临时输入项与过期选择（如已占用的 `bedId`），防止再次点击直接重复提交同一笔业务。
- [ ] B4：修复因 `flex-col` 拉伸导致次要按钮（`查询诊断`、`添加次诊断`、`放弃编辑`、`前往手术原记录` 等）撑满整栏 100% 宽度的问题；检索动作与输入框同行排列，底部主次操作按“次要取消/重置｜主确认”对齐并区分视觉权重。
- [ ] B5：去除已有 750ms 自动保存下的手动 `保存工作稿` 按钮（仅在自动保存失败时提供重试），去除已有轮询下无状态接收语义的冗余手动刷新按钮；对于 DRG 推演，当轮询检测到新指纹将当前评估标为 `stale` 时，保留并突出显式的 `重新计算` 动作以更新已接收评估基准并解锁审阅与医嘱提交，仅在评估处于最新状态时收敛常驻刷新入口。
- [ ] B6：分组核对中的 AI 解释按钮按实际行为明确命名：尚未生成或需重新派发模型请求时显示 `生成 AI 解释`，已有有效结果仅在前端展开时显示 `展开 AI 解释`。

### C. 行级操作解耦与不可逆动作确认

- [ ] C1：「诊断医嘱」移除列表上方孤立的 `停嘱或按需执行理由` 共享输入框；点击某条医嘱的 `申请停嘱` 或 `请求按需执行` 时，在针对该医嘱的行内弹层或确认框中填写理由并提交，提交后不污染其他医嘱行。
- [ ] C2：「费用」移除表格上方孤立的 `冲正理由` 共享输入框；点击某笔费用的 `冲正` 时弹出包含费用名称、金额与理由输入框的 `AlertDialog`，确认后执行冲正并清空输入，按钮可访问名称包含目标费用项名称。
- [ ] C3：「手术」申请卡片移除同时控制 5 个按钮的共享 `手术记录说明` 输入框；护士 `核对术前检查`、医生 `确认知情同意已签署` 各自独立提交，破坏性动作 `取消手术申请` 改为 `destructive` 样式并弹出独立填写取消原因的确认框。
- [ ] C4：「术中耗材使用」将“新增耗材登记”与“已有记录更正/撤销”彻底解耦：不再使用顶部新增表单的耗材下拉框和说明框去遥控下方行按钮 `更正为当前选择`；每行 `撤销错误记录` 与 `更正` 通过独立对话框核对原记录、填写依据并确认。
- [ ] C5：「DRG 与费用推演」中释放既有预留（`审阅释放预留`）在释放确认框内独立填写释放理由，不再与上方“新增预留”表单共用输入框；待办列表中的 `复查最新业务事实` 无需填写理由即可触发，`人工判断无需处理` 独立要求说明并确认。
- [ ] C6：「出院结算」移除常驻的共享 `出院处理说明` 输入框；`开出院医嘱`、`办理出区`、`召回住院`、`清床` 以及「入科分床」的 `互换床位`、「病案」的不可逆 `归档病案`、「转科」的 `取消转科申请`、顶栏的 `推进一天` 均提供明确展示目标对象与影响的确认环节。

### D. 手术、耗材、收费与医保重复入口收敛

- [ ] D1：手术卡片处于 `ready` 状态时，不再在同一卡片内上下并列展示同时亮起的 `开始手术逐笔登记` 与 `记录实际手术` 两个主按钮；改为先通过模式切换选择「术中逐笔登记」或「术后一次性补录」，仅展示当前模式对应的表单字段与唯一主提交按钮。
- [ ] D2：`PCI 选型参数与候选依据` 移至存在关联 PCI 手术计划时展示（无计划时折叠并提示先提交手术申请），且将病变长度、近端/远端直径的常规临床数值与高级来源核验元数据（`sourceReferenceId`、`sourceVersion` 等）分层折叠，避免首屏平铺 28 个输入控件。
- [ ] D3：保留 [`InpatientInsuranceReview`](../../apps/web/src/app/inpatient-insurance-review.tsx) 作为 `medical-insurance` 角色工作台（承载已归档病案队列、`useInpatientWriteIntent`、`InpatientWriteRecovery` 并内嵌 [`InpatientDrgPayer`](../../apps/web/src/app/inpatient-drg-payer.tsx)），清理队列与内嵌核定面板之间的重复职责说明与冗余外壳，使选中队列条目后直接衔接带冻结分组、支付预览与二次确认的核定流程。
- [ ] D4：在院预交金补缴与出院结算入口语义对齐（在「费用」环节提供预交金入口或将结算阶段明确标识为收退款与结算）；收费员的 `合成渠道结果`（成功/拒绝/未知）故障注入器从常规收退款表单移入折叠的仿真调试区，默认保持 `success`。
- [ ] D5：收款与退款的冻结预览保存在组件本地状态中（与 `inpatient-financial-adjustments.tsx` 一致），不因其他阶段写入或确认失败导致预览瞬间丢失；财务更正与退款下拉框要求显式选择目标项，不静默隐式预选第一条记录。

### E. 禁用门禁提示、临床状态命名与写入恢复反馈

- [ ] E1：所有受前置条件门禁控制的禁用按钮在按钮旁或关联说明中展示具体缺失条件：
  - 检验影像 `确认报告已阅` 未解锁时提示“请先展开查看影像后再确认已阅”；
  - 药品医嘱处于 `pending` 未发药时在执行卡显示“待住院药房发药”状态标签；
  - 药房 `发药` 按钮因医嘱未校对或批次库存不足禁用时显示对应原因，且批次选择默认按有效期与可用库存优先；
  - `清床` 未结算禁用时提示“待收费处完成出院结算”；
  - `归档病案` 禁用时列出未满足项（编码审核通过 / 已清床 / 已结算）；
  - `审阅财务更正` 提示原因最少字数要求。
- [ ] E2：修复服务类医嘱（`order.kind === 'service'`）护士执行按钮文案写死为 `完成健康教育` 的错误，按实际医嘱项目名称显示（如 `完成执行：{order.display}`）。
- [ ] E3：住院医生站在左栏切换患者（`viewedId`）与顶栏患者切换器保持单一选中状态，确保切换患者后的写入成功反馈正常显示，并在成功提示中写明具体完成的动作名称。
- [ ] E4：`InpatientWriteRecovery` 明确展示待恢复操作的患者姓名、操作名称与发生位置；`inpatient-write-intent` 按工作区或业务域提供清晰的占用提示与跳转/恢复入口，避免门诊收费、虚拟时间推进与住院工作台互相静默锁死。

### F. 导航、队列与全站壳层一致性

- [ ] F1：修复住院患者阶段导航栏在「病案」分组下渲染为 `病案 | 病案` 重复文字的问题；单页签分组不重复渲染同名分组前缀。
- [ ] F2：病案工作台的「病案队列」条目改为可交互按钮，支持直接点击切换当前查看的病案患者；状态筛选器使用与主提交按钮区分的切换样式（`ToggleGroup` 或 `secondary`）。
- [ ] F3：护士站一览板的任务统计拆分“待校对”“待给药（已发药）”与“待药房发药”，召回窗口患者与已结算待清床患者提供直接点击进入患者详情的链接。
- [ ] F4：出院后未发生与已发生的可选环节（检查检验、手术、转科）按实际业务记录区分 `done` 与 `closed` 状态标记，避免已做过手术或检查的出院病历在导航上被标为“本次住院未发生”。
- [ ] F5：全站外层壳层（`workspace-shell.tsx`）在窄屏（`<1024px`）下收敛底部双重导航栏，统一状态语义 token（替换散落的 `amber-*` / `emerald-*` 硬编码类），并为住院患者列表、费用明细、医嘱历史与药房发药队列补齐标准化 `Empty` 空状态与横向滚动阴影提示。

## 设计决定

### 1. 冗余文案裁剪与保留边界

界面只保留影响当前用户操作判断的**实时业务事实**（如欠费金额、待校对数量、冻结病组、差额、具体阻断原因），删除所有解释系统架构边界与制度常识的静态说教段落，并将合成数据身份、来源缺口与适用范围限制从重复长段落收敛为精简标识或可展开详情。需要同步更新 [`docs/ui/design.md`](../ui/design.md) §126–128 中“每个阶段说明负责岗位、前置条件与实际办理路径”的表述，改为由导航状态标记与按钮门禁提示直接承载。

| 文案类别 | 典型代表文件 | 处置决定 |
| --- | --- | --- |
| 阶段顶部岗位职责 SOP 说教 | [`inpatient-patient-workspace.tsx`](../../apps/web/src/app/inpatient-patient-workspace.tsx) | 删除 8 个阶段的 `ownerZh` 与 `conditionZh` 顶部常驻段落；非本岗且无只读协作需求的阶段Tab按岗位隐藏或只展示精简只读事实。 |
| “不…也不…”架构免责声明 | [`inpatient-material-estimate.tsx`](../../apps/web/src/app/inpatient-material-estimate.tsx)、[`inpatient-drg-followup.tsx`](../../apps/web/src/app/inpatient-drg-followup.tsx)、[`inpatient-drg-review.tsx`](../../apps/web/src/app/inpatient-drg-review.tsx)、[`inpatient-surgery-materials.tsx`](../../apps/web/src/app/inpatient-surgery-materials.tsx) | 全部删除；字段含义通过精确的 `FieldLabel`（如 `推演假设主操作`）表达。 |
| 合成数据与来源权威性免责 | [`inpatient-surgery.tsx`](../../apps/web/src/app/inpatient-surgery.tsx)、[`inpatient-record.tsx`](../../apps/web/src/app/inpatient-record.tsx)、[`inpatient-drg.tsx`](../../apps/web/src/app/inpatient-drg.tsx)、[`insurance-panel.tsx`](../../apps/web/src/app/insurance-panel.tsx) | 移除主操作流中重复铺开的长段免责声明，同时以精简标识或默认折叠的 `<details>` 保留正式住院 DRG 规格要求的合成病例/演示参数标识、来源缺口与适用范围限制。 |
| 未实现指标占位说明 | [`inpatient-drg.tsx`](../../apps/web/src/app/inpatient-drg.tsx) | 删除 `预计收入：暂不估算` 与 `已覆盖成本：暂不估算` 两行段落。 |
| 机器校验串与 Token 计费规则 | [`inpatient-material-estimate.tsx`](../../apps/web/src/app/inpatient-material-estimate.tsx)、[`inpatient-drg-usage.tsx`](../../apps/web/src/app/inpatient-drg-usage.tsx) | 消除同一卡片两次打印 260 字校验串的问题，改为结构化字段并默认收起详情；模型用量面板默认折叠为单行摘要。 |

### 2. 按钮与交互反模式重构对照

所有写操作继续通过既有共享 Command、幂等键、expectedVersion 和审计链路执行，不在前端复制状态机。

| 交互反模式 | 涉及组件 | 重构方案 |
| --- | --- | --- |
| 检索与选择分体 + `Enter` 误提交 | [`inpatient-diagnosis-editor.tsx`](../../apps/web/src/app/inpatient-diagnosis-editor.tsx)、[`inpatient-clinical.tsx`](../../apps/web/src/app/inpatient-clinical.tsx)、[`inpatient-investigations.tsx`](../../apps/web/src/app/inpatient-investigations.tsx)、[`inpatient-workspace.tsx`](../../apps/web/src/app/inpatient-workspace.tsx) | 搜索输入移出主提交 `<form>` 或拦截 `Enter` 执行检索；目录检索与条目选择合并为单步选择器，废弃独立的 `InpatientCatalogPicker` 顶部常驻折叠面板。 |
| 顶部单一理由框遥控多行按钮 | [`inpatient-clinical.tsx`](../../apps/web/src/app/inpatient-clinical.tsx)、[`inpatient-charges.tsx`](../../apps/web/src/app/inpatient-charges.tsx)、[`inpatient-surgery.tsx`](../../apps/web/src/app/inpatient-surgery.tsx)、[`inpatient-surgery-materials.tsx`](../../apps/web/src/app/inpatient-surgery-materials.tsx)、[`inpatient-discharge.tsx`](../../apps/web/src/app/inpatient-discharge.tsx)、[`inpatient-drg.tsx`](../../apps/web/src/app/inpatient-drg.tsx) | 移除列表/卡片顶部的共享理由输入框；每行操作按钮直接可用（受业务状态门禁约束），点击后在行级 `Popover` 或 `AlertDialog` 中展示目标对象摘要、独立填写理由并确认提交。 |
| 同一手术卡双主按钮与三重耗材入口 | [`inpatient-surgery.tsx`](../../apps/web/src/app/inpatient-surgery.tsx)、[`inpatient-pci-selection.tsx`](../../apps/web/src/app/inpatient-pci-selection.tsx)、[`inpatient-material-estimate.tsx`](../../apps/web/src/app/inpatient-material-estimate.tsx) | 1. `ready` 手术卡用分段切换选择「术中逐笔登记」或「术后一次性补录」，每次只渲染一个主操作按钮。<br>2. `InpatientPciSelection` 仅在有待执行 PCI 计划时展开，28 个字段拆分为核心测量值与折叠的高级来源元数据。<br>3. 移除手动 `保存工作稿` 按钮。 |
| 医保办队列与核定面板层级冗余 | [`inpatient-workspace.tsx`](../../apps/web/src/app/inpatient-workspace.tsx)、[`inpatient-insurance-review.tsx`](../../apps/web/src/app/inpatient-insurance-review.tsx)、[`inpatient-drg-payer.tsx`](../../apps/web/src/app/inpatient-drg-payer.tsx) | 保留 `InpatientInsuranceReview` 承载已归档队列、写入恢复保护与内嵌 `InpatientDrgPayer` 的职责，移除面板顶部的重复角色免责文案与多余嵌套层级，统一在选中病案后直接聚焦冻结预览与核定确认。 |
| 共享 mutation 覆盖预览与跨区锁死 | [`inpatient-funding.tsx`](../../apps/web/src/app/inpatient-funding.tsx)、[`inpatient-write-intent.ts`](../../apps/web/src/app/inpatient-write-intent.ts)、[`inpatient-write-recovery.tsx`](../../apps/web/src/app/inpatient-write-recovery.tsx) | 收退款冻结预览存入组件本地 state；恢复横幅展示待恢复的操作名与患者标识，并提供核查或跳转回原工作区的明确出口。 |

## 测试策略

- **单元测试与组件交互测试**：
  - 更新 `apps/web` 下受影响的住院工作台测试，验证检索框按 `Enter` 不触发正式提交、行级弹窗独立填写理由且提交后清空、手术双模式切换、医保队列与内嵌核定面板衔接及禁用门禁原因展示。
  - 验证 DSH Surface React 18.3.1 与 standalone Web React 19.2 双版本浏览器合同（`pnpm test:browser`），新增或修改的 `Dialog` / `AlertDialog` / `Popover` 保持 `PortalContainerProvider` ShadowRoot 边界兼容。
- **E2E 浏览器回归（`pnpm test:e2e`）**：
  - 同步更新因移除冗余文案与调整行级确认交互而受影响的 Playwright 用例断言（如 [`inpatient-admission.spec.ts`](../../apps/web/e2e/inpatient-admission.spec.ts)、[`inpatient-referral.spec.ts`](../../apps/web/e2e/inpatient-referral.spec.ts)、[`inpatient-bench.spec.ts`](../../apps/web/e2e/inpatient-bench.spec.ts)、[`inpatient-material-plan-review.journey.ts`](../../apps/web/e2e/inpatient-material-plan-review.journey.ts)、[`inpatient-drg-record-checks.journey.ts`](../../apps/web/e2e/inpatient-drg-record-checks.journey.ts)）。
  - 从真实 Web 入口覆盖 7 个住院岗位在 1440×900 桌面、390×844 窄屏及亮暗主题下的完整闭环，确认无横向溢出、无双重底栏、无死锁按钮。
- **构建与文档检查**：
  - `pnpm typecheck`、`pnpm lint`、`pnpm --filter @clinmesh/dsh-web build`（通过 verify-artifact 体积门禁）、`pnpm verify:docs`、`pnpm docs:check`。

## 范围外

- 修改后端 FHIR R5 资源结构、HTTP 路由路径、Command 状态机、SQLite 表结构或 Agent CLI 合同。
- 新增后端临床业务能力（如体征网格、病程记录、危急值闭环）。
- 原生移动端（`apps/mobile`）与桌面端宿主壳层（`apps/desktop`）的独立功能扩展。

## 依赖与风险

- **既有 E2E 测试的文案与选择器耦合**：现有部分 Playwright 用例直接断言了 `负责岗位：…` 文案或依赖顶部共享理由输入框（如 `#inpatient-order-reason`、`#inpatient-reversal-reason`）直接点击行按钮。改造时需在同一切片同步更新对应 E2E 页面对象与测试步骤，保持业务闭环断言强度不变。
- **DSH 产物体积与 React 18 兼容性**：移除大段静态中英文说明文案与冗余包装层级预计将净减少前端 bundle 体积；新增行级确认交互须继续复用 `@clinmesh/ui` 既有 `AlertDialog` / `Dialog` 原语，不使用 React 19 专有 API。
