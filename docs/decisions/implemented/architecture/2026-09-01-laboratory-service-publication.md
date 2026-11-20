# Agent Note: 检验参考库同步、本院服务默认启用与可信成人基线

Status: implemented

## Problem

临床检验标准术语库（`laboratory-cn` WS/T 886-2026 及可选完整 `loinc-zh-cn`）、本院实际开展的检验服务（`Hospital Laboratory Service`）、医生单次检验申请与 LIS 签发报告具有不同身份与生命周期。若直接把参考概念当成医嘱目录或按病例投影“是否可生成结果”，会缺失标本、单位、panel 闭包与医院计价边界并向医生泄漏底层 Case Truth 与模型状态；若新环境每次都要求管理员手工逐项发布基础检验，或把缺失／冲突真值一律静默兜底为正常值，则会抬高开箱门槛并掩盖数据不兼容错误。

## Decision

建立离线参考库同步、本院服务自动启用与可信成人基线三层机制，当前业务与仿真合同见[检验、检查与报告](../../../architecture/examinations-and-reports.md)及[仿真、病例与素材](../../../architecture/simulation.md)：

1. **双 Schema 离线参考库与默认自动启用**：`cn-health` 仅作为开发／运维期数据同步工具（`pnpm reference:sync`），经版本锁、Manifest、哈希与关系不变量校验后原子写入独立只读 Reference SQLite（支持既有 Dataset Schema v1、`laboratory-cn` discriminated 原子项／panel 定义及 `loinc-zh-cn` Schema v2 的 11.2 万概念、单位、标本与 panel 边）。启动与新 Epoch 初始化时，系统通过受信内部上下文在 `hospital_service_catalog` 幂等启用 `laboratory-cn` 全部活动单项与组合（普通组合标本取成员交集，“混合标本”保留成员各自标本；心血管核心检验默认合成定价与危急值阈值扩展见[心血管核心检验默认定价基线](../feature/2026-11-12-cardiology-default-labs-and-multivessel-angiography.md)）。管理员仍可通过 CLI 显式选择最多 50 个 `loinc-zh-cn` Class Type 1 候选运行异步 Catalog Enrichment 发布任务；医生目录仅展示已启用的 doctor-orderable 本院服务，绝不暴露生成能力或 Case Truth。
2. **精确真值优先、可信成人基线与证据哈希快照**：检验执行按申请开立时冻结的报告叶子闭包运行。每个叶子优先匹配精确 LOINC／WS/T `Case Truth`（受控单位换算与确定性兼容错误见[检验真值单位换算](../bug-fix/2026-10-16-laboratory-truth-unit-conversion.md)）；缺失叶子若服务具备完整 `Adult Reference Baseline` 且患者按虚拟时间属适用成人，则用独立于临床参考上下限的双侧 `simulation bounds` 与固定 SHA-256 确定性生成缺项（无需外部模型），否则才调用 Investigation Agent（可恢复错误最多自动尝试三次，失败进入 `generation-failed` 且不落盘残缺报告）。结果冻结为以 `workspace + case + Hospital Service + input/evidence hash` 唯一标识的 `Investigation Result Snapshot`：跨 Epoch 重放相同初始证据时零模型复用，新增正式诊断或已完成报告后的复查则因证据哈希变化生成新快照。
3. **统一模拟数据重置与患者库逻辑归档**：管理员唯一首页收敛为模拟数据管理，重置操作经二次确认显式区分“仅重置诊疗进度（创建新 Epoch、沿用已启用检验目录并重放已开始病例）”与“同时清空患者库（对 Profile 标记 `archived_at` 并退役未开始 Case，运行中生成任务阻断清空，完整保留历史临床、报告快照与审计外键）”。

## Alternatives considered

- **在运行时请求中调用 `cn-health` 或把完整 LOINC 直接作为开单目录**：引入运行时外部网络／子进程耦合，并丢失医院编码、价格、周转时间与组合闭包控制。
- **按病例向医生目录投影结果生成能力，或让模型推测成人参考区间**：前者向临床端泄漏隐藏真值与模型配置，后者用不稳定模型输出覆盖权威卫生行业标准数值与双侧模拟分布。
- **任意缺失或不兼容真值统一回退正常值，或按病例与项目永久复用首份快照**：吞掉单位／年龄冲突，且使后续复查无法反映病情与诊断变化。
- **清空患者库时物理删除 Profile 与历史快照**：破坏既有 Epoch 已签发报告、Provenance 与来源档案之间的可追溯完整性。

## Consequences

全新环境同步锁定参考库后即可离线开箱使用完整 `laboratory-cn` 单项与组合检验，成人病例在无外部 AI Provider 时也能保留精确阳性异常并确定性补齐其余常规指标；服务重发不会篡改历史申请已冻结的报告定义与参考范围。首期成人基线不覆盖儿童、妊娠或仪器方法学差异，非兼容真值继续显式失败供医生取消或排查。
