# AGENTS.md — Mobile

补充根 [AGENTS.md](../../AGENTS.md)，适用于 `apps/mobile/`。

- 运行时只导入 `@clinmesh/contracts/*` 与 `@clinmesh/core/*` 纯函数，禁止导入 `@clinmesh/ui`、`@clinmesh/views` 或任何 DOM 依赖；拥有独立的移动端导航、安全存储、QueryClient 与测试，不用 DOM 测试替代移动端校验。
- 读取请求须支持取消与硬超时；认证使用 Bearer token 与安全存储，不复用 Web Cookie/Origin 机制；仅持久化 token、偏好与明确的本地草稿。
- Expo 与 React Native 版本直接固定在本包 `package.json`（不使用根 catalog），调整依赖后运行 `pnpm check:mobile`。
- 修改移动 UI 前先对齐 Web/Desktop 对应领域规则与 schema，说明必须一致的业务语义及移动交互差异理由。
