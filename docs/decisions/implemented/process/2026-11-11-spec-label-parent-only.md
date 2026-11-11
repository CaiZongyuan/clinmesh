# Agent Note: spec 标签仅标识规格主票

Status: implemented

## Problem

[仓库文档拥有正式需求规格](2026-10-06-repository-owned-specs.md)将 `spec` 标签从标识 canonical spec issue 改为标识“引用仓库正式规格的追踪 Issue”，并让父 Issue 与拆出的执行子票共用默认带 `spec` 的实施跟踪模板。拆票任务因此为每张执行子票都加上 `spec` 标签，使 GitHub `spec` 筛选视图被数十张纵向切片淹没，无法按“一项正式需求对应一个主追踪入口”检索，也与 `spec` 标签自身的 canonical specification 语义相悖。

## Decision

恢复 `spec` 标签仅标识规格主票的边界：采用 [仓库正式规格](../../../spec/README.md) 的任务，只在单票任务的追踪 Issue 或多票任务的父 Issue 上添加 `spec` 标签；拆出的执行子票使用 GitHub 原生 `sub-issues` 关联父 Issue，并在正文中链接对应仓库规格切片，不添加 `spec` 标签。本决定部分修正 [仓库文档拥有正式需求规格](2026-10-06-repository-owned-specs.md) 中对所有关联追踪 Issue 一律标记 `spec` 的做法，正式需求正文归属 `docs/spec/` 的规则保持不变。

## Alternatives considered

**继续为父 Issue 和所有执行子票都打上 `spec`。** 虽然能直接从任意子票标签看出该切片关联仓库规格，但一个大型需求会拆出十余至二十余张子票，导致 `label:spec` 列表失去需求级总览能力，主从角色在标签层完全混同。

**彻底废弃 `spec` 标签，完全依赖正文链接识别。** 这能省去标签维护，但维护者无法在 GitHub Issue 列表中直接过滤出所有对应正式规格的主追踪入口。

**为执行子票新增独立的 `ticket` 或 `sub-spec` 标签。** 原生 `sub-issues` 关系已经表达父子归属，`ready-for-agent` 与 `needs-triage` 已表达可执行状态，再造新标签只会重复平台原生状态（违反 [Triage labels](../../../agents/triage-labels.md) 的去重原则）。

## Consequences

GitHub 中 `label:spec` 重新与正式规格保持一对一（或一规格一父 Issue）的清晰映射；执行子票依靠原生 `sub-issues`、`blocked_by` 与 triage 标签表达层级和就绪门禁。实施模板与 [Issue 规则](../../../agents/issue-tracker.md) 明确区分规格主票与执行子票的标签要求。
