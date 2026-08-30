# Agent Note: 流式导入与校验 Reference Release

Status: proposed

## Problem

`importReferenceDataRelease` 当前把每个 source artifact 转成完整 `ReferenceArtifact` 数组，再复制为带 `sourceId` 的第二组数组；`contentHash` 对所有对象递归 canonicalize 并一次性 `JSON.stringify`。`verifyReferenceDatabase` 又通过 `conceptRows`、`medicationProductRows`、`medicalServiceRows` 和 `valueSetEntryRows` 把整个 Release 读回内存后重复同一 hash。

真实 r2 Release 包含 `nhc-icd10-clinical@2022.r3`、`nhsa-drugs@2026-01-09.r3` 和 `laboratory-cn@2026-08-30.r1`，共 306,422 行。早期两来源 r1 的首次 import 用时 8.16 秒、峰值 RSS 1,129,996 KiB，verify 用时 3.99 秒、峰值 RSS 1,210,472 KiB。加入检验 Candidate 后，r2 幂等重导入用时 5.30 秒、峰值 RSS 1,133,572 KiB；包含 r1/r2 的作者库 verify 用时 7.83 秒、峰值 RSS 1,610,128 KiB。导入结果和校验都正确，瓶颈来自同时保留源对象、带 source ID 对象和完整 canonical JSON，而不是 SQLite 写入本身。

## Proposal

让所有 source adapter 把已验证行写入当前 Reference DB 的 staging 表，Candidate SQLite 使用只读 `ATTACH` 与明确列投影，文本 adapter 通过 iterator 分批插入。唯一性、FK 和状态约束由 staging schema 与逐行 Zod 校验共同保证；所有 source 成功后再在同一 `BEGIN IMMEDIATE` 中发布 Release metadata 和正式行。

新增增量 canonical JSON hasher，按当前 `contentHash` 的键顺序和行排序逐段写入 SHA-256，不构造完整对象树或字符串。import 从 staging 有序扫描，verify 从正式表有序扫描，两者必须产生与现有算法逐字节相同的 hash。旧 Release 不增加 hash algorithm 分支，也不改写 content hash。

## Alternatives considered

**提高 Node heap 或 stack。** 逐项 `push` 已解决大数组 spread 的栈溢出，但提高进程上限不会减少三份同时物化的数据，也无法改善 Runtime 启动时的 verify 峰值。

**只信任 Candidate canonical hash。** 这能跳过 ClinMesh 行级 hash，却无法覆盖 CSV/XML sources、ClinMesh 字段映射、source ID、状态转换和组合 Release，因此会削弱当前防篡改合同。

**为 Candidate Release 引入 content-hash v2。** 新算法实现较简单，但会让 importer、verify、迁移和工具长期维护两套语义。保持现有字节结果可以获得内存收益而不扩大持久合同。

**逐 source 发布后再组合。** 这会让失败导入留下部分 Release，破坏当前原子性和 content hash owner。

## Acceptance criteria

- 合成 CSV/XML/JSON source、疾病/药品/`laboratory-cn`/`loinc-zh-cn` 四种 cn-health Candidate 及多 source 原子失败测试继续通过。
- 真实 r1 仍得到 `5ffa89597f50ff1b931e57aaef685f715c1e772729dea14ba14846d458233b9e`，r2 仍得到 `fefd3638d67ce2c5005798b98aab3f0ca857c823fce0b64a21872f027df55def`。
- 已发布旧 fixture Release 的 content hash 与 migration 校验保持不变。
- import、幂等重导入和 verify 的峰值 RSS 各低于 384 MiB，且不通过关闭 Zod、SQLite integrity/application ID、FK、唯一性或 provenance 校验实现。
- 任一 source、staging insert 或 hash 失败时，`reference_release` 和正式子表不出现部分新 Release。

## Risks

手写增量 JSON 输出若遗漏逗号、可选空数组或属性顺序，会造成 hash 漂移。实施应先用当前小 fixture 对“对象算法”和“流算法”做逐字节 golden 比较，再运行真实 Release。SQLite `ATTACH` 的 schema 名和表名必须来自 Dataset 白名单，路径使用参数绑定；不能把 Manifest 字段拼接为 SQL identifier。
