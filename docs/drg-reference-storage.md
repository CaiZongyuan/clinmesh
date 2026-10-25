# DRG 离线资料储存合同

本合同定义完整离线资料的物理储存、逻辑文件读取和维护转换。安装入口、分发锁与失败恢复见[部署指南](deployment.md#离线-drg-资料核对)；用途继续限定为离线核对，不启用患者分组或支付计算。

## 身份与覆盖

离线锁中的 package 继续保留原版本、来源 URL、manifest/checksums 哈希及隔离条件。原 manifest 和 checksums 描述完整逻辑文件；精简储存另通过可选 `storage` 固定 `clinmesh.drg-compact.v1` 索引的路径和 SHA-256。物理格式变化使用新的 inventory 与 Release 身份；旧格式锁、发行资产和不可变数据库清单保持原身份可用。

索引的 `files` 为每个原逻辑路径保存原 SHA-256、原字节数和内建重建配方；`objects` 为常驻物理路径保存 SHA-256 和字节数。原逻辑文件集合必须恰好等于锁定来源清单，不能通过省略未使用地区、版本、规则或表格降低完整覆盖。来源 manifest/checksums 本身也是逻辑文件和已校验对象。

## 内容表示

- 完全相同文件的多个逻辑路径指向一个常驻对象；别名保留每个地区、版本与来源身份。
- ICD accepted 从完整 records 按资格字段筛选原始行；hierarchy 按首次来源顺序重建层级、父子关系及 occurrence IDs，保留来源 JSON 原始数字词法。
- OpenDRG module JSON 从对应具名 JSON 按固定序列化重建；CSV 从字典、费用、分组参数和目录重建，保留 BOM、引号及换行；合并费用表保留方案、来源表、原行号与 URL。
- 展开 DAT 从保留的 rule-dat-pack 取得对应文本，不执行包内 JavaScript。
- readiness 将重复状态字段保存为模板，保留每条记录的身份和原字段存在性；模板覆盖适用性、缺参、价格准备和隔离原因。
- rule-members 逐行保留全部成员和顺序，以原文页及零起算行号恢复 source 元数据与 rawLine；同一编码出现于多个病组或条件时仍保留每条事实。

所有转换以旧文件的完整字节为最终约束，不能仅凭解析后的 JSON 或 CSV 相等判定成功。无效模板、来源页行失配、缺少依赖和不可重建字节均拒绝转换或读取，不用默认值补全事实。

## 核验与读取

读取器只解释内建的窄 schema 配方；不执行外部代码、访问任意 URL 或自动写入派生文件。逻辑结果必须同时匹配原哈希与字节数，物理文件必须匹配物理索引；路径必须位于其包或储存目录，不允许链接、越界、悬空引用和依赖循环。

每次独立准备重新核验完整物理内容与原逻辑覆盖，继续核对全部表的行数、单位、缺参及选定方案。一次核验内可复用规则汇总和原文页等共享依赖，不保存跨运行的核验结论。校验成功后才原子安装并登记，失败保留原资料和数据库；check-only 仅使用临时目录和临时数据库。

安装目录只保存索引与物理对象，不生成 accepted、CSV、module、展开 DAT 等旧副本。显式导出使用同一读取器，目标必须在受管理来源及安装路径之外；导出失败不覆盖已有目标。完整旧资料的维护者副本和旧版本目录不会被自动删除。

## 维护命令

从完整旧资料创建独立的新目录，转换器核验所有输入并逐文件往返后才发布目录；目标目录必须尚不存在：

```sh
pnpm --filter @clinmesh/server drg:compact --input-root <完整资料根目录> --manifest <旧离线锁> --output <新目录> --inventory <新清单身份> --created-at <ISO日期>
pnpm --filter @clinmesh/server drg:package --input-root <新目录> --manifest <新目录>/drg-offline.lock.json --output <归档.tar.gz>
```

制包只收录索引列出的物理对象与索引本身，输出压缩大小、常驻字节数、物理文件数和规范化离线锁哈希。常驻规模包含新增索引、模板及规范化行；作为仓库配置分发的两份 lock 不计入资料归档体积。固定文件顺序、时间和压缩参数使同一输入可重复制包。

按原逻辑路径导出单个文件：

```sh
pnpm --filter @clinmesh/server drg:export --input-root <已安装版本根目录> --manifest <离线锁> --path .data/reference-prepared/r3/icd10/accepted.jsonl --output <安装目录外>/accepted.jsonl
```

更新默认资料前，先取得精确归档及两份新锁，完成全量往返、空目录安装、重复准备与损坏恢复验证，再以新 Release 资产分发。禁止覆盖旧资产或在同一 inventory 下替换物理索引。相关正式验收见[精简储存规格](spec/2026-10-25-drg-compact-storage.md)，取舍见[Agent Note](decisions/implemented/architecture/2026-10-25-drg-compact-storage.md)。

## 当前固定快照

`clinmesh-drg-offline-2026-10-25.r1` 保留原 `clinmesh-drg-offline-2026-10-22.r2` 全部逻辑文件，每个重建文件的 SHA-256 与旧清单一致。所有 MB 为十进制。

| 指标 | 原完整包 | 精简包 |
| --- | ---: | ---: |
| 逻辑文件数 | 2,335 | 2,335 |
| 归档中的物理文件数 | 2,335 | 411 |
| 常驻资料 bytes | 665,553,443 | 347,615,526 |
| 下载归档 bytes | 60,712,201 | 36,122,034 |
| 常驻减少 | — | 317,937,917 bytes（47.8%） |
| 下载减少 | — | 24,590,167 bytes（40.5%） |

精简常驻规模包含索引、状态模板、规范化行、完整记录、原文页和保留对象。1,889 个文件改为按需派生；两张模板化表合计从 122,784,929 bytes 降至 55,490,111 bytes，其余完全重复内容使用物理别名。归档 SHA-256 为 `e6da3f253bf098a5e694cb6766f0ae57808eab399757636f14322b7f2749efa4`，准确分发身份以[分发锁](../apps/server/reference-data/drg-distribution.lock.json)为准。

公开发行 [drg-reference-2026-10-25-r1](https://github.com/CaiZongyuan/clinmesh/releases/tag/drg-reference-2026-10-25-r1) 的固定下载地址已于 2026-10-25 完整下载核验：HTTP 200、36,122,034 bytes，SHA-256 与上述归档及分发锁一致。

2026-10-25 在仓库外空目录通过受控 HTTP 分发该精确归档，首次完整准备耗时 158,995 ms；关闭 HTTP 服务并移除临时分发配置后，离线重复准备耗时 120,490 ms，返回 `source=installed`、`created=false`，请求总数保持为 1。两次核验及显式导出 readiness 原文件后，安装目录始终为 411 个文件、347,615,526 bytes。这些墙钟值为本机验收观察，不是性能预算；损坏恢复、失败保旧、check-only、危险归档、旧本地离线转换及生产 CLI 由合成公共入口回归覆盖。
