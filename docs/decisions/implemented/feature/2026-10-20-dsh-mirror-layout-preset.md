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

`workspace-mirror` 进入 `VALID_LAYOUTS`；ClinMesh 侧桥接的 supported 声明、`ReactSurfaceLayout` 类型与 `verify-artifact` 产物 marker 守卫不进入上游 PR，在 lock 推进（连续升级管线 PR #283）之后的 ClinMesh 侧 diff（PR #284）交付，保持上游预设先于声明合入的顺序（旧构建产物的本机会被 marker 守卫正确拦截）。DSH 宿主集成验收（第三步）在锁定升级后执行；后续 DSH 上游若提供官方镜像预设，迁移路径为替换预设名，ClinMesh 内容区无感。

第三步按上游依赖拆分推进：队列回落卡片（`DoctorQueueRail` 组件与 `surfaceDisplay.queuePresentation: 'rail'`）不依赖上游，先行交付并由 `apps/dsh-web` browser 合同覆盖（ShadowRoot、React 18/19、容器查询、双主题三档字号）；上游镜像预设经 PR #16 合入（`7db43de`）后，lock 由连续升级管线推进（PR #283），`workspace-mirror` 的三类桥接守卫与 `apps/dsh-web` 布局声明、传值切换（退出全屏回到进入前布局）在 PR #284 交付。`dev:dsh` 真实宿主手工验收（镜像几何、队列卡片实位、双主题）随锁定升级执行。

2026-10-22 集成验收补充决定：集成宿主不提供布局切换入口——#153 的「医院工作台」导航以同 slot 同 id 替换了上游启动器（含布局下拉），镜像预设因此没有用户可见的切换路径。经确认（用户 2026-10-22），镜像布局直接作为 ClinMesh 表面的默认形态（注册声明 `default: 'workspace-mirror'`），不新增切换入口；`supported` 保留 `workspace` 供持久化偏好回落。宿主侧栏保持默认收起、所有权不变；「侧栏改造为会话助手」仍属路线 B（会话嵌入）候选，需上游会话列注入接口立项评估，不随本线交付。

2026-10-22 回退决定：用户实机体验后确认会话列保持宿主右侧原生位置，镜像左列形态回退。ClinMesh 声明回到 `default: 'workspace'`，`supported` 移除 `workspace-mirror`（预设本身保留在上游桥接仓库）；短暂镜像默认期写入的存量 `workspace-mirror` 偏好在 Surface 注册时由 `upgradeLegacyMirrorLayout` 自动升级回 `workspace`（setLayout 即落盘，仅发生一次）。队列折叠卡片不再与镜像绑定：`queuePresentation: 'rail'` 成为 DSH 面所有布局的统一队列形态，贴内容区左缘、默认收起、展开含在诊/待诊/完诊页签（用户确认保留该折叠形态）。
