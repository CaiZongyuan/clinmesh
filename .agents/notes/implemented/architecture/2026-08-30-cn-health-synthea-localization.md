# Agent Note: cn-health 数据与 Synthea 中国本地化接入

Status: implemented

## Problem

ClinMesh 的 Synthetic Patient Profile 曾从少量姓名、地址、固定行政代码和真实移动号段外观中重建身份。Synthea Provider 也曾使用美国人口与地域资源，Profile Revision 无法指出姓名、地理和人口数据版本。ClinMesh 若复制中国数据或身份算法，会与通用 `cn-health-data` 形成两个 canonical owner。

本决策由 [issue 42](https://github.com/CaiZongyuan/clinmesh/issues/42) 交付，并扩展[可选 Synthea 生成 Provider](./2026-08-26-optional-synthea-provider.md)。

其中宿主 Candidate/profile 挂载与 UID/GID 配置后来由[一键 Synthea 运行时](./2026-09-03-one-command-synthea-runtime.md)取代；cn-health-data 所有权、身份算法、临床显示和 provenance 校验不变。

## Decision

`cn-health-data` 拥有 `geography-cn`、`population-cn`、`names-cn`、确定性 synthetic identity、Synthea profile 和 FHIR R4 Bundle localizer。ClinMesh Compose 以两个只读非 root 服务运行固定 Synthea 与 cn-health localizer；Provider 使用 profile classpath、外部配置和“中国”地域，启动时验证 profile 与三个 Candidate，逐 Bundle 核对 localizer metadata 和 `urn:cn-health-data:synthea-profile` tag。

cn-health localizer 先生成中国合成身份，再用固定的 `synthea-zh-cn` catalog 投影 clinical display；运行时只接受 approved、human-reviewed 和 machine-checked，任何 gap 整个请求失败，Claim/ExplanationOfBenefit 及其引用闭包被删除。provenance 明确保存 experimental-preview projection ID、catalog SHA-256、语言和记录数，不声称术语内容已具备公开再分发资格。ClinMesh Provider adapter 再次验证 profile ID/hash、固定 commit、依赖集合、display provenance 与 Bundle 双 tag、中国地址、`100` 电话、`.test` 邮箱、项目 identifier namespace 和 `990000` 模拟居民号码。`createSyntheticPatientProfiles` 仅在完整 provenance 可信时复用来源 Patient 身份，并原样保存不可变的完整中文 FHIR R4 Bundle；Index Encounter、Visible Source History 和隐藏 Case Truth 从同一已验证来源确定性派生，不做诊断或药品 mapping。其他来源使用明显虚构的 fallback，不生成真实移动号段外观或真实行政区划式号码。Profile 当前行和每条 revision 独立保存 localization provenance，新 Release 不改写旧 revision。

其中 translation gap 的失败策略后来由 [Synthea 缺译告警与全量目录默认浏览](../bug-fix/2026-08-31-synthea-translation-warning-and-catalog-browse.md)局部取代；catalog/provenance 验证、来源 owner 和不做临床编码 mapping 的决策不变。

ClinMesh 独立 Reference SQLite 通过 `cn-health-candidate` adapter 验证 Manifest、Dataset/Release、SQLite hash/size、integrity、application ID、主表形状和 canonical record count，并原子导入疾病、药品和项目自有 `laboratory-cn` Candidate；调用方提供的完整 `loinc-zh-cn` Candidate 使用同一 concept importer。系统选择一个全局当前 Reference Release，医生通过有界分页和全文搜索使用完整疾病、药品和检验目录。目录行不复制进 Profile、Case 或 operational SQLite；新建业务事实保存当时的 `system + version + code + display` 快照，Synthea 来源编码仅用于展示来源病史。

## Alternatives considered

**继续维护 ClinMesh 内置姓名和地址列表。** 运行依赖少，但无法描述人口分布和来源版本，也会重复维护同一中国数据。

**把全量 cn-health 目录复制进 operational SQLite。** 可以让业务库独立查询，却会重复 Reference SQLite 的 canonical 数据，并让 Profile、Case 与业务事实随当前 Release 漂移。

**只把原始 Synthea Patient 字段写入 Profile。** 可以保留 profile 地理信息，但无法证明美国 SSN、电话和姓名顺序已经消除，也没有独立 localization provenance。

**在 ClinMesh TypeScript 或 Java 中复制 cn-health 身份算法。** 可以减少一个运行服务，但会形成两个算法 owner。独立 localizer 让 ClinMesh 只验证和消费结果。

**按中文名称把 Synthea 编码映射到国家目录。** 使用方便，但同名、多厂家、多规格和版本变化会静默改变来源病史。来源编码与医生选择的本院 coding 因此保持独立。

## Consequences

固定 commit 的 Docker smoke 使用默认 `all` 模式生成患者。真实 Provider 响应经过 ClinMesh adapter 后保存不可变 Profile R4 来源与独立 Case；重启和 reset 复用相同 Profile、Case、Brief 与已冻结 Investigation snapshot，operational SQLite 不出现全量 reference 表。

本地 Candidate 文件通常只允许宿主所有者读取，Compose 通过显式宿主非 root UID/GID 读取只读挂载。部署目录不同或 UID/GID 不同需要配置路径与 `CN_HEALTH_DATA_RUN_AS`，不能提升容器为 root。

药品、疾病和 `laboratory-cn` Candidate 已验证全量导入与当前 Release 搜索；医生新建的诊断、处方和 FHIR ServiceRequest 保留所选 coding 快照。`laboratory-cn` 是项目自行编写的 18 项精选目录，不声称是官方完整 LOINC 中文语言包；构建独立 `loinc-zh-cn` 仍需要调用方提供按适用条款取得的官方来源包。

新 cn-health Release 只影响后续目录搜索；旧 Profile Revision 的本地化来源和已经创建的业务 coding 快照保持不变。Profile/Case 生成不依赖 mapping、Hospital Reference Selection、Dataset、Package 或 install。
