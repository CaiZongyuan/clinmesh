# AGENTS.md — Server

补充根 [AGENTS.md](../../AGENTS.md)，适用于 `apps/server/`。

- **写接口信任边界**：Better Auth 在 `NODE_ENV=test` 下必须保持 Origin 校验开启；每条 HIS 写路由须显式调用 `identity.assertTrustedMutation`（`resolveRequestActor` 只解析身份，不替代 Origin 校验）。公开 `/api/his/v1` 路由以完整字面量注册，确保通过 `hisOperationCatalog` 覆盖测试。
- **SQLite 迁移与表重建**：`drizzle/` 迁移文件名必须匹配 `^\d{4}_[a-z0-9-]+\.sql$`（仅允许小写字母、数字与连字符，下划线会被静默跳过）。重建表时必须合并后续迁移新增的全部索引（尤其下游复合外键依赖的 `UNIQUE` 索引）。新增迁移同步更新测试中的 `expectedSchemaVersion()`、`applied` 清单与旧库夹具排除列表；`payment-cutover.ts` 的 `runtimeTables` 保持冻结不追加新表。
- **幂等与持久回执**：Command 包装不在 `CommandExecutor.execute` 之前执行隐含 `assertActive` 的可变状态或资产检查，确保终态 Run 的既有回执优先原样重放；响应 DTO 演进必须向后兼容历史持久回执。
- **模型与测试生命周期**：`completeJson` 新增调用点必须传入与解析一致的 `validate` schema 质量门；手动调用 `processNext`/`dispatchPending` 的测试省略 `autoDispatchIntervalMs`（传 `0` 仍会启动定时器争用）；跨包调用 `applyMigrations` 时经 `import.meta.url` 解析 `apps/server/drizzle/`，清理时先关闭 Runtime/数据库连接再删临时目录（防 Windows `EBUSY`）。
