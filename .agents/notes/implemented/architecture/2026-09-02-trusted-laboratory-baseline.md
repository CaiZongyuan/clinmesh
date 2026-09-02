# Agent Note: 可信成人检验基线

Status: implemented

## Problem

[issue #69](https://github.com/CaiZongyuan/clinmesh/issues/69) 要求消费 `laboratory-cn` 中版本固定的 WS/T 886 检验定义、成人参考规则、健康模拟元数据和项目整理 panel，同时保持[完整检验参考库与本院服务发布](./2026-09-01-laboratory-service-publication.md)定义的 Reference Concept、Hospital Service、Clinical Request 和 Investigation Result Snapshot owner。把数据集当作运行时查询服务会破坏离线边界；让 Catalog Enrichment Agent 重建医学定义会丢失权威来源和确定性；把缺失或不兼容事实统一替换为正常值会掩盖错误。

## Decision

`cn-health` 是开发和运维阶段的数据交付工具，不是 Server 运行时依赖。仓库锁固定 CLI、Registry 信任根和每个 Dataset Release；`reference:sync` materialize 已验证 Manifest、SQLite 与 receipt，并由 ClinMesh 再校验身份、hash、Schema、canonical 表和关系不变量。成功输入形成一个不可变复合 Reference Release，check-only 使用临时数据库，正式同步不切换运行配置。

`laboratory-cn` 使用独立 discriminated Reference definition 保存原子检验与 panel，不伪造 LOINC 专属字段。WS/T 886、项目 panel 和本地 specimen 使用三个明确的 canonical system。Reference source provenance 保留 Dataset Release、Manifest/SQLite hash、Registry key 和导入诊断；医院目录只保存冻结快照，不回读新 Release 改写旧申请。

`hospital_service_catalog` 继续是唯一 Hospital Service owner。管理员只发布 `laboratory-cn` panel 根，成员是 dependency-only 服务。发布使用确定性运营 policy，不调用 Catalog Enrichment；服务身份只含稳定 panel/leaf coding，不含复合 Reference Release，因此新数据 Release 重发同一 panel 会更新原服务并递增版本。

Adult Reference Baseline 只适用于已冻结完整规则的成人服务。年龄按申请 Virtual Time 计算；男/女规则优先于 `all`，其他或未知性别只使用 `all`。Investigation 先读取完全兼容的 Case Truth，随后用独立 simulation bounds 和固定 SHA-256 算法生成缺项；fixed-normal 直接返回冻结字符串。精确事实不兼容、患者不适用或规则不完整都会失败。Snapshot 固定 Dataset/Reference Release、policy、规则、input hash 和逐项来源，FHIR 报告从该 Snapshot 原子生成。

## Alternatives considered

**在 Hono 请求中调用 `cn-health`。** 这会把 Registry、子进程、网络和工具存储布局带入临床运行时，无法保证离线或请求级原子性。

**由 ClinMesh 自行实现 Registry 下载和签名验证。** 这会产生第二个分发安全边界，并使两个项目对 eligibility、revocation 和 artifact 验证发生漂移。

**继续让 Catalog Enrichment 推测成人规则。** 模型适合补齐本院运营字段，不应覆盖版本化医学来源、precision 或生成边界。

**把 clinical reference bound 当作随机区间。** upper/lower-bound 只表达临床判读；随机生成必须使用独立的双侧 simulation bounds，否则会制造无界或错误分布。

**把任意缺失结果回退为正常。** 这会吞掉精确事实冲突、年龄或性别不适用和数据缺陷。Adult Reference Baseline 是显式、版本化且可审计的生成能力，不是 fallback。

## Consequences

同步命令可以直接报告 `laboratory-cn@2026-09-01.r1` 的 84 个 tests、96 条 references、15 个 panels 和 88 条 members；Server 在同步后可删除 staging 并断网运行。导入 Reference Release 不启用医院服务，发布仍是 Workspace/Epoch 内的显式 Command。

医生只看到 doctor-orderable panel 根。成人健康病例可在没有 Investigation Agent Provider 时完成结构化报告；含精确异常的 partial panel 保留异常事实并只生成缺项。Observation 保留 WS/T 与可用 LOINC coding、患者适用 referenceRange 和逐项来源，Provenance 可追溯 Snapshot、两个 Release、policy 和 input hash。

首期不支持儿童、妊娠、仪器方法、医院自建范围、疾病驱动异常分布或 panel 相关性。WS/T 886—2026 在 2026-11-01 实施，更早启用只能声明为 future-standard preview。
