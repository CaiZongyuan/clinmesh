# Agent Note: 来源历史中类型概念的合法结构

Status: implemented

## Problem

当前病例的授权来源历史包含 Device 与 SupplyDelivery，其 `type` 是单个 CodeableConcept；Encounter 与 Organization 使用概念数组。共享临床投影只接受数组时，合法的设备与耗材历史会被校验拒绝。建议读取需要收集这些历史，因此检验、诊断和处方接口一起返回 `INVALID_INPUT`，尚未进入模型生成。需求与授权边界仍由[当前病例读取规格](../../../../docs/spec/2026-10-08-doctor-agent-context-execution.md)及[诊疗建议规格](../../../../docs/spec/2026-10-13-doctor-guideline-recommendations.md)拥有。

## Decision

[共享历史合同](../../../../packages/contracts/src/doctor-history.ts)的 `type` 接受单个概念或概念数组，两种结构均复用现有概念与 coding 字段白名单。保持来源记录的合法结构，不丢弃临床类型信息；未知扩展、原文、URL、对象关联和 metadata 继续从公开投影移除。非法结构仍由现有校验拒绝，不改动历史授权、模型预算或正式临床确认。

## Alternatives considered

- 跳过设备、耗材历史或删除 `type`，会减少模型和医生能核对的临床依据。
- 在建议服务中吞掉历史读取异常，会掩盖缺证，其他共享历史读取入口仍然失败。
- 接受任意 JSON 或字符串，无法维持当前临床字段白名单与类型校验。

## Consequences

来源历史仍是独立的 FHIR R4 输入；公开临床投影不把它转成本院 FHIR R5 资源，也不放开原始资源、隐藏病例答案或任意对象读取。公共 HTTP 回归通过真实合成病例与 SQLite 验证设备和耗材历史保留、原概念数组兼容、三类建议读取及字段过滤，同时断言临床草稿没有被生成或改写。
