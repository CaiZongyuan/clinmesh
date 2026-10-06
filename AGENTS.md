# AGENTS.md

ClinMesh 是面向 Agent 的中国公立医院仿真 HIS。修改业务或接口前阅读 [系统架构](docs/architecture.md) 和 [领域词汇](CONTEXT.md)；开发、交付、录屏或 GitHub 写入前阅读 [工程记忆](docs/memory/memory.md)；协作约定见 [Agent 工程开发](docs/agent-development.md)，文档规则见 [docs/AGENTS.md](docs/AGENTS.md)，包规则见 [packages/AGENTS.md](packages/AGENTS.md)。

## Agent skills

按用户请求和任务范围选择 skills，明确目标后直接实施。Issue、拆票、TDD、审查和录屏按需要使用，不要求每项任务走固定生命周期。

- 代码简化使用 [reduce-complexity](.agents/skills/reduce-complexity/SKILL.md)，覆盖当前变更的行为保持型整理，以及用户要求的较大范围简化调查。
- 编写文档遵循 [docs/AGENTS.md](docs/AGENTS.md)；编写 skills 或 Agent 指令时使用 `writing-for-agents`。
- Matt skills 保持上游内容；仓库代码和 owner 文档拥有事实，通用 ADR 产物映射为 Agent Note。
- GitHub 写入和交付遵循 [实施与交付](docs/agent-development.md#实施与交付)，沿用已有授权。

## Commands

```sh
pnpm install
pnpm dev:web
pnpm dev:server
pnpm dev:desktop
pnpm dev:mobile
pnpm typecheck
pnpm typecheck:mobile
pnpm check:mobile
pnpm lint
pnpm test
pnpm doc-sync
pnpm check
```

只报告实际运行的检查。迭代时先运行覆盖变更的最小检查；跨包接口、构建配置、文档投影或发布路径变化再运行 `pnpm check`。纯文档、设计资产或 PR 媒体变更只运行对应文档或媒体检查，不运行与 diff 无关的代码测试，也不重复仍然有效的成功证据。

## Standing orders

- 用户要求提交、推送或提 PR 时，默认在独立工作分支提交和推送，通过 PR 合入 `main`；只有用户明确要求直接写入主分支时才提交或推送到 `main`。
- 用户要求记住的约束，以及开发中发现的可复用坑和解决方法，必须在当前任务结束前落盘。高频、跨任务且漏读会反复出错的规则写入适用范围内的 `AGENTS.md`；其他稳定偏好和低频操作经验写入 `docs/memory/memory.md`。不记录密钥、真实凭证、患者信息、临时端口、一次性进程或已失效的 PR 状态。
- 前端浏览器回归和真实入口验证默认使用 Playwright，运行入口与证据规则见[测试策略](docs/testing.md#用户界面验证)；`agent-browser` 按探索或会话接管需要选用。
- `.agents/skills/` 只保存开发 Agent 的工程 skills；`clinmesh-*` 是项目启动后操作 HIS 的运行时 Agent skills，统一放在根 `skills/`，不得复制或链接回开发 skills 目录。
- TypeScript 使用 ESM 和 strict mode。运行时边界、网络响应、工具 JSON、持久化数据必须验证；同进程已类型化的私有调用不重复验证。
- FHIR 版本固定为 R5 `5.0.0`。资源、SearchParameter 和 Operation 只能声明实际实现的能力。
- 复杂状态变化通过共享 Command 模块执行；HTTP、FHIR Operation、Web/Desktop 和 Agent tools 不复制状态机。
- TanStack Query 拥有服务端状态；Zustand 只保存客户端视图状态。禁止把同一接口结果同时写入两者。
- Web/Desktop 共享 `contracts -> core -> ui/views`。Mobile 只复用 contracts、类型和纯函数，UI、导航、存储和 QueryClient 独立。
- DSH 宿主页面提供上游锁定的 React 18.3.1，standalone Web 使用 React 19.2：Surface 共享代码只使用两个版本共有的 React API（禁止 `useEffectEvent` 等 19-only API，需要时用 latest-ref 模式），对话框类组件纳入 React 18/19 双版本浏览器合同测试，见 [Agent Note](.agents/notes/implemented/bug-fix/2026-09-16-dsh-surface-react-api-surface.md)。
- `packages/contracts` 和 `packages/core` 不得读取 DOM、`localStorage`、Electron、React Native 或环境变量。平台能力由 app adapter 注入。
- `packages/ui` 不依赖 `core`；`packages/views` 可依赖 `core + ui`，但不导入 Vite、Electron、Expo 或路由框架。
- Agent tools 使用窄 schema、受信 context binding、幂等键、预期版本和完整审计；不提供任意 URL、SQL、Bundle 或任意 method/path/body 写工具。
- Agent-facing CLI 的 `cliPath`、schema、错误或恢复合同变化时，在同一 diff 更新 owning Operation Catalog、对应 `clinmesh-*` Skill 和命令示例漂移测试。
- 所有演示数据必须是合成数据。禁止提交真实患者信息、医保凭证、支付凭证或平台密钥。唯一的例外是 [影像素材清单](imaging-assets/README.md) 与 [病理切片素材清单](pathology-assets/README.md) 登记的公开授权、已去标识的影像像素：只提交清单，像素与来源文件不进入 Git、日志、模型输入或 SQLite；演示、截图和录屏保留清单要求的署名。Agent 开发和验证时不读取影像像素或截图，只使用文字快照和聚合统计。
- 非平凡架构、流程、协议或测试策略变更必须新增或更新一份 [Agent Note](.agents/notes/README.md)。
- Commit、issue 和 PR 的标题与正文使用简体中文，结构见 [消息与提交规范](docs/agent-development.md#消息与提交规范)。
- 文档是当前状态，不记录评审过程或实现流水账；一个事实只有一个详细归属位置，其他位置链接它。
- 不修改 `references/`；它是本地只读研究输入且不进入版本库或文档构建。
- 文件以一个换行结束。禁止提交生成目录、构建产物或密钥。
