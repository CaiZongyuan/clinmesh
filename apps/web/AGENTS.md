# AGENTS.md — Web

补充根 [AGENTS.md](../../AGENTS.md)，适用于 `apps/web/`（其核心应用同时由 `apps/dsh-web` 作为 React Surface 复用）。

- **双宿主兼容与懒加载**：所有进入 Surface 的业务组件只使用 React 18.3.1 / 19.2 共有 API（需要 DOM ref 的共享输入保留 `forwardRef`）；依赖浏览器 DOM 的重型阅片器（如 OpenSeadragon）按展开懒加载（`React.lazy`），避免 Node 纯函数测试导入工作台时触发 `document is not defined`。应用全局样式统一由 `src/main.tsx` 加载。
- **私稿与持久写意图恢复**：`sessionStorage` 业务私稿允许暂存未合法输入并在存储异常后停止同步重试；`signOut` 的存储异常不得阻断界面卸载与缓存清理。多个组件共用 `useInpatientWriteIntent` 时，成功回调与通知须先校验 `command.operation` 与目标 `admissionId` 再解析回执。
- **文案与多层测试同步**：精简可见文案或将单项弹窗改为连续录入 composer 时，同步更新组件测试、`inpatient-visible-copy.test.ts`、共享 `e2e/*.journey.ts`（同时驱动 Web 与 React 18/19 Surface 合同）及对应关闭/计数断言；Playwright 统一从仓库根运行（`--project=web` / `--project=contracts`），修改 `e2e/` 后补跑 `pnpm exec tsc --noEmit -p tsconfig.browser.json`。
