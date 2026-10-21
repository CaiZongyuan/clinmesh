# Agent Note: 离线 DRG 资料清单与运行时目录分离

Status: implemented

## Problem

既有五目录清洗包和 OpenDRG 快照具有可校验的文件身份，但使用条件、编码兼容、当前适用性和算法正确性尚未全部确认。直接导入已发布临床目录会让完整性核验被误认为业务启用。需求来自 [Issue #267](https://github.com/CaiZongyuan/clinmesh/issues/267) 及其[固定批准规格](https://github.com/CaiZongyuan/clinmesh/blob/e322fef689b009cc0175931b4070b8713c8dedff/docs/spec/2026-10-15-drg-prescription-budget.md)。

## Decision

扩展现有 Reference SQLite 运维 CLI，核验固定来源并原子保存不可变的离线摘要，沿用管理员参考数据 HTTP 入口和共享审计链。资料与临床目录拥有独立的表和发布身份，所有包固定为离线核对用途并保持停用；不加载包内分组程序。当前合同由[参考数据策略](../../../architecture/fhir-and-commands.md#54-中国术语与参考数据策略)拥有，操作步骤由[部署指南](../../../deployment.md#离线-drg-资料核对)拥有。

## Alternatives considered

- 将整个旧 DRG 原型及其 prepared 查询迁入主分支：会把本票依赖绑到独立模拟业务和额外状态，超出资料前置范围。
- 直接发布成临床 Reference Release：会把来源文字通过、机器核验和业务适用性混为一个启用状态。
- 只提交研究报告与哈希：维护者无法从现有公开运维及查询入口复核实际本地文件、重复执行和失败恢复。

## Consequences

完整性失败不会覆盖已发布清单；服务端不执行外部资料程序、不产生编码映射或支付结果。准备成功与失败记录在本地维护审计中，管理员读取追加 operational 审计并保留只读参考库边界。原件及生成资料仍须本地备份，仅有哈希不能恢复原件。后续分组启用仍需要独立的编码适配、使用条件确认、合成支付参数及固定对照测试。

公共 CLI 与真实 HTTP／临时 SQLite 回归覆盖重复准备、完整性错误、版本／格式不兼容、缺文件、行数及路径异常、内容不可变和管理员权限；不将这些结果宣称为分组正确性。
