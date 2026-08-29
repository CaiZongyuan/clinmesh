# Agent Note: 删除 Scenario Provider 单值 kind

Status: proposed

## Problem

`ScenarioGenerationProvider.generate` 当前返回 `SourcePatientCorpus`，其中 `content` 是经过来源校验和编译的 `ScenarioDatasetContent`，`sources` 保存每名患者的原始来源、hash 和 localization provenance，`kind` 则固定为 `case-truth`。两个生产消费者 `ScenarioDataService.generate` 和 `ScenarioDataService.processNextGenerationJob` 同时读取 `content` 与 `sources` 来创建 Dataset 和 Synthetic Patient Profile；删除 wrapper 或 `sources` 会破坏身份与来源持久化。仓库内没有生产代码读取 `kind`、按它分支或持久化它，只有两个 Provider 和测试重复附加同一字面量。

单值 `kind` 表现得像一个可扩展的来源类型体系，而实际 Dataset 编译与安装路径只接受一种结果合同。`SourcePatientCorpus` 名称也没有表达 `sources` 已成为 Profile identity/provenance 的必要输入。

## Proposal

把 `SourcePatientCorpus` 重命名为 `ScenarioGenerationResult`，保留 `{ content, sources }`，删除固定的 `kind: 'case-truth'`。内置与 Synthea Provider 继续返回临床内容和逐患者来源，`ScenarioDataService` 继续用两者原子创建 Dataset 与 Profile。

如果未来确实出现第二种生成结果，应先定义它独有的运行时 schema、来源持久化和消费分支，再恢复具有多个真实分支的判别联合。

## Alternatives considered

**保留 `kind` 作为未来扩展点。** 当前只有一个字面量且没有读取者，保留它会让不存在的扩展能力继续成为公共接口的一部分。

**让 Provider 只返回 `ScenarioDatasetContent`。** `sources` 现在用于 Profile source hash、原始 R4 Bundle、mapping compilation 和 localization provenance，不能删除或从 Dataset 内容反推。

**把 `sources` 合并进 `ScenarioDatasetContent`。** 原始 Bundle 与身份 provenance 属于 Profile source artifact，不是可编辑 CaseTruth；合并会扩大 Dataset 持久合同并让作者更新内容时携带原始输入。

## Acceptance criteria

- `ScenarioGenerationProvider.generate` 返回 `{ content, sources }`，仓库生产代码和测试中不再存在固定 `case-truth` 字段。
- 两个 `ScenarioDataService` 消费路径仍把每名患者的唯一 source artifact 交给 `createSyntheticPatientProfiles`。
- 同一请求生成的 Dataset 内容、规范化哈希、诊断、审计 Effect 和任务终态保持不变。
- 内置 Provider、Synthea Provider、持久生成任务、Dataset Validator 和检查 resolver 的现有测试继续通过，Server 类型检查通过。
- Provider 仍不能直接写 Dataset、Package、活动 Epoch、FHIR Repository 或 HIS 领域表。

## Risks

仓库外若存在直接导入 Server 内部 `provider.ts` 的未登记 Adapter，接口重命名会要求其同步修改；当前 workspace export、运行时注册和仓库搜索均未发现此类消费者。机械改写不能漏掉受控测试 Provider，也不能把 `sources` 误并入可编辑 Dataset 内容。
