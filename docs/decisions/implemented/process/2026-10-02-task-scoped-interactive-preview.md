# Agent Note: 任务级交互预览

Status: implemented

## Problem

正式 Web 内长期保留 `/ui-dev` Lab 和 `src/prototype` 展示页，会累积独立 mock 模型、重复工作台、方案切换器和专属测试。展示内容不能证明真实业务能力，旧预览也难以表达当前任务已接受的体验与后续修订。

## Decision

交互预览按任务交付独立、可运行且有明确版本的产物。预览、反馈、已有确认与正式实现的关系由[交互预览规范](../../../../docs/agent-development.md#交互预览)拥有；预览只承载合成数据和隔离的模拟交互。

Web application 移除常驻开发预览路由和源码树，不维护第二套医院界面与内存业务模型。真实 `/components` 与设置中的组件目录继续展示产品实际 primitives；支付、临床文书和完诊的业务预览继续由既有 owner 驱动。

本决策取代[医生工作台 UI 重构](../architecture/2026-08-31-doctor-workspace-ui-refactor.md)中继续保留开发预览入口的约定，保留其生产模块与业务边界。已选定的设计以正式组件、[设计合同](../../../../docs/ui/design.md)和 owning Agent Notes 为准；通用 Matt `prototype` skill 保持上游内容。

## Alternatives considered

- 保留常驻 Lab 并继续增加方案：每项任务都要维护演示壳、模拟状态和生产实现，旧展示无法直接代表已接受版本。
- 把 mock 工作台接入真实 API：会将仅用于设计判断的交互和字段推入生产，并扩大真实业务写入范围。
- 只删除路由：未注册的原型源码、专属测试与文档仍继续暗示存在活动预览入口。
- 仅提供静态截图：可以比较外观，但不能判断关键操作、状态与错误恢复；有交互决定时使用可运行预览。

## Consequences

Web 与 DSH 复用同一生产 application interface，开发和生产路由均不承载常驻 mock 展示站。后续需要应用上下文的预览使用按任务隔离的临时入口，已接受版本和反馈作为正式实施输入，产物按其保留规则处理。

删除的测试只拥有已移除 Lab 的主题与方案交互。正式 Web shell、岗位、组件目录、React 18/19 浏览器合同和真实入口 E2E 继续拥有原有验证范围；预览不能替代这些证据。
