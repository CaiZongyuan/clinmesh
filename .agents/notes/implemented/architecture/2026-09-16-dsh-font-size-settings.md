# Agent Note: DSH 设置承载 ClinMesh 字号

Status: implemented

## Problem

Surface 语言和主题由 DSH 控制后，医院工作台的通用设置只剩字号。用户需要在两个设置入口之间切换；DSH 自有字号控制只影响会话，不能代替医院工作台的排版偏好。任务合同见 [issue #105](https://github.com/CaiZongyuan/clinmesh/issues/105)。

## Decision

Client adapter 通过官方 `settings.general.item` 注册独立的 ClinMesh 字号控件，与 Surface 共享一个可订阅的偏好源。选择器复用 DSH 浏览器提供的 `Menu` 与箭头组件，触发按钮使用宿主语言选择器的样式 token；宿主拥有菜单浮层、选中标记和键盘交互。该模块作为宿主 external 加载，不复制菜单实现，测试桩只覆盖组件边界，真实交互由 DSH 入口验收。Web runtime 注入生效字号，WebApp 在渲染时派生显示偏好，不重建应用或把注入值写回独立 Web 偏好。语言继续遵循[宿主语言归属](2026-09-16-dsh-host-locale-ownership.md)。

设置位置集中到 DSH，字号仍是 ClinMesh 专属偏好。它使用当前浏览器 origin 下的 `clinmesh.dsh.font-size:v1`，值域为 `standard`、`larger`、`large`。首次缺少此键时继承旧 `clinmesh.preferences:v1` 的字号并保存；已有非法值回退到标准。独立 Web 偏好只读继承一次，不被反向修改。其他标签页的存储变化通过浏览器事件同步；没有订阅者时移除监听，重新订阅时读取最新值。存储不可读写时保留当前插件会话内的选择，刷新后不保证恢复。

完整产品行为由[系统架构](../../../../docs/architecture.md#71-surface-与-host-边界)拥有。本决策替代 [Web 应用级字号偏好](../feature/2026-09-02-web-font-size-preference.md)中 Surface 的设置入口与存储归属，保留其三档比例、字号 token 和宿主样式隔离规则；旧存储归属继续适用于独立 Web。

## Alternatives considered

**共用 DSH 会话字号。** 会把会话文本与医院表单、表格绑定，无法分别调整。

**继续共用 Web 本地偏好对象。** 两个设置入口或异步更新容易覆盖语言、主题或独立 Web 的选择，且共享应用内部状态需要双向同步。

**新增 DSH 宿主设置命名空间。** 可提供宿主文件持久化，但会改变现有浏览器偏好的作用域和远程浏览器可写性。移动设置入口不需要改变这份合同。

## Consequences

DSH Profile 必须加载官方通用设置插件。Surface 未打开时可先调整字号；已挂载或隐藏的工作台实时更新，页面、登录和草稿保留。医院导航不再发布通用设置入口，旧 Surface `/settings` 地址回到当前岗位，组件开发入口保持可用。独立 Web 仍在通用设置调整字号。

WebApp 与 DSH adapter 集成测试覆盖控件到工作台、语言同步、独立偏好隔离和导航；偏好边界测试覆盖继承、非法值、跨标签页更新、订阅清理及存储失败。真实 DSH 验收覆盖设置位置、字号效果和会话字号独立性。
