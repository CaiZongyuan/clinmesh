# 存储与事务

本文拥有 FHIR 与领域存储、标识符、SQLite 事务、outbox、附件、数据库运维与迁移，以及模型调用账本和浏览器未提交私稿存储边界。系统总入口见[系统架构](../architecture.md)，业务验证要求见[测试策略](../testing.md)。

## 数据架构

### FHIR Resource Store

当前使用统一 current/history 表，不按资源类型拆表：

```text
fhir_resource(workspace_id, epoch, resource_type, resource_id, version_id, last_updated, deleted, owner_kind, content_json, content_hash)
fhir_history(workspace_id, epoch, resource_type, resource_id, version_id, last_updated, deleted, content_json, content_hash)
fhir_sp_string(workspace_id, epoch, resource_type, resource_id, param, normalized, exact)
```

`fhir_resource` 主键为 `(workspace_id, epoch, resource_type, resource_id)`，`fhir_history` 主键追加 `version_id`。写时 Search 索引仅有 `fhir_sp_string`，统一承载 Patient `name`/`identifier` 及[FHIR Search 最小实现](fhir-and-commands.md#55-fhir-search-最小实现)登记的本地相对引用参数；每次资源变更在同一事务整组删除旧索引并插入新索引，数据库 CLI `reindex` 可完整重建并验证。运行时不执行任意 FHIRPath，FHIR 授权隔离必须下推 SQL 查询。

### 领域表

所有租户运行事实表的表结构、主键、唯一键、外键和岗位队列索引均以 `(workspace_id, epoch, ...)` 开头（删除默认 `RESTRICT`）；新增 FHIR-native 辅助索引必须可由权威资源重建，无法重建的事实必须明确成为 domain aggregate，禁止 FHIR JSON 与领域表双向拥有。各领域表边界如下：

- **身份与平台仿真**：Better Auth 账户会话、Workspace Actor／Membership、Agent Client／Grant、岗位绑定与当前 session context；Workspace/Epoch、Scenario Run/State、跨 Epoch 不可变的 Synthetic Profile/Case/Persona/Investigation Snapshot、私有 Case Truth、Command Receipt/Effect、Audit、Action Trace、Outbox 及 Agent Page Context／Tool call／proposal／review。
- **门诊与文书**：Consultation、append-only Consultation Record、目录、挂号与门诊 case、分诊、各诊疗草稿、诊断确认分组、检查申请草稿与正式申请、Prescription／外延处方／无需用药／撤回，以及结构化病历草稿、签署预览和修订父链（已签 `Composition`、`Bundle`、`Provenance` 正文由 FHIR store 权威保存）。
- **住院、手术与病案**：Admission、住院证、病区床位与时间段占用、诊断编码快照、长期／临时医嘱与校对／给药关联、出院／召回／清床事件、不可覆盖结算快照；手术申请、两项准备确认、唯一实际实施、`inpatient_surgery_material`、`inpatient_surgery_material_record`（`recording_kind` 区分 `initial` 与 `postoperative-addendum`）、`inpatient_surgery_material_correction`（唯一引用原使用并关联费用／冲正）及耗材预留消耗与 `release_reason`（完全消耗的 replaced 项仍保留关闭选择）；按依据指纹去重的 `inpatient_drg_review_revision`、`inpatient_drg_review`、`inpatient_drg_review_todo`（`task_id` 仅作来源去重标识，不强绑跟进任务）与 `inpatient_drg_review_action`；按 Workspace/Epoch/Patient 持久分配的病案号与 `inpatient_record_revision`、`inpatient_record_review`、`inpatient_record_archive` 三张 append-only 病案表（归档快照独立于活动 Patient 与目录，见[住院与手术流程](inpatient-workflows.md)与[住院闭环模型决策](../decisions/implemented/architecture/2026-10-21-inpatient-closed-loop-model.md)）。
- **跨门诊与住院的检查上下文**：`clinical_request_context` 以复合外键严格绑定门诊 case XOR 住院 admission，保证检查申请拥有唯一真实 owner（兼容保留 `case_id` wire 字段），`clinical_request_source` 只读投影合成病例来源。
- **库存与发药**：`InventoryLot`、append-only `InventoryMovement` 与 `Dispense`；库存余额归 `InventoryLot`，每次库存移动恰好关联门诊处方或住院实际发药单之一，不实现预占、追溯码、盘点或调拨。

#### 门诊独立检查计费策略

`outpatient_investigation_billing` 以 `(workspace_id, epoch, request_id)` 为主键，复合外键关联原申请、门诊 case 与唯一原 `ChargeItem`；`payment_policy` 区分 `prepaid-v1`（冻结开立时不可变 `price_json`）与历史升级兼容的 `legacy-unbilled`（住院不取得门诊计费策略）。检验、放射与病理草稿分别冻结服务与当前价格，开立时校验目录版本；首次受理在同一事务同时保存 `released_at` 与 `release_json`（记录原费用身份、版本、金额及实收／医保覆盖依据），读取边界严格校验 JSON，缺失或不完整记录绝不解释为历史豁免，业务门禁见[检验、检查与报告](examinations-and-reports.md)。

#### 门诊收款记录

门诊与住院共用 `PaymentCollection` 交易表（`collection_transaction`、`collection_tender` 与唯一追加确定结果的 `collection_resolution`）及 `RefundLedger` 原款退款表（`refund_transaction`、`refund_tender`、`refund_resolution`），所有金额以整数分保存且拒绝业务 Command 事务外写入：

- **单项与多费用合并收款**：`payment_preview` 保存单项费用预览；`multi_charge_payment_preview` 独立保存同次门诊的多费用冻结预览（绑定 `outpatient_case`、预期版本集合、逐项快照、组合方式、token 摘要与真实期限），旧单项确认路径不能消费合并预览。`outpatient_payment_allocation` 以 `(workspace_id, epoch, payment_id, charge_id)` 为主键关联原交易与同一就诊 Charge Record，合并原款为每项冻结费用写一行且合计等于原款金额；账单历史先按 `(workspace_id, epoch, case_id, created_at, payment_id)` 复合索引按整笔原款分页，再批量读取当前页分配与方式，恢复 Command 仅按单笔原 payment ID 定向查询，事务读取量不随历史增长，见[收费、结算与医保](billing-and-insurance.md)与[门诊多费用合并收款决策](../decisions/implemented/architecture/2026-11-10-outpatient-multi-charge-collection.md)。
- **住院预交金、首次结算与后续财务更正**：住院登记现金预交金、追加预交金、首次结算补收与结算后补收均写入共同交易表，`inpatient_payment_allocation` 绑定原住院、原预览及可空的 `adjustment_id`；成功预交金唯一入账 `inpatient_deposit`，首次补缴反向投影 `inpatient_collection_supplement_refund` 关联新原款分配与原退款；结算后补计／冲减追加于 `inpatient_financial_adjustment`，绝不改写原 `ChargeItem`、首次结算 JSON 或病案归档，见[住院资金与首次结算决策](../decisions/implemented/architecture/2026-10-22-inpatient-funding-and-first-settlement.md)。
- **原款逐分配退款**：`refund_transaction` 通过 `source_kind + source_id`、`basis_id` 与 `owner_kind + owner_id` 绑定原款、退费依据和就诊；`outpatient_refund_preview` 非空绑定原 `collection_transaction` 与指定分配 `charge_id`。`RefundLedger` 按成功退款扣减、按未知退款预占原款各方式余额与该费用分配额度，防止并发超退。

#### 患者医保待遇记录

`insurance_preview` 保存受信岗位摘要、token 摘要、真实期限及冻结费用、目录和年度账户预览。`insurance_event` 保存 Workspace/Epoch、Patient、年度、目标及不可覆盖的待遇快照和有符号影响（`reverses_id` 唯一引用原结算实现逆向撤销），账户余额与门诊／住院年度累计全部由事件计算，不保存第二套可编辑余额。住院结算后医保更正由 `inpatient_insurance_adjustment` 复合外键关联财务调整、原待遇、补偿与替代待遇（每个财务调整最多一条更正链，每个有效待遇最多补偿一次），详见[收费、结算与医保](billing-and-insurance.md)。

#### 模型执行恢复

- **自由问诊回复**：`consultation_reply_attempt` 通过局部唯一索引保证每个医生轮次只有一个 `executing` 尝试，`consultation_reply_intent` 按 Actor／operation／幂等键关联调用者回执；控制阻塞同事务保存 `MODEL_CONTROL_BLOCKED` 与 `model_reply_wait` 恢复输入，启动时将缺少匹配待办的遗留阻塞与崩溃尝试统一转为 `unknown`（仅允许医生显式发起新补答），读取时已保存患者回答始终优先于尝试状态。
- **诊疗建议与通用模型步骤**：`doctor_recommendation_execution`（含 `_plan`、`_unit`、`_continue`）与通用 `model_task_step`／`model_task_wait` 以 `(workspace_id, epoch, ...)` 复合键隔离保存完整输入指纹、每次外部派发前短事务原子预占的单元／额外次数、结构化输出安全分类 `invalid_code` 与控制拒绝码 `blocked_code`。派发后崩溃窗口保留占用并落为未知，禁止自动重发；人工继续意图仅为一个未知、失败或 `MODEL_RETRY_DISABLED` 单元持久保存单次 `resume_available` 授权并在准入事务内与请求预占原子消费，不重置预算。动态额度拒绝在进程内缓存最多 4096 项政策快照（配置缺失以 `runtime-restart` 区分，重启前不因周期轮询唤醒），政策变更、核对结算或淘汰重启后安全重评；`model_host_wait` 仅保存已验证 Host 任务 claims 与 1 秒心跳租约供状态观测。详见[临床决策支持与质控](clinical-decision-support.md)与[模型请求控制与恢复决策](../decisions/implemented/architecture/2026-10-21-model-request-control-recovery.md)。

### FHIR 投影

当前 `domain-projection` 包含 `AuditEvent`、`InventoryItem`、`ImagingStudy` 和 `Procedure` 四类资源，以稳定 logical id 直接关联审计、库存、影像检查或手术实施事实（不另建 `domain_resource_link` 表），与领域写入、Search 索引、历史版本在同一 SQLite 事务原子提交；投影失败则整笔 Command 回滚，HTTP FHIR generic 写请求一律拒绝。

<a id="94-标识符"></a>

### 标识符

- 在线新建的 FHIR logical id 使用 UUIDv7 文本；确定性 scenario fixture 使用预分配 ID 或 `scenario version/seed + logical key` 派生的 UUIDv5，对外只暴露 FHIR logical id。
- 患者号、门诊号、住院号、病案号存于对应主体的业务列或 `Identifier`（含稳定 `system` URI、用途与分配机构），不充当数据库主键；患者合并保留源 `Patient` 并以 `link` 表达，禁止改写历史 ID。

#### 门诊号发行状态

门诊号格式为 `CM-OP-YYYYMMDD-流水号`（至少六位，超六位自然增长），在普通挂号、合成病例开始及 Epoch 重放的同一 Command 写事务内分配并提交（同键重放不再发行）。`registration_number_counter(visit_date, high_water)` 跨全部 Workspace/Epoch 保存全库按日已提交高水位，业务删除与 Epoch reset 不清理它；单例 `registration_number_authority` 保存权威 ID、`active`/`retired` 状态与全量计数器规范化 SHA-256 摘要，缺行、摘要损坏、已退休权威或安全整数容量耗尽均拒绝发号，绝不从现存业务行猜测重建。历史库迁移须先校验完整审计链、初始 `AuditEvent` 投影与全部历史 Encounter 号码后才汇总高水位，证据不足返回 `REGISTRATION_NUMBER_HISTORY_UNVERIFIED` 并回滚迁移，见[门诊号发行完整性决策](../decisions/implemented/architecture/2026-10-20-registration-numbering-integrity.md)。

### SQLite 类型规则

- 主键：`TEXT` UUIDv7（fixture 可用 UUIDv5）；UTC 时间：`TEXT` ISO 8601（显示层转 `Asia/Shanghai`），虚拟业务时间与真实提交时间分列。
- 布尔：`INTEGER CHECK(value IN (0,1))`；枚举：`TEXT CHECK(...)` 或术语外键；人民币金额：整数分 `INTEGER`（高精度医保与模型计价使用定点安全整数）；数量：基准单位定点整数，禁止浮点累加余额。
- JSON：`TEXT CHECK(json_valid(...))`，只用于 FHIR 正文、冻结快照和不可检索文档；集合关系使用关联表；所有运行事实表使用 `(workspace_id, epoch, ...)` 复合主键与复合外键。

<a id="96-sqlite-事务"></a>

### SQLite 事务

SQLite 连接启用 `foreign_keys`、WAL 和 5 秒有界 `busy_timeout`，首期单进程单 writer。每个同步业务 Command 预算小于 1 秒，禁止在事务内等待浏览器或发起网络调用：

1. 认证、Workspace 与权限检查。
2. 网络 schema 与业务规则校验。
3. 初查 idempotency receipt。
4. 开启 `BEGIN IMMEDIATE` 取得写锁，重读 active Epoch、receipt、资源版本与所有并发敏感依赖。
5. 应用服务校验依赖并生成确定性 Effect。
6. 通过复合外键、唯一／检查约束、expected-version 条件更新和库存 `quantity_on_hand >= delta` 下限保护不变量。
7. 同事务原子写入当前资源、历史、Search 索引、领域事实、outbox、Audit Event、Action Trace 和 receipt。
8. 提交后在事务外唤醒 dispatcher（CommandExecutor 不叠加应用层事务重试，外部结果未知必须走对账恢复）。

<a id="97-outbox"></a>

### Outbox

```text
queued -> claimed -> completed
                  -> failed -> claimed
                  -> ambiguous
queued/claimed    -> abandoned
```

每个 `outbox_event` 携带 event ID、Workspace/Epoch、Scenario Run、kind、dedup key、correlation ID、attempt、next attempt、`lease_owner/lease_version/leased_until` 和 payload hash。模型控制拒绝使用独立的 `model-blocked` 完成语义将事件置为关联 `model_task_wait` 的等待态并归还调度 attempt，不消耗技术重试机会；已派发结果未知保持 `ambiguous`，不随控制恢复重领。dispatcher 在外部调用前持久化 lease，提交结果前重验 active Epoch，采用 at-least-once 投递加幂等 consumer（检查报告按申请关联去重，支付仅在未决资金全部收敛且净应收完全覆盖时放行下游），崩溃后由过期 lease 回收。

<a id="98-文书与附件边界"></a>

### 文书与附件边界

已签署临床文书 `Bundle`、`Composition`、`Provenance` 作为结构化 FHIR JSON 存入 current/history store，修订创建新 logical resource 并声明 `replaces`，唯一根约束阻止分叉。首期不提供 Binary、PDF、扫描件等附件存储；放射与病理像素保存在数据库外的本地素材目录，经只读阅片边界按检查标识访问，绝不进入 SQLite、FHIR 正文、日志或模型输入，见[影像素材与病例影像准备](simulation.md#107-影像素材与病例影像准备)。

<a id="99-数据库迁移边界"></a>

### 数据库迁移与运维

Drizzle schema 与迁移以真实 file-backed SQLite 为唯一目标（未来引入 PostgreSQL、D1 或 Supabase 须新建真实 Repository adapter、双端合同测试与显式数据迁移，不维护虚假方言兼容层）。已应用迁移按完整文件名与 LF 归一化校验和识别；岗位枚举或类别 CHECK 扩展在单次迁移事务周边保真重建表，并在提交前验证全量 `foreign_key_check`。

<a id="database-operations"></a>
<a id="共享收款的一次性开发切换"></a>

#### 数据库运维与备份恢复

Server 启动只校验当前 operational SQLite 的 schema 版本与完整性，不隐式执行迁移；开发入口通过 `db:prepare` 显式迁移并幂等 seed（生产升级步骤见[部署指南](../deployment.md#生产构建与-nodejs-直跑)）：

```sh
pnpm --filter @clinmesh/server db:migrate
pnpm --filter @clinmesh/server db:verify
pnpm --filter @clinmesh/server db:reindex
pnpm --filter @clinmesh/server db:backup --output ./.data/clinmesh-backup.sqlite
pnpm --filter @clinmesh/server db:restore --authority-database ./.data/clinmesh.sqlite --backup ./.data/clinmesh-backup.sqlite --destination ./.data/clinmesh-restored.sqlite
```

- **备份与校验**：`db:backup` 使用 SQLite 在线备份 API 生成新文件（禁止连接活跃时直接复制 `.sqlite` 主文件），校验 schema version、`integrity_check`、`foreign_key_check` 及 canonical state hash（口径见[确定性与故障注入](simulation.md#104-确定性与故障注入)）；非空库运行 `db:migrate` 前自动生成升级前备份（若残留已退役历史资金表则以 `PAYMENT_CUTOVER_REQUIRED` 拒绝普通迁移）。
- **受控恢复与门诊号高水位合并**：`db:restore` 不覆盖现有文件，要求先停止旧库 Server 并显式传入最新权威库 `--authority-database`；校验两库发号完整性后将旧权威标为 `retired`，逐日取两库门诊号高水位最大值写入新目标库 `--destination` 并重算 canonical state hash。缺少最新权威或身份失配返回 `REGISTRATION_NUMBER_RECOVERY_UNVERIFIED` 且已退休旧库不自动重启用，禁止用旧备份直接覆盖业务库或双开克隆实例。
- **独立指南全文库（schema v3）**：`.data/clinmesh-guidelines.sqlite` 独立于业务库与 Reference 库，将来源元数据、`derivedFromSourceId` 派生链及 `guideline_source_restriction` 维护限制与按原件 SHA-256 及完整定位去重的共享正文分开保存；撤回、替代与用途收紧优先于固定包且沿派生链向下传播，单实例最多 64 条检索缓存通过 SQLite `data_version` 与 `total_changes()` 即时失效。安装、升级与回滚备份见[部署指南](../deployment.md#免费指南全文同步)、[临床决策支持与质控](clinical-decision-support.md)及[免费指南全文库决策](../decisions/implemented/architecture/2026-10-16-free-guideline-corpus.md)。

<a id="910-模型调用账本"></a>

### 模型调用账本

`model_usage_attempt` 按 Workspace 跨 Epoch 持久保存 Server 直接 Provider、DSH bridge 与 Host 独立医生代问识别（`doctor_delegation`）的逐次尝试。每次实际生成、格式纠错（`format-repair`）和限流重发（`rate-limit-retry`）在网络派发前，于同一短事务内原子创建 UUID 尝试、校验建议单元或任务包络并写入 `model_usage_request_reservation`／`model_usage_dimension_reservation` 预占，账本写入失败立即停止请求。记录仅保存任务、阶段、多来源关联、请求／实际模型、推理策略、可知输出上限、UTC 时间、结果、服务商请求 ID 与归一化 Token 元数据（OpenAI 与 DSH 缓存计入输入子集、推理计入输出子集，`raw` 保留原始分项，未知记 `null`、缺价记 `price-not-configured`，禁存提示词、临床或模型正文与凭证；日期趋势按 `Asia/Shanghai` 汇总）。

DSH 用量帧到达后以短事务保存可信量、实际配置与已派发证据，多帧快照按已报告分项合并且新帧可信归一化计数不被旧原始分项覆盖；Host 代问期限固定 30 秒，超期在途记录在读取、准入或上报时持久转为未知且不释放消耗。已保存成功、失败或取消终态不可改写，迟到可信用量只补齐未知计数与费用，矛盾报告整体忽略。

`model_usage_control` 与 `model_usage_dimension` 保存部署与 Workspace 双层开关、自动重试及请求／Token／人民币上限；任一维度首次设为有限时建立跨重启与 Epoch reset 存续的独立累计起点。`priceSnapshot` 按派发前 `Provider + requestedModel` 冻结单价与汇率版本，金额以百万分之一货币单位的安全整数精确运算（预占向上取整，结算四舍五入且人民币只舍入一次）。`reservationBoundary` 核验可信总量与金额上界：确认未派发（如 bridge SDK 预检拒绝）整体释放；已派发或无法证明未派发的取消、超时、断流与进程退出保留未知维度占用。结果仍未知时后续证据按新旧有效计量差额原子调整（重新不可核算时扣回旧结算量并恢复未知预占）。管理员 `reconcile`／`reprice` 作为独立 `corrections` 修订经共享 Command 同事务写审计、回执与额度结算，不覆盖原始 `usage`/`priceSnapshot`（缺汇率补算沿用原单价只补新汇率；派发未知的已结束请求在两项有效消费均已知时允许提交空数值核对修订将请求预占保守转为一次已用请求）。配置与查询授权见[部署指南](../deployment.md#模型用量)、[模型用量查询](security-and-reliability.md#模型用量查询)及[模型用量记账与控制决策](../decisions/implemented/architecture/2026-10-21-model-usage-accounting-control.md)。

#### 明细保留与长期汇总

`model_usage_retention` 按 Workspace 保存明细保留天数（默认 `90` 天，按真实 UTC `started_at` 满 24 小时计算，`null` 为永久），在启动、每小时、工作区查询及保存设置时触发清理。仍在途、派发未知且未完成消费核对、实际 Token 未知或任一维度仍有 `reserved` 预占的记录强制保留，不因超期提前过期。同一 SQLite 事务先将到期可结算明细按 `Asia/Shanghai` 日期、Workspace、Epoch、病例、任务、阶段、功能、请求／实际模型和结果归并入 `model_usage_daily`（保留请求数、已知输入／输出下界、分项缺失数、未知计数、已知人民币微单位及缺价数，不修改控制层累计起点与余额），再删除逐次明细与已结算预占；带核对／补算修订的到期记录另将最小 `status/dispatch/usage/cost/priceSnapshot/corrections` 证据留存于 `model_usage_correction_audit` 并将原 Command 回执明细替换为过期标记，已清理明细不可恢复。

## 浏览器未提交私稿

门诊与住院集中办理窗口的未提交私稿、勾选集合和待恢复写意图保存在经结构校验的 `sessionStorage`，按账号、完整 Actor 上下文（含 Workspace/Epoch 与岗位）、Patient、本次就诊（Encounter 或 Admission）及具体动作子域严格隔离；关闭弹窗、切换页签／患者或刷新后可恢复，存储读取失败或写入被拒时原位报错并阻止提交新写请求，批量原子性与 `command-receipts` 恢复流程见[连续办理私稿与逐项原回执恢复](clinical-workflows.md#连续办理私稿与逐项原回执恢复)及[连续办理私稿决策](../decisions/implemented/architecture/2026-11-10-clinical-batch-draft-and-receipt-recovery.md)。

退出登录先将私稿命名空间标为不含临床正文的待清理状态（存储完全拒绝访问时以内存标记阻断），裁剪或删除全部未提交私稿并移除标记后才解除读取阻断，防止已退出会话的未发送输入在重新登录后恢复；同时完整保留已发送未决写意图的 scope、命令、幂等键、原行与住院药房同库存批次先前成功证明供原回执核对（报告显示资格与批量共用原因不随记录恢复，无法验证的损坏记录保留原文并阻止读取以免误删原意图），详见[住院命令意图与私稿清理恢复决策](../decisions/implemented/bug-fix/2026-10-20-inpatient-command-intent-recovery.md)。住院医嘱与检查开立在共享写入层收到成功响应或查得原成功回执时持久结算，全局恢复不依赖原弹窗挂载。
