# AGENTS.md — Documentation

本文规定 `docs/` 的内容归属、写作方式和发布检查。编写 skills 或 Agent 指令时使用 `writing-for-agents`；普通文档直接遵循本文。Agent Note 使用独立规则，见 [`docs/decisions/README.md`](decisions/README.md)。

## 内容归属

当前行为由实现与对应合同文档共同说明；正式需求保存目标和验收，Agent Note 保存决策理由，研究保存外部证据，记忆保存操作经验。修改事实时先找到详细 owner，其他位置只保留阅读所需的摘要和链接。

| 位置 | 职责 |
| --- | --- |
| `docs/index.md` | 文档入口，只做导航 |
| `docs/architecture.md` | 系统架构导航；按任务进入详细 owner |
| `docs/architecture/` | 系统边界、FHIR 与 Command、Agent 集成、临床流程、持久化、仿真、安全与可靠性的当前合同 |
| `docs/frontend-architecture.md` | Web/Desktop/Mobile 包拓扑与共享规则 |
| `CONTEXT.md` | 唯一领域词汇，不保存实现方案 |
| `docs/ui/design.md` | 临床 UI token、组件组合、响应式与真实组件目录 |
| `docs/deployment.md` | 从 clone 到完整运行的顺序部署教程 |
| `docs/agent-capabilities.md` | 产品内 Agent 的操作、反馈和恢复指南；工程协作规则不放在这里 |
| `docs/imaging.md` | 放射检查的使用指南：各岗位操作步骤、界面状态含义和常见问题 |
| `docs/pathology.md` | 病理切片会诊的使用指南：切片复核、病例准备、各岗位操作步骤和常见问题 |
| `docs/demo-architecture.md` | 首期 Demo 运行时、数据库与部署决策 |
| `docs/agent-development.md` | Agent 参与工程开发的操作规范 |
| `docs/testing.md` | 测试层级、场景和检查要求 |
| `docs/templates/`、`docs/pull_request_template.md` | 项目开发模板；入口见 [开发模板](templates/README.md)，PR 模板沿用 GitHub 支持的自动发现位置 |
| `docs/spec/` | 正式需求、独有验收条件与状态；生命周期及索引见 [需求规格](spec/README.md) |
| `docs/decisions/` | 决策动机、真实替代方案和后果；生命周期见 [Agent Notes](decisions/README.md) |
| `docs/agents/` | 通用工程 skills 使用的仓库配置；不作为产品行为权威 |
| `docs/memory/` | [工程记忆](memory/memory.md)拥有稳定协作偏好并按场景导航低频操作经验；不作为产品行为或架构权威 |
| `docs/research/` | 外部标准、参考源码和候选方案的研究证据；入口见 [研究索引](research/README.md)，不作为当前行为权威 |
| `docs/postmortem/` | 已发生故障的时间线、根因和防复发措施 |

## 维护与生命周期

- 当前合同随实现维护；新增合同优先扩展现有 owner，仅在职责和阅读任务不同且确实过长时拆分。入口只说明去哪查。
- 规格的验收状态不由文档整理推断；完成后的保留、迁回与删除按[规格生命周期](spec/README.md#完成后的维护)执行。
- Agent Note 保留仍有价值的理由与取舍，当前机制链接对应合同；替代关系与保留条件由 [Notes 规则](decisions/README.md)拥有。
- 研究材料注明证据范围及当前 owner；已吸收的结论写入当前合同或 Note，研究保留独有来源，不维护另一套当前实现。
- 记忆条目放到对应场景，保留触发条件、可操作经验及必要来源；长期合同迁入 owner 后，记忆只留排障线索和链接。
- 移动或删除内容前核对入站引用、标题锚点、源码引用和公开页面。独有合同或活跃需求尚无去向时保留原文；历史修订由 Git 保存，不新增 completed/archive 副本。

## 写作规则

- 文档描述当前状态，不记录聊天、评审轮次、实现流水或已经失效的迁移故事。
- 一个事实只有一个详细归属位置；其他文档用相对链接引用。
- Tutorial 必须从前置条件走到可观察结果；reference 必须明确查询范围，不强迫顺序阅读。
- 保留行为、失败、时序、所有权、安全限制和例外；删除代码复述、空泛形容和推理过程。
- 修改前核对 owning 文档和实现，保留主体、条件、动作、结果与非显然理由。读者应能从当前仓库理解每个引用和结论。
- 一个自然段使用一条物理行。代码块、表格和列表按 Markdown 结构换行。
- 仓库相对链接必须指向实际文件。`references/` 不进入版本库或文档站，因此公开文档只能将其作为代码路径提及，不能建立依赖该目录的链接。
- 公开页面由 `apps/docs/docs.ts` 显式允许；不要编辑 `apps/docs/.generated`。
- 公开页面移动时，同时更新 manifest 和入站链接。

公开文档的源文件、manifest 和生成投影约定见 [文档发布](agent-development.md#文档发布)。

## Verification

文档变更运行以下检查；`pnpm doc-sync` 已包含这些检查时不重复运行：

```sh
pnpm verify:docs
pnpm docs:check
```

修改 Agent Notes 时同时运行 `pnpm verify:agent-notes`。修改代码和文档发布路径时运行 `pnpm doc-sync`。
