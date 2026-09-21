# Agent Note: 问诊完成后的工具重新发布

Status: implemented

## Problem

问诊 Tool 是否发布由后端 Page Context 许可和前端 action 的可用状态共同决定。问诊成功会刷新病例与队列；病例先返回时，mutation 仍处于 pending。如果页面 action 缓存不依赖 pending 状态，就可能在人工输入已恢复后继续发布不含 ask 的工具清单。已有病历草稿保持文书对象稳定时可以复现该问题；没有草稿时临时生成的文书对象会使缓存重新计算，掩盖缺失依赖。关联 [issue #108](https://github.com/CaiZongyuan/clinmesh/issues/108)。

## Decision

医生页面 action 缓存显式依赖提问与重试 mutation 的 pending 状态及调用函数。回复成功后重新计算可用工具；患者回复失败、末条文本仍是医生消息时继续只开放恢复动作，不放宽授权或绕过领域前置条件。

## Alternatives considered

- 始终发布 ask：会把等待回复和允许新问题混为一谈，无法修复页面状态失步。
- 修改 DSH 注册机制或延长发布延迟：工具清单在进入桥接前已经缺项，额外等待不能使过时的 React 缓存重新计算。
- 只测试空病例或单次成功：缺少稳定文书对象和刷新时序，不能捕获成功后工具消失。

## Consequences

回归通过真实 WebApp 的 Surface 注册入口调用两轮 ask，在 HTTP 边界控制队列刷新晚于病例刷新，验证人工输入恢复、ask 重新发布及第二轮使用更新后的问诊版本；同时覆盖有无持久文书和失败后重试。该组件回归证明应用发布行为，不替代全局 DSH 真实模型 Session 验收。
