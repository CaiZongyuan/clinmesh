# 本地指南全文库缺失核查

核验日期：2026-10-26。代码基线：`76aac7a2014b16ba9e905db443fa36327c8d73f5`。本文记录原 26 份资料的缺库诊断及恢复证据；这些来源的用途限制保持不变，未调用真实模型。新增冠心病本地来源另由[评估](2026-10-26-coronary-guideline-folder-assessment.md)登记，不能用原 26 份的默认可检索数量代表当前全部资料。当前运行合同由[部署指南](../deployment.md#免费指南全文同步)及[临床业务流程](../architecture/clinical-workflows.md)拥有。

## 结论与证据强度

26 份原文没有丢失。诊断时缺失的是主运行目录中的 `.data/clinmesh-guidelines.sqlite`；历史成功导入使用的库位于独立实施目录 `clinmesh-worktrees/free-guideline-corpus/.data/clinmesh-guidelines.sqlite`，该实施目录当前已不存在。已确认原库的位置及缺库后的降级机制，未取得原目录被删除的时间、执行者或具体命令证据，也未找到将原库交接到主运行目录的记录。因此，实施环境与主运行环境的本地数据交接缺口有明确依据，但不能将某次迁移或清理操作写成已经查实的删除原因。

此前将当前环境概括为“只有书目、没有取得全文”不准确：本机保留了完整原文，历史交付也实际建过检索库。原文存在、曾经导入、当前运行库存在和当前用途允许检索是四个不同事实。

| 核验对象 | 实际证据 |
| --- | --- |
| 原文文件 | `.data/guidelines/free/2026-10-16/` 的 21 份 PDF 与 5 份 WHO 文本均存在；逐份大小、SHA-256 与原始 manifest 全部匹配，合计 25,501,548 字节；26 个来源身份及哈希也与当前注册表一致 |
| 历史建库 | [PR #221](https://github.com/CaiZongyuan/clinmesh/pull/221)记录实际同步 26 来源、1,255 段；启用适用非商业用途时为 5 来源、116 段。既有[来源研究](2026-10-13-clinical-recommendation-guidelines.md#免费路线的首批原文与正文核验)保留相同统计 |
| 原库绝对位置 | 本地 ClinMesh 历史工具执行记录在 2026-10-16 11:31:08.958 UTC 成功返回 `/home/houyu/clinmesh-worktrees/free-guideline-corpus/.data/clinmesh-guidelines.sqlite`，26 来源、1,255 段、失败数 0、退出码 0；11:32:15.261 UTC 再次返回相同位置和统计 |
| 历史用途检查 | 同一任务在 2026-10-18 01:57:02.124 UTC 返回 26 来源、1,255 段但可检索为 0；01:59:15.926 UTC 在适用用途下返回 5 来源、116 段，均退出码 0 |
| 恢复前运行配置 | 根 `.env` 及本机 Server 进程没有指南路径或非商业用途覆盖；当时使用默认主目录路径，目标库文件不存在；原实施目录也不存在 |
| 恢复前可复现结果 | `node node_modules/tsx/dist/cli.mjs apps/server/src/guideline-sync.ts --check` 退出码 1，返回 `SQLITE_CANTOPEN: unable to open database file` |
| 保留副本搜索 | 已登记 worktree、相关保留目录和项目备份中未找到该库；主项目 `.data` 下 50 个 SQLite 文件只读检查均没有 `guideline_source` 表。搜索结果不证明系统从未存在其他副本 |

本地历史工具记录来自 `rollout-2026-10-16T16-18-28-01a143ca-876b-7211-842e-abd3b207914b` 的成功工具输出，第 1839、1862、3943、4018 行；仅提取库路径、时间及统计，不复制完整会话或凭据。

## 为什么合入功能后仍可能缺库

默认路径由 [config.ts](../../apps/server/src/config.ts:124)依据代码所在目录计算。独立 worktree 中运行同步，默认写入该 worktree 自己的 `.data`；[同步 CLI](../../apps/server/src/guideline-sync.ts:31)使用相同默认规则。`.data/` 被根 `.gitignore` 排除，合并代码不会转移 SQLite 或缓存。[PR #221](https://github.com/CaiZongyuan/clinmesh/pull/221)也明确说明全文不随 Git 分发、部署需要单独同步。该 PR 在 2026-10-18 合入 `ca90ef4`；主目录当时的本地保全记录覆盖源码与 WIP，没有指南库交接条目。

[开发启动准备](../../apps/server/src/development-database-prepare.ts:10)处理业务库、Reference 与 DRG 资料，不调用指南同步。[runtime.ts](../../apps/server/src/runtime.ts:208)仅在文件存在时打开指南库，缺失时不报启动错误，也没有该分支的启动警告，继续使用固定摘录。因此应用能够正常启动，并不能证明本地全文库已就绪。

检查指南导入、指南存储、启动及备份路径，没有发现启动时自动删除指南 SQLite 的代码。导入器的文件清理针对临时下载文件，存储中的删除针对事务内替换的旧段落。该检查不能排除历史人工或工具执行过目录清理。

## 当前使用限制与恢复边界

库文件缺失和用途限制分别影响全文使用。当前非商业用途声明未开启；即使恢复全部正文，按现有登记仍是 21 份国内全文用途未核实、5 份 WHO 全文需要适用的非商业用途声明，不能将恢复文件等同于全部允许发送模型。用途合同见[部署指南](../deployment.md#免费指南全文同步)。

原文及当前注册表的全部来源身份、哈希一致，为重建保留了完整输入。恢复使用现有同步器，不改原始来源、用途标记、正文提取或建议生成规则；将已校验的官方原始字节填入内容寻址缓存后，禁止网络访问并调用现有同步入口，在新阶段库验证完成后以无覆盖方式放置到主运行目录。放置前关闭连接、清空 WAL 并切换为 DELETE 日志模式，避免遗漏已提交正文或覆盖并发创建的库。

## 恢复后的验证

正式库为 `.data/clinmesh-guidelines.sqlite`，缓存为 `.data/guidelines/cache/`；根 `.env` 显式固定 `CLINMESH_GUIDELINE_DATABASE_PATH=.data/clinmesh-guidelines.sqlite`，非商业用途声明未改变。当前 Server 已只读打开恢复的库，健康接口返回 200。沿用现有开发 watcher 重载 Server，源文件内容哈希未变，DSH 宿主未重启；首次 45 秒等待窗口超时，随后独立进程文件描述符及健康检查确认就绪，没有再次重启。

| 检查 | 结果与实际耗时 |
| --- | --- |
| 离线恢复及原文／库自检 | 26 来源、1,255 段，0 失败；完整性 `ok`、外键冲突 0；来源大小、SHA-256、原始下载地址及用途标记匹配，网络请求 0；16.450 秒 |
| 显式目标的 `guideline-sync.ts --check --database <实际库路径>` | 26 来源、1,255 段，当前用途可检索来源及段落均为 0，退出码 0；0.815 秒 |
| `vitest run tests/guideline-corpus.test.ts tests/guideline-sync.test.ts tests/import-guideline-source.test.ts tests/doctor-guideline-corpus-http.test.ts --maxWorkers=2` | 4 文件、66 项通过；32.905 秒。HTTP 测试用合成资料及受控 Provider 验证原文进入生成和复核请求，未启动真实模型验证 |

实际恢复统计、缓存身份、库文件哈希和服务接库证据保留在本地 `.data/maintenance/guideline-corpus-restore-20261026T070753Z/` 的 `restoration.json`、`status-check.json` 与 `activation.json`；这些文件不包含凭据或临床原文。恢复文件不改变现有许可条件，原 26 份资料在默认用途下可检索全文为 0，固定摘录仍可使用。

桌面冠心病资料不属于这 26 个来源，其本地导入不改变上述恢复基线；实际纳入范围、原文质量及来源由[冠心病资料评估](2026-10-26-coronary-guideline-folder-assessment.md)拥有，用途及操作见[本地验证入口](../deployment.md#冠心病资料的本地流程验证)。
