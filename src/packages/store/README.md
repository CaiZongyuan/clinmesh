# Store Repository Port

业务包从 `src/packages/store/index.ts` 使用 `StorePort`。Node 组合根调用 `createNodeSqliteStore({ dbPath })`。`WorkspaceDurableObject` 将完整的 `ctx.storage` 传给 `createDurableObjectSqliteStore`。同一进程对同一本地文件、同一对象对同一 DO Storage 创建的句柄共享写入队列与 pi 会话。调用各句柄的 `close()` 释放所有权。文件数据库使用 WAL、外键以及 5000 ms 的锁等待。

```ts
await store.withTransaction(tx => {
  tx.createWorkspace({ id: workspaceId, recorded_at: new Date().toISOString() });
  tx.createEpoch({ workspaceId, epoch }, { status: 'active', virtual_time: virtualTime, clock_revision: 0 });
});

const patient = await store.read(reader => reader.get({ workspaceId, epoch }, 'patients', patientId));
```

每次业务读写都携带 Workspace ID 和 Epoch ID。ID 使用小写 UUIDv7，固定病例也支持 UUIDv5。时间戳使用 UTC ISO-8601 `Z`，`virtual_at` 和 `recorded_at` 分别记录业务与审计时间。金额由安全整数 `amount_minor`、`currency_code` 和 `currency_exponent` 共同表达。布尔值在端口中保持 `boolean`。

`read` 提供只读的 `StoreReader`，同一回调内的多次查询共享一致视图。Node 的普通查询和快照导出使用 `BEGIN DEFERRED`，在 WAL 写入期间仍可读取已提交的状态。显式写事务在 Node 使用 `BEGIN IMMEDIATE`，在 DO 使用外层异步事务覆盖等待前后的 SQL，并在 `transactionSync` 中启动同步阶段。`StoreReader` 和 `StoreTx` 只在当前同步或异步回调期间有效。事务内使用传入的句柄。外部 I/O、LLM 请求、嵌套 Store 调用以及 pi 操作须在事务之外执行。例外会回滚整笔事务。

通过 `update(scope, table, id, expectedVersion, changes)` 修改可编辑事实。补丁忽略 `undefined` 字段。空补丁仅核对版本。CAS 冲突或安全整数版本耗尽时抛出 `StoreVersionConflictError`。正式病历、诊断、报告和审计保留不可变历史。修订通过前驱 ID 和连续版本号连接。`appendDiagnosisRevision(scope, revision, members)` 一次签发整组 1–8 项诊断，其中恰有一个主诊断。更正时追加一整组新修订。重放同一命令可先调用 `findCommandReceipt`，再在写入事实的同一事务内调用 `recordCommandReceipt`。同幂等键命中不同操作或请求摘要会抛出 `StoreIdempotencyConflictError`。

仿真解析器和完诊复盘通过 `readPrivateCaseTruth(scope, { purpose, encounterId })` 读取该 Encounter 的源病例。`completed-debrief` 验证 Encounter 已完诊。`simulation` 供受信任的服务端仿真解析器使用。临床列表、患者智能体和医生助手应使用公开实体查询。

在事务中注册 `pi_sessions` 行后，运行时通过 `openPiStorage(scope, sessionId)` 获取官方 `pi-durable` Storage。每个会话在同一个数据库中使用独立的 `pi_*` 表，患者会话绑定具体 Encounter。每个会话由一个运行时管理，结束时调用 SDK 的 `close(context)`。调用方在持久化前处理 Provider 错误与凭据，Store 如实保留提交的记录。

`exportLogicalSnapshot(workspaceId)` 返回 `clinmesh.snapshot.v3` JSON，包含该 Workspace 所有 Epoch、私有 Case Truth、不可变历史和已初始化的 pi 会话。导出包含敏感的私有病例及会话内容，只交给获授权的运维人员。校验摘要是对省略 `sha256` 字段、递归按键名排序的紧凑 UTF-8 JSON 计算的 SHA-256。表和修订按依赖顺序排列。`importLogicalSnapshot(snapshot)` 在空库的一次事务中校验、恢复并核对全部内容。v1 和 v2 快照先按原格式校验，再为空缺的分诊表或处方签发、用法、撤回表建立空表。JSON 导入导出在内存中完成。

每次开诊写入独立的 `encounter_triage` 分诊事实。v2 快照也记录空分诊表。`visitorSigningSecret()` 供宿主组合根取得 Visitor Gate 的签名材料。Node 在本机数据库保存它，Worker 使用独立命名的门禁 Durable Object。导出的 Workspace 快照范围仅覆盖规定的 Workspace 实体和 pi 会话。

在 Windows 原生环境执行 `pnpm exec vitest run src/packages/store/tests`。同一套 `runStoreConformanceSuite(source, restoreIntoEmpty)` 驱动独立的源库和恢复目标。该套件会写入合成数据，使用可丢弃的空库运行。测试还在真实 workerd 与本地 SQLite 之间双向迁移数据。构建后执行 `pnpm verify:worker` 检查 Worker 体积与 Node 原生依赖。
