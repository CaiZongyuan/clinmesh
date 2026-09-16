# Agent Note: DSH Surface 边框与菜单引用兼容

Status: implemented

## Problem

DSH React Surface 使用 ShadowRoot 和宿主 React 18，standalone Web 使用 React 19。Tailwind 的非继承自定义属性依赖 `@property` 初始值，但 Chromium 不在 ShadowRoot 内注册这些声明，导致边框样式变量为空。作为 Base UI 菜单 render 元素的共享 Button 若使用普通函数组件，React 18 不会把 ref 作为 prop 传入，菜单因缺少按钮引用而无法完成首次定位。本 Note 只拥有样式与 ref 转发维度；React API 面维度由 [Surface React API 面约束](2026-09-16-dsh-surface-react-api-surface.md) 拥有。合同见 [issue #81](https://github.com/CaiZongyuan/clinmesh/issues/81)；整体集成边界由 [DSH 原生 Surface](../architecture/2026-08-30-dsh-native-clinmesh-surface.md) 拥有。

## Decision

Surface 样式构建从实际 CSS 的 `@property` 声明提取 `inherits: false` 且有 `initial-value` 的默认值，放入低优先级 `properties` 层的元素与伪元素规则。默认值留在 ShadowRoot 内，普通 utility 仍可覆盖；不向宿主 document 注册属性，也不维护手写 Tailwind 变量清单。

共享 Button 通过 `forwardRef` 将 DOM 引用交给 Base UI primitive，同时兼容 React 18 和 React 19。保持同一 Button 与菜单实现，不维护 DSH 专用控件副本。

## Alternatives considered

只补 `--tw-border-style` 能恢复边框，但其余依赖注册初始值的 utility 仍受影响，且清单会随 Tailwind 输出漂移。向宿主注册所有属性会扩大样式影响范围，因此默认值由 Surface stylesheet 拥有。

升级全局 DSH 的 React 或在运行时修补 Base UI store 会把修复绑定到宿主或私有状态。共享 Button 显式转发引用符合两个运行版本的公共组件合同。

## Consequences

浏览器合同测试消费实际构建 CSS，检查边框和宿主隔离；菜单测试使用真实 Button、Menu 和 ShadowRoot Portal，在 React 18/19 下验证定位、重复开关、选项操作和方向键导航。真实入口验证鼠标、键盘和关闭后焦点恢复；虚拟时间下的程序化点击不替代真实输入的焦点证明。React 18 别名依赖仅用于 DSH adapter 的测试，不进入产品构建。Chrome 测试 helper 的可选虚拟时间预算允许弹层定位和交互任务完成，原有同步样式测试不启用该选项。
