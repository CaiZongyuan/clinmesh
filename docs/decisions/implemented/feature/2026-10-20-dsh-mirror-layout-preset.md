# Agent Note: 助手会话左列采用镜像布局预设而非会话嵌入

Status: implemented

> 默认采用镜像布局的结论已由[助手会话保持宿主右侧原生位置](2026-10-22-dsh-mirror-layout-rollback.md)反转；不采用会话嵌入的路线 B 取舍、自有桥接仓库预设几何定义，以及 `workspace-mirror` 保留为兼容声明的结论由接替记录共同说明。

## Problem

AI 原生医生工作台的"中病例 + 右建议栈"内容区布局要求助手会话列在左（规格 A2）。`dsh-react-surface` 既有布局预设（`workspace`、`full-frame`、`center`、`right-panel`、`bottom-panel`）均以"助手在右或全屏"为几何前提，没有会话在左的排列。可行性研究见 [DSH 镜像预设可行性](../../../research/2026-10-20-dsh-mirror-preset-feasibility.md)。

## Decision

在自有桥接仓库 `dsh-react-surface` 新增 `workspace-mirror` 布局预设：内容区 bounds 在侧栏与会话列之后内缩，`justifySelf: start` 贴左缘并以右分隔线与会话列分界；resize 边为会话列左缘；窄宽度回落 `full-frame`，最小 `360px` 与 `shrink` 约束下不产生横向滚动。预设为纯几何函数，助手会话 UI、工具绑定与 Composer 零迁移，宿主不识别该预设时布局引擎自动回落，不阻断启动。

## Alternatives considered

会话嵌入（路线 B）：把助手会话 UI 嵌入 ClinMesh 内容区自行渲染。需要迁移会话 UI、工具绑定与 Composer，ClinMesh 长期维护一份宿主会话栈复制品，且每次 DSH 上游升级都要重新对齐，破坏"助手保持 100% 原生"的升级路径。未采用。

等待 DSH 官方提供镜像预设：节奏不可控，阻塞交付。`dsh-react-surface` 是自有桥接仓库，预设改动小且随适配基线维护，自持成本可接受。未采用等待。

## Consequences

`workspace-mirror` 进入上游 `VALID_LAYOUTS`，ClinMesh 侧桥接声明、类型和产物 marker 守卫要求上游预设先于声明合入。默认布局随后回退至 `workspace`，存量偏好升级与队列折叠卡片解耦见[回退决策](2026-10-22-dsh-mirror-layout-rollback.md)。
