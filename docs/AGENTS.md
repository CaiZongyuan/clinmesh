# AGENTS.md — Documentation

本文规定 `docs/` 的内容归属、生命周期与写作检查；Agent Note 规则见 [`docs/decisions/README.md`](decisions/README.md)。

## 内容归属

当前行为由代码实现与唯一合同文档共同说明；正式需求归 GitHub Issue，取舍理由归 Agent Note，外部证据归研究记录，排障线索归工程记忆。修改事实时只改详细 owner，其他位置用摘要与相对链接指向它。

| 位置 | 职责 |
| --- | --- |
| `docs/index.md`、`docs/overview.md` | 文档站首页导航与新成员项目概览；只做摘要和路由，不拥有详细合同 |
| `docs/architecture.md`、`docs/architecture/` | 系统架构任务路由及系统边界、FHIR/Command、Agent 接入、六大临床业务子域、DRG 分组、存储事务、仿真病例、安全可靠性的当前合同 |
| `docs/drg-reference-storage.md` | DRG 离线资料精简物理储存、无损读取与维护命令合同 |
| `docs/frontend-architecture.md`、`docs/ui/design.md` | Web/Desktop/Mobile 包拓扑，以及临床 UI token、工作台框架与组件规范（业务状态流归 `docs/architecture/`） |
| `CONTEXT.md` | 唯一医院仿真领域词汇表，不保存技术实现方案 |
| `docs/deployment.md` | 从 clone 到完整运行的顺序部署教程 |
| `docs/agent-capabilities.md` | 产品内 Agent 会话绑定、审阅时序与恢复指南（可执行参数与完整清单由 `agentToolCatalog` 拥有） |
| `docs/imaging.md`、`docs/pathology.md`、`docs/pci-demo.md` | 放射检查、病理切片会诊与 PCI 跨岗位演示的操作手册 |
| `docs/agent-development.md`、`docs/testing.md` | Agent 工程开发协作规范，以及测试层级、可观察证据与验证门禁合同 |
| `docs/templates/`、`docs/pull_request_template.md` | [开发模板](templates/README.md)与 GitHub 自动发现的 PR 模板 |
| `docs/decisions/` | 具备长期指导价值的架构/流程/测试取舍；生命周期见 [Agent Notes](decisions/README.md) |
| `docs/agents/` | 通用工程 skills 的仓库适配配置（Issue 与标签规则） |
| `docs/memory/` | [工程记忆](memory/memory.md)拥有稳定协作偏好并按场景索引紧凑排障线索，不作为产品合同权威 |
| `docs/research/`、`docs/postmortem/` | [研究索引](research/README.md)保存独有外部标准与数据核验（未采用外部拆解归本地 `references/`）；`postmortem/` 记录故障复盘 |

## 生命周期与写作规则

- **禁止缓存代码环境（Environment Cache）**：具体测试文件名列表、完整路由清单、Tool 明细大表、合成价目分值与锁文件哈希由代码、schema 与 lockfile 权威拥有，文档只保留架构不变量、状态边界与失败语义。
- **单一当前状态**：文档只描述已实现的当前状态，删除未落地的早期设想、评审轮次、实现流水与已完成的一次性迁移故事；历史修订由 Git 保存，不建 `completed/` 或 `archived/` 副本。
- **按分支渐进披露**：单文件混入多个独立修改域且过长时按任务边界拆分；移动、合并或删除章节前核对全库入站引用、标题 `#anchor`、源码报错文案引用与 `apps/docs/docs.ts` 公开清单（参见[文档发布](agent-development.md#文档发布)）。
- **格式与链接**：一个自然段使用一条物理行，代码块、表格和列表按 Markdown 结构换行。仓库内链接使用实际存在的相对路径；公开页面中的本机 `localhost` 地址写成反引号代码 span，提及本地只读 `references/` 时不建 Markdown 链接，不编辑 `apps/docs/.generated`。

## Verification

文档变更运行 `pnpm verify:docs && pnpm docs:check`；涉及 Agent Notes 或公开投影路径时直接运行 `pnpm doc-sync`。
