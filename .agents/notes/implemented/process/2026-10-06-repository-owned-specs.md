# Agent Note: 仓库文档拥有正式需求规格

Status: implemented

## Problem

需要跨会话追踪的需求此前以 GitHub Issue body 为唯一正式版本，导致离线工作和代码审查不能仅从仓库快照取得完整实施合同。通用 `to-spec` skill 默认发布 Issue，但 ClinMesh 的文档与代码归属需要保持同一仓库中的可追溯版本。本决定取代 [Traceable Agent development workflow](2026-08-21-traceable-agent-development-workflow.md) 中 Issue body 拥有实施合同的规则。

## Decision

新增正式需求统一放在 [需求规格目录](../../../../docs/spec/README.md)，一个需求只维护一个文件。仓库模板定义目标、范围、用户故事、验收、设计、测试和真实依赖；状态区分草稿、批准、已实施和被取代。采用仓库规格的 GitHub Issue 只追踪执行、拆票和 PR，并链接规格；既有已批准 Issue 在显式迁移前沿用原合同。Agent Note 继续拥有非平凡取舍的理由，当前架构文档和代码拥有已交付事实。

项目文档把通用 `to-spec` 的产物位置映射为 `docs/spec/`，保留上游 skill 原文。公开 Issue 的内容与授权规则不变；本地写入规格不自动发布到 GitHub。

## Alternatives considered

**继续以 Issue body 为唯一规格。** GitHub 追踪方便，但离线 checkout 缺少完整需求，Issue 修订与代码版本不能一起审查。

**同时在 Issue 和仓库维护完整正文。** 两份 owner 会在需求修订时分叉，无法明确哪个版本约束实施。

**只保留对话或临时交接记录。** 跨会话实施和审查缺少稳定、可版本化的验收依据。

## Consequences

Agent 在实施非平凡需求前读取对应仓库规格，发现新取舍时更新同一文件并重新确认受影响部分。Issue 和 PR 引用规格路径；未解决实施依赖的规格保持 `draft`，其执行 Issue 不标记为 `ready-for-agent`。项目文档检查覆盖目录规则、模板和规格链接。
