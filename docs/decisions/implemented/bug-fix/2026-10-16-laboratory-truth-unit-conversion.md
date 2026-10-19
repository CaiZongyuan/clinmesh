# Agent Note: 检验真值单位换算与确定性失败恢复

Status: implemented

## Problem

精确 Case Truth Observation 的 UCUM 编码可能不同于冻结 Laboratory Service，但数值仍可确定换算。直接比较单位字符串会拒绝等价血细胞计数、质量浓度和葡萄糖结果。此类错误在模型调用前发生，却与可恢复的模型输出错误共用错误码，造成重复尝试。取消 Command 已接受失败状态，医生页面与 DSH 的多层可用性判断却未覆盖该错误。

## Decision

Investigation 在精确真值进入结果闭包前执行受控换算。冻结服务继续拥有目标单位与患者适用参考范围，Case Truth 保持不可变。转换只接受明确 UCUM system 和显式源／目标单位对；等价计数保留数值，`g/dL → g/L` 乘以 10，葡萄糖沿用已有审核映射的 LOINC 身份和因子。支持范围和验收由[修复规格](../../../../docs/spec/2026-10-16-laboratory-unit-conversion.md)拥有。

精确真值保留换算后的有限值，不按健康基线的 simulation bounds 夹紧，也不套用其 precision 截断；判读使用冻结目标参考范围。任何叶子的值类型、单位或允许值不兼容都拒绝整个组合，不把已有异常替换成正常值，不创建部分正式报告。

精确真值兼容失败使用 `INVESTIGATION_TRUTH_INCOMPATIBLE`，自动执行首次即失败。该错误与既有 `INVESTIGATION_UNSUPPORTED` 均拒绝显式重试；模型超时、请求失败与 `INVESTIGATION_OUTPUT_INVALID` 保留原有重试规则。既有 `OUTPUT_INVALID` 记录不凭错误文本猜测分类，仍允许显式重试，由当前 resolver 使用原冻结输入换算或给出新分类，无须迁移数据库。

失败申请的取消继续经过既有 Command、责任医生、expected version 和审计。医生页面及 Surface action、DSH operation 可见性和目标校验均接受 `generation-failed`，可以与可恢复错误的重试同时显示；进行中申请仍不可取消。CLI Catalog 版本和医生运行时 Skill 同步描述该恢复合同。

此决定扩展[可信成人检验基线](../architecture/2026-09-02-trusted-laboratory-baseline.md)的单位兼容规则，并局部取代[服务发布](../architecture/2026-09-01-laboratory-service-publication.md)中所有失败均开启三次尝试窗口的恢复描述。

## Alternatives considered

**只替换单位标签。** 等价计数恰好数值不变，但会错误处理质量浓度和葡萄糖。

**引入完整 UCUM 引擎。** 本次只有有限的已知输入；通用量纲转换仍不能自动决定分析物的摩尔质量，引入依赖不会替代临床映射。

**单位冲突时忽略真值并生成健康基线。** 会隐藏已有异常，破坏精确真值优先合同。

**按旧错误消息批量迁移失败申请。** 历史错误码粒度不足；文本不应承担持久化分类协议，显式重试和取消已经提供可验证的恢复方式。

## Consequences

受支持的单位差异可在原冻结申请上恢复，已有成功快照和正式报告不被重写。未知分析物或单位继续明确失败；扩展矩阵需要来源证据和独立数值回归。HTTP／真实 SQLite 覆盖数值转换、异常保留、整单原子性、自动尝试及旧单恢复，页面和 DSH 合同覆盖多层恢复授权，真实 Web 入口验证确认取消与重试操作。
