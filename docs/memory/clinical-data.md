# 临床数据与模型任务排障

处理 SQLite、迁移、持久回执、草稿缓存、来源核验、模型任务、Synthea 或影像素材时查阅。本文记录排障与回归切入点；产品合同由[系统架构](../architecture.md)、[Demo 运行与部署架构](../demo-architecture.md)及条目中的 owning 决策负责。安装与使用步骤分别见[部署指南](../deployment.md)、[影像检查使用指南](../imaging.md)和[病理切片会诊使用指南](../pathology.md)。

其他操作经验见[工程记忆入口](memory.md)。

## SQLite、迁移与持久回执

- 资金预览成功、确认却因金额schema失败时，先统一预览、确认与回执的单笔限额，提前拒绝超限请求并按原限额分笔办理；不要为绕过失败扩大单笔范围。原款总额、累计已退与单笔交易分别验证，回归覆盖限额值、限额加一、分笔后的累计余额及未知恢复，详细合同见[住院出院与结算](../architecture/clinical-workflows.md#住院出院与结算)。

- 仅延后单条迁移、其余 schema 沿用当前版本的兼容测试，固定历史行用显式列名写入，新增可空列交由默认值补齐；真正固定版本的历史库仍固定迁移集合。继续比较完整业务行、归档 JSON、回执及重放行为，见[资金迁移回归](../../apps/server/tests/inpatient-payments-migration.test.ts)。

- 嵌套 SQLite transaction 的内层 catch 写入仍属于外层事务；外层抛错时，拒绝原因等诊断记录也会回滚。需要保留拒绝证据时，在最外层准入回滚后写入，并从公开控制接口验证最近拒绝原因；不要只断言 HTTP 错误码。回归入口见[Host 用量测试](../../apps/server/tests/model-usage-host.test.ts)。

- 构造门诊号迁移的旧库 fixture 时，使用真实 CommandExecutor 生成审计和初始 FHIR 历史；仅手写合法业务行、伪造 audit hash 或漏掉 AuditEvent 投影会被发行历史证明拒绝。业务行最大号是下界，不能用它修复缺失发号状态；旧 reset 的重放 effects 缺口与受控恢复退休边界见[发行完整性决策](../decisions/implemented/architecture/2026-10-20-registration-numbering-integrity.md)。

- 新增迁移后，搜索回归中对“升级到当前版本”的 schema 数量断言，并使用 `expectedSchemaVersion()`，避免迁移成功却因旧数字失败。整合并行分支时，同时核对从历史 fixture 到当前目标的完整待执行文件列表；没有文本冲突的断言也可能遗漏另一分支新增的迁移。除业务迁移测试，还须核对 `database-lifecycle.test.ts` 的空库、旧回执和 CLI 升级清单，以及用排除列表构造历史库的 fixture；同数字前缀的迁移按完整文件名排序，不能遗漏后缀不同的文件。真正固定历史分支的 fixture 仍保留其历史迁移数量，不能一并改成当前目标；升级验证继续核对原业务行、回执、审计、来源和外键。

- 新增持久错误白名单时，用同一幂等键对照首次失败、重放及公开状态，覆盖模型派发前的确定性业务错误；仅覆盖 Provider 错误会漏掉错误分类被兜底改写。患者回答的档案缺失与旧版档案回归见 [问诊 HTTP 测试](../../apps/server/tests/consultation-dialogue-http.test.ts)，当前合同由[临床流程](../architecture/clinical-workflows.md#81-门诊闭环)拥有。

- 构造旧版本 SQLite fixture 时，只复制当时已有的 outbox 事件类型；不能丢弃新任务投影却保留其事件，否则重建任务代次可能撞幂等键并回滚无关业务事务。新增后台事件的调用者测试显式处理已知事件，保留原业务顺序与未知事件断言。

- 同一张 SQLite 表在并行分支分别迁移时，整合须保留已执行 SQL 的文件名和校验和，并验证两条非空升级路径；来源外键、字段 CHECK、rowid 顺序和任务身份都需一起核对。合并后的字段并集不能只改 TypeScript。

- 本地启动报迁移校验和变化时，先对照 `schema_migration`、LF／CRLF 哈希及实际表结构，区分换行与已执行 SQL 被补改。缺列不能靠更新库内校验和解决；已知历史版本通过精确匹配及前向迁移修复，保留原回执，见[增量记录迁移兼容](../decisions/implemented/bug-fix/2026-10-18-incremental-recording-migration-compatibility.md)。

- SQLite 连接在构造成功后设置 PRAGMA 仍可能因文件损坏而抛错。打开函数须在失败分支关闭原始连接，否则上层尚未拿到连接就无法释放，Windows 会在清理损坏备份时持续报 `EBUSY`；沿用数据库恢复回归验证活动库不变、恢复目标不创建且临时文件可清理。

- 新增 SQLite migration 后，先核对 `database.ts` 的文件名筛选与 `schema_migration` 中的实际应用记录；文件存在不代表启动时会被发现。描述部分误用下划线会被当前筛选忽略，表现为新接口缺少列的 500；修正文件名并通过公开 HTTP 验证，不以启动成功代替迁移证据。跨包测试调用默认迁移目录时还须核对工作目录：从 DSH 包运行会把 `apps/server/drizzle` 拼到包内，测试应显式传入迁移目录；排障时可从仓库根用 DSH 的 Vitest 配置复核原用例，区分路径错误与业务失败。

- 新增默认 SQLite 迁移后，同步默认完整升级入口的版本断言，但保留显式历史 migrationDirectory 的固定版本。用当前 runtime 构造旧库时，仅复制旧版能表达的岗位、成员及会话关联，并同时排除后来新增的环境 FHIR current/history/Search 投影；否则会先触发旧 CHECK、外键或重复 seed 冲突，无法验证真正的业务记录升级。回归见[开发库准备](../../apps/server/tests/development-database-prepare.test.ts)与[存量记录升级](../../apps/server/tests/consultation-auto-record-http.test.ts)。

- SQLite 的 `length`／`instr` 按 Unicode 码点计数，JavaScript 文本范围按 UTF-16 code unit 计数；emoji 等非 BMP 字符会使两者偏移分叉。恢复浏览器编辑范围时使用 owning Command 中的 JavaScript 字符串计算，并要求原片段完整且唯一；当前病史范围恢复由[片段归属决策](../decisions/implemented/architecture/2026-10-08-consultation-history-ownership.md)拥有。

- 带不同时区偏移的 ISO 时间不能直接按 SQLite TEXT 比较先后。按时间点比较前先统一为时间戳或规范 UTC，医院日界线另按业务时区计算；回归包含上海 `23:30+08:00` 至次日午夜，见[住院时钟测试](../../apps/server/tests/inpatient-http.test.ts)与[虚拟时钟合同](../architecture/simulation.md#102-虚拟时钟)。

- Command receipt 是跨版本持久数据。响应 DTO 新增必填字段时提供向后兼容默认值或迁移旧回执；删除 strict DTO 字段时投影旧响应，并覆盖提前委托到其他方法的动作分支。回归用原请求与原幂等键重放升级前响应形状，同时检查原回执和审计不变；只验证新命令成功不能发现这类回归。

- 扩展共享 apply 的业务上下文时，逐一回归其公开 Command 包装的岗位边界；共享实现允许住院，不代表旧门诊入口可放行住院岗位。同时构造缺关联的遗留事实，验证系统事件拒绝而正确入口仍可完成；见[授权边界回归](../../apps/server/tests/inpatient-legacy-request-http.test.ts)与[临床合同](../architecture/clinical-workflows.md#82-住院闭环后续)。

- SQLite perf gate 统计数据库、WAL 和 SHM 总增长；同一 Command completion 更新的多个 nullable 关联列若各建独立索引，会放大短事务 WAL pages。优先按真实验证查询建立一个复合索引，并用 `pnpm perf:ci` 证明增长，而不是放宽预算。

- 跨 CRLF/LF 工作区复用 SQLite 时，先区分 SQL 内容改动与换行字节差异。迁移引擎兼容既有 LF／CRLF checksum，新迁移统一记录 LF checksum，不重写已应用记录；仍报 `Applied migration checksum changed` 时须追查真实内容或其他字节差异，不能跳过校验或手工重算原库记录。当前合同见[迁移换行校验决策](../decisions/implemented/bug-fix/2026-10-15-portable-migration-checksums.md)。

- 新增会写入每个 Epoch 的基线数据（例如新的 Hospital Service）时，`perf:ci` 的 `scenario-install-reset-application` 写入行数会变化；该基线上下限相同，需要随基线数据同步更新 `apps/server/performance-baselines.json`。`verify:boundaries` 按文本匹配 `window.`、`document.` 等写法，`packages/core` 与 `packages/contracts` 中不要把变量或参数命名为 `window`。

## 草稿、缓存与正式动作

- 排查检验字段改后又恢复旧值时，分别核对小型本院目录与完整 Reference 目录；小型目录未包含当前项目时，也要保留医生刚选的字段值，不能先取持久草稿盖回。统一字段与恢复归属见[清单决策](../decisions/implemented/architecture/2026-10-18-prepared-clinical-confirmation.md)。

- 后台保存的 pending 只表示暂时不能提交，不应推进同病例编辑器的导航身份或卸载弹窗；否则诊断、处方等自动保存会丢失正在填写的临时内容。输入保留、隐藏挂载与成功回调归属见[统一清单决策](../decisions/implemented/architecture/2026-10-18-prepared-clinical-confirmation.md)。

- 需要跨病例导航复用后台检查时，组件 ref 只能记录当前视图，不能拥有请求身份；身份元数据跟随 QueryClient，完整输入对应的任务由服务端持久化。输入相同的 saved/unsaved 入口共享执行所有权并保留各自版本绑定，不把“复制 pending 状态”当成任务复用；否则刷新或失效后可能留下永久处理中的副本。质控当前合同见[输入归属决策](../decisions/implemented/architecture/2026-10-15-doctor-document-quality-control.md)。

- 排查未保存病历丢失时，分别验证同一工作台内切换病例与工作台卸载重建；不能仅凭没有点击保存就认定普通病例切换会丢失。保存提醒回归同时检查失败、恢复原文和保存后继续编辑，避免陈旧的“已保存”状态误导操作。工作稿归属与持久化边界由[系统架构](../architecture/clinical-workflows.md#81-门诊闭环)拥有。

- React 18 的普通函数组件不会接收 `ref`；共享输入组件需要沿用 `forwardRef`，并用 ShadowRoot 的 `activeElement` 核对真实返回焦点。Query 刷新时重建的 mutation 回执对象不能作为清空草稿的效果依赖，按病例与业务版本处理，并忽略旧回执；删除草稿回归还须覆盖请求未完成时继续编辑、自动保存和迟到的查询刷新。相关回归与决定见[诊断与处方两阶段视图](../decisions/implemented/architecture/2026-10-10-diagnosis-prescription-workspace.md)。

- 新增临床文书字段时，核对活动病历与病例库各自的只读渲染器；草稿、签署和修订数据完整不代表病例库已经展示。回归同时检查签署原件、修订值、主动清空和缺少字段的旧文书，避免固定字段列表遗漏新内容。

- 目录读取失败后，重设相同搜索条件不会改变 TanStack Query key，重试需显式 `refetch`。回归从真实页面观察第二次 HTTP 读取和恢复，不只断言搜索回调被调用。

- 首次自动草稿从无到有时，不能将其未涉及字段的空值当作清空指令；页面预填值与人工输入都须覆盖回归。验证保留后还要保存、刷新，并主动清空再保存，避免修复变成永久恢复默认值。当前病史边界由[增量记录决策](../decisions/implemented/architecture/2026-10-08-consultation-history-increments.md)拥有。

- 校验持久后台任务的 Grant 时，覆盖同一业务结果的所有公开触发路径，尤其失败后的显式重试、暂停恢复和取消签署；不能只检查主入口操作权限。失效回归保留原 Grant 撤销后同一 Client 仍有其他有效 Grant 的场景，防止借用另一授权继续旧任务。 同岗位的不同后台任务可以共享身份基础校验，但保留各自操作白名单，避免为新任务放宽旧任务权限。

- 后台任务回归需要第二位参与者时，建立真实的合成 User Account、活动 Workspace Membership 和岗位授权；只替换 context 的 Actor ID 会被持久身份校验拒绝。保留不同 Actor 使用同一幂等键的原断言，不为旧夹具放宽生产权限；示例见[DSH 模型集成测试](../../apps/server/tests/dsh-model-integration.test.ts)。

- 自动创建草稿的预填回归须覆盖人工保存前刷新、首次进入已有自动草稿，以及保存后主动清空。页面基线和版本号都不能证明是否曾显式保存；当前持久依据见[病史增量决策](../decisions/implemented/architecture/2026-10-08-consultation-history-increments.md)。

- 预填与后台文本合并的回归须覆盖首次自动更新同一个未保存字段，以及其他字段已有自动草稿时该字段才首次更新；同时断言编辑框、保存后的服务端正文和刷新结果，防止界面丢弃新增后又通过保存删掉服务端已应用的内容。当前合并基线见[片段归属决策](../decisions/implemented/architecture/2026-10-08-consultation-history-ownership.md)。

- 把待应用建议改为后台直接写入时，重新验证同一片段的未保存改写与整段自动更新；字符差异互不重叠不证明语义可以拼接。回归须覆盖完整新事实、连续更新、保存及刷新；病史当前取舍见[未保存病史合并决策](../decisions/implemented/bug-fix/2026-10-14-consultation-unsaved-summary-merges.md)。

- 签署冻结等异步业务边界须等待真实预览和持久准备状态生效，再读取快照或释放在途替身；`click()` 完成不能证明对应 Command 已提交。保留冻结、取消恢复和最终签署断言，不用固定等待替代完成屏障。

- 自动记录的人工冲突回归同时覆盖纯手写病史和已改写自动片段的当前文本；仅提供患者原话无法证明当前手工内容参与比较。来源校验与冲突比较分开验证；并发既要覆盖旧目标修改，也要覆盖模型请求后新增人工矛盾、持续编辑后的有界失败与显式恢复。核对范围覆盖新增限定语、人工扩写多句及独立句子的无关编辑，防止旧建议替换新人工内容或删除无关句子。当前边界见[人工病史冲突决策](../decisions/implemented/bug-fix/2026-10-12-consultation-manual-history-conflicts.md)。

- 旧数据惰性恢复的回归先通过公开 Query 取得标识，再直接执行对应 Command；同时检查读取不落盘、失败事务不改状态和重试仍可使用公开标识。只在保存或新任务之后验证会掩盖标识在恢复中被替代的死循环，当前病史恢复见[片段归属决策](../decisions/implemented/architecture/2026-10-08-consultation-history-ownership.md)。

- 目录表格同时支持行双击确认和行内选择切换时，选择按钮须阻止 `dblclick` 冒泡，避免快速选中再取消触发行确认。药品包装切换只更新当前选择，不复用取消选择逻辑。

- 持久准备的取消回归须覆盖服务端已提交但响应丢失，以及其他会话先消费同一准备的场景。仅验证明确失败后重试不足以证明恢复：还要重新读取已提交状态，确认本地旧预览不会继续锁住编辑或遮挡恢复入口；重试同一取消意图应能复用幂等回执或根据最新读取结束失效的本地准备。

- 异步创建人工审阅前，先检查 `AbortSignal.aborted` 和当前病例／Actor 范围；给已经终止的 signal 注册事件不会补发 abort。若先前请求已创建持久准备，提前退出也必须尝试取消，并保留 Query 恢复入口。回归覆盖预览返回前终止和切换病例。

- TanStack Query 的 `invalidateQueries` 默认不抛出刷新失败，不能靠它把成功写入同步到界面。保存成功后先校验并应用服务端返回的已提交值与 revision，取消可能覆盖该值的旧读取，再刷新目录。有缓存数据的后台读取失败也会设置 `isError`；错误分支须区分首次加载、暂时读取失败和权限失效，且按已提交状态决定后续轮询，避免恢复已成功却只能重载页面。用户偏好：设置已经保存成功且界面保留已确认值时，只提示“已保存”，后续自动刷新失败静默处理，不展示“已保存但刷新失败”等内部同步提示；首次加载和实际保存失败仍须明确反馈。回归同时覆盖设置读取失败、目录读取失败、失败后的再次保存和延迟到达的旧响应，避免界面与实际生效值分叉。

- 合并 Command 回执与 Query 缓存前，先确认版本号覆盖的事实范围。记录控制版本不随后台进度、编辑归属或显式保存推进，同版本的迟到控制回执不能整块覆盖已经读取的新状态。回归组合覆盖回执延迟、期间读取新状态、后续读取失败及切换病例后返回，并检查显式保存的空字段是否被旧预填恢复。

- 排查 Agent 代问后病历未更新时，用 Tool 回执的 `patientTurn.id` 关联实际病例、记录任务与增量，并对照控制 Command 的时间；先确认人工提问和 Agent 提问是否发生在同一病例及相同记录状态。`outbox_event.status=completed` 只证明事件已结束，病史整理可能已经失败，须同时核对 `consultation_recording_job` 和失败 Command。暂停会重置未完成任务的当前错误码，既往失败应从 Command 记录追溯。耗时诊断同时核对排队、outbox 的真实创建／完成时间、尝试次数和失败回执；患者来源的 `recorded_at` 可能是虚拟时间，不能据此计算真实等待，后续来源的事件也可能直到前一任务结束才创建。启用、补录与恢复合同见[问诊自动记录规格](../spec/2026-10-08-consultation-auto-record.md)。

## 模型、来源与后台任务

- 模型成功步骤缓存启用后，确定性临床约束（如检验值、参考区间与高低解释的一致性）须进入 Provider 的 `validate`，不能只在缓存返回后拒绝结果，否则结构合法但临床矛盾的正文会被持久标为成功并反复复用。保留后置门禁及原安全错误码，通过异常 `cause` 精确还原自身领域错误；替身也须执行 `validate`。回归核对无效结果未进入成功检查点、未生成报告和原实际请求次数，参见[检验生成回归](../../apps/server/tests/synthetic-case-http.test.ts)。

- 模型任务失效后丢弃迟到结果，不等于取消实际 Provider 请求。把失效信号贯通模型绑定、生成与格式修复，并在任务结束后释放状态订阅；回归须在放行受控 Provider 前断言取消，再检查未完成来源与恢复处理。自动记录机制见[常规模型等待决策](../decisions/implemented/architecture/2026-10-18-recording-normal-model-budget.md)。

- 模型语义核对的否定结论是合法结果，结构化输出 `validate` 只校验完整性和形状；在请求完成后处理否定结论。把否定结论当成可修复格式错误，会诱导模型对同一候选改成通过。病史总结采用此边界，见[多轮溯源决策](../decisions/implemented/architecture/2026-10-12-consultation-agent-summary-sources.md)。

- 验证自然语言来源时，原文归属与完整引用属于确定性边界，事实是否成立属于语义边界；不能用句末问号排除同句中的明确自述，也不能删标点或截断引用规避检查。回归同时提供完整混合句、纯提问和错误肯定总结，确保合法来源确实到达独立核对，而否定结果不触发格式修复；当前病史规则见[多轮溯源决策](../decisions/implemented/architecture/2026-10-12-consultation-agent-summary-sources.md)。

- 单来源升级为多来源时，逐一检查拒绝重放、去重和更正判定是否仍只读取代表引用；回归组合引用重排、拒绝后重启、旧证据重放与新轮次再次提供证据，并把更正引用放在其他事实之后。句界校验不能用 `trimStart`／`trimEnd` 擦除 CR、LF，来源校验和持久锚点应共用规则，同时覆盖两种换行。病史总结的当前边界由[多轮溯源决策](../decisions/implemented/architecture/2026-10-12-consultation-agent-summary-sources.md)拥有。

- 模型返回合法空结果时，先检查该模式的必需输出是否仍被 schema 声明为可选，再判断是否过度保守。模式专用请求可强制显式数组，并将来源编号枚举限定为本轮实际输入；新增 schema 字节仍计入预算，运行时来源与语义核验继续保留。诊疗建议的当前合同见[临床说明决策](../decisions/implemented/architecture/2026-10-16-clinical-explanations.md)。

- 来源许可核验不能替代部署用途核验；非商业等受限全文默认关闭，显式用途声明必须贯通实际读取、幂等回执重放、同步统计与缓存失效。只修改许可说明而不约束模型输入，会让其他部署越过原本已确认的使用边界；指南的当前取舍见[全文用途决策](../decisions/implemented/architecture/2026-10-16-free-guideline-corpus.md)。

- 模型超时配置须贯通 Provider、宿主请求、持久任务总预算和 outbox lease；一次结构化生成的修复与限流恢复共享原始截止时间，服务关闭取消与模型超时分开处理。回归同时覆盖剩余预算内修复、耗尽后不再调用和宿主主动超时，不用单层配置或本地 AbortSignal 代替整链证据。当前时限见[有限恢复决策](../decisions/implemented/bug-fix/2026-10-16-recommendation-record-selection.md)，任务与失败边界见[自动病史调用决策](../decisions/implemented/bug-fix/2026-10-08-consultation-model-output-budget.md)。

- 病史任务反复报来源无效时，回归须组合真实记录服务与 DSH Provider，核对领域校验是否进入修复反馈；仅验证 JSON schema 或用忽略 `validate` 的 Provider stub 会漏掉无反馈重试。覆盖修复后成功、修复耗尽后停止及显式重试，仍验证完整逐字来源和不确定表述拒绝，见[自动病史调用决策](../decisions/implemented/bug-fix/2026-10-08-consultation-model-output-budget.md)。

- 校验失败诊断的回归须穿过真实 Provider 适配器并检查持久失败回执；直接抛领域错误的替身会漏掉异常包装造成的原因丢失。具体边界见[直接记录决策](../decisions/implemented/architecture/2026-10-14-consultation-direct-recording.md)。

- 批次候选隔离回归须同时穿过 Provider 的 `validate` 回调，并混入来自不同来源的合法候选；仅测试逐项解码会漏掉上游整批校验，只有正文断言也会漏掉成功来源被误记失败。另组合不合格候选与同目标竞争替换，避免过滤顺序破坏原子性；当前边界见[增量记录决策](../decisions/implemented/architecture/2026-10-15-low-latency-document-recording.md)。

- 模型摘录的逐字匹配不能单独证明事实完整。引用边界回归同时覆盖限定语与疑问号在引用外、句间空白、逗号和小数点位于引用首尾，避免通过截断制造肯定事实、改变测量值或拒绝完整陈述；当前写入规则由[病史增量决策](../decisions/implemented/architecture/2026-10-08-consultation-history-increments.md)拥有。

- 同一引用可能先出现在长句内部，再以完整句重复；引用校验回归同时覆盖后续合法匹配和全部匹配不合法。普通新增去重还须覆盖同一来源、同批和新回答的句尾表示差异，保持持久标识、不同更正目标及新来源拒绝证据的独立性；当前边界见[病史增量决策](../decisions/implemented/architecture/2026-10-08-consultation-history-increments.md)与[片段归属决策](../decisions/implemented/architecture/2026-10-08-consultation-history-ownership.md)。

- 引用校验允许跳过不完整的首次匹配时，来源高亮也必须使用同一合法完整句定位；只用 `indexOf` 会高亮否定句内部的局部文字。浏览器回归须断言高亮前后的完整原文位置，不能只检查 `<mark>` 中的文字；当前规则见[多轮溯源决策](../decisions/implemented/architecture/2026-10-12-consultation-agent-summary-sources.md)。

- 多来源总结的拒绝回归须混入无关新事实，不能只验证全部引用已拒绝的重放；同时覆盖恢复前一版本、一个事实混用旧新引用、多事实共用引用、处理中撤销和患者再次提供同一事实。新引用只能支持对应事实，不能解除同组其他旧事实的拒绝；当前过滤与核对边界见[多轮溯源决策](../decisions/implemented/architecture/2026-10-12-consultation-agent-summary-sources.md)。

- 单来源模型流程改为批次后，同步核对提示词中的“本次来源”范围，不能只新增复数 ID 字段却继续按最后一个 ID 判断。回归检查实际发给 Provider 的提示词、完整来源与请求次数，覆盖首份新来源重新支持旧拒绝事实、末份来源无关和单来源兼容；提示词合同测试不能代替真实模型语义准确度评估。

- 增量去重回归同时覆盖重复投递、同批重复、同句多目标更正，以及拒绝后的句界表示变化和新来源再次提出相同措辞。正常增量与拒绝证据不能共用去重范围；增量身份与普通事实去重见[片段归属决策](../decisions/implemented/architecture/2026-10-08-consultation-history-ownership.md)，拒绝证据见[审阅和撤销决策](../decisions/implemented/architecture/2026-10-10-consultation-history-review-undo.md)。

- OpenRouter 部分模型（尤其 free 档）不支持结构化输出，`response_format: json_schema` 请求固定 400，tool call 输出可能整段缺失必填字段或返回空串且每次不同。`completeJson` 的 `validate` 回调是内容质量闸门，新增调用点必须传与后续 `parse` 相同的 Zod schema（`safeParse(value).success`），否则可解析的坏 tool-call 内容会掩盖后续 prompt 降级策略。生成类 `*_RESPONSE_INVALID` 报错先用 `patient-persona-live-smoke` 复现并确认模型的 structured outputs 支持情况。

- 诊疗资料读取的性能测量必须经过公开 HTTP，计入授权、重复 prepare、分页、解析和装配；只比较裸 SQL 的 N+1 与 JOIN 可能低估数量级。先以 SQL 数量与阶段耗时定位，再在保持医生历史索引和白名单边界的前提下批量读取。新增质控等调用者须核对是否复用批量路径；“不等待模型”仍可能因同步历史装配拖慢切换患者和轮询。产品合同由[分批证据读取决策](../decisions/implemented/architecture/2026-10-15-recommendation-context-budget.md)和[质控输入归属](../decisions/implemented/architecture/2026-10-15-doctor-document-quality-control.md)拥有。

- 真实模型性能验收不能直接复用 `apps/server/tests/browser-server.ts` 的 `startBrowserServer`：该 fixture 会包装语义核对替身。需要显式装配真实 Provider、真实 Hono listener 与临时 SQLite，并从真实页面读取持久化结果；确认所有模型阶段均经过真实 Provider，再报告性能。最小探测也须先通过实际桥接请求 schema，使用允许的 schemaName；请求校验失败同样可能返回安全的 `MODEL_UNAVAILABLE`，不能据此判断 Provider 不可用。

- 多客户端长轮询压测使用每客户端独立的 Playwright BrowserContext。多个页签共用会话会争用 Chromium 每源的 HTTP/1.1 连接池，让长轮询挤占正常 Query 连接；这不能代表不同浏览器客户端的服务器负载。观测循环用来源索引查找样本，避免随来源增长反复线性扫描全部样本。报告须记录客户端隔离方式、实际注入耗时和迟到情况，并把提交到页面可见的等待与模型耗时分开。

- 并发队列的定时器只启动空闲槽位，不要每个 tick 都创建等待全部通道的排空调用。慢通道会积累大量等待者，结束时集中唤醒并重复调度，短测可能正常、持续负载才出现峰值；使用假时钟和受控慢通道，断言释放后新增调度调用仍有界。手动排空可复用槽位内的在途任务，但每次调用仍须启动空闲槽位；全局合并排空调用会让新来源等待无关的慢通道。

- 真实模型排障先通过当前宿主 resolve 核对本次 Provider、模型和实际端点，历史绑定或另一条路由的结果不能代表当前配置。OpenAI 兼容网关的 baseURL 使用其实际 API 根路径（常见为 /v1）；HTTP 200 可能是网页，静态模型目录与 SSE 保活也不能证明生成成功。用同一凭据和最小合成请求对照代理、直连及真实模型桥，分别记录 401、429、有效数据帧和正常终止，不用扩大超时掩盖配置错误或上游限流。

- 实模返回 `AI_RESPONSE_INVALID` 时先保存安全的形状、未知编号、重复编号和完整读取标志计数，区分 JSON 形状失败与来源成员校验失败；不记录模型正文、凭据或完整医疗内容，不通过放宽引用校验让失败变为成功。记录级选择的运行合同由[对应决策](../decisions/implemented/bug-fix/2026-10-16-recommendation-record-selection.md)拥有。

- 病历质控提示“超出检查范围”时先核对持久状态的 `failure.stage/reason` 与策略版本；`invalid-scope` 指候选检查项目越界，不等于输入太长。对照实际发送的 schema、运行时条件和有界纠正路径，检查是否缺少候选或引文索引、完整句界说明；同输入失败会复用，须区分普通刷新与显式重试。合同由[病历质控决策](../decisions/implemented/architecture/2026-10-15-doctor-document-quality-control.md)拥有。

- 按内容哈希去重前，先用完整业务 schema 规范化有效候选；首尾空格和 JSON 字段顺序不能制造竞争替换。不合格候选仍参与共享目标冲突判断，不能为去重先过滤掉坏候选而破坏原子拒绝；自动记录的归属与回归由[增量记录决策](../decisions/implemented/architecture/2026-10-15-low-latency-document-recording.md)拥有。

- 模型传输引用的编号差异不能直接当作业务内容差异；回归同时覆盖同来源重复原句、不同来源同文和多个无效编号，验证解码后的等价去重、来源独立性及失败归属。句子引用的当前规则由[句子引用决策](../decisions/implemented/architecture/2026-10-19-recording-sentence-references.md)拥有。

- 测试包装实际模型 Provider 时必须透传 `supportsRequestControl` 与 `supportsUsageAccounting` 能力，或直接注入实际 Provider；只包装 `completeJson` 却转发底层 hook 会让兼容层和底层重复预占同一次请求。格式修复回归应同时断言请求次数与业务结果，避免误判为输出校验失败。

## 参考目录、Synthea 与影像素材

- 以编码字符串查询 JSON 参数字典时先用 `Object.hasOwn` 检查自有键；直接读取 `table[code] !== undefined` 会把 `toString` 等原型属性误当有效编码，导致 CC/MCC 等计算伪命中。对应分组公开接口保留原型键回归；规则与编码边界见[DRG 条件分组](../architecture/drg-grouping.md)。

- 离线清单的合成 fixture 要沿用真实来源字段名，并从公开准备与回读入口核对；只用自拟的通用 `unit` 字段会漏掉来源单位提取缺口。摘要提取修正后重新准备已有资料时，先核对清单身份，恢复方式见[离线 DRG 资料核对](../deployment.md#离线-drg-资料核对)，不要修改数据库绕过不可变校验。

- 验证离线清单读取的失败审计时，用已认证管理员发送非法分页参数，再从公开 FHIR AuditEvent 回读失败事件；只断言 HTTP 400 会漏掉路由提前解析参数、绕过服务层审计的缺口。认证拒绝与进入受信读取边界后的参数拒绝分别验证，合同见[参考数据策略](../architecture/fhir-and-commands.md#54-中国术语与参考数据策略)。

- 核验数十万行 JSONL 时，把可复用的 Zod schema 放在行循环之外；逐行新建递归 JSON schema 会增加大量 CPU 开销。性能改动仍须保留每行解析、原始字节哈希和行数校验，并通过真实运维入口复核整个包。

- JSON 摘要若用 `JSON.stringify` 计算内容哈希，先按持久化 schema 规范化再哈希；Zod object 解析会按 schema 顺序重建字段。只测首次写入会漏掉“写入成功、再次读取哈希失配”，应覆盖每种来源的重复准备和公开回读。

- 解析 OpenDRG 导出时，缺少分组程序的方案会以 `null` 表示 `grouperSourceUrl/groupDataPath`；先允许来源的缺失表示，再强制所选方案具有已锁定程序和参数。参数文件的 `SS_VALID` 是字符串数组，`CC/MCC/CCE` 是对象；合成 fixture 应覆盖这些真实形状。自动资料核对及运行时不执行来源程序；完整条件的显式离线对照见[DRG 条件分组](../architecture/drg-grouping.md)，资料用途边界见[参考数据策略](../architecture/fhir-and-commands.md#54-中国术语与参考数据策略)。

- `pnpm reference:sync` 固定写入默认路径 `.data/clinmesh-reference.sqlite`，不读取 `.env` 的 `CLINMESH_REFERENCE_DATABASE_PATH`；`.env` 指向自定义路径时会与同步结果分叉，出现"诊断药品正常、检验目录为空"（旧 Release 不含 `laboratory-cn`）。排查时直接查库：`reference_release` 表按 `release_id` 看 `laboratory_definition_count`。当前 Release 默认取 `reference-data.lock.json` 的 `compositeRelease.releaseId`，不要在 `.env` 手抄该 ID 制造双事实来源；运行中 Server 不热切换参考库，修复后必须重启。

- 影像流水线经代理访问 TCIA 时须设置 `NODE_USE_ENV_PROXY=1`；Node 的 `fetch` 默认不读取 `HTTPS_PROXY`，缺少该变量时 `pnpm imaging:sync` 和 `imaging:record` 表现为连接超时。下载在后台运行并轮询结果文件，不在前台阻塞等待。

- 影像与病理素材文件校验为 `ready`，但覆盖清单全部显示 `REVIEW_STALE` 时，先核对报告规则文件的换行字节；它们按原始字节参与复核签署，Windows 的 `core.autocrlf` 转换会使签署失效。`.gitattributes` 为两个素材包的 `prompts/*.md` 固定 LF；既有检出仅在确认内容与 Git 一致后恢复 LF，不通过重新签署掩盖字节变化。定向病例不显示时分别检查运行中 Provider 的 `targetedGeneration` 和定向条目接口是否为空；Docker 已启动不代表运行中的容器已使用 Compose 当前指定的镜像。

- 病理素材流水线从 IDC 公开存储桶（`idc-open-data`）匿名下载，经代理时同样需要 `NODE_USE_ENV_PROXY=1`；一个 20 倍实例可达数百 MB，来源客户端按区间下载并只重试失败的区间。会话的 `/tmp` scratchpad 会随机器重启清空：需要跨重启保留的下载缓存和研究数据放在仓库的 `.data/` 下，其中不放测试或脚本文件。清单条目里的临床字段从重新下载的来源文件转录并登记文件哈希，不凭记忆填写。

- `jpeg-js` 解码三分量 JPEG 时，`colorTransform` 缺省会把 Adobe APP14 transform=0（RGB）的码流当作 YCbCr 转换；需要按码流标记显式传入。`@cornerstonejs/codec-openjpeg` 的 Emscripten 模块默认逐瓦片向标准输出打印 INFO，创建模块时传入空的 `print` 与 `printErr`。验证真实切片的颜色解释不看像素：解码已安装层级后统计通道均值与近白像素比例，H&E 组织像素的红、蓝明显高于绿，背景接近白色。

- 验证真实影像时不读取像素或截图：用 Playwright locator 或文字快照核对报告、状态和控件，用页面内脚本返回 canvas 尺寸、非零像素比例、均值和翻片前后的校验和变化等聚合量。帧切换计时以 canvas 内容发生变化为准，页码文字会先于像素更新。

- 合成 fixture 须贴近 Synthea 的真实导出形态。Synthea 在导出时已写下之后的病程：本次就诊诊断的急性病带有就诊之后的 `abatementDateTime`。按“字段是否存在”判断状态的规则在 fixture 上通过、在真实病例上全部失配；涉及来源时间的规则以 Index Encounter 时间为界，并用真实 Provider 生成的病例验证一次。

- `PERSONA_DIAGNOSIS_LEAK` 的失败输出不会保存，错误码本身不能证明模型真正泄露。先核对可见既往史与隐藏诊断术语，使用合成文本复现“已知病名中包含禁词”和“已知并发症已命名基础疾病”的误判，并同时验证另一处新增诊断、未知子型和编码仍被拦截。删除标点的归一化可能把不同分句拼成已知病名；禁词豁免须保留分句边界，回归同时覆盖跨分句泄漏和用标点拆开诊断的绕过尝试。

- 按年份偏移日期时，替换年份字符串会产生无效的 2 月 29 日，JavaScript 的 `setUTCFullYear` 则会自动进位到 3 月；需要月末截断语义时，使用 UTC 日历运算并把进位结果退到原月份最后一天，回归包含非闰年与世纪年份。

- 用模块过滤让 Synthea 定向生成病例时，一个批次中任一患者死亡会让 Provider 返回 502，任一患者没有合格的 Index Encounter 会让整个任务以 `INDEX_ENCOUNTER_NOT_FOUND` 失败。定向搜索使用 `count: 1` 的多个任务并更换 seed；低患病率疾病（如存活的肺癌患者）每个任务最多内部重试十次，耗时按分钟计；更快的做法是先在 Provider 镜像的临时离线容器里用与 Provider 相同的 Synthea 命令行并行预筛种子，命中后把同一组 population/clinical seed 提交给正式生成任务，得到的患者一致。Synthea 的肺癌模块只在 45–65 岁发病且数年内死亡，存活患者集中在 48–66 岁。

- Synthea keep module（`-k`）的内部重试只重跑临床模拟，患者的年龄、性别等人口属性在第一次抽取后固定；抽到无法满足条件的年龄时会耗尽 `generate.max_attempts_to_keep_patient`（默认 1000，约 100 秒）后放弃；放弃时进程仍以 0 退出，只是导出的患者少于请求数（全部落空时连 `fhir` 目录都没有），判断依据只能是导出数量。定向生成必须由外层换 seed 重试，并用较窄的年龄范围提高命中率；不要只靠调大内部尝试次数。

- Synthea GMF 的 `Observation` 条件在患者没有该 Observation 时做值比较会抛出 `NullPointerException` 并中止整次运行（只有 `is nil` / `is not nil` 不抛）；`And` 按书写顺序短路。写进 keep module 的 Observation 取值条件必须先放同一编码的 `is not nil`，再放 `==` 比较；编码值比较要求 `value_code` 的 system 与模块中一致（SNOMED 为 `SNOMED-CT`），类型不符的比较同样抛出异常。

- 给既有 Scenario 增加环境或岗位时，验证已经 reset 到后续 Epoch 的旧库重启；装配入口必须补当前 active Epoch，且认证 binding 与 FHIR Practitioner/Role 均存在。新库 seed 通过不能代替旧库升级证明，见[住院建档决策](../decisions/implemented/architecture/2026-10-20-inpatient-admission-owner.md)。
