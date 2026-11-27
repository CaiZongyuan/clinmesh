# ClinMesh

ClinMesh 是面向合成教学病例的全球医疗智能体探索平台。原生 Node 与本地 Wrangler/workerd 共用一套 Hono 接口。Mini HIS Core 可独立开诊、问诊、签署病历、确认诊断、完诊并解锁病例复盘。

## Windows 本地启动

本阶段仅支持和验收 Windows 原生环境。仓库保留容器配置，但 Docker、WSL 与 Linux 不在本阶段支持或验收范围。

本机与 CI 使用 Node.js 24.18.0 验证。项目声明 Node.js `>=24`，安装工具链时 pnpm 也会检查各依赖的引擎要求。在 Node.js 24.x 上，当前锁定的 `jsdom` 和 `w3c-xmlserializer` 要求至少 24.15.0。使用 `package.json` 指定的 pnpm 版本，在仓库根目录的 PowerShell 中执行以下命令。

```powershell
pnpm install --frozen-lockfile
pnpm build
$env:CLINMESH_LOCAL_DEV_OPEN='1'
pnpm start
```

打开 `http://127.0.0.1:51868`。可用 `$env:CLINMESH_HOST`、`$env:CLINMESH_PORT` 修改监听地址。Node 的开发入口 `pnpm dev` 会监视服务端变更，也从 `dist/client` 提供页面；需要前端热更新时，在另一 PowerShell 窗口运行 `pnpm dev:web`，通过 Vite 输出的地址访问（`/api` 代理到 Node）。

Vite 开发页从 `src/web` 启动，按公开入口的依赖图加载模块与资源。构建后可执行 `pnpm exec vite preview` 预览 `dist/client`，Node 与 Worker 的静态资源也来自该目录。

## 其他运行方式

- 本地 Worker 构建后运行 `pnpm dev:worker`。在 PowerShell 中设置 `$env:CLINMESH_LOCAL_DEV_OPEN='1'` 后，此入口将 Wrangler/workerd 绑定到回环地址。可用 `CLINMESH_PORT` 指定端口，默认 `8787`。每个 Workspace 对应一个 `WORKSPACE_DO` 实例。[Store 使用说明](src/packages/store/README.md)
- Node 与本地 Wrangler 在开放模式下校验监听地址，接受 `127.0.0.1`、`::1` 和映射到 `127.0.0.1` 的 `localhost`。共享监听或生产 Worker 使用 `CLINMESH_VISITOR_PASSCODE`。Node 从进程环境读取，Wrangler 本地支持 `.dev.vars`。默认签名材料由宿主生成并持久保存。可通过 `CLINMESH_SESSION_SECRET` 提供至少 32 字符的独立签名密钥。
- 在浏览器点击「进入工作台」后选择固定病例开诊。顶栏可切换为负责医生，管理岗位可在医院设置中选择数据包并确认重置。在「模型设置」配置 BYOK 或显式启用 Mock Mode，即可提问、停止或重试患者回复。刷新会续接在途回复，等待时仍可编辑草稿。[模型配置与恢复](src/packages/agent-runtime/README.md)
- 访问 `/dev/health` 可查看当前运行时和已装载模块。`pnpm clinmesh` 是外部 CLI 入口，操作的输入输出、授权和路由由服务端的 Operation Catalog 定义。

## 验证与架构

`pnpm check` 运行严格类型检查、静态检查、真实依赖图守卫、`pnpm lint:theme`、Markdown 校验、测试和构建。构建后执行 `pnpm verify:worker`，用 Wrangler dry-run 生成真实上传包并检查压缩体积严格小于 3 MiB。所有检查均在 Windows 上运行，不需 Cloudflare 账户，也不进行线上部署。

打开 `/dev/ui-kit` 可试用组件目录、浅深主题、三档字号和 Agent 活动态。业务页面从 [ui-kit](src/packages/ui-kit/index.ts) 导入控件，以 `Field` 标记输入，用 `ConfirmActionButton` 或 `InlineConfirmBar` 表达正式操作。`createClinMeshUiAgent` 在渲染前创建，`registerWebMCP()` 注册同一套工具并返回注销函数。标记 `data-agent-confirm` 的操作默认拒绝，页面通过人工审批弹窗单次放行。`data-agent-secret` 隐去控件的值，`data-agent-hidden` 隐去整块区域。

- [深模块契约与包职责](src/packages/README.md)
- [工作台 HTTP、Command 和临床扩展接口](src/packages/clinical-core/README.md)
- [检验与功能检查工作台、报告修订与版本已阅](src/packages/mod-lab/README.md)
- [放射、病理申请与关键帧审阅](src/packages/mod-imaging/README.md)
- [Hospital Data Pack 编译、热切换与工作台读取](src/packages/data-pack/README.md)、[合成教学包的来源](data/packs/README.md)
- [领域词汇](GLOSSARY.md)、[架构决策](docs/adr/)、[协作规范](AGENTS.md)
