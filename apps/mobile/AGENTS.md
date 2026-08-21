# AGENTS.md — Mobile

移动端保持与 Web/Desktop 相同的领域语义、协议 schema、权限、标识和状态转换，但不共享 DOM UI、路由、存储、QueryClient 或 Zustand store。

- 可运行时导入 `@clinmesh/contracts/*` 和 `@clinmesh/core/*` 中的纯函数；禁止导入 `@clinmesh/ui` 与 `@clinmesh/views`。
- 新功能先核对 Web/Desktop 对应领域规则和 API schema，再设计适合移动场景的界面。
- 网络响应必须通过共享 schema 校验；读取请求支持取消和硬超时。
- 服务端状态由移动端自己的 TanStack Query client 管理；仅持久化 token、偏好和明确的本地草稿。
- 认证使用 Bearer token 与安全存储，不复制 Web cookie/CSRF 机制。
- 移动端发布节奏独立；Expo 和 React Native 版本直接固定在本包，不使用 root catalog。
- 修改移动 UI 前给出交互方式、与 Web/Desktop 必须一致的语义，以及必须不同的移动交互理由。
