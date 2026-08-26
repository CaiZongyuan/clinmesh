# Agent Note: 拆分 Scenario Dataset 编辑组件

Status: proposed

## Problem

`apps/web/src/app/scenario-data-workspace.tsx` 同时拥有 Provider 能力、生成参数、持久任务轮询、Dataset 列表和完整 Dataset 编辑器。文件当前接近 2,000 行，其中 `DatasetEditor` 单独管理远程保存、安装、删除、一个共享 draft，以及患者、病史、问诊、检查、诊断、目录、库存、Hidden Fact、Reveal Policy 和模拟器规则七个 tab。唯一生产入口是管理员 `ScenarioDataWorkspace`，没有其他调用者需要这个宽组件。

共享 draft 和一次性保存是正确的事务边界，但所有字段渲染与集合更新都留在同一函数，会让局部字段变更需要理解无关 tab，并增加可编辑 ID、React key、数组索引和可访问标签相互影响的风险。

## Proposal

保留 `DatasetEditor` 作为唯一 draft、选中患者和 mutation owner，把每个 tab 提取为模块级组件。子组件只接收当前领域值和类型化更新函数，不拥有 TanStack Query、Dataset version、安装或删除状态。通用的不可变数组更新、可选字段删除和稳定新 ID 继续由一个编辑器辅助模块拥有。

优先拆分患者与就诊、纵向病史、问诊应答、查体与检查、诊断与处置、目录与库存、隐藏事实与揭示七个组件。拆分不改变标签文本、DOM control 类型、保存请求体、诊断展示或 mutation 顺序，也不把同一 Dataset 结果复制到 Zustand 或第二个 TanStack Query key。

## Alternatives considered

**每个 tab 拥有独立 draft。** 这能缩小单个 state，但会引入跨 tab 合并、版本和保存顺序，破坏当前一次 PUT 的 Dataset 编辑合同。

**引入通用 schema 表单生成器。** 当前字段包含判别联合、引用选择、业务默认值和按类型显示逻辑；通用生成器只会把这些判断转移到元数据，并扩大新的公共抽象。

**保持单文件并只折叠 JSX。** 视觉折叠不改善模块导航、依赖范围或测试定位，维护成本仍由同一文件承担。

## Acceptance criteria

- `ScenarioDataWorkspace` 只拥有 Provider、生成任务、搜索和 Dataset 选择；`DatasetEditor` 只拥有共享 draft 与保存、安装、删除 mutation。
- 七个领域 tab 的组件各自只有类型化数据和更新输入，不创建服务端状态缓存或网络调用。
- 现有管理员 Web seam 的字段标签、删除确认、校验、版本冲突、安装成功和 PUT body 断言无需修改即可通过。
- Web typecheck 通过，真实管理员入口仍能生成、编辑、保存、安装和删除合成 Dataset。

## Risks

直接移动大段 JSX 容易改变 label 与 control 的关联、列表 key 或闭包中的患者索引。实施应按 tab 逐个移动，每次运行现有 Web seam；不要同时重做表单视觉设计或 Dataset 状态模型。
