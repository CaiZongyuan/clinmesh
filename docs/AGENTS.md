# AGENTS.md — Documentation

本文规定 `docs/` 的内容归属、写作方式和发布检查。写作、移动或审计文档时使用 `dsh-doc-standards` 和 `dsh-prose-standard`；改变公开投影时同时使用 `dsh-doc-site-sync`；清理 authoring-session 视角时使用 `dsh-trim-cot-leakage`。Agent Note 使用独立规则，见 [`.agents/notes/README.md`](../.agents/notes/README.md)。

## Content tiers

| 位置 | 职责 |
| --- | --- |
| `docs/index.md` | 文档入口，只做导航 |
| `docs/architecture.md` | 仿真 HIS 系统与 FHIR 详细架构 |
| `docs/frontend-architecture.md` | Web/Desktop/Mobile 包拓扑与共享规则 |
| `docs/deployment.md` | 从 clone 到完整运行的顺序部署教程 |
| `docs/demo-architecture.md` | 首期 Demo 运行时、数据库与部署决策 |
| `docs/agent-development.md` | Agent 参与工程开发的操作规范 |
| `docs/testing.md` | 测试层级、场景和检查要求 |
| `docs/agents/` | 通用工程 skills 使用的仓库配置；不作为产品行为权威 |
| `docs/memory/` | 用户的稳定协作偏好和低频操作坑；不作为产品行为或架构权威 |
| `docs/research/` | 基于参考源码或外部标准的研究记录；不作为当前行为权威 |
| `docs/postmortem/` | 已发生故障的时间线、根因和防复发措施 |

## Writing rules

- 文档描述当前状态，不记录聊天、评审轮次、实现流水或已经失效的迁移故事。
- 一个事实只有一个详细归属位置；其他文档用相对链接引用。
- Tutorial 必须从前置条件走到可观察结果；reference 必须明确查询范围，不强迫顺序阅读。
- 保留行为、失败、时序、所有权、安全限制和例外；删除代码复述、空泛形容和推理过程。
- 一个自然段使用一条物理行。代码块、表格和列表按 Markdown 结构换行。
- 仓库相对链接必须指向实际文件。`references/` 不进入版本库或文档站，因此公开文档只能将其作为代码路径提及，不能建立依赖该目录的链接。
- 公开页面由 `apps/docs/docs.ts` 显式允许；不要编辑 `apps/docs/.generated`。
- 公开页面移动时，同时更新 manifest 和入站链接。

## Verification

文档变更至少运行：

```sh
pnpm verify:docs
pnpm docs:check
```

修改 Agent Notes 时同时运行 `pnpm verify:agent-notes`。修改代码和文档发布路径时运行 `pnpm doc-sync`。
