# Agent Note: Synthea 中国本地化病例来源、真值隔离与跨 Epoch 重放

Status: implemented

## Problem

Synthea 生成的纵向 FHIR R4 病史、患者本次待诊隐藏真值、本院实际诊疗产生的 FHIR R5 事实与中国国家临床参考目录具有截然不同的生命周期和可见性。若将 Java 生成器塞入主服务镜像或要求部署者手工配置宿主数据挂载与 UID/GID，会让可选生成能力阻塞日常 HIS 启动并破坏跨环境复现；若把完整 R4 Bundle 直接导入本院 FHIR R5 或按中文名模糊映射到国家目录，会伪造本院历史活动并静默篡改来源病史；若管理员缺少受控真值核对入口或重置时重新调用外部生成器与模型，则无法在不污染临床读取边界的前提下稳定复盘同一病例。

## Decision

围绕固定来源、四层事实隔离与确定性重放建立合成患者管线，当前运行合同见[仿真、病例与素材](../../../architecture/simulation.md)与[部署指南](../../../deployment.md)：

1. **一键不可变镜像运行时与异步生成任务**：部署入口收敛为 `pnpm synthea:up`、`pnpm synthea:doctor` 与 `pnpm synthea:down`，通过 `compose.synthea-provider.yaml` 按不可变镜像 digest 运行非 root、只读文件系统的 `cn-health-synthea-localizer` 与 `clinmesh-synthea-provider`（无需本地挂载 Candidate、JDK 或 Docker socket）。`cn-health-data` 拥有中国合成身份（`100` 号段电话、`.test` 邮箱、`990000` 模拟证件号）与 `synthea-zh-cn` 临床显示投影，剔除 Claim/ExplanationOfBenefit 并附带完整 provenance 校验。Server 仅通过可选 `CLINMESH_SYNTHEA_PROVIDER_URL` 经持久 `ScenarioGenerationJob` 单并发 worker 异步调用 `/v1/generate`，重启自动将 `running` 任务退回 `queued`；无合格 Index Encounter 时换派生 seed 有界重试十次，全成功才在同一事务落盘 Profile 与 Case（按影像／病理适配条目的定向保留生成见[胸片与胸部 CT 阅片闭环](2026-10-01-chest-imaging-reading-loop.md)与[病理切片摄取](2026-10-02-pathology-slide-ingest.md)，多病例作者底稿编译器见[通用 Authored Case Pack 编译器](2026-11-19-authored-case-pack-compiler.md)）。
2. **四类事实唯一归属与管理员只读真值核对**：`Synthetic Patient Profile` 保存合成身份与不可变中文 FHIR R4 Bundle；`Synthetic Case Instance` 与私有 `Case Truth` 仓库固定最后一个临床 Index Encounter 为隐藏答案，此前资源按 `Asia/Shanghai` 业务日期聚合为逐项白名单授权的 `Visible Source History`；Operational SQLite 与 FHIR R5 只记录本院挂号、分诊、医嘱、报告、收费与药房实际产生的事实；独立只读 Reference SQLite 保存系统当前临床目录 Release，业务写入冻结所选编码快照，不做 Synthea 到国家目录的自动编码映射。管理员模拟数据详情提供默认折叠、禁止 HTTP 缓存的专用只读真值核对区，普通临床接口、FHIR、CLI、Page Context 与患者问诊模型均严格隔离 `Case Truth`。
3. **单次消费实体化、跨 Epoch 确定性重放与逻辑清空**：管理员选定无诊断泄漏的不可变 `Patient Persona`（原 Brief）修订后，挂号员窄列表仅暴露 `brief-ready` 待挂号身份摘要，与管理员直启共用 `registration.synthetic-case.start` 物化内核，单次原子创建本院 Patient、Registration、Encounter 与候诊队列。检验优先匹配精确 `Case Truth` Observation，缺失时才生成并冻结 workspace 级 `Investigation Result Snapshot`。管理员重置默认关闭旧 Epoch 并以相同 Case/Profile/Persona 修订和已冻结检查快照在新 Epoch 重放病例（生成新本院业务 ID，零外部模型或 Synthea 调用）；勾选“清空患者库”时执行 `archived_at` 逻辑归档并退役关联未开始 Case（运行中生成任务阻断清空），保留历史临床、快照与审计关联供追溯。

## Alternatives considered

- **将 Java/Synthea 放入主镜像或由 Server 通过 Docker socket 拉起容器**：扩大主服务供应链、暴露宿主机控制面，并使生成器故障拖垮日常 HIS 岗位。
- **将完整来源 R4 Bundle 导入本院 FHIR R5 或自动映射至国家目录**：混淆外院既往史与本院诊疗责任，且同名多规格映射会静默扭曲原始病史。
- **把真值合并进来源历史，或仅在前端隐藏真值面板**：破坏临床可见历史白名单，无法阻止非管理员直接请求接口获取隐藏诊断。
- **Reset 时重新运行 Synthea／模型，或清空患者库时物理删除历史行**：前者导致重放表现漂移，后者打断已签发报告、病例物化与跨 Epoch 审计链的外键追溯。

## Consequences

患者生成成为完全可选的离线可复现外设：未启动 Docker 或 Provider 时不影响既有病例、岗位流转与跨 Epoch 重放。升级 Synthea、localizer 或临床显示目录须发布新镜像并更新锁定 digest；`synthea-zh-cn` 保持实验预览声明，不冒充正式国家标准编码。所有新增临床或 Agent 读取入口均须维持对 `Case Truth` 的负向隔离测试。
