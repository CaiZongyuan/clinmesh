# 本机 PCI 演示规则部署

本入口使用既有[运行时装载机制](../../docs/deployment.md#运行时-drg-规则启用)，把[固定包审核](pci-demo-review.json)用于本机合成医院演示。审核的四项依据、来源原文、实际哈希、临床目录和验收证据见[核验记录](../../docs/research/2026-10-27-pci-drg-demo-enablement.md)。这是实际核验后的固定受信配置，不是制包命令或测试自动生成的批准。

## 准备与身份

先按[参考资料安装](../../docs/deployment.md#离线-drg-资料核对)准备完整资料和临床 Reference 库，再以现有维护命令物化规则。以下路径参数使用绝对路径；输入根目录包含 `.data/drg-compact/v1/index.json`：

```sh
pnpm --filter @clinmesh/server drg:rules:prepare --input-root <已安装精简资料根目录绝对路径> --output-directory <仓库绝对路径>/.data/drg-rules/clinmesh-chs-drg-30-2026-10-25.conditions-v2
```

输出应为完整 `clinmesh.drg-rules.v2`，Manifest SHA-256 必须是 `23dcd363076bbf1956d62788698819d1693b457c2b383818f209b963b7cc9d44`，来源为 `opendrg-chs-drg-3.0@2026-10-20`；已有同包只核对，不覆盖不同身份。将本目录的 [NOTICE.md](NOTICE.md) 复制到物化目录保留署名。实际临床参考库必须发布 `clinmesh-cn-health-2026-09-15.r1`，contentHash 为 `1f4693925350643d55914005b531cb4f9472100caa330c390795d3dcfc4ad2d7`；从管理员资料 Release 与医生诊断目录核对，不用配置字符串或旧 PCI 摘录身份代替。

## 配置与重新启动

在演示环境现有根 `.env` 中同时设置两项，路径相对该环境文件所在目录：

```dotenv
CLINMESH_DRG_RULES_DIRECTORY=.data/drg-rules/clinmesh-chs-drg-30-2026-10-25.conditions-v2
CLINMESH_DRG_RULES_REVIEW_PATH=deployment/drg/pci-demo-review.json
```

其余认证、业务库、参考库及平台配置沿用该演示环境。开发及验收使用合成 Provider 和临时业务库；真实模型与压测仍需当次明确许可。业务库先通过既有迁移检查，停止本环境原 Server 后用原启动命令重新启动。普通开发入口为 `pnpm dev:server`；已完成资料和迁移准备时，可直接使用相同正常 Server 入口：

```sh
node --import tsx apps/server/src/index.ts
```

重新启动使用原业务库和相同规则、审核及临床 Release，不执行 reset，不重复物化病例。医生从“住院 → 患者 → DRG 与费用推演”查看正式事实：固定 PCI 无操作 FR59、实际造影为主 FM59、实际支架为主 FM39；FM39 参考 12,000 元来自 `clinmesh-synthetic-pci-payment@2026-10-25.r1`。FM59 缺支付参数，成本继续显示缺失。计划推演与正式事实分开展示；两项操作均实际完成但选造影为主，仍可能进入 FM59，不能只看 `grouped` 状态。

## 失败与回退

只配置一项、缺审核、四项审核不完整、Manifest 哈希、规则身份或临床 Release 不匹配均拒绝启动。出现不匹配时恢复被审核的同一文件及版本；来源、规则或临床目录升级需要重新核验，不修改审核字段来绕过失败。

暂时停用时同时移除上述两项后重启，其他 HIS 流程保留，DRG 显示规则未就绪。此操作不删除诊疗、资金、病案或回执；旧归档按原冻结结果读取，不因停用或再次启用而重算。既有数据库的操作遵循[备份与恢复](../../docs/deployment.md)，不以新库替换原库。

本审核仅适用于这里固定的本机合成仿真范围。OpenDRG 一般集成说明与国家规则研究公开依据分别保留；审核不宣称实际 bundle 为 Apache-2.0，也不扩大到规则产物再分发、商业产品交付或地方正式医保结算。
