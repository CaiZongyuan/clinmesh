# Agent Note: 恢复 GitHub Issue 为正式需求规格与自包含子票

Status: implemented

## Problem

仓库在 `2026-10` 期间将正式需求迁入 `docs/spec/` 并强制 GitHub Issue 改用四段式薄追踪模板（仅写链接、一句话范围、阻塞与证据，禁止写入具体验收标准与测试决策，并要求有前置依赖的子票保留 `needs-triage`）。实际协作表明，这种双层分离把需求审阅与任务追踪拆到两处，使拆出的子票退化为空壳追踪单，单看子票无法判断独立验收边界和测试 seam，有明确前置依赖的已审定子票也被误归入待分诊队列。

## Decision

以 GitHub Issue 正文作为项目唯一正式需求规格（canonical implementation specification），维护与标签边界分别由 [GitHub issue tracker](../../../agents/issue-tracker.md) 与 [Triage labels](../../../agents/triage-labels.md) 拥有，不再维护仓库内平行的需求规格目录或四段式薄追踪模板：

单切片需求直接使用 1 张携带 `spec` 标签的规格 Issue（模板见 [功能规格模板](../../../../.github/ISSUE_TEMPLATE/feature-spec.md)）。多切片需求采用“1 张父规格 Issue + N 张单一职责自包含纵向子票”结构，通过 GitHub 原生 `sub-issues` 与 `blocked_by` 关联，使每张子票单凭自身正文即可明确验收边界与测试 seam，并保持 `label:spec` 与正式规格的一对一映射。本决定取代此前将正式需求迁入仓库规格目录的过渡安排，并更新 [Traceable Agent development workflow](2026-08-21-traceable-agent-development-workflow.md) 的归属引用。

## Alternatives considered

**继续维持 `docs/spec/` 加四段式薄追踪 Issue。** 虽然仓库内可直接检索 Markdown 规格，但每项需求都要同时维护仓库规格与空壳 Issue，子票失去独立可读性与可执行上下文。

**在 `docs/spec/` 与父子 Issue 中同时维护完整规格正文。** 双份正文会在范围调整时迅速分叉，违背单一事实源原则。

**保留封闭的 `docs/spec/` 历史归档而不删除。** 虽然省去一次性迁回独有合同细则和重写引用的成本，但会在仓库中长期留下与当前架构文档竞争的第二套历史契约目录，违背文档只保留当前状态单一 owner 的原则。

## Consequences

`to-spec` 与 `to-tickets` 重新直接产出结构完整、边界清晰的父子 GitHub Issues，`label:spec` 与正式规格保持一对一映射，每张子票单凭自身正文即可独立实施与验收。仓库文档彻底收敛回当前状态合同、决策记录、研究证据与操作记忆四类职责，不再残留 `docs/spec/` 或薄模板样板字。
