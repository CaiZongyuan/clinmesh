# 参考项目评估与采用边界

本文保留固定版本参考项目的评估、采用边界与外部标准入口，不拥有 ClinMesh 当前行为。当前合同从[系统架构](../architecture.md)进入；决定理由以对应 [Agent Note](../decisions/README.md) 为准。`references/` 是本地只读研究输入，不进入版本库和文档站。

## 2. 参考项目评估

### 2.1 OpenHIS 的参考价值

OpenHIS 2.0.5 是 Java 17、Spring Boot、JPA/Hibernate、Flyway 和 PostgreSQL 构建的模块化单体。其价值主要在中国医院业务覆盖，而不是技术实现。

值得保留的业务知识：

- 门诊预约、挂号、到诊、接诊、完诊和取消。
- 住院申请、入科、分床、转床、转科、出院、召回和清床。
- 西药、中药、检查、检验、治疗和耗材医嘱。
- 医嘱草稿、签发、护士校对、执行、停嘱和停嘱校对。
- 门诊与住院发药、汇总摆药、退药、批号、效期和追溯码。
- 挂费、支付、退款、预交金、日结、交账和审批。
- 吉林医保人员查询、费用上传、预结算、结算、撤销、清算和审核。
- 电子病历模板、文书版本、病案首页、质控、归档和借阅。

关键事实可从以下迁移和源码看到：

- `whale-health/health-infrastructure/.../V2__adm_ddl.sql`
- `whale-health/health-infrastructure/.../V3__cln_ddl.sql`
- `whale-health/health-infrastructure/.../V4__fin_ddl.sql`
- `whale-health/health-infrastructure/.../V5__med_ddl.sql`
- `whale-health/health-infrastructure/.../V6__wkf_ddl.sql`
- `whale-module-chs-jilin/.../V1__chs_ddl.sql`
- `health-domain/.../encounter/command/`
- `health-domain/.../medicationrequest/command/`

不应继承的实现：

- 动态扫描全部 `*AppService` 公共方法并注册成统一 POST API。
- 全局 AOP 将所有 AppService 包进默认读写事务。
- `service_table + service_id`、`item_table + item_id` 等任意表名多态引用。
- `charge_item_ids`、`encounter_diagnosis_ids` 等字符串化 ID 集合。
- 业务表之间极少数据库外键，大量状态和关联只能由应用约定维护。
- PostgreSQL 专属数组、JSONB、trigram、函数索引和 Quartz 表。
- 将外部密码、client secret 和私钥作为普通业务表字段。
- 把菜单、类名或表存在误认为业务闭环已经可执行。

OpenHIS 中大量实体使用 FHIR 名称，但仓库没有 FHIR Server 实现。它是“受 FHIR 启发的领域模型”，不是可直接互操作的 FHIR 服务。

### 2.2 Medplum 的参考价值

Medplum 5.1.30 是 TypeScript、Express、PostgreSQL、Redis、BullMQ 和对象存储构成的完整平台，其正式 FHIR API 固定为 R4 `4.0.1`。

值得借鉴：

- FHIR Router 与 Repository 解耦。
- 完整 FHIR JSON 是权威表示，Search 列和 lookup table 是写时索引。
- 当前资源、历史版本、tombstone、ETag 和 `If-Match`。
- CapabilityStatement 根据真实能力生成。
- FHIR Search 先编译为中间表示，再生成参数化 SQL。
- 授权条件与业务查询合并到同一 SQL，而不是查询后过滤。
- SMART scope、项目成员、AccessPolicy 和 compartment 权限求交集。
- Repository 层统一记录 AuditEvent。
- transaction Bundle 的 ID 预分配、本地引用重写和整体回滚语义。
- Agent SQLite durable queue 对 queued、claimed、inflight、failed、ambiguous outcome 的区分。
- MCP FHIR 代理中的同源校验和出站请求 SSRF 防护。

不应照搬：

- 每种 FHIR 资源独立当前表、历史表和多组 PostgreSQL 索引表。
- PostgreSQL UUID 数组、range/multirange、GIN、GiST 和 trigram 查询。
- Redis 缓存、Pub/Sub 和 BullMQ 常驻 worker。
- reader/writer pool、多 shard、savepoint 和复杂事务重试框架。
- AWS/Azure/GCP 部署层和 Node VM Bot 执行环境。
- 允许任意 method、path、body 的全能 `fhir-request` Agent 工具。

结论是借鉴 Medplum 的协议边界、Repository、Search 索引、授权和审计，不移植其物理架构。

## 19. 参考资料

项目内：

- [Web Demo 运行与部署架构](../demo-architecture.md)
- [跨端前端架构](../frontend-architecture.md)
- [Agent 工程开发](../agent-development.md)
- [Node.js 与 SQLite Web 基础设施决策](../decisions/implemented/architecture/2026-08-23-node-sqlite-web-foundation.md)
- [多岗位发热门诊首期闭环决策](../decisions/implemented/feature/2026-08-23-outpatient-fever-first-release.md)
- [结构化临床文书独立生命周期决策](../decisions/implemented/feature/2026-08-25-structured-clinical-document-lifecycle.md)
- [DSH 原生 ClinMesh React Surface 决策](../decisions/implemented/architecture/2026-08-30-dsh-native-clinmesh-surface.md)
- OpenHIS 研究输入：`references/openhis-itai-pro/`
- Medplum 研究输入：`references/medplum/`

外部标准与参考实现：

- [FHIR R5](https://hl7.org/fhir/R5/)
- [FHIR R5 RESTful API](https://hl7.org/fhir/R5/http.html)
- [FHIR R5 CapabilityStatement](https://hl7.org/fhir/R5/capabilitystatement.html)
- [FHIR R5 Extensibility](https://hl7.org/fhir/R5/extensibility.html)
- [FHIR R5 OperationOutcome](https://hl7.org/fhir/R5/operationoutcome.html)
- [SMART App Launch](https://hl7.org/fhir/smart-app-launch/)
- [CN Core R4 参考项目](https://github.com/HL7China/CN-CORE-R4)
- [SQLite Transactions](https://www.sqlite.org/lang_transaction.html)
- [SQLite Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [SQLite Online Backup API](https://www.sqlite.org/backup.html)
