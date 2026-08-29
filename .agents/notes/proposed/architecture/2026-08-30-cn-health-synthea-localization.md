# Agent Note: cn-health 数据与 Synthea 中国本地化接入

Status: proposed

## Problem

ClinMesh 已将 Synthea R4 病史、正式 mapping、Hospital Baseline 和 Scenario Package 分层，但 Patient Profile 仍从八个姓名、四个地址、固定行政代码和真实移动号段外观中重建身份。Synthea Provider 也始终使用 Massachusetts 人口与地域资源；即使 CaseTruth 丢弃美国机构和付款方，来源患者仍不代表中国人口分布，Profile Revision 也无法指出姓名、地理和人口数据版本。

另一方面，`cn-health-data` 已经产生版本化的 `geography-cn`、`population-cn`、`names-cn`、药品和诊断 Candidate，并能将前三者投影为固定 Synthea commit 的 profile、对 R4 Bundle 做确定性身份本地化。LOINC 已有严格适配器，但只有在提供符合其许可条件的来源包后才构建真实 Candidate。ClinMesh 若复制这些数据或继续自行维护姓名和行政规则，会产生第二个 canonical owner。

本决策扩展[Scenario 数据编译与参考数据接入](../../implemented/architecture/2026-08-21-scenario-data-compilation.md)和[可选 Synthea 生成 Provider](../../implemented/architecture/2026-08-26-optional-synthea-provider.md)。

## Proposal

Synthea Provider 的中国 profile 与身份本地化由 `cn-health-data` artifact 拥有。Provider 响应中的 Bundle 必须带 `urn:cn-health-data:synthea-profile` tag，并使用中国地址、安全 synthetic 电话及自有 identifier namespace；metadata 同时返回 profile ID、profile content hash、identity algorithm version 和三个数据依赖。

`compileSyntheaR4Bundle` 继续只拥有临床白名单转换。`createSyntheticPatientProfiles` 在来源 Bundle 带完整且受信的 localization provenance 时，从 Patient 资源提取严格验证的 identity；未带该 provenance 的内置或旧来源使用明显 synthetic fallback，不再生成真实移动前缀外观或真实行政区划式号码。Synthetic Patient Profile Revision 持久保存 localization provenance，新 Release 只影响后续 revision。

ClinMesh authoring reference DB 通过专用 Candidate adapter 验证 `cn-health-data` Manifest、SQLite hash/size、integrity 和 application ID，再把诊断、药品以及已配置来源的 LOINC Candidate 导入现有 reference release。完整 Candidate 不进入 operational SQLite；Hospital Baseline Compiler 仍只冻结病例闭包与 mapping provenance。

## Alternatives considered

**继续维护 ClinMesh 内置姓名和地址列表。** 运行依赖最少，但无法描述人口分布和来源版本，也会与其他消费者重复维护同一中国数据。

**运行时直接查询 cn-health 全量 SQLite。** 可以总是读取最新数据，却使普通 Profile、Package install 和 reset 依赖 authoring artifact，并破坏旧 revision 不漂移的要求。

**只把原始 Synthea Patient 字段写入 Profile。** 可以保留中国 profile 的地理信息，但无法证明美国 SSN、驾照、电话和姓名顺序已经消除，也没有独立 localization provenance。

**在 ClinMesh TypeScript 中完整复制 cn-health 身份算法。** 可以不修改 Provider，但会形成两个算法 owner。ClinMesh 只验证并消费已经本地化的 Bundle；兼容 fallback 明确不冒充人口学真实性。

## Acceptance criteria

- 固定 Synthea commit 的 Docker Provider 使用 cn-health profile 生成 fever、type-2-diabetes、hypertension 各 10 人。
- Bundle identity 只使用中国地址、安全 synthetic 电话和 cn-health identifier namespace，非身份临床资源 hash 保持不变且引用闭合。
- Profile Revision 保存 profile ID/content hash、identity algorithm 与 Candidate dependencies；旧 revision 和旧 Package hash 不变。
- ClinMesh 不再包含八姓名、四地址、`13x` 电话或固定真实行政代码 fallback。
- cn-health 药品、诊断 Candidate 以及提供合规来源后构建的 LOINC Candidate 可以原子导入独立 reference DB，并由现有 mapping/package compiler 消费。
- 安装后的 Package 在 Provider、cn-health Candidate 和外网离线时仍可运行与 reset。

## Risks

- Provider/profile 与 Synthea commit 不匹配时可能在资源加载阶段失败；启动与响应都必须核对固定 commit/profile hash。
- 外部 Bundle 伪造 profile tag 会绕过身份重建；只有 Provider metadata 与 Bundle tag、依赖 hash 全部一致时才能消费来源 identity。
- Candidate schema 变化可能破坏 importer；adapter 只接受明确 Dataset/schema version，不按列名猜测。
- 人口统计是国家级边际分布向地点的投影，不得在 ClinMesh UI 中表述为城市级官方联合统计。
