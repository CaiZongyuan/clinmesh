# Agent Note: cn-health 数据与 Synthea 中国本地化接入

Status: implemented

## Problem

ClinMesh 已将 Synthea R4 病史、正式 mapping、Hospital Baseline 和 Scenario Package 分层，但 Patient Profile 曾从少量姓名、地址、固定行政代码和真实移动号段外观中重建身份。Synthea Provider 也使用美国人口与地域资源，Profile Revision 无法指出姓名、地理和人口数据版本。ClinMesh 若复制中国数据或身份算法，会与通用 `cn-health-data` 形成两个 canonical owner。

本决策由 [issue 42](https://github.com/CaiZongyuan/clinmesh/issues/42) 交付，并扩展[Scenario 数据编译与参考数据接入](./2026-08-21-scenario-data-compilation.md)和[可选 Synthea 生成 Provider](./2026-08-26-optional-synthea-provider.md)。

## Decision

`cn-health-data` 拥有 `geography-cn`、`population-cn`、`names-cn`、确定性 synthetic identity、Synthea profile 和 FHIR R4 Bundle localizer。ClinMesh Compose 以两个只读非 root 服务运行固定 Synthea 与 cn-health localizer；Provider 使用 profile classpath、外部配置和“中国”地域，启动时验证 profile 与三个 Candidate，逐 Bundle 核对 localizer metadata 和 `urn:cn-health-data:synthea-profile` tag。

ClinMesh Provider adapter 再次验证 profile ID/hash、固定 commit、依赖集合、中国地址、`100` 电话、`.test` 邮箱、项目 identifier namespace 和 `990000` 模拟居民号码。`compileSyntheaR4Bundle` 只拥有临床白名单转换；`createSyntheticPatientProfiles` 仅在完整 provenance 可信时复用来源 Patient 身份。其他来源使用明显虚构的 fallback，不生成真实移动号段外观或真实行政区划式号码。Profile 当前行和每条 revision 独立保存 localization provenance，新 Release 不改写旧 revision。

ClinMesh authoring Reference SQLite 通过 `cn-health-candidate` adapter 验证 Manifest、Dataset/Release、SQLite hash/size、integrity、application ID、主表形状和 canonical record count，并原子导入疾病、药品和项目自有 `laboratory-cn` Candidate；调用方提供的完整 `loinc-zh-cn` Candidate 使用同一 concept importer。版本化 Hospital Reference Selection 使用 `system + version + code` 选择本院疾病、检验和药品闭包；显示文本不参与批准。选中的疾病和检验快照进入 Dataset 与 Package，本院安装目录及 FHIR ServiceRequest 保留对应 coding。完整 Candidate 不进入 operational SQLite，Package 只冻结选中行、组合 reference provenance、mapping provenance 和 Hospital Baseline。

## Alternatives considered

**继续维护 ClinMesh 内置姓名和地址列表。** 运行依赖少，但无法描述人口分布和来源版本，也会重复维护同一中国数据。

**运行时直接查询 cn-health 全量 SQLite。** 可以读取当前数据，却使普通 Profile、Package install 和 reset 依赖 authoring artifact，并让旧 revision 随当前 Release 漂移。

**只把原始 Synthea Patient 字段写入 Profile。** 可以保留 profile 地理信息，但无法证明美国 SSN、电话和姓名顺序已经消除，也没有独立 localization provenance。

**在 ClinMesh TypeScript 或 Java 中复制 cn-health 身份算法。** 可以减少一个运行服务，但会形成两个算法 owner。独立 localizer 让 ClinMesh 只验证和消费结果。

**按中文名称自动选择全量参考数据中的产品和概念。** 使用方便，但同名、多厂家、多规格和版本变化会静默改变 Package。Hospital Reference Selection 因此要求精确 coding 和自身内容哈希。

## Consequences

固定 commit 的 Docker smoke 对 fever、type-2-diabetes 和 hypertension 各生成 10 人。真实 Provider 响应可以经过 ClinMesh adapter、Profile 保存、Package install、无 Provider/Reference DB 重启和 reset；reset 保持 Package hash，operational SQLite 不出现全量 reference 表。

本地 Candidate 文件通常只允许宿主所有者读取，Compose 通过显式宿主非 root UID/GID 读取只读挂载。部署目录不同或 UID/GID 不同需要配置路径与 `CN_HEALTH_DATA_RUN_AS`，不能提升容器为 root。

药品、疾病和 `laboratory-cn` Candidate 已验证全量导入与精确本院选择；真实 Dataset 中的疾病与检验 `referenceConcept` 会进入不可变 Package，安装后的 `diagnosis_catalog`、检验配置和 FHIR ServiceRequest 保留所选 coding。`laboratory-cn` 是项目自行编写的 18 项精选目录，不声称是官方完整 LOINC 中文语言包；构建独立 `loinc-zh-cn` 仍需要调用方提供按适用条款取得的官方来源包。

安装后的 Package 只依赖自身快照。新 cn-health Release、selection 或 mapping package 只影响后续 Dataset/Profile/Package；旧 Profile Revision、旧 Package 和内置兼容蓝图继续按各自固定内容读取与 reset。
