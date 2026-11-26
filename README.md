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

## 其他运行方式

- 本地 Worker：先 `pnpm build`，再 `pnpm dev:worker`。Wrangler 在 Windows 上启动 workerd 和静态资源服务；`WORKSPACE_DO` 绑定预留给每个 Workspace 的 SQLite Durable Object，尚不建表。
- CLI：`pnpm clinmesh`。入口就绪，尚无已注册操作。

## 验证与架构

`pnpm check` 运行严格类型检查、静态检查、真实依赖图守卫、Markdown 校验、测试和构建。构建后执行 `pnpm verify:worker`，用 Wrangler dry-run 生成真实上传包并检查压缩体积严格小于 3 MiB。所有检查均在 Windows 上运行，不需 Cloudflare 账户，也不进行线上部署。

- [深模块契约与包职责](src/packages/README.md)
- [领域词汇](GLOSSARY.md)、[架构决策](docs/adr/)、[协作规范](AGENTS.md)
