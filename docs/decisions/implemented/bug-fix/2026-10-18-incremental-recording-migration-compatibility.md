# Agent Note: 早期增量记录迁移兼容

Status: implemented

## Problem

增量记录的 `0064_incremental-recording.sql` 曾在开发库执行后补入完成任务的结果回填及核对 Actor 上下文列。早期库与提交版本具有同一迁移 ID、不同校验和和表结构，启动因此被校验拒绝；仅忽略校验仍会在核对任务写入时缺列。发布分支的其他升级约束由[低延迟记录决策](../architecture/2026-10-15-low-latency-document-recording.md)拥有。

## Decision

保留提交版本 SQL 与两个版本的既有迁移回执。业务库只对这个文件名、当前规范 SQL 哈希和已确认早期 LF／CRLF 哈希组合接受兼容；任何后续 SQL 编辑或其他历史哈希仍拒绝。参考数据库不适用该例外。

新增 `0065_incremental-recording-context.sql`，沿用迁移前备份及单迁移事务。SQLite 不支持条件添加列，因此 runner 仅在执行此迁移且早期表缺列时暂存可空列；SQL 从原核对 outbox 的批次、增量及任务标识恢复同一 Workspace/Epoch/病例的 Actor，重建为带 JSON 校验的非空列。已有核对 Actor、状态及内容哈希保持原值，无法恢复的身份使整个迁移回滚，不借用当前岗位或占位身份。完成任务只回填尚未记录的结果，保留之后产生的结果及失败任务。

## Alternatives considered

- 删除或重建开发库：丢失现有合成病例、病历和审计。
- 只改库内校验和或普遍忽略差异：掩盖真实缺列，也无法区分未知 SQL 修改。
- 将 `0064` 改回早期 SQL：会使已执行提交版本的数据库反向校验失败。
- 所有核对统一使用当前任务 Actor：会覆盖已固定的核对身份，改变授权边界。

## Consequences

业务库版本增加一条迁移，两个已知版本均可继续升级，原始回执不改写。file-backed SQLite 回归覆盖早期 LF／CRLF、提交版本的非空核对、结果回填、原身份保留、重复迁移、未知 SQL 拒绝和身份缺失回滚；完整开发准备及存量发布分支升级验证使用同一 runner。
