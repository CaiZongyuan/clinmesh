# Agent Note: 版本化参考数据与轻量运行时分离

Status: proposed

## Problem

Synthea、LOINC、UCUM、医保目录和国家医疗服务目录属于版本、许可和获取方式各异的 authoring 输入。若完整参考数据直接进入 operational database，普通岗位查询、备份、Scenario reset 和运行部署会承担全国目录的体积与更新生命周期；若 Dataset 只读取当前参考数据，又会让映射或上游版本更新改变已经安装的 Scenario Package。本提案由 [issue 42](https://github.com/CaiZongyuan/clinmesh/issues/42) 跟踪。

## Proposal

完整参考数据由独立 Reference Data Release 拥有。Release 以来源 manifest、实际校验过的 artifact checksum、导入诊断、规范化内容和 content hash 不可变发布；失败导入不产生可用 Release。Server 可以在 authoring profile 中只读访问已发布 Release，未配置参考库时仍可使用内置 Reference Data Release 并运行既有 Package。

Scenario Dataset、Synthetic Patient Profile Revision 和不可变 Scenario Package 固定所用 Release 与 mapping、Hospital Baseline 和 compiler 的身份及内容哈希。Package 保存运行所需的 resolved Hospital Baseline 和患者事实；安装、reset 和普通岗位流程不重新访问参考库、Synthea 或上游网络。

Reference Data Release 是完整 authoring reference，Reference Data Package 是构建 Scenario 时选定的 Release 与审核映射集合，Hospital Baseline 是虚构医院从中启用并补齐运行属性的子集。三者不能共享一个可变当前状态。

## Alternatives considered

**把完整参考数据加入 operational SQLite。** 单文件部署更直接，但全国目录会进入普通运行备份、查询和迁移，并使参考更新与 Workspace/Epoch 生命周期耦合。

**只提交每个病例需要的手写目录。** 初始数据很小，但无法自动发现 Synthea 模块缺失编码，也不能证明新增病种复用了相同来源和映射。

**运行时在线查询上游或独立术语服务。** 可以避免本地参考库，但上游可用性、许可账号和版本漂移会进入普通 HIS 请求与 reset 路径。

## Acceptance criteria

- 独立参考库通过显式 CLI 迁移、导入和验证，不写 operational database 或活动 Epoch。
- 每个已发布 Release 固定来源、许可、版本、实际 artifact checksum、记录数和 content hash；同一 ID 不可被不同内容覆盖。
- 管理员可以读取 Release 摘要，普通岗位不能读取完整参考内容。
- 新 Dataset、Profile Revision 和 Package 固定 Release 身份；没有参考库时既有 Package 仍能安装、运行和 reset。
- 真实临时 reference/operational SQLite 测试覆盖原子失败、发布、权限和离线 reset。

## Risks

- Reference Data Package、Release 和 Hospital Baseline 的版本关系若没有集中 compiler，可能在调用方重新形成手工拼装。
- 受限上游文件不能进入 Git 或普通 CI，完整 importer 仍需 opt-in artifact 验证，CI 只能保存合法最小 fixture。
- Package 持久合同增加 provenance 字段时必须兼容升级前数据，不能通过当前 importer 或 mapping 重建旧 Package。
