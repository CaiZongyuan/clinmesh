# AGENTS.md

ClinMesh 是面向 Agent 的中国公立医院仿真 HIS。修改业务或接口前阅读 [系统架构](docs/architecture.md) 与 [领域词汇](CONTEXT.md)；开发、交付、录屏或 GitHub 写入前阅读 [工程记忆](docs/memory/memory.md)；协作与授权见 [Agent 工程开发](docs/agent-development.md)，文档归属见 [docs/AGENTS.md](docs/AGENTS.md)，包级约束见目标路径下的子目录 `AGENTS.md`（`packages/`、`apps/server/`、`apps/web/`、`apps/dsh-web/`、`apps/mobile/`）。

## Agent skills

主 Agent 默认统筹澄清、实施、验证与交付，需求确认并获授权后连续推进；分派、worktree 隔离、双轴审查与交付边界见 [开发入口](docs/agent-development.md#开发入口) 与 [实施与交付](docs/agent-development.md#实施与交付)。

- 本机开发 skills 位于被忽略的 `.agents/skills/` 等宿主目录（不纳入 Git），保留 Matt 上游原文及显式调用限制，通用 ADR 映射为 [Agent Note](docs/decisions/README.md)；产品运行时 `clinmesh-*` skills 位于根 `skills/` 并随版本库同步。
- 代码简化保留行为与合同，可用时调用 `reduce-complexity`；编写 skills 或 `AGENTS.md` 时使用 `writing-for-agents`；普通文档遵循 [docs/AGENTS.md](docs/AGENTS.md)。

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

只报告实际运行的检查。迭代时运行覆盖变更的最小检查；跨包接口、构建配置、文档投影或发布路径变化运行 `pnpm check`。纯文档、设计资产或 PR 媒体变更只运行对应检查，不重跑仍有效的证据。

## Standing orders

- 修改代码前先按 [Issue 规则](docs/agents/issue-tracker.md) 创建或关联 GitHub Issue 并明确范围；沿用已有 Issue 与授权。
- 提交、推送或提 PR 默认使用独立工作分支经 PR 合入 `main`，仅在用户明确要求时直接写入 `main`。Commit、Issue 和 PR 使用简体中文，遵循 [消息与提交规范](docs/agent-development.md#消息与提交规范)。
- 用户要求记住的约束及可复用排障经验在任务结束前落盘：高频防错规则入对应范围 `AGENTS.md`，稳定协作偏好入 [工程记忆](docs/memory/memory.md)，低频排障入其场景子页，产品事实与决策理由归各自 owner。不记录密钥、真实凭证、患者信息、临时端口或已失效 PR 状态。
- 浏览器回归与真实入口验证默认使用 Playwright（见[测试策略](docs/testing.md#用户界面验证)），探索或会话接管按需选用 `agent-browser`。存在 `.prototypes/` 原型时，完工前必须对照原型 HTML 源码与真实浏览器渲染逐项核对，移除被替代旧面板并同步冲突的旧测试断言（细则见[浏览器与演示证据](docs/memory/browser-evidence.md#布局滚动与像素聚合)）。
- TypeScript 使用 ESM 和 strict mode。运行时边界、网络响应、工具 JSON 与持久化数据必须做 schema 校验；同进程已类型化的私有调用不重复校验。
- FHIR 固定为 R5 `5.0.0`，只声明实际实现的资源、SearchParameter 和 Operation；复杂业务状态变化统一走共享 Command 模块，HTTP、FHIR Operation、前端与 Agent tools 不复制状态机。
- TanStack Query 拥有服务端状态，Zustand 只保存客户端视图状态，禁止同一接口结果双写。
- Web/Desktop 共享 `contracts -> core -> ui/views`（`contracts`/`core` 禁读 DOM、存储、环境变量或平台 API，`ui` 不依赖 `core`，`views` 不导入路由或宿主框架）；Mobile 仅复用 `contracts` 与 `core` 纯函数。DSH Surface 共享代码只使用 React 18.3.1 与 19.2 共有 API（需稳定回调时用 latest-ref，禁 `useEffectEvent`），对话框纳入双版本浏览器合同测试，见 [React API 面约束](docs/decisions/implemented/bug-fix/2026-09-16-dsh-surface-react-api-surface.md)。
- Agent tools 使用窄 schema、受信 context binding、幂等键、预期版本和完整审计，禁止提供任意 URL、SQL、Bundle 或任意 method/path/body 写工具。Agent-facing CLI 的 `cliPath`、schema、错误或恢复合同变化时，同一 diff 同步 owning Operation Catalog、对应 `clinmesh-*` Skill 与命令示例漂移测试。
- 演示数据必须全为合成数据，严禁提交真实患者信息、医保/支付凭证或密钥。唯一例外是 [影像素材清单](imaging-assets/README.md) 与 [病理切片素材清单](pathology-assets/README.md) 登记的去标识公开像素（像素与源文件不入 Git、日志、模型输入或 SQLite，展示保留署名；Agent 不读取含影像或切片的像素及截图，仅用文字快照与聚合量，无影像界面与原型图可正常读取）。
- 开发与验收默认使用合成 Provider、受控模型流和临时数据库。压测或真实模型运行须获用户针对当次运行的明确许可；失败后停止并保留诊断，不自行重试、改参或扩载。
- 非平凡架构、流程、协议或测试策略变更必须新增或更新 [Agent Note](docs/decisions/README.md)。文档只写当前状态且单一事实单一 owner；不修改只读的本地 `references/`；文件以单个 LF 换行结束，禁止提交生成目录、构建产物或密钥。
