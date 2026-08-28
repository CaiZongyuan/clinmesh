# Agent Note: 病例定义驱动本院目录闭包

Status: implemented

## Problem

Synthea 病种模块、病例作者真值和本院可执行目录解决不同问题。若 Compiler 按病种增加条件分支，新增病种会同时修改患者真值、来源 fixture、映射和目录选择；若每个 Dataset 无条件安装完整 Hospital Baseline，又无法证明病例依赖已映射，也会让普通岗位查询携带与当前能力无关的项目。本决策由 [issue 49](https://github.com/CaiZongyuan/clinmesh/issues/49) 交付，并扩展[Scenario 数据编译与参考数据接入](./2026-08-21-scenario-data-compilation.md)和[版本化参考数据与轻量运行时分离](../../proposed/architecture/2026-08-28-versioned-reference-data-and-runtime-separation.md)。

## Decision

`scenarioCaseDefinitions` 是受版本控制的病例定义注册表。每个 module 在一条定义中拥有 Synthea 根模块、内置来源 fixture、患者认知、症状、查体、检查真值、诊断空间、处置规则和目录依赖；通用 Compiler 只按 module key 取定义并物化 CaseTruth，不按病种分支。当前注册表支持 `fever`、`type-2-diabetes` 和 `hypertension`。

离线 `synthea-inventory` CLI 对固定 Synthea commit 的根模块和 `CallSubmodule` 递归依赖生成 static inventory，并对三个病种各自固定双 seed、时间范围和 10 人 Provider corpus 统计 generated concept、UCUM unit 和资源类型频次。Git 只保存清单、频次和输入内容 hash，不保存可重建的原始患者 Bundle；`references/` 仍是只读输入，不进入运行时。

`compileScenarioCatalog` 从所选病例定义与基础门诊工作流求并集。检查组合递归加入成员，本院服务递归加入组合服务和执行科室，药品加入对应合成库存；药品的可选组合与诊断允许列表裁剪到当前闭包，不通过可选引用带入无关目录。诊断、观察和历史用药仍通过版本化 mapping package 解析，不使用名称匹配；RxNorm `308136` 的 2.5 mg 历史 Drug Concept 与本次可处方的本院 5 mg Medication Product 保持不同身份。

每个新 Dataset 和 Package 保存病例定义 hash、完整 Hospital Baseline hash、编译后目录 snapshot 及所选病种 static/generated inventory 的内容 hash，并保存覆盖条目和频次。覆盖报告分别统计关键真值、工作流必需、仅保留历史、明确忽略、歧义、本院未启用和缺失；关键真值或工作流必需项存在缺失或歧义时 `supported=false`，Dataset validator 产生安装级错误。升级前 Package 没有该可选报告时仍按原 JSON 和 hash 读取、安装和 reset。

## Alternatives considered

**为每个病种增加 Compiler switch。** 局部实现短，但病例真值、内置 Provider 和目录选择会重复同一病种判断，无法从一份定义审查完整依赖。

**所有生成 Dataset 都安装完整 Hospital Baseline。** 可以避免悬空引用，但会把 HbA1c、降糖药或其他服务带入不相关病种，并使目录数量代替真实依赖覆盖。

**只扫描实际生成 corpus。** 频次能反映固定 seed 的实际事件，却会漏掉低概率路径；static module/submodule inventory 与 generated inventory 必须同时保留。

**运行时读取 Synthea 源码或完整参考库。** 可以动态获得最新依赖，但会把 authoring 输入的体积、可用性和版本漂移带入安装、reset 和普通岗位流程。

## Consequences

高血压具有固定 SNOMED CT/RxNorm 映射、病例真值、窄本院目录和可重复 Package hash，并能通过共享 Consultation、检验、诊断、处方、病历和完诊 Command。目录条目数由病例与工作流闭包产生，不作为完整性的输入或替代指标；背景搜索数据和性能放大由独立 profile 负责。新增病种必须先增加一条完整病例定义和覆盖证据，不能在 Compiler、Provider 或 UI 中复制新的病种状态机。
