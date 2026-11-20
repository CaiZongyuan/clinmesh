# Agent Note: 精简全库文档体系、拆分临床合同与收敛历史决策语料

Status: implemented

## Problem

随着门诊、住院、共享收款、DRG、心血管专病内核与指南体系迭代，仓库文档在保持单事实源的同时出现了严重的上下文膨胀与检索信噪比退化：`docs/architecture/clinical-workflows.md` 单文件膨胀至约 200 KB，任何涉及单一临床子域的 Agent 任务都被迫加载整院跨岗位合同；`docs/memory/` 以只增不减方式累积超过 260 KB 的排障流水、本机环境探测缓存表及含非 ASCII 路径的专题文件；架构与测试合同中夹杂逐文件源码、迁移与测试路径清单，极易与真实目录发生漂移；`docs/decisions/` 累积了 237 份逐子票拆分的 Agent Notes（约 1 MB），同一机制往往跨越 5 至 15 份带 `>` 局部取代免责声明的历史片段；`docs/research/` 混入大量未被当前实现引用的外部开源项目拆解与淘汰候选调研。全库全文检索中约 67%–92% 的命中来自已取代的历史演进描述、本机环境快照或外部参考拆解，严重挤占 Agent 上下文窗口并诱发过期规则误判。

## Decision

在保留 [按阅读任务拆分文档 owner](2026-10-19-documentation-ownership.md) 确立的四类文档职责边界基础上，对全库文档执行四项结构性收敛（需求与拆票见 [Issue #532](https://github.com/CaiZongyuan/clinmesh/issues/532)）：

1. **临床工作流六域拆分与路由锚点兼容**：将原 `docs/architecture/clinical-workflows.md` 按阅读与修改边界拆分为六份领域合同——[门诊业务流程](../../../architecture/outpatient-workflows.md)、[住院与手术流程](../../../architecture/inpatient-workflows.md)、[处方、医嘱与药事](../../../architecture/orders-and-pharmacy.md)、[检验、检查与报告](../../../architecture/examinations-and-reports.md)、[收费、结算与医保](../../../architecture/billing-and-insurance.md)及[临床决策支持与质控](../../../architecture/clinical-decision-support.md)，同步登记至 `apps/docs/docs.ts` 公开文档清单；`clinical-workflows.md` 收敛为临床总览路由与跨领域[连续办理私稿与逐项原回执恢复](../../../architecture/clinical-workflows.md)合同，并显式保留历史 `<a id="...">` 路由锚点以兼容运行时 `skills/clinmesh-*` 与外部链接。
2. **剥离代码／测试盘点清单与去重 `docs/memory/`**：从架构合同、测试策略与工程记忆中移除可通过文件树或 `git grep` 即时获知的源码文件清单、迁移文件枚举与本机硬件／工具链探测缓存表；将 `docs/memory/` 去重压缩为高复用排障规则，并将非 ASCII 文件名统一重命名为 [`docs/memory/video-walkthrough.md`](../../../memory/video-walkthrough.md)。
3. **同源决策演进链合并为 Keeper Notes 并迁移 `proposed` 积压**：将 `docs/decisions/` 中同一机制的多轮迭代、局部补丁及反转记录合并入 74 份自包含 `implemented` Keeper Notes，剔除行内 `>` 局部取代免责声明与时间线流水账，直接陈述当前已交付架构、仍有价值的否定保证与真实替代方案；遵循 [恢复 GitHub Issue 为正式需求规格](2026-11-11-github-issue-canonical-specs.md)，将长期滞留的 `proposed` 流式参考导入提案迁移至 [Issue #531](https://github.com/CaiZongyuan/clinmesh/issues/531) 并清空 `docs/decisions/proposed/`。
4. **外部参考调研迁入本地 `references/` 并补齐 `apps/*/AGENTS.md`**：`docs/research/` 仅保留 16 份支撑现行医疗标准、数据许可、DRG 核验与指南取证的研究证据，其余外部参考系统拆解与未采用候选方案移入被 Git 忽略的本地只读 `references/archived-research/`（公开文档不建立指向 `references/` 的相对链接）；同时在 `apps/*/` 下补齐包级 `AGENTS.md`，使 Agent 按工作目录就近加载各应用端约束。

## Alternatives considered

- **仅在超大文档顶部补充目录索引而不拆分或删减**：无法减少单次文件读取体积，也无法降低 `git grep` 在 237 份历史子票决策与外部参考调研中的高比例噪声命中。
- **新建 `docs/decisions/archived/` 或 `docs/research/archived/` 归档目录**：会在版本库中继续保留竞争性的第二套过时语料，Agent 搜索时仍会命中已废弃中间态，且违背 [Agent Notes 规则](../../README.md) 无归档生命周期的约定；Git 历史已完整保留演进过程。
- **删除全部历史 Agent Notes，仅保留当前架构文档**：会丢失架构文档不承载的“为何拒绝某诱人方案”（如为何不用通用钱包、为何不在 DSH 开放住院直写工具、为何不把 `coverage_json` 纳入住院费用哈希）等关键负向约束，导致未来维护者重蹈覆辙。
- **破坏性删除 `clinical-workflows.md` 原有章节锚点**：会导致产品运行时 `skills/clinmesh-*` 及既有 Issue／PR 链接断链；保留轻量路由页与显式锚点可在零外部破坏的前提下让内部文档直连六份新领域 owner。

## Consequences

Agent 按任务读取单一临床领域合同的上下文开销从约 200 KB 降至单篇约 20–35 KB，`docs/decisions/` 文件数减少约三分之二且每份 Keeper Note 自包含表达完整前因后果，全库检索直接聚焦现行合同与有效决策取舍。后续演进同一机制且未反转核心结论时，优先在对应 Keeper Note 原位更新当前机制与路径并保持精炼，仅在推翻原核心结论或引入全新架构域时新建 Agent Note；任何公开文档与 Agent Note 继续由 `pnpm doc-sync` 强制校验相对链接、章节锚点与模板结构。
