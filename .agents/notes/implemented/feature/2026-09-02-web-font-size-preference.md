# Agent Note: Web 应用级字号偏好

Status: implemented

## Problem

ClinMesh 的 standalone Web 和 DSH Surface 复用同一份应用与样式，但 `rem` 在两种载体中都相对宿主文档根元素计算。把应用基础字号直接应用到带 `data-clinmesh-app="web"` 的 standalone `<html>` 会先把根字号从 `16px` 降到 `13px`，再让 `text-sm` 等 `rem` token 按 `13px` 二次缩小。字号偏好还需要在刷新、登录状态和 Surface 挂载之间保持一致，而不改变 DSH 外壳或服务端状态。

Canonical implementation contract 是 [GitHub issue #72](https://github.com/CaiZongyuan/clinmesh/issues/72)。

## Decision

`WebPreferences` 拥有设备本地的 `fontSize` 偏好，并继续使用 `clinmesh.preferences:v1`。`standard`、`larger` 和 `large` 分别表示 `100%`、`112.5%` 和 `125%`；缺少或无法识别的字号值按 `standard` 读取，同时保留有效的语言和主题。

`WebApp` 在首次渲染前同步读取偏好，并通过 React Context 向岗位页面和组件目录提供唯一的客户端状态。ClinMesh 应用根携带当前字号档位，`packages/ui/src/styles.css` 在该作用域内调整语义字体 token。standalone 文档根保持 `16px`，应用基础字号只作用于 `body` 和 `.clinmesh-web-root`；Surface 只修改自己的应用根。

设置页提供固定三档单选并即时持久化。字号变化不修改 spacing、图标尺寸、控件高度、浏览器缩放或 DSH 宿主文档根。

## Alternatives considered

**修改文档根字号。** 该方案能自然缩放 `rem`，但也会缩放间距、图标和控件，并且 Surface 无权修改 DSH 文档根，因此不采用。

**使用 `zoom` 或 `transform: scale()`。** 该方案会缩放整个应用并改变布局、滚动和命中区域，不符合只调文字的行为，因此不采用。

**使用连续滑块。** 任意比例扩大了密集工作台的布局组合和验收范围；固定三档提供可复现的尺寸，因此不采用。

**同步到账号或服务端。** 当前语言和主题已经是设备本地 Web 偏好，字号沿用同一 owner，不新增账号级协议。

## Consequences

Tailwind 语义字号和 UI primitives 的非标准小字号都必须消费应用级字号 token；新增固定 `rem` 字号时需要同时证明三档行为。尺寸和 spacing token 不消费字号比例。

jsdom 用户交互测试验证偏好、可访问控件和应用根作用域；样式源合同测试保护 standalone 根字号与三档 token，Vite 构建验证生产样式可编译，真实浏览器验证三档 computed font-size、长中文和窄视口布局。DSH 样式构建必须继续保留应用根作用域，不能把字号提升到宿主根。
