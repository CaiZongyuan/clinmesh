# ClinMesh

全球医疗智能体探索平台的模块化运行基座。同一套 Hono 路由运行在原生 Node 和本地 Wrangler/workerd；React 页面从 `/api/health` 读取当前运行时和实际装载的模块。当前未装载 Clinical Module，也不处理病历、患者数据或密钥。

## Windows 本地启动

本阶段仅支持和验收 Windows 原生环境。仓库保留容器配置，但 Docker、WSL 与 Linux 不在本阶段支持或验收范围。

本机与 CI 使用 Node.js 24.18.0 验证。项目声明 Node.js `>=24`，安装工具链时 pnpm 也会检查各依赖的引擎要求。在 Node.js 24.x 上，当前锁定的 `jsdom` 和 `w3c-xmlserializer` 要求至少 24.15.0。使用 `package.json` 指定的 pnpm 版本，在仓库根目录的 PowerShell 中执行以下命令。

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

打开 `http://127.0.0.1:51868`。可用 `$env:CLINMESH_HOST`、`$env:CLINMESH_PORT` 修改监听地址。Node 的开发入口 `pnpm dev` 会监视服务端变更，也从 `dist/client` 提供页面；需要前端热更新时，在另一 PowerShell 窗口运行 `pnpm dev:web`，通过 Vite 输出的地址访问（`/api` 代理到 Node）。

Vite 开发页从 `src/web` 启动，按公开入口的依赖图加载模块与资源。构建后可执行 `pnpm exec vite preview` 预览 `dist/client`，Node 与 Worker 的静态资源也来自该目录。

## 其他运行方式

- 本地 Worker 可通过 `pnpm build` 和 `pnpm dev:worker` 启动。Wrangler 在 Windows 上运行 workerd 和静态资源服务。每个 Workspace 的 `WORKSPACE_DO` 实例首次启动时建立 v1 SQLite 关系模型。[Store 使用说明](src/packages/store/README.md)
- CLI：`pnpm clinmesh`。入口就绪，尚无已注册操作。

## 验证与架构

`pnpm check` 运行严格类型检查、静态检查、真实依赖图守卫、`pnpm lint:theme`、Markdown 校验、测试和构建。构建后执行 `pnpm verify:worker`，用 Wrangler dry-run 生成真实上传包并检查压缩体积严格小于 3 MiB。所有检查均在 Windows 上运行，不需 Cloudflare 账户，也不进行线上部署。

打开 `/dev/ui-kit` 可试用组件目录、浅深主题、三档字号和 Agent 活动态。业务页面从 [ui-kit](src/packages/ui-kit/index.ts) 导入控件，以 `Field` 标记输入，用 `ConfirmActionButton` 或 `InlineConfirmBar` 表达正式操作。`createClinMeshUiAgent` 在渲染前创建，`registerWebMCP()` 注册同一套工具并返回注销函数。标记 `data-agent-confirm` 的操作默认拒绝，页面通过人工审批弹窗单次放行。`data-agent-secret` 隐去控件的值，`data-agent-hidden` 隐去整块区域。

- [深模块契约与包职责](src/packages/README.md)
- [Hospital Data Pack 编译、热切换与工作台读取](src/packages/data-pack/README.md)、[两套合成教学包的来源](data/packs/README.md)
- [领域词汇](GLOSSARY.md)、[架构决策](docs/adr/)、[协作规范](AGENTS.md)
