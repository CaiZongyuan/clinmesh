# Agent Note: 局域网 HTTP 下的客户端随机标识

Status: implemented

## Problem

局域网开发入口使用普通 HTTP。浏览器仅在安全上下文提供 `crypto.randomUUID`，但仍允许 `crypto.getRandomValues`；直接调用前者会使登录后的页面初始化、草稿编辑或写入意图创建失败。仅在 localhost 运行浏览器回归不能发现该差异。

## Decision

Web 应用内的客户端标识统一经 `createRandomUuid` 生成：有原生方法时保留原实现，否则使用 `getRandomValues` 取得 128 位随机字节并设置 UUID v4 的版本与变体。没有加密随机源时拒绝生成，禁止用时间或 `Math.random` 替代。兼容逻辑留在平台应用，不修改全局 Crypto，也不进入领域纯函数包。

## Alternatives considered

- 只修复首次崩溃的页面初始化：其他草稿和写入意图仍会在局域网操作时失败。
- 全局补写 `crypto.randomUUID`：会改变宿主行为，并使 Surface 依赖加载顺序。
- 要求开发访问全部改成 HTTPS：正式部署仍需要 HTTPS，但这不能修复已提供的局域网 HTTP 开发入口。

## Consequences

Web 与 Surface 共用相同标识函数，业务 schema、幂等键格式与持久回执不变。浏览器回归在原生方法缺失时验证登录、合成病例准备和刷新，辅以实际局域网地址复现；这不把普通 HTTP 作为生产部署方案。局域网启动合同见[部署指南](../../../deployment.md#局域网访问-web-开发入口)。
