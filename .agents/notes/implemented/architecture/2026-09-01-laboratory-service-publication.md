# Agent Note: 完整检验参考库与本院服务发布

Status: implemented

## Problem

完整 LOINC Reference Release、医院实际开展的 Laboratory Service、医生一次 Clinical Request 和 LIS 执行报告具有不同身份、生命周期和可见性。此前病例级目录直接在全局 Reference Concept 上投影 Investigation Generation Capability，使医生看到“当前病例不可生成”，也允许运行时模型配置决定项目能否开立。`laboratory-cn` 的 18 条精选概念与临时白细胞来源同时承担参考术语、本院目录和模拟器 profile，无法消费 `loinc-zh-cn@2.83.r1` 的完整单位、标本和 panel 关系。

本决策由 [issue #66](https://github.com/CaiZongyuan/clinmesh/issues/66) 实施，并局部取代[医生核心临床业务流](../feature/2026-08-24-doctor-clinical-core-workflow.md)、[医生临床目录选择与草稿确认](../feature/2026-08-31-doctor-clinical-catalog-dialogs.md)、[医生草稿自动保存与诊断确认修订](./2026-08-31-doctor-draft-autosave-and-diagnosis-revision.md)和 [Synthea 来源病例与跨 Epoch 重放](./2026-08-30-synthea-case-source-and-replay.md)中的精选数值目录、病例级 capability、永久失败恢复分支与按病例项目永久复用 snapshot 决策。

`laboratory-cn` 的可信数据集发布与 Adult Reference Baseline 是本决策的扩展路径，由[可信成人检验基线](./2026-09-02-trusted-laboratory-baseline.md)拥有。

## Decision

Reference SQLite 接受既有 Dataset Schema v1 和 `loinc-zh-cn` Schema v2。Schema v2 importer 校验 Candidate manifest、SQLite artifact、四张 canonical 表及其记录数，把 LOINC 主表、单位、SYSTEM 标本关系和 panel 成员边原子发布为不可变 Reference Release。Class Type 1 概念属于 laboratory domain；生命体征、临床观察、问卷和量表属于 `other`，不会进入 Laboratory Service 候选。

现有 operational `hospital_service_catalog` 继续作为唯一 Hospital Service owner。管理员从 active、Class Type 1、Order/Both 候选中选择最多 50 个根概念，创建有 expected candidate version 和幂等键的 publication job。Catalog Enrichment 使用独立模型配置和 strict output，在后台补齐本院名称、合成价格、TAT、参考范围、定性值和报告定义；panel 根与 dependency-only 成员在一个 Command transaction 中发布。失败 job 保存结构化错误并保持既有服务不变，未成功候选不进入医生目录。

每次 Workspace Epoch transition 把已发布的 Laboratory Service root/component rows 以相同 ID 和版本物化到新 Epoch，Clinical Request 和报告仍按新业务运行重新创建。Publication job 固定来源 Reference Release；停机中断把 running job 退回 queued，重启后不会改读新的当前 Release。

医生病例目录只返回 active、doctor-orderable Laboratory Service。选择器展示根 LOINC、报告结构、标本和 TAT，不返回 Case Truth、模型或 generation capability。草稿冻结 Hospital Service、根 Reference coding 和完整 report definition；开立重新校验 service ID 与版本。Reference Concept ID 不能替代 Hospital Service ID。旧 `outpatient_catalog` 单项路径只作为既有兼容调用保留，不在新医生目录公开。

Investigation 按冻结 report definition 的叶子闭包执行。每个叶子先按精确 LOINC coding 读取 Case Truth；完整 panel 全部命中时不调用模型，partial panel 只生成缺失叶子。Agent 输入加入当前正式诊断和已有正式检验，并继续限制 Visible History 与私有证据各 20 项；输出必须保持结果全集、值类型、单位、参考范围和判读一致。outbox 最多自动尝试三次，连续失败后才进入 `generation-failed`，且不创建 Specimen、Observation 或 DiagnosticReport。人工重试不重新解释病例级 generation capability，而是为同一冻结申请开启新的三次尝试窗口。

Investigation Result Snapshot 的唯一键是 `workspace + case + Hospital Service + input/evidence hash`。hash 固定 Case revision、服务/报告版本、申请前正式证据与私有来源输入。同一 request 通过持久 snapshot ID 幂等复用；Reset 后相同初始证据复用旧 snapshot；完成报告或诊断变化后的复查形成新 hash 和新 snapshot。

## Alternatives considered

**把完整 LOINC 直接作为医生目录。** 实现最短，但把标准术语误表示为医院开展项目，缺少本院编码、科室、价格、TAT、报告定义和 panel 开立边界。

**继续按病例投影生成 capability。** 可以在开立前避免运行时失败，却把模拟器、Case Truth 和模型配置泄漏给医生，并让所有患者看到不同的医院目录。

**为检验另建一套本院服务表。** 可以避开既有通用 Service schema，但会建立第二个 Hospital Service owner，并重复科室、价格、TAT、组合和版本语义。

**医生首次选择时懒执行 enrichment。** 可以减少提前配置，却把高延迟和模型失败放进临床路径，也使同一服务定义随患者或请求漂移。

**继续按病例和项目永久复用第一个 snapshot。** Reset 简单，但复查无法响应新增诊断或既有报告；evidence hash 同时保留重放确定性和复查新结果。

## Consequences

完整 LOINC 只增加 Reference SQLite 的不可变事实，不复制到 operational SQLite。真实 `loinc-zh-cn@2.83.r1` 导入产生 112,405 个概念、45,207 条单位、112,405 条标本关系和 95,705 条 panel 边；69,651 个 Class Type 1 概念进入 laboratory domain，43,465 个 active Order/Both 概念可作为发布候选。Candidate 标记为不可公开 Registry 发布，ClinMesh 只消费调用方合法取得的本地 artifact。

管理员增加一个异步配置工作面和 `clinmesh-administrator` CLI workflow。医生只能开立已经通过 enrichment 与闭包校验的服务，因此运行时 provider 不可用会形成系统执行异常，而不会改变医生目录或生成默认正常值。

Hospital Service 重新发布不会改写旧申请；每个申请和报告从冻结 snapshot 读取。panel 一次开立产生一个 ServiceRequest、一个 Specimen、每个叶子一个 Observation 和一个 DiagnosticReport。独立检验继续不创建 ChargeItem；收费与退款语义仍由后续独立决策拥有。
