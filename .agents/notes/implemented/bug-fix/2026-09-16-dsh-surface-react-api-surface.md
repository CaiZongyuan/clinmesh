# Agent Note: DSH Surface 共享代码的 React API 面约束

Status: implemented

## Problem

DSH 宿主页面向插件提供上游锁定的 React 18.3.1，standalone Web 与测试环境使用 workspace 的 React 19.2.3。医生工作台的诊断、检验、药品目录对话框曾使用 `useEffectEvent`（React 19.2 转正的 API）：在 DSH Web 中打开任一对话框即抛 `TypeError: useEffectEvent is not a function`，`RuntimeErrorBoundary` 把整个工作台替换为错误提示；崩溃只发生在浏览器端，`pnpm dev:dsh` 的 `[Server]`/`[DSH]` 日志无任何输出。单元测试与 `pnpm check` 全部运行在 React 19 下，无法发现这类回归。ref 转发维度的同一合同见 [DSH Surface 边框与菜单引用兼容](2026-09-10-dsh-surface-borders-and-menu-refs.md)；集成边界由 [DSH 原生 Surface](../architecture/2026-08-30-dsh-native-clinmesh-surface.md) 拥有。

## Decision

Surface 共享代码（`apps/web`、`packages/ui`、`packages/views` 及 `packages/core` 的 React 相关部分）只使用宿主 React 18.3.1 与 React 19.2.3 共同提供的 API 面；需要"effects 中调用最新回调"语义时用 latest-ref 模式（`useRef` + 无依赖 `useEffect` 赋值）替代 `useEffectEvent`。目录对话框的防抖搜索按该模式实现，防抖语义不变。

浏览器合同测试把临床目录对话框纳入 React 18/19 双版本矩阵（复用 `react18`/`react-dom18` 别名与 headless Chrome 机制）：fixture 依次打开三个对话框，断言搜索输入出现、无 window 错误、防抖只触发一次且参数正确。fixture 页面必须带 `<meta charset="utf-8">`，否则脚本内的中文输入被按 windows-1252 解码。

## Alternatives considered

升级宿主 React 不可行：版本由 DSH 上游锁与官方前端产物决定，遵循持续升级策略而不是本地改包。让插件自带第二份 React 会破坏跨边界的 hooks 与 Context 共享。只依赖 React 19 下的单元测试会永久漏掉该类崩溃，因为运行时 API 缺失只在宿主 18.3.1 中出现。

## Consequences

根 `AGENTS.md` 增加了 Surface 共享代码的 API 面禁令，评审按双轴审查检查 changed interface 的两侧。双版本合同测试每次运行真实构建产物与 headless Chrome，新增对话框类组件时应扩展同一 fixture，而不是只在 React 19 下新增单元测试。上游升级（`dsh-upstreams.lock.json` 变更宿主前端版本）时需重新确认宿主 React 版本，再决定是否放宽 API 面。
