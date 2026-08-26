# Agent Note: 收窄 Scenario Provider 生成返回值

Status: proposed

## Problem

`ScenarioGenerationProvider.generate` 当前返回 `SourcePatientCorpus`，其中 `content` 是经过来源校验和编译的 `ScenarioDatasetContent`，`kind` 则固定为 `case-truth`。两个生产消费者 `ScenarioDataService.generate` 和 `ScenarioDataService.processNextGenerationJob` 都只读取 `content`；内置与 Synthea Provider 只负责重复附加相同的 `kind` 字面量。仓库内没有按 `kind` 分支的生产代码、动态 Provider 注册或持久化字段，现有[场景数据集与安装快照决策](../../implemented/architecture/2026-08-26-scenario-dataset-and-package.md)也把 Provider 返回合同定义为 `ScenarioDatasetContent`。

这个单值包装层没有隔离验证、持久化或安装责任，却表现得像一个可扩展的来源类型体系。新增 Provider 容易误以为可以返回另一种 corpus，而实际 Dataset 编译与安装路径只接受一种内容合同。

## Proposal

让 `ScenarioGenerationProvider.generate` 直接返回 `Promise<ScenarioDatasetContent>`，删除 `SourcePatientCorpus`，并让 `ScenarioDataService` 把返回值直接交给 Dataset 构造。内置与 Synthea Provider 保留现有来源验证、FHIR 编译、复现元数据和错误分类，只移除 `{ content, kind: 'case-truth' }` 包装。

该收窄放弃在同一方法下增加第二种 corpus 类型的隐式扩展点。如果未来确实出现未编译来源或其他 Dataset 内容类型，应先定义各类型独有的运行时 schema、编译 owner 和消费分支，再引入有多个真实分支的判别联合。

## Alternatives considered

**保留 `kind` 作为未来扩展点。** 当前只有一个字面量和一个消费路径，保留它会让不存在的扩展能力继续成为公共接口的一部分。

**只把 `SourcePatientCorpus` 重命名为生成结果。** 这能降低名称歧义，但仍保留没有生产语义的包装和值。

**立即支持原始 FHIR corpus 与 CaseTruth 两种返回值。** Synthea Adapter 已经在 Provider 边界完成白名单验证和 CaseTruth 编译；把未编译来源交给 Service 会扩大接口并分散来源责任。

## Acceptance criteria

- `ScenarioGenerationProvider.generate` 直接返回 `ScenarioDatasetContent`，仓库生产代码和测试中不再存在 `SourcePatientCorpus` 或固定 `case-truth` 返回包装。
- 同一请求生成的 Dataset 内容、规范化哈希、诊断、审计 Effect 和任务终态保持不变。
- 内置 Provider、Synthea Provider、持久生成任务、Dataset Validator 和检查 resolver 的现有测试继续通过，Server 类型检查通过。
- Provider 仍不能直接写 Dataset、Package、活动 Epoch、FHIR Repository 或 HIS 领域表。

## Risks

仓库外若存在直接导入 Server 内部 `provider.ts` 的未登记 Adapter，接口收窄会要求其同步修改；当前 workspace export、运行时注册和仓库搜索均未发现此类消费者。机械改写时还可能把 `content` 变量与完整 Dataset 混淆，因此验收必须比较生成内容哈希和持久任务结果，而不能只依赖类型检查。
