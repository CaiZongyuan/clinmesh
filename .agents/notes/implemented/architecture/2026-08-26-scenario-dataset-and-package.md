# Agent Note: 场景数据集与安装快照分离

Status: implemented

## Problem

ClinMesh 的 Scenario 初始事实原本由服务端内置蓝图直接拥有，管理员无法通过稳定接口生成、修改或校验一组待安装数据。如果编辑来源事实会原地改变已经运行的 Scenario，旧 Epoch 的重置结果和定义哈希也会随之漂移。把外部生成器作为 Server 启动依赖还会让数据生成故障扩散到现有岗位工作流。本决策由 [issue 37](https://github.com/CaiZongyuan/clinmesh/issues/37) 交付。

## Decision

`ScenarioGenerationProvider` 是患者与场景来源的窄边界，只暴露能力查询和受控生成。Provider 返回经过运行时验证的 `ScenarioDatasetContent`，不直接写活动 Epoch、FHIR Repository 或 HIS 领域表。内置 Provider 始终可用；未配置的外部 Provider 通过能力结果报告不可用，不参与 Server 启动门禁。

`scenario_dataset` 保存 Workspace 内管理员可编辑的生成结果。Dataset 使用 expected version 防止并发覆盖，并保存规范化内容哈希和稳定诊断；错误诊断不阻止继续编辑，但阻止安装。普通岗位不能读取或修改 Dataset。

安装操作把指定 Dataset 版本复制为不可变 `scenario_package`，再由共享 `ScenarioService` 创建新 Epoch。Scenario 定义使用 Package 标识，reset 从 Package 快照重建，而不是回读来源 Dataset。删除或继续编辑 Dataset 因此不会改变已安装运行的定义哈希和重置结果。

外部患者历史和目录只作为 Dataset 的来源材料。OpenHIS 可用于校准中国公立医院目录字段、领域关系和导入分层，但其 seed、生产配置、凭证、物理 schema 和患者级数据不进入 ClinMesh。

## Alternatives considered

**直接修改活动 Epoch。** 这种设计省去安装步骤，但管理员编辑会改变正在进行的岗位事实，无法保留 Epoch 隔离和确定性 reset。

**让 Scenario Run 持续引用可变 Dataset。** 这种设计减少一次快照写入，但 Dataset 删除、修正或并发覆盖会使旧运行无法重放，内容哈希也不再代表安装时事实。

**让每个生成器直接安装 Scenario。** 这种设计缩短调用链，但会把 Provider 与权限、持久化、FHIR 投影和 Epoch 状态机耦合，并允许外部故障跨越生成边界。

**把 Synthea 或其他外部生成器作为默认运行时依赖。** 这种设计能减少可选部署配置，但会把 Java、网络可用性和生成器升级引入现有 HIS 的启动与可用性边界。

## Consequences

新增生成器需要实现同一 Provider interface，并在内容进入 Dataset 前完成来源特有的验证和转换。Provider 不拥有 Dataset 生命周期、安装事务或运行时状态。

Dataset schema 与 Package 快照格式是持久化合同。改变字段、规范化哈希或诊断语义时必须提供显式迁移，并验证旧 Package 的 reset；不能通过重新调用 Provider 恢复既有运行。

安装事务同时创建不可变 Package、Scenario 定义和新 Epoch。该路径继续使用共享 Scenario 状态转换，因此 Web、HTTP 和未来 Agent adapter 不能各自复制安装状态机。

外部 Provider 不可用只会拒绝对应生成请求。内置 Scenario、已有 Package、reset 和普通岗位流程不依赖外部生成服务。
