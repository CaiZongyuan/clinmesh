# Agent Note: 助手会话左列采用镜像布局预设而非会话嵌入

Status: implemented

## Problem

AI 原生医生工作台的"中病例 + 右建议栈"内容区布局要求助手会话列在左（规格 A2）。`dsh-react-surface` 既有布局预设（`workspace`、`full-frame`、`center`、`right-panel`、`bottom-panel`）均以"助手在右或全屏"为几何前提，没有会话在左的排列。可行性研究见 [DSH 镜像预设可行性](../../../research/2026-10-20-dsh-mirror-preset-feasibility.md)。

## Decision

在自有桥接仓库 `dsh-react-surface` 新增 `workspace-mirror` 布局预设：内容区 bounds 在侧栏与会话列之后内缩，`justifySelf: start` 贴左缘并以右分隔线与会话列分界；resize 边为会话列左缘；窄宽度回落 `full-frame`，最小 `360px` 与 `shrink` 约束下不产生横向滚动。预设为纯几何函数，助手会话 UI、工具绑定与 Composer 零迁移，宿主不识别该预设时布局引擎自动回落，不阻断启动。

三个原型验证点（队列卡片钉顶可扫读、会话列单一 Composer 不复制、窄屏容器查询回落）在上游仓库单测覆盖；真实宿主浏览器级 e2e 随 `dsh-upstreams.lock.json` 升级验收（DSH CLI `0.2.1-rc.2` 环境）一并执行。

## Alternatives considered

会话嵌入（路线 B）：把助手会话 UI 嵌入 ClinMesh 内容区自行渲染。需要迁移会话 UI、工具绑定与 Composer，ClinMesh 长期维护一份宿主会话栈复制品，且每次 DSH 上游升级都要重新对齐，破坏"助手保持 100% 原生"的升级路径。未采用。

等待 DSH 官方提供镜像预设：节奏不可控，阻塞第二步交付。`dsh-react-surface` 是自有桥接仓库（`dsh-upstreams.lock.json` 支持 PR 先例为 dsh-ag-ui #66 与本仓库 #15），预设改动小且随 `0.2.1-rc.2` 适配基线维护，自持成本可接受。未采用等待。

## Consequences

`workspace-mirror` 进入 `VALID_LAYOUTS`；ClinMesh 侧桥接的 supported 声明、`ReactSurfaceLayout` 类型与 `verify-artifact` 产物 marker 守卫随 `dsh-upstreams.lock.json` 推进在同一 diff 更新，不在上游 PR 中先行合入（旧构建产物的本机会被 marker 守卫正确拦截）。DSH 宿主集成验收（第三步）在锁定升级后执行；后续 DSH 上游若提供官方镜像预设，迁移路径为替换预设名，ClinMesh 内容区无感。

第三步按上游依赖拆分推进：队列回落卡片（`DoctorQueueRail` 组件与 `surfaceDisplay.queuePresentation: 'rail'`）不依赖上游，先行交付并由 `apps/dsh-web` browser 合同覆盖（ShadowRoot、React 18/19、容器查询、双主题三档字号）；`workspace-mirror` 的三类桥接守卫与 `apps/dsh-web` 布局声明、传值切换仍随 `dsh-upstreams.lock.json` 推进在同一 diff 更新（上游预设 PR 需单独授权推送，预设实现保存在本地 `feat/mirror-preset` 分支）。镜像布局生效前的 `dev:dsh` 真实宿主手工验收（镜像几何、队列卡片实位、双主题）随锁定升级后执行。
