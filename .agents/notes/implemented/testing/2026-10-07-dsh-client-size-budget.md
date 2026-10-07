# Agent Note: DSH 客户端产物体积预算

Status: implemented

## Problem

DSH Surface 客户端是包含共享 Web 应用与依赖的单文件 lazy-CJS 产物。原有 4,100,000 字节预算的余量不足以支持后续界面与功能增长；该值是项目的构建门禁，并非 DSH 宿主的加载上限。原始体积与编译器选型证据见[病理切片阅片引擎](../architecture/2026-10-02-slide-pyramid-engine.md)。

## Decision

客户端体积预算为 5 MB，即 5,000,000 字节，由 `apps/dsh-web/src/verify-artifact.ts` 检查。只有大于预算时构建失败，等于预算允许通过。本决策取代[阅片引擎 Note](../architecture/2026-10-02-slide-pyramid-engine.md)中的体积上限；Bun 仍使用与 CI 一致的 1.4.2，lazy-CJS、宿主 React、允许的外部模块与 Tool 描述检查继续生效。

## Alternatives considered

- 保留 4.1 MB：当前产物能够通过，但新增功能容易触发预算，接受适度增加的加载和解析开销。
- 移除体积门禁：无法及时发现异常依赖增长，保留明确上限。
- 用更高预算代替编译器版本一致性：不同编译器的体积无法直接比较，固定已验证的 Bun 版本后评估增长。

## Consequences

Bun 1.4.2 构建的当前产物为 4,033,552 字节，距预算还有 966,448 字节。预算增加允许更大的单文件产物，因此仍优先使用较小的依赖入口；超过 5 MB 时需要减少体积或重新评估预算。
