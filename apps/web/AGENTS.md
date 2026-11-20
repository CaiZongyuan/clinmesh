# AGENTS.md — Web

补充根 [AGENTS.md](../../AGENTS.md)，适用于 `apps/web/`（其核心应用同时由 `apps/dsh-web` 作为 React Surface 复用）。

- **双宿主兼容与懒加载**：进入 Surface 的组件遵守根指令双版本 React 约束（需要 DOM ref 的共享输入保留 `forwardRef`，见 [React API 面约束](../../docs/decisions/implemented/bug-fix/2026-09-16-dsh-surface-react-api-surface.md)）；依赖浏览器 DOM 的重型阅片器（如 OpenSeadragon）按展开懒加载（`React.lazy`），避免 Node 纯函数测试导入工作台时触发 `document is not defined`。应用全局样式统一由 `src/main.tsx` 加载。
- **私稿与持久写意图恢复**：`sessionStorage` 业务私稿允许暂存未合法输入并在存储异常后停止同步重试；`signOut` 的存储异常不得阻断界面卸载与缓存清理。多个组件共用 `useInpatientWriteIntent` 时，成功回调与通知须先校验 `command.operation` 与目标 `admissionId` 再解析回执。
- **文案与多层测试同步**：精简可见文案或将单项弹窗改为连续录入 composer 时，同步更新组件单测、可见文案契约单测、同时驱动 Web 与双版本 Surface 合同的共享浏览器旅程及对应关闭/计数断言；Playwright 统一从仓库根运行（`--project=web` / `--project=contracts`），修改 `e2e/` 后补跑 `pnpm exec tsc --noEmit -p tsconfig.browser.json`。
