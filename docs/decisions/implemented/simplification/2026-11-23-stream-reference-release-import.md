# Agent Note: 流式导入与校验 Reference Release

Status: implemented

## Problem

`importReferenceDataRelease` 先前将每个来源解析为完整的内存 `ReferenceArtifact` 对象数组，再复制为附加 `sourceId` 的第二份数组并用内存 `Set` 逐表查重，随后通过递归对象 canonicalize 与单次 `JSON.stringify` 生成整包 JSON 字符串计算 `contentHash`；`verifyReferenceDatabase` 又将正式表全量行一次读回内存重算同一哈希，`verifyOfflineInventories` 也按分页整批反序列化离线清单。面对包含 `nhc-icd10-clinical`、`nhsa-drugs` 与 `laboratory-cn` 等约 30 万行规模的 Reference Data Release 时，首次导入、幂等重导入及服务启动只读校验会出现 `1.1–1.6 GiB` 峰值 RSS，在低内存容器或并行验证环境中易触发内存压力，而实际瓶颈在于多份全表对象与完整 canonical JSON 字符串同时驻留内存，而非 SQLite 写入或校验语义本身。本决策由 [Issue #531](https://github.com/CaiZongyuan/clinmesh/issues/531) 交付。

## Decision

保持 `importReferenceDataRelease` 与 `verifyReferenceDatabase` 的同步签名、参考库持久 schema（`schemaVersion = 11`）及既有 `contentHash` 逐字节兼容不变，改为基于连接级 `TEMP` staging 表与增量流式 canonical JSON 哈希器执行导入与核验：

1. **连接私有 `TEMP` staging 与原子发布**：`importReferenceDataRelease` 在事务外建立当前连接隔离的 `STRICT` `TEMP` staging 表（含主键、`source_id` 外键、枚举 `CHECK` 及跨源编码唯一约束，其中 `staging_value_set_entry` 显式约束 `(system, system_version, code)` 跨源唯一，检验定义/单位/标本/组合关系的 `concept_id` 外键在全部来源写入后跨来源统一核验并在正式表发布时再次由数据库外键兜底），不升级持久参考库 schema，也不污染主库页面或 WAL。所有来源与 `contentHash` 校验通过后，仅在单一 `BEGIN IMMEDIATE` 事务内通过 `INSERT INTO ... SELECT` 原子发布 `reference_release`、`reference_source_manifest` 与非空正式子表；幂等重导入在比对既有 `content_hash` 一致后直接返回 `created: false`；外层 `finally` 按外键逆序清理全部 `TEMP` staging 表。
2. **只读参数绑定 `ATTACH`、模块级行级 Zod 校验与分块写入**：`cn-health` Candidate SQLite 先流式核验文件字节大小与 SHA-256，再在事务外以参数绑定 `ATTACH DATABASE ? AS cn_health_candidate` 挂载固定白名单 schema，立即开启 `query_only = ON` 执行 `integrity_check`、`application_id`、白名单表结构、v2 canonical 表摘要及游标逐行模块级 Zod 校验（保留跨字段 `superRefine`、来源版本核对与计数核验）；游标收尾恢复 `query_only` 后再执行显式列投影或有界分批写入 `TEMP` staging，并在内层 `finally` 恢复 `query_only` 及 `DETACH` Candidate 数据库（正常路径下清理失败直接抛错，仅在传播主异常时保留原始错误）。CSV、UCUM XML 与 `clinmesh-reference-v1` JSON 文本来源均按 64 KiB 文件块流式扫描元素，逐条经模块级 Zod 校验后按 500 行分批写入 staging。
3. **流式 canonical JSON SHA-256 与有界外部 `localeCompare` 归并**：`computeStreamingReleaseContentHash` 按既有顶层键序、可选空数组省略规则及 `clinmesh-reference-v1` 来源格式特例增量写入 SHA-256。由于 `better-sqlite3` 不提供自定义 collation，而 SQLite 默认 `BINARY` 排序在含 `†`（ICD-10 剑号编码）或大小写混合标识上与既有 `String.prototype.localeCompare` 顺序不同，单分块内的表直接在内存复用固定 `Buffer` slab 排序输出，超阈值大表将分块排序结果顺序写入操作系统临时目录下的单一临时归并文件并以有界读缓冲多路最小堆归并复现精确 `localeCompare` 行序（`finally` 关闭句柄并删除临时文件）。`verifyReferenceDatabase` 与 `verifyOfflineInventories` 均通过只读游标逐行校验并流式馈入同一哈希器，完全兼容 `createClinMeshRuntime` 的 `readonly: true` 连接。
4. **性能门禁联动**：同步校准 `apps/server/performance-baselines.json` 中 `reference-import-application` 在 `TEMP` staging 与批量 `INSERT INTO ... SELECT` 发布模式下的确定性 SQL 语句数与写入行数门禁，同时保持持久参考数据库文件增长上限不退化（参见 [SQLite 性能工作负载与稳定门禁分离](../testing/2026-08-28-sqlite-performance-contract.md)）。

## Alternatives considered

- **单纯调高 Node.js 堆上限**：无法消除源对象数组、带 `sourceId` 副本与完整 canonical JSON 字符串三份全量驻留，也不能降低 `createClinMeshRuntime` 启动只读 `verifyReferenceDatabase` 时的容器内存峰值。
- **仅信任上游 Candidate canonical hash 或纯 SQL 跳过行级 Zod 校验**：无法覆盖 CSV/XML/JSON 来源、ClinMesh 字段转换、检验定义跨字段 `superRefine` 规则及多来源组合唯一性，会削弱参考库防篡改与输入校验边界。
- **引入 `content-hash` v2 或直接改用 SQLite `BINARY` 行序**：会导致含 `†` 或大小写混合编码的既有锁定 Release（如 `clinmesh-cn-health-2026-09-15.r1`）与历史夹具哈希漂移，迫使导入、校验、迁移与离线工具长期维护双版本哈希分支。
- **使用持久 staging 表或逐 source 提交正式表**：持久临时表需要额外参考库迁移并把中间页写入主库与 WAL，异常退出还会遗留脏表；逐 source 提交则在后续来源失败时留下半成品 Release。

## Consequences

30 万行级 Reference Data Release 的首次导入、幂等重导入及只读连接下的 `verifyReferenceDatabase`（含离线清单游标核验）峰值 RSS 均控制在 `384 MiB` 以内，同时锁定 Release 与全部历史夹具的 `contentHash` 逐字节保持不变，失败导入零正式表污染且零残留 `ATTACH` 句柄。后续扩展新的参考子表或来源格式时，必须将数据库行与输入记录的 Zod schema 保持在模块顶层常量，接入 `TEMP` staging 外键清理逆序与 `computeStreamingReleaseContentHash` 的 `localeCompare` 排序键定义，并通过对象算法与流式哈希器的逐字节 golden 对比测试。
