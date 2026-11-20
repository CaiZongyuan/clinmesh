# DRG 离线资料储存合同

本合同定义完整离线资料的物理储存、逻辑文件读取和维护构建。安装入口、分发锁与失败恢复见[部署指南](deployment.md#离线-drg-资料核对)；用途限定为离线核对与显式规则物化输入，默认不直接启用患者分组或支付计算。

## 身份与覆盖

离线锁中的 package 保留原版本、来源 URL、manifest/checksums 哈希及隔离条件。原 manifest 和 checksums 描述完整逻辑文件；必填的 `storage` 固定 `clinmesh.drg-compact.v1` 索引的路径和校验摘要。当前锁、清单登记、读取和制包只接受这一物理格式；缺少索引的锁被拒绝。旧格式安装不自动迁移；已被当前资料完整替代的旧登记可按[局部恢复合同](deployment.md#旧格式-drg-登记的局部恢复)显式清理，保留临床参考目录及业务数据。当前格式取舍见[当前格式决策](decisions/implemented/simplification/2026-10-25-drg-current-format-only.md)。

索引的 `files` 为每个原逻辑路径保存原 SHA-256、原字节数和内建重建配方；`objects` 为常驻物理路径保存 SHA-256 和字节数。原逻辑文件集合必须恰好等于锁定来源清单，不能通过省略未使用地区、版本、规则或表格降低完整覆盖。来源 manifest/checksums 本身也是逻辑文件和已校验对象。

## 内容表示

- 完全相同文件的多个逻辑路径指向一个常驻对象；别名保留每个地区、版本与来源身份。
- ICD accepted 从完整 records 按资格字段筛选原始行；hierarchy 按首次来源顺序重建层级、父子关系及 occurrence IDs，保留来源 JSON 原始数字词法。
- OpenDRG module JSON 从对应具名 JSON 按固定序列化重建；CSV 从字典、费用、分组参数和目录重建，保留 BOM、引号及换行；合并费用表保留方案、来源表、原行号与 URL。
- 展开 DAT 从保留的 rule-dat-pack 取得对应文本，不执行包内 JavaScript。
- readiness 将重复状态字段保存为模板，保留每条记录的身份、原字段存在性及 `source-only-unverified`、`offline-review`、`integrity-only`、`runtimeEnabled=false` 状态标记；模板覆盖适用性、缺参、价格准备和隔离原因。
- rule-members 逐行保留全部成员和顺序，以原文页及零起算行号恢复 source 元数据与 rawLine；同一编码出现于多个病组或条件时仍保留每条事实。

所有构建以逻辑来源文件的完整字节为最终约束，不能仅凭解析后的 JSON 或 CSV 相等判定成功。无效模板、来源页行失配、缺少依赖和不可重建字节均拒绝构建或读取，不用默认值补全事实。

## 核验与读取

读取器只解释内建的窄 schema 配方；不执行外部代码、访问任意 URL 或自动写入派生文件。逻辑结果必须同时匹配原哈希与字节数，物理文件必须匹配物理索引；路径必须位于其包或储存目录，不允许链接、越界、悬空引用和依赖循环。

每次独立准备重新核验完整物理内容与原逻辑覆盖，继续核对全部表的行数、单位、缺参及选定方案。一次核验内可复用规则汇总和原文页等共享依赖，不保存跨运行的核验结论。校验成功后才原子安装并登记，失败保留原资料和数据库；check-only 仅使用临时目录和临时数据库。

安装目录只保存索引与物理对象，不生成 accepted、CSV、module、展开 DAT 等逻辑副本。显式导出使用同一读取器，目标必须在资料根及安装路径之外；导出失败不覆盖已有目标。完整逻辑来源仅作为维护者构建输入，自动安装只复用当前精简资料或下载固定精简包。

## 维护命令

使用当前离线锁与完整逻辑来源创建独立的新目录。构建器按来源清单核验输入，在输出目录完整检查物理对象、全部逻辑文件和清单语义后才发布；目标目录必须尚不存在。可用相同身份和时间重建同一快照：

```sh
pnpm --filter @clinmesh/server drg:compact --input-root <完整逻辑来源根目录> --manifest <当前离线锁> --output <新目录> --inventory <清单身份> --created-at <ISO日期>
pnpm --filter @clinmesh/server drg:package --input-root <新目录> --manifest <新目录>/drg-offline.lock.json --output <归档.tar.gz>
```

制包只收录索引列出的物理对象与索引本身，输出压缩大小、常驻字节数、物理文件数和规范化离线锁摘要。常驻规模包含索引、模板及规范化行；作为仓库配置分发的两份 lock 不计入资料归档体积。固定文件顺序、时间和压缩参数使同一输入可重复制包。

按原逻辑路径导出单个文件：

```sh
pnpm --filter @clinmesh/server drg:export --input-root <已安装版本根目录> --manifest <离线锁> --path .data/reference-prepared/r3/icd10/accepted.jsonl --output <安装目录外>/accepted.jsonl
```

更新默认资料前，先取得精确归档及两份锁，完成全量往返、空目录安装、重复准备与损坏恢复验证，再以新 Release 资产分发。禁止覆盖已发布资产或在同一 inventory 下替换物理索引。仓库只保存当前格式的发行锁。物理表达与条件分组体系取舍见[DRG 条件程序与离线资料决策](decisions/implemented/architecture/2026-10-25-drg-condition-program.md)。

## 当前固定快照

当前精简快照 `clinmesh-drg-offline-2026-10-25.r1` 完整保留原 `clinmesh-drg-offline-2026-10-22.r2` 的全部逻辑文件与逐文件校验摘要，仅将可无损派生的 accepted、CSV、module、展开 DAT 等逻辑文件转为按需重建，并通过状态模板／原文页行引用压缩 `readiness` 与 `rule-members` 记录、以物理别名去重完全相同的文件。精确逻辑与物理文件计数、常驻与归档字节数、Release 下载地址及 SHA-256 校验值以仓库锁定的[离线清单](../apps/server/reference-data/drg-offline.lock.json)和[分发锁](../apps/server/reference-data/drg-distribution.lock.json)为唯一权威。
