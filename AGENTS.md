# AGENTS.md

ClinMesh 是面向 Agent 的中国公立医院仿真 HIS。修改业务或接口前阅读 [系统架构](docs/architecture.md) 和 [领域词汇](CONTEXT.md)；开发流程见 [Agent 工程开发](docs/agent-development.md)，文档规则见 [docs/AGENTS.md](docs/AGENTS.md)，包规则见 [packages/AGENTS.md](packages/AGENTS.md)。

## Development workflow

1. **Clarify**：新功能、可观察行为变化、跨包工作和非平凡 bug 在编辑前检查 design frontier；存在未决设计问题时使用 `grilling`，涉及公共接口、跨包状态流、持久化、外部协议、多 ticket 或测试策略权衡时使用 `grill-with-docs`。已有批准 spec 且没有未决分支时可直接实施。
2. **Record**：共享理解确认前不编辑正式文件。确认后使用 `to-spec` 形成 canonical GitHub issue；公开全文和拆票结构必须先经用户批准并完成敏感信息检查。只有多个独立纵向切片或需要跨 session 时才使用 `to-tickets`。
3. **Implement**：对批准的 issue 使用 `implement` 和 `tdd`。写测试前说明目标行为、测试层级、关键断言和最窄测试范围；运行后报告实际命令、结果、耗时和未运行项。
4. **Refine and review**：变绿后使用 `code-simplifier` 只整理当前 diff，再运行被影响的最小检查并创建引用 issue 的 checkpoint commit。随后使用 `code-review` 做 Standards/Spec 双轴审查，修复 findings，最后使用 `dsh-pre-push-checks` 覆盖 outgoing diff。
5. **Demonstrate**：用户可见的 Web/Desktop PR 使用 `agent-browser` 验证真实入口，并用 `record-browser-gif` 发布绑定精确 commit 的 GIF；React Web 性能改动同时使用 `vercel-react-best-practices`。文档改动按 [docs/AGENTS.md](docs/AGENTS.md) 路由对应 skills。

`implement <issue>` 授权创建 feature branch、本地 commit、正常 push、draft PR 和 PR 验收证据；merge、force-push、release、删除分支和将 draft 标记为 ready 仍需单独授权。Skill 定义工作流，仓库代码和当前文档拥有事实；发生冲突时遵循仓库规则，并把通用 ADR 产物映射为 Agent Note。

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

只报告实际运行的检查。迭代时先运行覆盖变更的最小检查；跨包接口、构建配置、文档投影或发布路径变化再运行 `pnpm check`。

## Standing orders

- TypeScript 使用 ESM 和 strict mode。运行时边界、网络响应、工具 JSON、持久化数据必须验证；同进程已类型化的私有调用不重复验证。
- FHIR 版本固定为 R5 `5.0.0`。资源、SearchParameter 和 Operation 只能声明实际实现的能力。
- 复杂状态变化通过共享 Command 模块执行；HTTP、FHIR Operation、Web/Desktop 和 Agent tools 不复制状态机。
- TanStack Query 拥有服务端状态；Zustand 只保存客户端视图状态。禁止把同一接口结果同时写入两者。
- Web/Desktop 共享 `contracts -> core -> ui/views`。Mobile 只复用 contracts、类型和纯函数，UI、导航、存储和 QueryClient 独立。
- `packages/contracts` 和 `packages/core` 不得读取 DOM、`localStorage`、Electron、React Native 或环境变量。平台能力由 app adapter 注入。
- `packages/ui` 不依赖 `core`；`packages/views` 可依赖 `core + ui`，但不导入 Vite、Electron、Expo 或路由框架。
- Agent tools 使用窄 schema、受信 context binding、幂等键、预期版本和完整审计；不提供任意 URL、SQL、Bundle 或任意 method/path/body 写工具。
- 所有演示数据必须是合成数据。禁止提交真实患者信息、医保凭证、支付凭证或平台密钥。
- 非平凡架构、流程、协议或测试策略变更必须新增或更新一份 [Agent Note](.agents/notes/README.md)。
- 文档是当前状态，不记录评审过程或实现流水账；一个事实只有一个详细归属位置，其他位置链接它。
- 不修改 `references/`；它是本地只读研究输入且不进入版本库或文档构建。
- 文件以一个换行结束。禁止提交生成目录、构建产物或密钥。
