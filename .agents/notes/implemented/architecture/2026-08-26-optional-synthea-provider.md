# Agent Note: 可选 Synthea 生成 Provider

Status: implemented

## Problem

Synthea 能提供纵向合成病史，但需要 Java、中国地域输入和 FHIR R4 exporter。把它放入 ClinMesh 主镜像或 Server 启动门禁，会让生成器的构建、网络、超时和输出故障影响现有岗位流程。同步 HTTP 生成还无法在 Server 重启后恢复长任务，也可能在 Profile、Case 与任务完成之间留下不一致状态。本决策由 [issue 38](https://github.com/CaiZongyuan/clinmesh/issues/38) 交付。

## Decision

Synthea 固定在 commit `d9d07a6eef91ee5144293b42ab64224d84d124f8`。推荐开发拓扑通过 standalone `compose.synthea-provider.yaml` 只启动非 root Java 容器，本地 Web 与 Server 分别运行在 `51888` 和 `51868`；Provider 在宿主与容器内统一使用 `51878`，并只绑定宿主回环地址。不使用 Docker 时，同一 Provider 接受显式 JAR、配置和监听端口路径，可由本机 JDK 17 启动。完整容器部署使用 `compose.synthea.yaml` 复用 standalone 服务，并把 Server 指向容器内 URL。源码归档在 Docker 构建时校验 SHA-256，运行镜像保留上游 Apache LICENSE 和 NOTICE，使用只读文件系统且不访问 Docker socket。默认 Compose、ClinMesh 主镜像和 Server 启动不依赖该容器；`CLINMESH_SYNTHEA_PROVIDER_URL` 只启用生成能力，不执行启动健康门禁。

管理员通过持久 `ScenarioGenerationJob` 提交外部生成。任务入队时完成管理员授权、Origin、幂等和受信 Actor context 校验；后台完成是该已接受请求的系统续作，不是新的用户请求，因此不因后续角色或活动 Epoch 变化重新授权。任务按 `queued -> running -> succeeded | failed` 推进，由独立于业务 outbox 的单并发 worker 执行；重启时 `running` 任务回到 `queued`。worker 只能在原 Workspace 写入不可变 Synthetic Patient Profile、其独立 Synthetic Case Instance 和任务终态，不能写活动 Epoch、FHIR Repository 或 HIS 运行事实。成功时 Profile、Case 与任务终态在同一 SQLite 事务提交，任务结果只返回 `profileIds` 和 `caseIds`；失败或某个患者在十次尝试后仍没有合格 Index Encounter 时不留下部分 Profile 或 Case。外部 Provider 不能绕过持久任务接口。

Provider HTTP 协议只接受已验证的人数、年龄、性别、生成模式、可选模块过滤、双 seed、时间范围和 `Asia/Shanghai` 时区，并固定调用 `/v1/generate`。默认 `all` 模式运行全部 Synthea 模块；`filter` 只用于管理员显式限制模块。Synthea 使用 [cn-health 数据与 Synthea 中国本地化接入](./2026-08-30-cn-health-synthea-localization.md)拥有的 profile、身份 localizer 和固定 clinical-display projector 输出自包含、不可变的中文 FHIR R4 collection Bundle，使患者、机构和医务人员来源资源可在一个边界内完成身份、资源类型、大小、引用和单患者归属验证。Provider 响应必须匹配请求的 commit、配置哈希、身份依赖与 display catalog provenance、生成模式、模块、双 seed、时间范围和时区；未知资源、悬空引用、跨患者引用、翻译 gap、越界响应和复现元数据漂移产生稳定错误。

其中 translation gap 的失败策略后来由 [Synthea 缺译告警与全量目录默认浏览](../bug-fix/2026-08-31-synthea-translation-warning-and-catalog-browse.md)局部取代；结构、边界和 provenance 错误仍沿用本 Note 的失败语义。

## Alternatives considered

**把 Java 和 Synthea 放入主镜像。** 这种拓扑只有一个容器，但扩大默认镜像和供应链，并让主服务发布依赖 Java 构建。

**让 ClinMesh 通过 Docker socket 启动一次性生成容器。** 这种方式可以按任务隔离进程，但把宿主控制面暴露给应用容器，权限和运维风险高于固定 HTTP Provider。

**在同步接口直接等待 Synthea。** 这种方式少一个任务表，但长请求无法可靠恢复，Server 关闭时也无法持久表达待重试工作。

**让 ClinMesh 接受 transaction Bundle 的外部搜索引用。** 这种方式贴近 Synthea 默认输出，但患者 Bundle 依赖另行导出的美国机构和医务人员资源，无法在持久化前证明引用闭合。collection Bundle 以有限重复换取自包含验证。

## Consequences

Synthea 未配置、未启动、不可达、超时或返回坏数据时，只影响对应生成能力和任务。已有 Profile、Case、Scenario Run、reset 和普通岗位 HTTP 路径不调用该 Provider。

撤销发起人的当前角色不会取消已经入队的工作，也不会把完成结果提升为活动业务事实。需要取消、审批或按执行时权限重验的生成模型属于新的任务协议，不能通过复用临床 Command 授权语义隐式加入。

R4 Bundle 是 Profile 保存的不可变来源材料，不是 ClinMesh FHIR R5 权威数据。Patient、Practitioner 和 Organization 身份在 Provider 返回前由 cn-health localizer 处理；Visible Source History 只读投影与隐藏 Case Truth 从该来源构建，不能被伪装成本院执行过的 Encounter、医嘱、收费或库存事实。开始 Case 时才创建本地 Patient、Registration、Encounter 和 Queue Task，不经过 mapping、Hospital Reference Selection、Dataset、Package 或 install。

固定 seed 只在固定 commit、配置、模块、时间范围和时区下提供复现。改变容器配置、模块映射、R4 白名单或转换规则时必须产生不同复现元数据，不能沿用旧结果的等价性声明。
