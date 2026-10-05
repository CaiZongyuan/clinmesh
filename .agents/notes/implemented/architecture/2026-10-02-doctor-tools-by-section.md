# Agent Note: 医生 Tool 按诊疗栏目发布

Status: implemented

## Problem

DSH browser Tool broker 每次注册最多接受 32 个 Tool，超出时整份注册失败。医生“接诊”页按岗位和 view 发布全部 Tool，放射接入后正好 32 个，病理等检查类型无法再增加 Tool。合并语义相近的 Tool 只能偶尔腾出名额，并让单个 Tool 的输入与审阅语义越来越宽。

本决策由 [issue #139](https://github.com/CaiZongyuan/clinmesh/issues/139) 交付，是 [issue #135](https://github.com/CaiZongyuan/clinmesh/issues/135) 病理接入的前置条件。当前行为与栏目归属表见 [DSH 页面操作](../../../../docs/agent-capabilities.md#医生诊疗栏目与-tool-发布) 和 [系统架构 7.3 节](../../../../docs/architecture.md)。

## Decision

**栏目归属是 Tool 目录的一部分。** `packages/contracts` 导出唯一的医生栏目枚举 `doctorCaseSectionSchema`，页面标签、`outpatient.section.select` 的输入与 Tool 定义的可选 `section` 字段都使用它。`agentToolsForContext(roleCode, viewId, activeSection)` 只返回未声明栏目或栏目等于当前栏目的 Tool。

**Server 授权与 Surface 注册调用同一个函数。** Hono 签发 Page Context 时把受信 claim 中的 active section 传给 `agentToolsForContext`，再按病例状态收窄；Surface publisher 用 snapshot 中的 claim 计算注册定义。授权以 snapshot 的 `allowedOperationIds` 为准，因此非当前栏目的调用以既有 `AGENT_OPERATION_NOT_ALLOWED` 拒绝，前端漏过滤也不会越权。active section 早已属于 page scope，切换栏目沿用既有的重签与重新注册路径。

**跨栏目 Tool 只保留页头和不止属于一个栏目的动作。** 共享 UI Tool、病例读取与选择、栏目切换、开始就诊和完成就诊始终发布。兼容初诊与复诊草稿的表单分布在多个栏目，也跨栏目发布；它们由病例状态收窄，结构化流程中不占名额。其余 Tool 归属其页面动作所在的标签，放射与检验同属“检验”栏目。`outpatient.section.select` 的描述列出各栏目的 Tool 类别，让模型知道切换到哪里取得目标 Tool。

## Alternatives considered

**继续合并语义相近的 Tool。** 不改变发布机制，但每次合并都扩大单个 Tool 的输入与审阅分支，下一种检查类型仍会触顶。

**Tool 可以属于多个栏目。** 能精确对应兼容复诊流程同时出现在“诊断”和“处方”标签的表单，但签署等 Tool 在结构化流程与兼容流程中位于不同标签，静态多栏目归属会让结构化流程在多个栏目重复发布；单一归属加跨栏目更容易让模型预测 Tool 位置。

**只在前端按栏目过滤。** 改动最小，但 Server 仍授权非当前栏目的操作，栏目边界只靠页面自觉，不构成授权边界。

**把栏目归属写在 Server 的状态收窄分支里。** 能复用 `narrowOperations` 的结构，但前端无法读取，两侧会各自维护一份清单。

## Consequences

每个栏目的发布数为跨栏目 Tool 加该栏目 Tool；当前最多的“检验”栏目为 20 个。跨栏目 Tool 占用每个栏目的名额，新增医生 Tool 默认应声明栏目。合同测试对每个岗位、视图与栏目断言不超过 32，并断言栏目 Tool 只出现在所属栏目。

Agent 调用非当前栏目的 Tool 前必须先切换栏目，并等待工具定义更新；切换后旧 Page Context 失效，旧绑定的调用以既有绑定或授权错误失败。兼容复诊流程的签署预览与签署在“病历记录”栏目发布，而人类在“诊断”或“处方”标签看到同一流程的表单。
