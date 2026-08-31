# Agent Note: 门诊医生工作台 UI 重构

Status: proposed

## Problem

门诊医生工作台已经拥有候诊队列、Virtual Patient 直达接诊、Consultation Record、结构化 Clinical Document、检查申请与报告确认、独立诊断、处方或无需用药、Encounter Completion、已完诊病例和受控纠错。当前 Web 将这些查询、Command、局部草稿、错误反馈和页面组合集中在 `apps/web/src/app/doctor-workspace.tsx`，使业务状态与视觉结构难以分别演进，也让页面难以稳定呈现高密度桌面工作流。

`/ui-dev` 医生工作台已经验证“全局导航、候诊队列、患者横幅、中央业务页签、固定右栏”的信息架构，但它使用 mock 数据和本地交互，只能作为视觉与布局参考。[普通门诊发热 Web 交互原型](../feature/2026-08-21-outpatient-fever-web-prototype.md)明确禁止把原型状态机和客户端动作直接迁入生产页面。

正式重构必须保持[医生核心临床业务流](../../implemented/feature/2026-08-24-doctor-clinical-core-workflow.md)、[结构化临床文书独立生命周期](../../implemented/feature/2026-08-25-structured-clinical-document-lifecycle.md)、[独立诊断生命周期](../../implemented/feature/2026-08-25-independent-encounter-diagnosis-lifecycle.md)、[独立处方与用药结论生命周期](../../implemented/feature/2026-08-25-independent-prescription-and-medication-conclusion-lifecycle.md)、[检验报告确认与不可变修订](../../implemented/feature/2026-08-25-laboratory-report-acknowledgement-and-revision.md)和 [Encounter 完诊门禁](../../implemented/feature/2026-08-25-encounter-completion-policy.md)拥有的业务事实，不能以 Demo 字段、页签或按钮补造服务端能力。

## Proposal

### 重构边界

Demo 只定义桌面工作面的视觉结构、信息密度、区域稳定性和页面内交互位置。生产 Contract、Command、授权、版本、幂等、查询失效、轮询、纠错窗口和完成条件继续由现有 owner 模块拥有。

重构第一阶段留在 `apps/web`。当前只有 Web 一个实际消费者，尚不存在第二个 Desktop adapter，不把医生业务视图提前移动到 `packages/views`。共享颜色、尺寸、状态和可访问 primitive 继续由[临床 UI 合同](../../implemented/architecture/2026-08-26-clinical-ui-contract-and-catalog.md)和 `packages/ui` 拥有。

### 不变量

| 范围 | 必须保持的业务合同 |
| --- | --- |
| 身份与责任 | 所有写入使用服务端解析的 Actor、Practitioner Role、Workspace 和 Epoch；客户端不声明行动身份 |
| 服务端状态 | TanStack Query 是唯一缓存；页面动作成功后精确失效 owner 查询，Zustand 不镜像病例 DTO |
| 并发 | 每个写 Command 保留 expected version、草稿版本、幂等键和冲突刷新 |
| Encounter | 同一病例始终使用同一个 Encounter；页签切换不推进状态 |
| Consultation Record | 患者问答按顺序追加且不可覆盖，不自动成为正式病历 |
| Clinical Document | 草稿可恢复；签署件不可覆盖；签署后通过 Revision 产生新事实 |
| 诊断 | 草稿与确认分离；确认后不可普通覆盖；主次诊断使用目录快照 |
| 用药结论 | 正式处方与无需用药互斥；开具后只读；撤回保留原事实和下游状态 |
| 检验报告 | 报告签发、医生已阅和报告修订是三个独立事实；修订后必须重新确认当前报告 |
| 完诊 | Completion Policy 只读取各 owner 的正式事实；客户端不自行复制七项门禁 |
| 已完诊病例 | 默认只读；病历修订、报告更正和处方撤回只从服务端声明的纠错入口进入 |

### 目标信息架构

宽屏医生工作台使用四个稳定区域：全局岗位导航、候诊队列、当前病例主区和右侧病例上下文栏。患者横幅位于主区顶部并在业务页签上方保持稳定；全局顶栏只保留跨页面动作，不堆放每个页签的写按钮。具体尺寸和响应式行为遵循[临床 UI 设计合同](../../../../docs/ui/design.md)与[HIS UI/UX 参考](../../../../docs/research/his-ui-ux-references.md)。

候诊队列只展示真实 `DoctorQueue` 状态：`awaiting-doctor`、`first-visit`、`awaiting-report`、`awaiting-revisit` 和 `revisit-draft`。分诊级别、患者摘要和报告等待状态来自服务端 DTO；不使用 Demo 的“当前就诊、急诊加号、已签到”等本地枚举替代业务事实。

患者横幅只投影 `DoctorCaseDetail` 已有患者身份、主诉、过敏、分诊、生命体征、Encounter 和只读状态。不存在来源的医保余额、费用、号序、标签或医生信息不得显示为真实事实。

### 页面责任

| 页面 | 生产数据与动作 | Demo 迁移限制 |
| --- | --- | --- |
| 问诊记录 | `consultation.questions`、`consultation.records` 与受控提问 Command | 展示医患问答时间线和可提问项；不把自由文本病史表单伪装成 Consultation Record |
| 病历 | `clinicalDocument` 草稿、签署预览、签署历史和 Revision | 未签署时编辑正式病历；签署后只读并按授权显示修订；不与问诊记录重复保存同一事实 |
| 检验 | `laboratoryRequests` 草稿、开立、取消、生成重试、报告、已阅和修订 | 可采用申请/结果双栏与行内状态；不复制报告异常汇总和独立进度状态机 |
| 检查 | Hospital Service 目录和 order/complete Command | 只有 Doctor Case 投影、检查结果 Contract 和责任/纠错规则完成后才独立上线；此前不展示可写占位页 |
| 诊断 | `diagnosis` 草稿、主次目录项、可选 note 和确认 Command | 只提交当前 Contract 支持的字段；病情分级、证据标签、慢病开关、诊断时间和医生不是可编辑生产字段 |
| 处方 | 药品目录、剂量、频次、疗程、数量、草稿、开具、无需用药和撤回 | 不提交 Contract 未拥有的给药途径；费用、支付和药房状态只有从下游 owner 查询得到时才显示 |
| 完诊 | Encounter Completion 预览与完成 Command | 右栏或固定操作区展示服务端七项条件；不从页签完成度推断能否完诊 |
| 已完诊病例 | 只读详情、统一时间线和 owner 纠错导航 | 复用当前只读与纠错能力；不把活动草稿编辑器带入病例库 |

### 右侧病例上下文栏

右栏是固定的病例上下文区域，随当前业务页签切换内容，但不拥有新的业务状态机。

第一阶段只展示可从 `DoctorCaseDetail`、Encounter Completion、当前报告和目录事实确定性推导的信息：患者过敏、分诊和生命体征；当前病例状态；页签相关的未完成事实；报告异常值；报告已阅状态；诊断与用药结论状态；完诊门禁和服务端冲突反馈。

生产 Contract 当前没有临床 AI 助手响应。没有受信助手 interface 时，右栏不得显示静态“AI 建议”、模型置信度、自动诊断、自动检验解读或一键生成病历。未来助手必须通过独立受信 interface 返回 Encounter 绑定、来源事实引用、生成版本和可审计建议；采纳建议只能填充对应 owner 的草稿或预览，最终 Command 仍由医生在原页面确认。

### Module 与 seam

重构把当前页面拆为 app 私有的深 Module，而不是把数十个 mutation prop 横向搬到多个浅组件。

```text
DoctorWorkspace
  -> DoctorQueueModule
  -> DoctorCaseController
       -> ConsultationPage
       -> ClinicalDocumentPage
       -> LaboratoryPage
       -> DiagnosisPage
       -> PrescriptionPage
       -> EncounterCompletionModule
  -> DoctorCaseContextRail
  -> CompletedCaseModule
```

`DoctorCaseController` 是 Query、Command、版本和失效策略的 seam。它按页面暴露最小的状态与动作切片，内部继续使用现有 API client 和 TanStack Query；页面不直接拼 query key、expected version、幂等键或跨 owner 失效列表。

`DoctorQueueModule` 拥有分页、选择、报告等待轮询和 Virtual Patient 开始接诊。`DoctorCaseContextRail` 只消费病例快照和 Completion 预览，不提交临床写 Command。各业务页面只调用自己 owner 的动作切片，不互相更新状态。

页面视觉实现继续使用 `@clinmesh/ui` primitive。业务页面、controller 和右栏保持在 `apps/web/src/app/doctor/`；只有出现 Web 与 Desktop 两个真实消费者后，才把稳定业务视图提升到 `packages/views`。

### 迁移顺序

1. 在不改变行为的前提下，从当前文件提取队列、病例 controller、患者横幅、右栏和现有业务页面，保留全部查询键、mutation、错误映射和纠错导航。
2. 替换外壳、候诊队列和患者横幅，使用真实状态验证 Demo 的信息密度与固定区域。
3. 依次迁移 Consultation Record、Clinical Document、检验、诊断和处方；每次只替换一个 owner 的渲染结构，并保持其他页面使用原实现。
4. 接入右侧事实栏和 Completion 预览，移除中央区域重复的摘要、异常汇总和独立进度投影。
5. 覆盖已完诊只读详情、病历修订、报告更正、处方撤回和 correction navigation 后，删除旧页面组合。
6. 单独设计 Doctor Case 的 Hospital Service 投影和受信临床助手 interface；对应能力交付前不开放生产检查页或 AI 建议。

## Alternatives considered

**直接把 `/ui-dev` 组件接入真实 DTO。** 视觉交付最快，但会把 mock 状态、无来源字段、自由输入问诊和静态 AI 文案伪装成业务能力，并绕过现有草稿、签署、确认和纠错生命周期。

**只在当前 `doctor-workspace.tsx` 中替换 class 和布局。** 变更范围较小，但 Query、Command、业务页和视觉组合继续集中在同一个文件，页面之间仍会通过局部状态和失效逻辑耦合，后续修改无法获得 locality。

**让每个页面直接拥有自己的 Query 和 mutation。** 页面表面更独立，却会重复 active case、expected version、幂等键、错误映射和跨 owner 查询失效。病例 controller 应隐藏这些共有机制，并按 owner 提供窄切片。

**立即把医生工作台移动到 `packages/views`。** 这符合目标拓扑，但当前没有第二个实际平台消费者，会产生假 seam 和平台 adapter。先在 Web 内稳定 interface，再按真实 Desktop 需求提升。

**把右栏直接实现为 AI 助手。** 这符合 Demo 视觉，但当前没有生产助手 Contract、来源引用和审计闭环。第一阶段使用确定性病例上下文栏，AI 能力另立决策。

**同时上线独立检查和检验页面。** 用户认知更清晰，但当前 Doctor Case 只完整投影独立检验请求。先迁移已闭环检验，检查页等待 Hospital Service 的病例投影、报告和纠错 interface。

## Acceptance criteria

- 正式医生工作台使用真实队列、病例详情、目录、Completion 预览和现有 Command，不读取 `/ui-dev` mock 数据或本地业务状态。
- 候诊队列、患者横幅、业务页签和右栏在 1280×800 与 1680×941 下无重叠、不可达动作或需要水平缩放的主流程。
- Consultation Record 与 Clinical Document 在页面、持久化和动作上保持独立；问答不能自动成为签署病历，病历也不重复写入问答记录。
- 病历草稿、签署、Revision、诊断确认、处方开具/无需用药/撤回、检验申请/取消/已阅/修订和完诊门禁全部保留现有版本与授权合同。
- 右栏只展示服务端事实或可追溯的确定性派生；没有受信助手 interface 时不显示 AI 建议、置信度或生成动作。
- 生产页面不展示 Contract 未拥有的诊断字段、处方字段、支付事实、检查结果或药房状态。
- 独立检查页只有在 Hospital Service 已进入 Doctor Case 读模型并拥有报告与纠错策略后才可访问。
- 完诊病例保持只读，只有服务端声明允许的 owner 导航显示更正或撤回入口。
- TanStack Query 继续独占服务端状态；页面和 Zustand 不复制病例 DTO，角色、Workspace 或 Epoch 变化后旧响应不能污染当前上下文。
- 每个迁移切片从真实 Web seam 覆盖正常、加载、空、冲突、只读和可逆窗口，并保留用户可见 Web 的浏览器证据。

## Risks

把视觉重构与 controller 提取同时进行会扩大单次 diff，并使行为回归难以定位。迁移应先做行为保持型提取，再按业务 owner 逐页替换，不在同一切片重写多个 Command 流程。

Demo 的六页导航比当前四页更细。若在接口完成前强行拆分检查和检验，页面会出现共享草稿、重复状态或无真实结果来源。导航必须服从 owner interface，而不是服从截图数量。

固定右栏会压缩中央工作区。中等宽度应允许关闭右栏并保留队列与主任务区；移动端不缩放桌面四栏，而使用独立原生信息架构。

当前病例同时存在 legacy 复诊组合流和带 Consultation 的独立 owner 流。重构必须继续按服务端能力选择编辑器，不能用统一视觉外观掩盖两套合同的互斥条件。

页面拆分后容易遗漏跨页面纠错导航、错误绑定和查询失效。controller 的 interface 必须保留病例 ID 与目标对象绑定，切换病例后不得显示上一病例的 pending、success 或 error 状态。
