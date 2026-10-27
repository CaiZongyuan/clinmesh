# 部署指南

本指南从 clone 开始，按顺序完成本地部署：基础运行、参考目录同步、AI Provider 配置、Synthea 患者生成与可选运行方式。每一步都以前一步为前提；只想快速体验的读者完成步骤 1、2、5 即可登录演示账号。产品定位与工程形态见仓库根 [README](../README.md)，部署决策与单实例约束见 [Demo 部署架构](demo-architecture.md)。

不配置 Synthea Provider 不阻塞 ClinMesh 启动；Provider 缺失只影响新的患者生成任务。生成患者后，"生成患者档案"和"开始门诊就诊"要求步骤 4 的 AI Provider 已配置。

## 0. 前置条件

| 目标 | 需要的工具 |
| --- | --- |
| 基础运行（步骤 1–2、5） | Node.js `^22.19.0` 或 `>=24.0.0`、pnpm `11.17.0`、Git，首次启动可访问 cn-health Registry 与 GitHub Release |
| 完整参考目录（步骤 3） | 同上，加可访问 cn-health Registry 的网络 |
| 患者档案与就诊闭环（步骤 4） | 同上，加一个 OpenAI-compatible Provider 及 API key，或 DSH 已配置的 Provider |
| Synthea 患者生成（步骤 6） | x86-64 主机上的 Docker Engine 与 `docker compose` |
| 全量检查与生产构建 | Bun `1.4.2`（DSH React Surface artifact 构建使用 `bun`） |
| DSH Web 原生入口 | Bun `1.4.2` 与网络，其余由 `pnpm dsh:setup` 按 lock 自动安装；Windows 同时需要系统自带的 Windows PowerShell 5.1 |
| Mobile 原生目标 | Xcode 或 Android Studio |

pnpm 版本由根 `package.json` 的 `packageManager` 字段固定，可使用 corepack 自动切换。

## 1. 获取代码与安装依赖

```sh
git clone <repository-url> clinmesh
cd clinmesh
git submodule update --init --recursive
pnpm install
```

子模块初始化必须发生在 `pnpm install` 之前：`apps/dsh-web` 通过 `file:` 协议依赖 `vendor/dsh-react-surface/packages/{runtime,build}`，子模块不存在时安装会以 ENOENT 失败。依赖版本由 `pnpm-lock.yaml` 固定；pnpm build scripts 采用 allowlist，只允许仓库明确登记的安装步骤。

## 2. 创建环境文件

```sh
cp .env.example .env
```

已有 `.env` 时不要覆盖。Server 与数据库 CLI 自动读取仓库根 `.env`，显式 shell 环境变量优先级更高。`.env.example` 已包含全部必填项：`CLINMESH_AUTH_SECRET`、`CLINMESH_CURSOR_SECRET`、`CLINMESH_DATABASE_PATH` 和 `CLINMESH_DEMO_PASSWORD`；默认 Server 监听 `127.0.0.1:51868`，Web 开发入口为 `51888`。在 git worktree 中运行时，`.env` 必须位于该 worktree 根目录。

## 3. 参考目录自动准备与维护

默认同步诊断（ICD-10）、药品和 `laboratory-cn` 三个数据集，并自动准备完整 DRG 固定资料；独立 LOINC 目录不进入默认 lock。参考数据保存在独立 Reference SQLite；Server 启动时自动将 laboratory-cn 单项和组合的可开服务快照写入 HIS operational SQLite。仓库提交的 `reference-data.lock.json` 固定每个 Dataset Release 与 Manifest hash；同步只在开发、构建或运维阶段访问 Registry，Server 运行时不执行 `cn-health`，也不访问 GitHub 或 Registry。

`pnpm dev:server` 等正常开发入口会自动准备参考目录；维护者需要提前核对时，可运行 check-only。它按 lock materialize 每个精确 Release 并交叉验证签名、身份、hash、SQLite 和表不变量，不写正式数据库。三个 Dataset 的 materialize 并行执行，stderr 逐阶段输出进度与耗时（stdout 的 JSON 结果不受影响）：

```sh
pnpm reference:sync -- --check
```

当前 `laboratory-cn@2026-09-01.r1` 应报告 `laboratory_test=84`、`laboratory_reference=96`、`laboratory_panel=15`、`laboratory_panel_member=88`。确认后执行正式同步：

```sh
pnpm reference:sync
```

正式同步写入 `.data/clinmesh-reference.sqlite`，相同 lock 重复执行返回幂等成功。`.env.example` 已默认启用 `CLINMESH_REFERENCE_DATABASE_PATH=.data/clinmesh-reference.sqlite`；当前 Release 默认取 `reference-data.lock.json` 的 `compositeRelease.releaseId`（lock 升级后自动跟随），仅覆盖 `CLINMESH_REFERENCE_RELEASE_ID` 时才需要手动维护。同步不会修改 `.env`，也不会热切换已启动的 Server。绕过准备入口直接启动 Server 时，库中缺少当前 Release 会失败关闭（`REFERENCE_RELEASE_NOT_FOUND`），错误消息指引重跑 `pnpm reference:sync`。只有显式移除参考数据库配置时，Server 才使用内置合成 fixture（`clinmesh-hospital-reference-fixture-2026-08-28`）：诊断与检验目录为空，药品目录只有 3 条合成产品，医生无法下诊断或开检验。

### 离线 DRG 资料核对

新用户无需复制资料目录或单独导入。`pnpm dev:server`、`pnpm dsh:setup` / `pnpm dev:dsh` 和 `pnpm dev:lan` 的启动准备自动取得并核验完整五目录 r3 与 OpenDRG 2026-10-20 快照；`pnpm reference:sync` 同样包含这一步。首次准备需要访问 GitHub Release；精简包约 36.1 MB，常驻约 347.6 MB，完整保留原 2,335 个逻辑文件。精确字节、物理文件数和无损读取机制见[DRG 储存合同](drg-reference-storage.md)。Docker 构建时自动准备并将资料及参考库放入镜像，冷启动离线复用，不从个人电脑寻找资料。

自动启动准备使用 `.env.example` 中的参考数据库配置。显式移除 `CLINMESH_REFERENCE_DATABASE_PATH` 时保留合成 fixture 模式，不下载 DRG，也不报告 DRG 已就绪；维护 CLI 显式指定 `--database` 仍可准备目标库。

内容身份由[离线清单](../apps/server/reference-data/drg-offline.lock.json)固定，下载地址、压缩包哈希及解包规模由[分发锁](../apps/server/reference-data/drg-distribution.lock.json)固定。自动安装目录位于参考数据库同级的 `drg-reference/`，默认是 `.data/drg-reference/`，按当前锁身份保存。仓库根或安装目录中已有完整的当前精简资料时，核验后离线复用；缺失时下载固定精简包。开发阶段只维护当前格式，不扫描、转换或回退旧完整安装；已有库残留旧格式登记时，按[局部恢复](#旧格式-drg-登记的局部恢复)处理，不因清单格式变化重建临床参考目录。

正常准备完成后，维护者可从仓库根目录核对结果：

```sh
pnpm --filter @clinmesh/server reference-db list-inventories --database ../../.data/clinmesh-reference.sqlite --page 1 --page-size 20
pnpm --filter @clinmesh/server reference-db inventory-audit --database ../../.data/clinmesh-reference.sqlite
pnpm --filter @clinmesh/server reference-db verify --database ../../.data/clinmesh-reference.sqlite
```

自动准备失败时显示下载或校验错误，启动准备不宣告成功；网络恢复后重跑原启动命令即可。已安装资料完整时不访问分发源；缺失或损坏时重新下载到临时目录，整包及来源文件核验通过才替换安装版本，失败保留已有文件和清单。只想修复 DRG 而不重新同步临床目录时，可运行 `pnpm --filter @clinmesh/server drg:prepare`；它读取与 Server 相同的环境文件和参考库路径，支持 `--database`、`--install-directory`、`--manifest`、`--distribution`、`--input-root` 供维护及隔离验证使用。`--check` 在临时目录核验，不写正式资料目录、数据库或审计。自定义 `--database` 应与 Server 配置一致。

准备在复用或登记当前身份前核验全部已有登记的格式和内容哈希；已有无效登记或其他不可恢复的数据库读取错误会直接失败，不以重新登记掩盖。每轮准备对完整资料核验一遍，登记清单复用本轮核验结果；下一次独立准备仍会重新检查全部文件，已有相同清单返回 `created: false`。LAN 和 DSH 启动器完成参考资料准备后，通过 Server 内部 `dev:prepared` 入口继续启动，只执行数据库迁移；`pnpm dev:server` 独立启动仍执行完整准备。哈希失配、缺文件、版本或格式不兼容、行数不符、越界路径、归档链接、循环依赖、重复或未列入索引的物理文件均拒绝发布；同一 `inventoryId` 不能覆盖。当前精简清单为 `clinmesh-drg-offline-2026-10-25.r1`，原逻辑 manifest/checksums 与全部来源事实保持不变；用途继续固定为离线核对，不启用分组或支付计算。`inventory-audit` 返回最近 100 条本地准备和查询记录，包含实际操作系统用户、时间、成功或失败，不记录原文；完整资料已就绪且相同清单已存在时，自动检查仅以只读方式复用。

维护者构建、制包和按需导出使用[储存维护命令](drg-reference-storage.md#维护命令)，安装不永久生成逻辑副本。新资料资产与两份锁一起更新，不能覆盖已发布快照；仓库只保留当前精简格式的发行锁。

管理员可在登录会话下请求 `GET /api/sim/v1/reference-data/offline-inventories?page=1&pageSize=20`，回读来源、Manifest／文件哈希、版本、行数、来源单位、覆盖与隔离项。HTTP 与 CLI 清单列表均返回 `items/page/pageSize/total`，默认每页 20 条、最多 50 条，可按总数继续翻页。普通岗位访问被拒绝；成功和失败读取沿用 operational 审计链及 FHIR AuditEvent。查询与恢复依据见[参考数据合同](architecture/fhir-and-commands.md#54-中国术语与参考数据策略)。

### 运行时 DRG 规则启用

离线清单就绪只证明文件完整，默认不启用住院分组。需要物化运行时规则时，从上述安装目录中选取当前锁身份对应的精简资料根目录，在仓库根目录执行：

```sh
pnpm --filter @clinmesh/server drg:rules:prepare --input-root <已安装精简资料根目录绝对路径> --output-directory <新规则目录绝对路径>
```

`--input-root` 指向包含 `.data/drg-compact/v1/index.json` 的已安装根目录；命令从精简读取器重建三份固定逻辑输入，不要求旧逻辑路径存在物理文件，也不永久展开来源副本。默认离线锁为 `apps/server/reference-data/drg-offline.lock.json`，隔离准备可用 `--manifest <离线锁绝对路径>` 指定另一份当前格式的固定清单。参数使用绝对路径，避免 `pnpm --filter` 切换到 Server 目录后解析到其他位置。

该命令将 `apps/server/reference-data/drg-rules-source.lock.json` 的三份来源路径及 SHA-256 与离线清单交叉核对，编译完整有序条件并核对 CC、MCC、CCE 与必填 SS_VALID 参数表，不执行上游 JavaScript。输出仅接受 `clinmesh.drg-rules.v2`；当前规则身份为 `clinmesh-chs-drg-30-2026-10-25.conditions-v2`，可将新规则目录放在仓库 `.data/drg-rules/` 下。新包在暂存目录校验后原子发布，重复运行核对同一 Manifest；输出目录已包含不同身份、缺少 Manifest、使用目录链接或产物损坏时明确报错，不能覆盖历史包。输出包含 `manifestSha256`、资料版本与 `runtimeEnabled:false`，不生成启用审核。显式单文件输入制包仍使用[分组维护命令](architecture/drg-grouping.md#规则产物与交接)。

部署审核使用 [`drgRulesReviewSchema`](../apps/server/src/infrastructure/reference-data/drg-rules-package.ts) 定义的本地 JSON：固定 `schemaVersion=clinmesh.drg-rules-review.v1`、`scope=hospital-simulation`，绑定实际 `releaseId/sourceVersion/manifestSha256/referenceReleaseId`，记录核验人和 UTC 时间。`checks.usageTerms/codingCompatibility/sourceApplicability/algorithmValidation` 必须分别有 `status=verified` 和非空证据引用。审核是部署受信配置，文件完整性和制包成功不能代替来源用途、编码与算法核验；不得为通过启动而填写未经证实的结论。

完成这些核验后，在根 `.env` 同时配置以下两个变量并重启 Server：

```sh
CLINMESH_DRG_RULES_DIRECTORY=.data/drg-rules/clinmesh-chs-drg-30-2026-10-25.conditions-v2
CLINMESH_DRG_RULES_REVIEW_PATH=.data/drg-rules/reviews/clinmesh-chs-drg-30-2026-10-25.conditions-v2.json
```

相对路径以环境文件所在目录解析。只配置其中一个、审核不完整、包哈希或规则身份不一致、临床 Reference Release 不匹配时启动失败。审核核对的同一份 Manifest 用于装载文件并再次验证完整条件；旧 v1 包及其审核不能用于 v2，重新制包后须按实际产物哈希、规则身份与临床目录版本核验。未配置时其他 HIS 流程可用，DRG 入口明确显示规则未就绪。运行期只读取物化包，不临时下载来源或执行原分组程序。

固定样本已独立对照冠心病无操作 FR59、实际 `36.0700` 支架置入 FM39、心衰 `I50.900` 的 FR25 和肺炎 `J18.900` 的 ES45；`00.6600` 在该来源有效操作表中未命中，不能以 PTCA 计划代替已核验的支架分组。完整条件程序的固定来源对照见[核验记录](research/2026-10-25-drg-condition-verification.md)，不能代替部署病例全部主次编码、来源用途及适用性的核验。OpenDRG 的公开用途说明亦不足以证明 ClinMesh 重新物化和再分发的全部适用条件，当前完整来源包继续隔离，不随制包自动启用。来源证据边界见[资料核验](research/2026-10-21-opendrg-public-data-inventory.md)。

### 旧格式 DRG 登记的局部恢复

本流程只处理已证明被当前精简资料完整替代的旧登记。`clinmesh-drg-offline-2026-10-25.r1` 与 `clinmesh-drg-offline-2026-10-22.r2` 的全部逻辑文件保持相同 SHA-256，变化的是物理储存和登记身份，见[固定快照](drg-reference-storage.md#当前固定快照)。若旧登记缺少 `storage`，当前读取器会拒绝它；单纯重复下载新资料不能消除旧登记。新安装没有此类残留时无需执行恢复。

维护者显式确认恢复范围后按以下顺序处理；正常准备不会自动删除、忽略或迁移历史记录，当前没有专用清理 CLI。

1. 核对 Server 实际配置的参考库绝对路径与临床 Reference Release，停止会访问或热重启该库的进程，确保维护期间没有并发写入。记录待删除旧身份、预期内容哈希及当前替代身份；不能把所有缺少 `storage` 的记录当成同一类可清理对象。
2. 使用 SQLite 一致备份机制保存完整参考库，包含 WAL 中已提交内容；不要在连接活跃时仅复制主 `.sqlite` 文件。核对备份完整性与源库逻辑状态一致，将目标旧登记的原始 `inventory_id/content_hash/inventory_json`、关联审计、替代依据及非目标数据校验值另行归档。备份与归档放在持久的本地资料目录，不进入 Git，禁止先删记录再备份。
3. 完整核验当前锁对应的物理对象、全部逻辑文件覆盖与原 SHA-256，以及行数、单位、缺参和隔离条件。可从公开入口执行下列 check-only 命令；自定义安装目录时同时指定实际 `--install-directory`，该模式不修改正式数据库、安装目录或审计。

   ```sh
   pnpm --filter @clinmesh/server drg:prepare --database <参考库绝对路径> --check
   ```

4. 对照归档旧登记和本轮核验得到的当前清单，逐项确认来源、版本、manifest/checksums、逻辑文件哈希及覆盖相符，当前登记的身份和内容哈希也必须与核验结果相符。没有明确替代关系、原哈希不符、当前资料不完整或归档不可验证时停止；不补写 `storage`，不改写旧内容或绕过不可变校验。
5. 在短 SQLite 写事务内再次核对目标旧身份、内容哈希及原始 JSON 与归档完全相同，并确认当前替代登记仍与本轮核验结果相符；只删除这次确认的旧登记，要求影响行数与预期一致。保留既有审计、其他登记、全部临床参考目录及业务数据库，任一检查失败则回滚。事务内不进行下载或长时间资料核验。
6. 回读所有剩余清单并运行参考库完整核验，比较清理前后非目标参考数据及既有审计，确认仅目标登记被移除且业务库未修改，再重跑原准备与启动入口。备份和原始归档继续保留；如仍有未知或损坏登记，保留现场并单独诊断，不扩大删除范围。

此流程调整的是已替代登记的维护策略，不恢复旧物理格式支持，也不要求变更临床 Release 配置或重新导入诊断、药品、检验目录。决策理由见[局部恢复决策](decisions/implemented/bug-fix/2026-10-26-drg-inventory-recovery.md)，独有验收条件见[修复规格](spec/2026-10-26-drg-inventory-recovery.md)。

### 免费指南全文同步

正常的 Server、LAN 和 DSH 准备入口会安装[固定指南包](../apps/server/reference-data/guideline-release.lock.json)，不因业务库或 Reference 库已存在而跳过。生产镜像在构建时准备相同资料，启动时离线复核；业务请求不下载原件。也可在仓库根单独准备或只读检查：

```sh
pnpm guidelines:prepare
pnpm guidelines:prepare -- --check
```

包锁拥有精确版本、Release URL、归档 SHA-256、解包规模、清单身份及原始段落数量；[来源清单](../apps/server/reference-data/guideline-release-manifest.json)拥有逐项题名、机构、文献性质、年份、来源、原件哈希及派生正文、核验记录的哈希。快照为 `guidelines-2026-10-26-v1`，包含既有 26 项及新增冠心病 32 项：58 份原件（53 PDF、5 WHO 文本），另有一份题录 XLSX。2016 年中国 PCI 指南使用 MinerU 恢复正文，2015 年冠状动脉痉挛共识使用 PDF.js CMap 正文并以 MinerU 辅助对照；原始导出、独立物理页映射及 Agent 校对修订随包锁定。核验记录的 `reviewerKind` 区分自动检查、Agent 校对与自然人审校；`manualReview` 只记录自然人状态，安装者无需另行提供人工记录。`textStatus=verified` 表示提取正文及定位通过登记的检查，具体校对页和未确认内容以核验记录为准；不能把局部校对称为全篇临床审校，也不能把 2015—2023 年冠心病合集称为最新指南全集。

默认沿用原用途过滤，当前包可检索全文为 0。内部测试部署在根 `.env` 显式选择以下策略后重启 Server，再检查准备结果：

```dotenv
CLINMESH_GUIDELINE_DEPLOYMENT_POLICY=internal-testing
```

该策略仅启用固定包中正文检查通过、状态 active 且至少有一段可靠正文的已登记来源；正文待核验、不可读、已撤回或被替代的来源保持停用。尚未确认的控制字符或替代字符段落完整保留，但在检索候选限额前隔离；可检索段落数因此可能少于已提取段落数，以准备结果为准。来源原始许可和用途待核实状态不变，不将内部测试策略表示为开放许可。取消该策略或设回 `default` 后恢复原限制，部署策略、来源身份、状态、正文与质量规则共同进入 revision，旧建议随之失效；首次建库或切换库路径需重启，已打开的库通过独立 writer 更新后运行中的只读连接可见新内容。未配置路径时，准备器和 Server 都使用 `.data/clinmesh-guidelines.sqlite`。

`guidelines:prepare` 的 stdout JSON 分别报告来源、物理原件、提取、正文核验、原始段落、可检索、异常段落、不可读和自然人待审校数量，并列出逐来源核验说明及 `withheldReason` 停用原因；进度写入 stderr。`--database <path>` 指定目标库，`--install-directory <path>` 指定资料目录，`--manifest <lock>` 指定版本锁。默认原件和正文安装在数据库同目录的 `guidelines/<manifest-sha256>/`；完整安装重复准备可离线复用，`--check` 不下载、不建库、不修改正式目录或审计，同时核对实际库正文，不能用安装成功代替检索命中。更新时维护者发布新版本并修改锁，不覆盖已发布的同版本资产；候选完整验证后整包事务导入，保留其他来源，失败回滚，不替换运行连接所读的 SQLite 文件。下载失败时保留旧库；修复损坏文件后重新准备。进程异常留下 `.prepare.lock` 时，先确认没有准备进程再删除该锁；若报告 recovery failed，先保存错误中给出的 staging／previous 路径并恢复备份，不清理唯一旧版。

准备器的库正文核对会将稳定的数据库主文件和 WAL 一起复制到系统临时目录，在副本中读取已提交事务并核对全文索引与实际正文的一致性；共享内存文件只在临时目录创建，结束后清理，正式目录及其 sidecar 不改写。正文完好但索引损坏也会使检查失败，普通准备可从已安装资料离线重建索引。复制期间如有 writer 提交、checkpoint、文件消失或替换，核对失败；等待写入完成后重跑原命令。遇到 rollback journal 时也等待 writer 完成，不忽略 WAL 或退回仅核对主文件。运行时普通只读连接仍可见后续 writer 更新。

维护者制包时准备原件、派生正文及核验记录，保留正文工具版本和物理页／行字符定位，在仓库外创建完整快照，然后运行 `pnpm guidelines:package -- --input-root <snapshot> --output <archive.tar.gz> --url <固定Release资产URL>`。命令验证全部文件并生成可重复的归档，stdout 返回新版本锁；源码仅纳入清单、锁与实现。首次获取依赖该固定 Release 已发布且可达；备份保留对应锁、完整资料目录和一致性 SQLite 备份。恢复到新路径后先准备／只读检查，再启动 Server；不要复制维护者个人桌面目录作为部署合同。

维护同步发布的撤回、替代、正文待核验／不可读及后续用途收紧优先于固定包，限制与正文在同一事务保存。普通准备、离线复用、新包安装和损坏修复均保留这些限制，可检索、正文不可读统计及 `withheldReason` 按实际库内状态报告，包内核验和规模计数仍描述固定快照；修复正文不会自动恢复启用。整包导入、限制更新和返回结果所需的全库来源状态读取在同一事务完成；任何来源的状态解析失败都会回滚本次导入，安装文件也恢复到更新前的状态。

固定包来源需要重新启用时，维护者先复核对应版本、正文和用途，确认当前锁定快照仍可使用，再明确指定来源 ID：

```sh
pnpm guidelines:prepare -- --restore-source coronary-01-2021
```

`--restore-source` 可重复指定多个来源，仅接受锁定包内 active、正文核验为 `verified` 且有可靠段落的来源。命令重新核对固定包的原件、正文和核验记录，在同一事务恢复指定来源的包内状态与原始许可，保留其余来源的限制；已安装资料可离线使用，不从单篇 `downloadUrl` 重新抓取，也不能与 `--check` 合用。恢复后是否可检索仍由部署用途策略决定。若复核后的版本、正文或许可与当前锁不同，先发布新 Release 并更新锁，不用旧快照解除仍有效的限制。

原有官方来源也可更新注册表并显式运行下文的维护同步；正文核验限制须显式登记恢复为 `verified`，旧注册表缺少核验状态时会拒绝重新导入 active 来源并保留限制，用途限制须更新为复核后的许可与分发状态。冠心病固定包来源使用上述恢复入口；不要通过删除库或限制记录恢复启用。

原有官方来源维护同步仍可独立使用：

```sh
pnpm guidelines:sync
pnpm guidelines:sync -- --check
```

同步从 `apps/server/reference-data/guideline-sources.json` 登记的免费官方地址获取文件，逐项校验 SHA-256 并提取正文；默认数据库为 `.data/clinmesh-guidelines.sqlite`，原文件缓存为 `.data/guidelines/cache`。`--check` 只读现有数据库，不下载；stdout JSON 分别报告来源总数、可检索来源数、段落数、可检索段落数、失败数及逐项状态，进度和失败原因写到 stderr。失败来源使退出码非零，损坏或失败更新保留旧版；来源撤回、被替代或用途收紧为非商业、未核实会优先发布限制并停用旧版，不能因下载失败继续使用。

首批注册表包含 21 份国内官方 PDF 和 5 份 WHO 正文文本，具体覆盖与许可事实由[来源研究](research/2026-10-13-clinical-recommendation-guidelines.md#免费路线的首批原文与正文核验)拥有。`sourceCount` 不等于可供模型使用的数量：国内全文用途暂未核实，标为 withheld；WHO 单篇采用非商业许可，仅适用于已核实的当前科研用途，不能据此承诺商业部署权益。新增或修订来源时由维护者核对版本、状态、许可、下载地址与哈希后更新注册表并重新同步，不自动抓取未知来源或推断最新版本。

在 `default` 部署策略下，只有核实本部署及所用模型服务的实际用途符合对应非商业许可后，才在根 `.env` 显式设置 `CLINMESH_GUIDELINE_NON_COMMERCIAL_USE=true`；未声明或设为 `false` 时非商业全文不进入建议、模型输入或可检索数量。Server、准备和同步 CLI 读取同一声明，变量只接受 `true`／`false`。该开关仅启用现有 5 份 WHO 中正文可靠的段落，不放行用途待核实资料；原有已核短引文沿用其独立依据。内部测试用途由上文的独立策略表达。

Server 默认从 `CLINMESH_GUIDELINE_DATABASE_PATH` 读取该库。库存在时只读打开；缺失时继续使用原有已核短引文，库存在但格式错误时启动失败。首次建立库或改变路径后重启 Server；已打开库的内容更新可被运行中的只读连接读取，并使旧建议失效。可显式使用 `--database <path>`、`--manifest <path>`、`--cache-dir <path>`，其中 `--database` 应与 Server 配置保持一致。备份时保留注册表版本与数据库，并按需保留可重新校验的下载缓存；完整原文和派生数据不提交 Git。正文抽取不等于表格、脚注、临床适用性或所有版本现行性已完成医学审校。

## 4. 配置 AI Provider（患者档案必需）

Server 在启动时按 `CLINMESH_AI_SOURCE` 选择模型来源，默认 `openai`。`pnpm dev:dsh` 自动设置为 `dsh`，复用宿主 Provider 与凭据，无需重复填写下面的地址、密钥或模型变量。在 DSH“设置 → 通用 → ClinMesh 模型”中选择具体 Provider／模型，或保留“使用 DSH 默认模型”；右侧会话的模型选择独立。

DSH 模型任务报 `AI_AUTH_FAILED` 时，在宿主模型设置中检查所选 Provider 的凭据与该模型的访问权限；模型出现在候选目录中不代表上游允许调用。需要改用其他可用模型时，保存新的 ClinMesh 模型选择：问诊点击“重试患者回答”，失败检验点击重新生成；患者档案或目录补全发起新生成任务。已在执行或排队的任务继续使用其绑定模型，已有结果保持不变。

独立 Web 默认使用 OpenAI-compatible Provider。四个基础变量必须同时配置；档案复用 `CLINMESH_AI_BRIEF_MODEL`，自由问诊另配置 `CLINMESH_AI_CONSULTATION_MODEL`：

```dotenv
CLINMESH_AI_BASE_URL=https://provider.example/v1
CLINMESH_AI_API_KEY=replace-with-local-key
CLINMESH_AI_BRIEF_MODEL=provider/brief-model
CLINMESH_AI_INVESTIGATION_MODEL=provider/investigation-model
CLINMESH_AI_CONSULTATION_MODEL=provider/consultation-model
```

laboratory-cn 默认自动启用，不需要 Catalog Enrichment。只有显式配置包含 LOINC 的 Reference Release，并通过 CLI 发布该来源服务时，才需要 `CLINMESH_AI_CATALOG_ENRICHMENT_MODEL`。未配置基础变量时，"生成患者档案"返回 `PROVIDER_NOT_AVAILABLE`，且没有档案就无法把合成病例开始为门诊就诊（`BRIEF_NOT_READY`）。

未配置 consultation 模型时，已有服务仍可启动；自由问诊返回 `CONSULTATION_REPLY_UNAVAILABLE`，保留医生发言并可在模型恢复后重试。每轮问诊最多等待约 30 秒。

可显式运行一次本地 live smoke 验证 schema 与泄漏检查；它不进入 `pnpm check`，不打印档案内容或凭证：

```sh
pnpm smoke:patient-brief:live
```

## 5. 启动并验证

```sh
pnpm dev:server
```

`pnpm dev:server` 先构建 Web，迁移 operational SQLite 和 `.env` 中已配置的 Reference SQLite，seed 演示 workspace 与合成账号，再启动只验证 schema 的监听进程。默认地址：

- Server 与 Web 发布：http://127.0.0.1:51868/
- Web 开发入口（热更新）：`pnpm dev:web` → http://127.0.0.1:51888/
- 健康检查：http://127.0.0.1:51868/api/health
- FHIR metadata：http://127.0.0.1:51868/fhir/R5/metadata

合成演示账号（共用 `.env` 中 `CLINMESH_DEMO_PASSWORD`，从 `.env.example` 复制时默认为 `ClinMesh-demo-password-2026!`）：

| 岗位 | 账户邮箱 |
| --- | --- |
| 挂号员 | `registrar@demo.clinmesh.local` |
| 分诊护士 | `triage@demo.clinmesh.local` |
| 门诊医生 | `doctor@demo.clinmesh.local` |
| 收费员 | `cashier@demo.clinmesh.local` |
| 药师 | `pharmacist@demo.clinmesh.local` |
| 住院医生 | `inpatient-doctor@demo.clinmesh.local` |
| 病区护士 | `ward-nurse@demo.clinmesh.local` |
| 病案人员 | `medical-records@demo.clinmesh.local` |
| 管理员 | `admin@demo.clinmesh.local` |

住院医生、病区护士与病案人员登录后进入住院工作台；挂号员、收费员与药师在各自工作台切换住院页签。住院医生与病区护士的当前岗位绑定具体科室和病区，转科时使用目标科室岗位接管，业务门禁见[临床业务流程](architecture/clinical-workflows.md#82-住院闭环后续)。

完成步骤 3 后，以门诊医生登录并打开诊断选择器应能搜索到 ICD-10 条目，即参考目录生效。

管理员可通过 [住院 CLI 的 PCI 资料准备入口](../skills/clinmesh-inpatient/SKILL.md#诊断医嘱与执行)读取固定版本底稿，再按当前 Epoch 幂等准备首例药耗及检验目录。该步骤只补基础资料和药品批次，不创建患者或就诊；已有价格、配置、库存消耗和业务保留。用量、候选缺项与数据边界见[住院医嘱合同](architecture/clinical-workflows.md#83-医嘱生命周期)，完整病例及 DRG 联合验收仍由对应执行任务完成。

## 6. Synthea 患者生成

Synthea Provider 与中国化 localizer 由固定 digest 的预构建镜像提供。镜像内已经包含固定 Synthea JAR、`synthea-cn@2026-08-29.r4` profile、匹配的姓名/地理/人口 Release 与实验性中文显示目录；宿主机不需要 JDK、Python、Rust、`uv`、第二个源码仓库或数据挂载。

当前 Provider 镜像只发布 `linux/amd64`。arm64 主机不自动启用模拟运行，必须等待对应的原生镜像发行。

启动两个内部容器并等待健康检查：

```sh
pnpm synthea:up
```

命令幂等拉取镜像，只启动 `cn-health-localizer` 与 `synthea-provider`，并在 Provider 真正健康后返回。需要执行一次完整的全模块单患者生成诊断时运行：

```sh
pnpm synthea:doctor
```

`doctor` 只打印版本、profile、模块数和 smoke 结果，不打印生成的 FHIR Bundle、模型内容或凭证。临床显示目录明确属于 `experimental-preview`；结构与 provenance 错误失败关闭，缺失翻译保留来源英文并在患者来源页显示“翻译待确认”。

访问管理员模拟数据页面 `http://127.0.0.1:51868/scenario-data`，在“合成患者库”中点击“生成患者”；默认选择全部 Synthea 模块，每次打开都会产生新的双 seed，高级设置可手动修改以复现。生成完成后选择患者，可在“来源”页查看完整来源病史。

需要能看片的患者时，在“定向病例”中选择一个影像适配条目，性别与年龄会对齐到条目的适用人群。定向生成要求 Provider 镜像在健康检查中声明 `targetedGeneration`；旧镜像不显示该选项。Synthea 在一次运行中固定患者的年龄等人口属性，只重试临床模拟，抽到难以满足条件的年龄时本次尝试约需一到两分钟才判定未命中，Server 随后换 seed 重试，整个任务可能持续十余分钟。肺癌条目把年龄收窄到 48–66 岁能显著缩短等待，因为 Synthea 的肺癌模块只在 45–65 岁发病且数年内死亡。各失败原因的处理见 [影像检查使用指南](imaging.md)。

在“来源历史”中打开任一条目的 R4 详情，点击“生成患者档案”（要求步骤 4 已配置）。Brief 成功且已有当前 revision 后点击“开始门诊就诊”，选择科室、地点和门诊类型；系统直接创建普通 HIS 的 Patient、Registration、Encounter 和 Queue Task，随后即可继续岗位流程。

停止并只移除两个 Synthea 容器：

```sh
pnpm synthea:down
```

该命令不删除 ClinMesh SQLite、业务数据、Docker volume 或其他服务。Provider 未启动、不可达或停止时，ClinMesh 普通 HIS 与已经生成的病例继续运行；只有新的患者生成任务不可用。运行与发行边界见 [一键 Synthea 运行时](decisions/implemented/architecture/2026-09-03-one-command-synthea-runtime.md)。

## 7. 可选运行方式

### 影像素材

胸片与胸部 CT 平扫的阅片需要本地影像素材。素材不随仓库分发：仓库只提交 [影像素材清单](../imaging-assets/README.md)，像素由下面的命令按清单从公开数据源拉取。不安装素材时系统照常启动，医生的放射服务显示为“本院当前未开展”，其余流程不受影响。

```sh
pnpm imaging:sync
pnpm imaging:verify
```

`imaging:sync` 需要访问 The Cancer Imaging Archive，逐文件下载来源 DICOM、校验哈希与 DICOM 中的 Study/Series/Instance UID、转码并原子安装；网络错误、超时、服务端错误、限流和被截断的响应会短暂退避后重试，其他请求错误直接报告失败。安装与保留的来源文件都完好的素材会被跳过，命令可以重复运行，中断后重跑即可，开始时会清理被中断运行遗留的临时目录。首批五套素材的来源文件约 355 MB，安装后另占约 352 MB。经代理访问公网时为该命令设置 `NODE_USE_ENV_PROXY=1`，Node 才会使用 `HTTPS_PROXY`。`imaging:verify` 只读核对已安装素材与 `sources/` 中保留的来源文件，不访问网络；每套素材的状态为 `ready`（完好）、`missing` / `corrupt` / `outdated`（安装目录缺失、损坏或与清单版本不符）、`sources-missing` / `sources-corrupt`（安装可用，但保留的来源文件缺失或哈希不符，无法离线修复）或 `unrecorded`（清单尚未登记）。两个命令都接受可重复的 `--asset <assetId>` 以限定素材。

素材默认安装到 `.data/imaging-assets`，用 `CLINMESH_IMAGING_ASSET_DIRECTORY` 可以改到其他位置；Server 与这些命令读取同一个变量。目录结构是 `sources/`（保留的来源文件）、`installed/`（阅片使用的规范帧数据）和 `.staging/`（安装中的临时目录）。安装完成后的运行期阅片不访问网络。

安装后以管理员进入“模拟数据”，在“影像覆盖清单”查看每套素材的安装与发布状态，并对已生成的病例运行影像准备；只有准备结果为已就绪的病例开立放射申请后才有报告和影像。后续操作和各状态的含义见 [影像检查使用指南](imaging.md)。

素材损坏或被误删时：

```sh
pnpm imaging:repair
```

`imaging:repair` 用 `sources/` 中保留的来源文件离线重建 `installed/`，不访问网络；来源文件也丢失或损坏时重新运行 `imaging:sync`，它会补齐 `sources/` 并重建安装。素材不可读期间，已签发的报告仍可阅读，阅片器提示影像暂不可用，确认已阅不开放；修复后无需重启 Server。

清单和哈希只能校验字节，不能取回字节：公开数据源可能下线或变更，因此仅有清单不构成可恢复的备份。备份 operational SQLite 时同时备份素材目录中的 `sources/`（不可变的来源文件），或者保留一份能独立校验为相同字节的副本；清单、哈希和转码版本随仓库提交固定。`installed/` 可以由 `imaging:repair` 从 `sources/` 离线重建，不必备份。恢复时把 `sources/` 放回目标机器的素材目录，运行 `pnpm imaging:repair` 重建安装，再运行 `pnpm imaging:verify`，确认每套素材都是 `ready`。

Docker 一键镜像不包含影像清单和素材，其中的放射服务显示为未开展；阅片闭环在源码运行方式下使用。

### 病理切片素材

乳腺切片病理会诊使用单独的病理素材包，与上面的放射素材互不依赖：可以只安装其中一个，任何一个缺失、安装失败或损坏都不影响另一个，也不影响 Server 启动。仓库只提交 [病理切片素材清单](../pathology-assets/README.md)，切片像素由下面的命令按清单拉取。

```sh
pnpm pathology:sync
pnpm pathology:verify
```

`pathology:sync` 需要访问 NCI Imaging Data Commons 的公开存储桶（`idc-open-data.s3.amazonaws.com`，匿名读取），按清单登记的序列目录下载来源 DICOM，校验哈希与文件中的 Study/Series/Instance UID，摄取为分层瓦片并原子安装；只下载清单登记的组织层级实例，不下载缩略图。下载按 8 MiB 的字节区间进行，网络错误、超时、服务端错误、限流和被截断的区间在退避后只重试该区间，对象在下载途中发生变化或其他请求错误直接报告失败；进度写入标准错误。安装与保留的来源文件都完好的切片会被跳过，命令可以重复运行，中断后重跑即可。首批七张切片的来源文件约 1.2 GB，安装后另占约 1.6 GB，其中最大的一张来源约 0.76 GB；一张切片的来源实例整份读入内存后摄取，这张切片摄取时进程内存峰值约 1.2 GB，摄取本身耗时数分钟。经代理访问公网时同样为该命令设置 `NODE_USE_ENV_PROXY=1`。`pathology:verify` 只读核对已安装切片与保留的来源文件，不访问网络，状态含义与 `imaging:verify` 相同。两个命令都接受可重复的 `--asset <assetId>` 以限定切片，例如只安装验收所需的两张。

切片默认安装到 `.data/pathology-assets`，用 `CLINMESH_PATHOLOGY_ASSET_DIRECTORY` 可以改到其他位置，`CLINMESH_PATHOLOGY_CATALOG_DIRECTORY` 指向清单目录；它们与放射的 `CLINMESH_IMAGING_*` 变量相互独立。目录结构与放射素材目录相同：`sources/`（保留的来源文件）、`installed/`（每张切片的 `levels/<n>.tiles` 瓦片文件、`levels/<n>.index` 偏移索引、`icc-profile.icc` 和安装回执）和 `.staging/`。来源文件头带有公开数据集的受试者编号，`installed/` 中没有。

切片损坏或被误删时：

```sh
pnpm pathology:repair
```

`pathology:repair` 用 `sources/` 中保留的来源文件离线重建 `installed/`，重建结果与清单登记的哈希逐字节一致；来源文件也丢失或损坏时重新运行 `pathology:sync`。摄取的转码与降采样结果依赖清单登记的编解码库版本，升级 `jpeg-js` 或 `@cornerstonejs/codec-openjpeg` 后同步与修复会在哈希核对处失败，需要维护者重新登记。

备份规则与放射素材相同但分开执行：备份病理素材目录中的 `sources/` 或保留一份能独立校验为相同字节的副本，`installed/` 不必备份；恢复时放回 `sources/`，依次运行 `pnpm pathology:repair` 与 `pnpm pathology:verify`，确认每张切片都是 `ready`。两个素材包的备份、恢复和修复互不影响。

### Docker 一键启动

需要完整容器化运行时（含 Synthea）时叠加两个 Compose 文件：

```sh
docker compose -f compose.yaml -f compose.synthea.yaml up -d --build
```

- Web：`http://localhost:51868/`
- 模拟数据：`http://localhost:51868/scenario-data`

容器入口使用命名卷 `clinmesh-data`，在启动应用进程前执行幂等 migration。除非明确要删除本地合成数据，不要使用 `docker compose down -v`。只需要容器化 ClinMesh、不需要 Synthea 时可单独运行 `docker compose up -d --build`。

### 生产构建与 Node.js 直跑

```sh
pnpm build
pnpm --filter @clinmesh/server db:migrate
pnpm --filter @clinmesh/server start
```

构建顺序由 workspace 依赖和 Turborepo 决定：先生成 Web assets，再生成 Server 的 Node.js bundle，同时构建 Desktop、DSH Surface artifact 和文档站。Server 启动时只验证 migration 状态，不隐式修改 schema；`CLINMESH_HOST`、`CLINMESH_PORT` 和 `CLINMESH_WEB_ROOT` 可覆盖运行配置。

升级前保留一致备份。门诊号迁移要求完整可信的历史发行证据，证据不足时拒绝迁移并保留原库；不要从现存最大号手工补发号状态。恢复旧备份需要同时保全可信最新发行权威库，停用旧 Server，再执行带 `--authority-database` 的受控恢复并切换到新目标。具体命令、失败处理和克隆边界见[数据库运维](demo-architecture.md#database-operations)。

### 局域网访问 Web 开发入口

```sh
pnpm dev:lan
```

该命令同时启动 Server 和 Web：自动识别私有 IPv4 地址、让 Vite 监听 `0.0.0.0:51888`，并把本机及识别到的 Web origins 注入 `CLINMESH_TRUSTED_ORIGINS`。启动进程前会检查数据源并打印就绪状态：Synthea Provider 按 `CLINMESH_SYNTHEA_PROVIDER_URL` 探测，URL 未配置时只提示患者生成不可用；不可达且为本地受管地址（环回主机名加 `CLINMESH_SYNTHEA_PROVIDER_PORT` 端口）时自动执行与 `pnpm synthea:up` 等价的拉起，Docker 不可用、拉起失败或为远程地址时只打印警告并继续（HIS 正常运行，仅新的患者生成任务不可用）。参考目录数据库缺失或未包含当前 lock Release 时，自动向配置的数据库路径执行 `pnpm reference:sync`，同步失败时降级警告并继续；Server 仍对已配置库的 Release 缺失执行失败关闭。`0.0.0.0` 仅用于监听，浏览器应访问打印出的具体地址；只需允许防火墙 TCP `51888` 入站。未识别到正确地址时可显式指定，例如 `CLINMESH_LAN_IP=192.168.1.23 pnpm dev:lan`。开发入口不提供 HTTPS，只应暴露在可信局域网内。

### DSH Web 原生入口

ClinMesh 只要求 DSH、React Surface 和 AG-UI。精确来源、版本、commit、依赖关系及维护归属由 [`dsh-upstreams.lock.json`](../dsh-upstreams.lock.json) 记录；React Surface 与 AG-UI 均直接声明当前 RC 依赖。其他插件与旧 HIS Demo 不属于此组合，不需要升级或逐项验收，也不应覆盖它们的配置和数据。跟进公开正式版和 RC 时更新经过验证的精确输入，不把 `latest` 当作可复现版本。

Windows PowerShell、Linux 和 macOS 使用两条命令完成搭建与启动：

```sh
pnpm dsh:setup
pnpm dev:dsh
```

`dsh:setup` 幂等供给 `.data/dsh-runtime/` 沙箱（已忽略，`CLINMESH_DSH_SANDBOX` 可覆盖到仓库外）：按 lock 安装 dshvm 工具目录与隔离宿主槽位、用宿主锁文件恢复依赖、克隆锁定 commit 的 AG-UI、构建 React Surface runtime 与 ClinMesh DSH artifact、组装 Web Profile 并重验三个插件 `link:`。`dev:dsh` 复用同一 ensure，然后直接启动 ClinMesh Server（`pnpm --filter @clinmesh/server dev`，绕过 Turborepo，`CLINMESH_AI_*` 直接生效）与 DSH Web（`dshvm exec web --port 3080 --no-open`）；Ctrl+C 或任一进程退出时全部停止并打印原因。就绪横幅打印 DSH Web 与 Server 地址；DSH Web 的真实入口是 Host 打印的带本次启动 token 的地址，直接打开无 token 地址会被要求认证。子进程日志以 `[Server]`/`[DSH]` 前缀标注归属，ensure 探测命令静默执行（失败时回显输出尾部）。`CLINMESH_DSH_BRIDGE_SECRET` 缺失时自动生成并追加到 `.env`，已有值不覆盖；`CLINMESH_TRUSTED_ORIGINS` 自动包含 `127.0.0.1:51868/51888/3080`，自定义 `CLINMESH_PORT` 时跟随。前置只检查 Bun `1.4.2` 与 submodule；网络步骤失败自动重试一次，仍失败则带原因退出且不启动任何进程。端口 `3080` 已被占用时启动前直接失败——DSH 会静默改用其他端口并导致 trusted origin 与登录校验错位。Profile `link:` 每次启动重验，仓库迁移目录后自动修复指向。React Surface 与 AG-UI 按 commit stamp 跳过重复构建，ClinMesh DSH artifact 每次启动重建。首次新装 Profile 后需在隔离宿主设置页配置模型 Provider。数据源检查行为与 `pnpm dev:lan` 一致。

复用工具目录前，ensure 核对已安装 dshvm 的 `package.json` 版本是否与 lock 一致；旧版、缺失或非法 manifest 触发重新安装，不能仅凭 CLI 文件存在跳过升级。仍有效的宿主槽位、Profile 和桥接构建继续复用。

AG-UI 的缓存 HEAD 与锁定提交不同时，ensure 先从 lock 的 `source` 获取精确 commit，再检出和重建；已有 clone 的 origin 不决定新提交的来源。获取失败自动重试一次，仍失败则在检出和构建前停止，保留原有构建记录；HEAD 已匹配时不联网获取。

Windows 的 npm/pnpm 启动由 `cross-spawn` 解析命令入口并转义参数；插件目录使用 junction，不要求管理员权限或开发者模式。目录迁移后的失效链接也会重建。开发服务由 Windows Job Object 持有，退出时清理本次启动的完整子树；POSIX 使用进程组。PowerShell 必须允许本地 `Add-Type` 调用 Win32 Job API；受限语言模式不受支持。命令或工作目录不存在时直接提示检查安装、PATH 和路径，不按网络故障重试。

验收重建也可使用以下手工路径。Bash 示例建立独立工具、连接器和数据目录，不接管日常 DSH。`CLINMESH_DSH_SANDBOX` 应使用仓库外尚未使用的绝对目录：

```sh
export CLINMESH_DSH_SANDBOX="$(cd .. && pwd)/clinmesh-dsh-runtime"
export DSHVM_HOME="$CLINMESH_DSH_SANDBOX/versions"
export DSHVM_BIN_DIR="$CLINMESH_DSH_SANDBOX/bin"
npm install --prefix "$CLINMESH_DSH_SANDBOX/tooling" @dsh-so/dshvm@0.2.0
DSHVM_CLI="$CLINMESH_DSH_SANDBOX/tooling/node_modules/@dsh-so/dshvm/bin/dshvm.js"
node "$DSHVM_CLI" install 0.2.1-rc.2
cp deployment/dsh/host/package*.json "$DSHVM_HOME/dsh-0.2.1-rc.2/"
npm ci --prefix "$DSHVM_HOME/dsh-0.2.1-rc.2"
node "$DSHVM_CLI" isolate 0.2.1-rc.2
node "$DSHVM_CLI" use 0.2.1-rc.2
node "$DSHVM_CLI" which 0.2.1-rc.2
node "$DSHVM_CLI" exec --version
export DSH_HOME="$DSHVM_HOME/isolate/0.2.1-rc.2"
DSH_CLI="$DSHVM_HOME/dsh-0.2.1-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js"
```

`which` 应指向该隔离槽位，`exec --version` 应返回锁定版本。宿主安装 manifest 的 `allowScripts` 明确审批 subprocess helper、koffi、node-pty 和 protobufjs，避免 npm 的默认脚本拦截遗漏原生运行支持。宿主安装必须在停止状态下使用 [`deployment/dsh/host/package-lock.json`](../deployment/dsh/host/package-lock.json) 执行 `npm ci`；dshvm 的初始安装用于建立槽位登记，不能代替锁文件恢复，因为 DSH 顶层版本的内部依赖仍使用版本范围。不要对已有共享槽位使用 `setup` 或 `isolate --copy` 来建立干净验收环境。Windows PowerShell 使用 `$env:DSHVM_HOME`、`$env:DSHVM_BIN_DIR` 和 `$env:DSH_HOME` 设置相同目录，普通路径变量使用 `$变量名`；Node CLI 的参数相同。新终端需要重新提供这些变量。DSH Provider 在隔离宿主设置页单独配置，密钥不写入 Profile 仓库或公开记录。

先按上游锁文件构建 React Surface 与 ClinMesh，再构建并安装 AG-UI。AG-UI 安装使用公开支持分支的精确 commit，合并后仍可按同一 commit 重建：

```sh
bun install --cwd vendor/dsh-react-surface --frozen-lockfile
bun run --cwd vendor/dsh-react-surface build:runtime
pnpm --filter @clinmesh/dsh-web build
git clone https://github.com/keaideppk/dsh-ag-ui.git "$CLINMESH_DSH_SANDBOX/ag-ui"
git -C "$CLINMESH_DSH_SANDBOX/ag-ui" checkout a22b9e3c6a6d7837f2aaec328462309f6bc1989a
pnpm --dir "$CLINMESH_DSH_SANDBOX/ag-ui" install --frozen-lockfile
pnpm --dir "$CLINMESH_DSH_SANDBOX/ag-ui" build
DSH_PROFILE="$DSH_HOME/profiles/web"
mkdir -p "$DSH_PROFILE/plugins"
cp deployment/dsh/profile/* "$DSH_PROFILE/"
ln -s "$CLINMESH_DSH_SANDBOX/ag-ui" "$DSH_PROFILE/plugins/ag-ui"
ln -s "$PWD/vendor/dsh-react-surface/packages/runtime" "$DSH_PROFILE/plugins/react-surface"
ln -s "$PWD/apps/dsh-web" "$DSH_PROFILE/plugins/clinmesh"
pnpm --dir "$DSH_PROFILE" install --frozen-lockfile
```

[`deployment/dsh/profile`](../deployment/dsh/profile/package.json) 只加载 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与上述三个插件；内置 bundle 由宿主槽位的 npm lock 提供，Profile 不重复安装宿主依赖闭包；其 pnpm lock 只固定三个本地插件的相对 `link:`。Windows 可用 `New-Item -ItemType Junction -Path <Profile/plugins/名称> -Target <对应源码绝对目录>` 代替三个 `ln -s`。模板只用于新建的专用 Profile，不覆盖已有 Profile；再次安装使用已有链接和 `--frozen-lockfile`。链接安装不替插件安装源码依赖，因此不能省略各 workspace 的安装与构建。

需要查看或修改插件时直接调用 `node "$DSH_CLI" plugin --profile web ...`：dshvm `0.2.0` 仍会把 `plugin --profile web` 识别为 Web 启动，并在默认端口被占用时附加插件命令不接受的 `--port`。dshvm 连接器也会按 active-data 覆盖显式 `DSH_HOME`；测试自行管理数据目录时应使用对应槽位的实际 bin。插件变更后重新验证并更新 Profile lock，日常运行不要用无锁安装替换已验证组合。

非开发模式的 DSH 会在插件激活时把 client 脚本读入内存。重新构建 `@clinmesh/dsh-web` 后，须重新加载插件或重启对应 DSH 宿主，再刷新页面并打开 ClinMesh；仅刷新浏览器不能替换宿主缓存。验收应核对宿主实际返回的脚本包含当前构建内容，并确认 `/react-surface-agent/lease` 成功、真实模型请求包含 ClinMesh 工具且能完成一次调用。页面已登录或 Page Context 签发成功不足以证明工具注册成功；原生 Session 的工作目录无需与 ClinMesh 源码目录一致。

手工路径在 `.env` 中设置 `CLINMESH_AI_SOURCE=dsh`、`CLINMESH_DSH_MODEL_ORIGIN=http://127.0.0.1:3080`，为 Server 配置至少 32 bytes 的 `CLINMESH_DSH_BRIDGE_SECRET`，并把实际 DSH Web origin 加入 `CLINMESH_TRUSTED_ORIGINS`（DSH 默认开发端口 `3080`；使用 `--port` 时必须同步替换该 origin，否则登录和 mutation 的 CSRF 校验会拒绝）：

```sh
export CLINMESH_TRUSTED_ORIGINS=http://127.0.0.1:51868,http://127.0.0.1:51888,http://127.0.0.1:3080
pnpm dev:server
```

另一个终端把同一个 secret 提供给 DSH Host；Server 使用非默认端口时同时设置 `CLINMESH_DSH_UPSTREAM_ORIGIN`：

```sh
set -a
. ./.env
set +a
node "$DSHVM_CLI" exec web --port 3080 --no-open
```

模型桥接地址只接受 HTTP loopback origin；DSH 使用非默认端口时同步修改 `CLINMESH_DSH_MODEL_ORIGIN`。同一 Server 的全部入口共用启动时选定的模型来源，打开或关闭 Surface 不切换来源。宿主设置权限允许的用户从侧栏底部“账号菜单 → 设置 → 通用设置”修改“ClinMesh 模型”，修改对该 Profile 的新任务生效，刷新和重启后仍保留；没有候选时先在 DSH 模型设置中配置 Provider。

DSH 一次结构化生成默认允许 120 秒；`CLINMESH_AI_TIMEOUT_MS` 可在 100 毫秒至十分钟之间覆盖。路由解析、初次生成、最多一次格式修复及有限限流恢复共用原始截止时间，每次调用只向宿主传递剩余预算；持久任务和 lease 仍覆盖路由与模型处理。病历页显示自动记录失败的具体原因，超时或修复失败后转为待更新，患者回答保留供人工核对。共享时限见[有限恢复决策](decisions/implemented/bug-fix/2026-10-16-recommendation-record-selection.md)，任务预算和失败分类见[自动病史调用决策](decisions/implemented/bug-fix/2026-10-08-consultation-model-output-budget.md)。

OpenAI 兼容网关的 `baseURL` 使用实际 API 根路径；需要 `/v1` 的网关不能只填写站点首页。模型列表或 HTTP 200 不证明生成可用，应核对 JSON／SSE 类型、实际内容和正常终止。模型桥对明确限流返回安全的 HTTP 429；Provider 按服务端提示在剩余预算内最多重试一次，格式修复共用这一次机会，无提示时等待一秒。诊疗建议在持续限流后停止并显示原因，稍后可人工刷新；不会自动改用其他模型。恢复合同见[记录级筛选决策](decisions/implemented/bug-fix/2026-10-16-recommendation-record-selection.md)。

切换模型后的任务绑定与人工重试规则见[系统架构](architecture/simulation.md#103-场景定义)。宿主不可达、原 Provider 删除或凭据失效时任务可控失败，可修复原 Provider，或按[AI Provider 配置](#4-配置-ai-provider患者档案必需)中的步骤使用新模型恢复。切换 Server 来源前遗留的 OpenAI 任务不会被重映射到 DSH，需恢复原来源处理或显式发起新生成尝试。

真实宿主模型 smoke 使用隔离 Profile 和合成 Provider，不调用付费模型；先构建 DSH adapter，再运行。默认使用本地 lock 对应的 runtime 槽位，可通过 `CLINMESH_DSH_SMOKE_RUNTIME` 指定槽位绝对目录：

```sh
pnpm --filter @clinmesh/dsh-web build
pnpm exec tsx scripts/smoke-dsh-models.ts
```

#### 问诊自动记录原生验收

完成上述宿主、React Surface、AG-UI 的锁定安装和构建后，在仓库根目录运行。默认读取 `.data/dsh-runtime/versions/dsh-<锁定版本>` 与 `.data/dsh-runtime/ag-ui`；目录不同时分别设置 `CLINMESH_DSH_SMOKE_RUNTIME` 和 `CLINMESH_DSH_SMOKE_AG_UI` 为绝对路径。脚本核对宿主版本及两个桥接组件的 commit，使用临时 Profile、SQLite、密码和 secret，从“医院工作台”打开 Surface，自动运行合成问诊与真实原生工具签署。运行结束清理临时环境，不改变日常 Profile。

```sh
pnpm --filter @clinmesh/dsh-web build
pnpm smoke:consultation:native
```

真实模型验收显式指定一个已有配置的隔离 `DSH_HOME` 和完整 Provider/model 路由。脚本把凭据和 Profile patch 复制到新的临时环境，在完整确定性旅程后，对新合成病例运行两轮真实病史总结与独立事实核对；患者档案和两轮回答使用固定合成 fixture，以便逐项核对起病、发热、干咳、体温及胸痛、气促的否定。`--summary-only` 可单独运行该多轮总结及来源入口验收，完整合成旅程的断言保持在默认模式。真实调用可能产生费用，命令不进入 `pnpm check` 或 CI。

通过 `HTTP_PROXY`／`HTTPS_PROXY` 访问模型 API 时，为验收命令设置 `NODE_USE_ENV_PROXY=1`；隔离 Node 宿主保留这一显式开关，仍不继承任意 `NODE_OPTIONS`。`NO_PROXY` 应包含 `localhost,127.0.0.1`，使本机模型桥和 Server 请求直接连接。

```sh
export CLINMESH_DSH_SMOKE_HOME=/absolute/path/to/configured/dsh-home
export CLINMESH_DSH_SMOKE_LIVE_MODEL='dsh:{"provider":"configured-provider","model":"configured-model"}'
pnpm smoke:consultation:live
# 已有完整合成旅程证据时，单独验证真实总结质量
pnpm smoke:consultation:live --summary-only
```

可用 `CLINMESH_DSH_SMOKE_REPORT=/absolute/path/to/report.json` 保存版本、代码 commit/内容 hash、处理数量和 request/audit/trace 关联的验收摘要；真实总结模式还保存固定合成回答、总结和事实来源供逐项复核，不保存凭据或 prompt。`liveJobs` 保留当前任务错误码，`liveFailedAttempts` 从不可变回执保留历次失败的错误码、阶段与有界校验诊断，重试成功后仍可追查；诊断机制见[直接记录决策](decisions/implemented/architecture/2026-10-14-consultation-direct-recording.md)。成功说明本次合成样本满足总结质量与来源断言，不能证明所有病史的语义准确；模型局限与 CI 证据边界见[测试策略](testing.md#end-to-end)。

指南建议复用上述宿主、组件和真实模型配置。`native` 使用已发布合成检验目录与合成模型，验证后台准备、折叠来源、处方缺项、医生直接确认与开具，以及报告发布后既有记录不被改写；`live` 在该旅程之后对新的合成病例读取诊断、处方和检验建议，不提交真实模型结果，也不创建临床事实。可执行建议的引用必须属于实际提供的指南与病例资料；只读思路引用本轮病例，明确待核实，不进入正式操作。没有可发布条目是合法结果，界面分别说明指南覆盖、院内目录、核验和系统处理限制。报告只保留该模式的状态、建议及来源数量，不能将少量样本视为临床语义质量评估。

```sh
pnpm smoke:recommendations:native
pnpm smoke:recommendations:live
```

病历质控可以复用同一隔离宿主运行 `pnpm smoke:consultation:live --quality-only`。合成原生旅程验证质控展示及医生操作，随后在新的合成病例中通过真实模型检查未保存正文、保存相同正文及另一个客户端检查入口。报告的 `liveDocumentQuality` 分别记录持久任务数、实际模型桥调用数、请求字节、最终状态与安全失败分类；相同授权及完整输入复用同一轮，不把有限格式纠正当作额外业务轮次。该入口不提交真实模型生成的诊断、处方或签署。

无桌面交互的浏览器验收可在隔离 Profile 的 `cordis.patch.yml` 使用官方目录选择器替换点，避免工作区选择触发不可操作的 Windows 原生对话框：

```yaml
- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

该替换同时加载 host 与 client 两半，不能与自动选择器同时启用；保存后重启隔离 DSH。可交互桌面的普通运行无需此覆盖。

重新启动 DSH Web 后，左侧栏顶端显示 ClinMesh Logo 和名称；应用尚未打开或已经关闭时仍保留该 Profile 品牌。新会话中央同样显示 ClinMesh Logo，中文标题为“医疗智能体平台”，英文为“Medical AI Agent Platform”。禁用或卸载 ClinMesh 插件后恢复宿主的品牌显示。从侧栏底部“医院工作台”菜单打开 ClinMesh；登录后岗位导航直接显示在宿主侧栏的新会话与工作区之间，底部菜单保留设置与主题入口，其他已注册 Surface 位于“其他应用”分组。ClinMesh 在 DSH 内不显示自己的左侧栏，默认使用 `workspace` 左右分屏并保留原生会话；现有页头的“全屏 ClinMesh”与“返回 DSH 分屏”按钮可往返切换，无需刷新。页头右侧的“收起会话 / 展开会话”可释放或恢复右侧空间，原生文件栏随会话隐藏并保留开合、文件选择和草稿；左侧医院导航保持可用。全屏时先返回分屏再使用宿主导航，返回后保留会话收起状态。窗口缩小或侧栏开关不自动全屏，应用内部按容器宽度适配。页面导航使用 Memory Router，不修改 DSH document pathname。独立 Web 保留原侧栏。当前模式只信任安装到同一 Web Profile 的插件，并只允许合成数据。

根 `pnpm dev:server` 直连 pnpm 运行 `@clinmesh/server` 的 `dev` 脚本，不经过 Turborepo：Turborepo 在 Windows 上包装 `tsx watch` 的持久任务时会把进程树冻结在启动阶段（服务永不监听），且 strict env 会过滤未声明的 `CLINMESH_AI_*` 变量——漏配时 Patient Persona 和 Investigation provider 会被视为未配置。`pnpm dev:dsh` 的 Server 进程同样直启。手动直启时若环境里已存在 `.env` 加载出的原始相对路径（`CLINMESH_DATABASE_PATH`、`CLINMESH_REFERENCE_DATABASE_PATH`、`CLINMESH_WEB_ROOT`），必须先按 `.env` 所在目录绝对化：Server 会对 `.env` 中的相对路径做同样的绝对化，但进程环境变量的原始相对值会覆盖该结果并按进程工作目录解析。

### DSH 持续升级

[`DSH upstream updates`](../.github/workflows/dsh-upstreams.yml) 每日 UTC 02:23（北京时间 10:23）发现更新，也支持 Actions 页面手动运行。发现范围由 [`dsh-upstreams.lock.json`](../dsh-upstreams.lock.json) 拥有：npm 组件比较全部公开正式版和 `rc.N`，不以 `latest` 或 `next` 标签决定候选；源码组件跟踪公开来源的默认分支完整 commit。源码默认分支落后于已验证支持提交时保留支持提交，历史分叉时明确失败并等待维护者协调。

决定跳过一次升级时，给对应升级 PR 添加 **`跳过此版本`** 标签并关闭 PR，无需修改仓库配置；已关闭的 PR 可以补加标签。自动化分页读取同一目标分支上已关闭且未合并的升级 PR，从其精确 HEAD 的 `deployment/dsh/candidate.json` 读取本次变化的组件名与目标 npm 版本或源码 commit。只跳过这些精确目标，候选中未变化的组件不受影响；后续正式版、RC、源码 commit 和其他组件继续发现，不回退已验证基线。跳过决定不依赖当前基线摘要或原分支是否仍存在。恢复更新时移除所有记录该目标的跳过标签；仅关闭 PR 或写评论不构成跳过，已合并、其他目标分支、外部 fork 和普通 PR 不参与。只读发现与发布使用相同入口；标签记录或对应候选读取失败、响应非法时停止，不把读取失败当作没有跳过记录。

本地只读发现命令为 `pnpm upstream:discover`，结果写入已忽略的 `dsh-upstreams.discovery.json`。所有来源解析成功后才产生新候选；已验证 npm 版本被撤销、发行身份或完整性变化、非法响应和网络错误均失败，不产生部分更新。没有差异不创建 PR。发布模式先从目标分支的精确 HEAD 读取基线锁，不采用运行分支或本地 checkout 的锁；读取失败停止，不回退到本地。手动和定时运行以仓库默认分支为目标，专用验证分支的 push 以该验证分支为目标。随后在新版本发现前检查当前基线对应的活动候选；官方 npm registry 对已知候选包直接返回 404、目标版本已撤销或内容变化时，保留候选和人工提交，确认 HEAD 未变化后将该提交的兼容状态置为失败，并在 PR 自动管理区和发现报告的 `result` 中记录待适配原因，不调度安装。即使后续发现因基线版本撤销或其他来源错误而失败，候选失效证据仍保存：报告的 `result` 保留待适配结果，报告和 CLI 输出另以 `discoveryError` 记录发现错误，不产生新候选或验收 HEAD。没有候选失效时，发现错误仍以非零退出码结束。正常候选不写入；候选核对禁止重定向，403、503、超时和非法响应仍报错，不判定为撤销。只有固定官方 registry 地址的直接 404 按整包撤销处理，其他来源的 404 不采用该规则。`pnpm upstream:discover --publish` 还要求 `GH_TOKEN`，使用 GitHub Git API 在当前升级分支 HEAD 上原子追加候选文件与 `deployment/dsh/discovery.json`，后者保存上一次自动发现的完整候选。再次更新前比较 PR 当前候选与该记录；人工支持 commit、版本或其他目标字段有变化时停止，保留人工目标，不先合并基线。没有人工修改时，新的上游目标同步更新两份文件。基于目标分支和基线摘要的分支名保证重复发现复用活动 draft PR；PR 中的自动管理区更新完整组件差异，区外人工说明保留。

main 上的上游锁是已验证基线；升级分支的 `deployment/dsh/candidate.json` 是待适配目标。发现只更新候选。同一目标分支的发现与 PR 验收由工作流串行执行，防止先前验收覆盖撤销后的失败状态。工作流随后显式调用[候选验收](../.github/workflows/dsh-upstreams-verify.yml)，不依赖 `GITHUB_TOKEN` 创建 PR 后触发 `pull_request`。安装与构建进程不获得写入 token；最终追加提交和写入 commit status 的步骤单独使用 token。需要仓库允许 Actions 创建 PR，并授予发现 job `contents:write`、`pull-requests:write`、`statuses:write`，验收收尾 job `contents:write`、`statuses:write`；权限不足保留明确的 HTTP 错误。

维护者可在全新独立 clone 中检出升级 PR 的精确 HEAD、递归恢复子模块并执行 `pnpm install --frozen-lockfile`，随后运行 `pnpm upstream:verify`。该命令拒绝主分支和已有未提交修改，保护不同于锁定版本的人工依赖或子模块适配；pnpm 给构建 CLI 添加的可执行位仅在文件内容与 Git 相同时恢复。它在安装前和全部检查结束后核对 npm registry 中的目标版本及发行摘要；版本撤销或内容变化时停止，不因旧 tarball 仍可下载而通过验收。它从候选的精确 URL 下载 DSH/dshvm tarball，逐字节计算 SHA-512，摘要一致后才准备依赖或执行候选；下载错误、重定向及摘要不符均停止，失败下载不保留为可安装文件。随后按精确源码构建 Surface 与 AG-UI，在新的系统临时目录安装已校验的 dshvm 文件，并由它安装已校验的宿主文件。宿主 `npm ci` 前还核对依赖锁中的版本、来源与完整性是否匹配候选，npm 安装时继续验证锁定摘要。宿主与 Web Profile 重建后，通过 dshvm 隔离、选择和 `exec` 检查实际版本并启动 HTTP smoke，随后向隔离 Profile 写入专用设置标记并核对返回值，验证设置持久化与热重载；该标记不等于宿主预览提示的确认版本。最后运行 `pnpm check`。子进程只继承运行工具所需环境，npm 使用临时空用户配置，模型密钥、GitHub token、日常 Profile 与数据库配置不传入；smoke 临时凭证在日志中脱敏。临时 Profile 只加载必要组合，不切换日常 Profile，也不调用付费模型。POSIX 命令与宿主在独立进程组中运行，退出或取消后有界清理；Windows 取消时回收 launcher 的现存子树。进程结束后保留临时安装供诊断；它不作为日常运行目录。

只有自动检查全部通过才写入升级 checkout 的目标上游锁与 `deployment/dsh/automation.json` 摘要回执。回执允许同一 PR 在已自动准备的组合上继续接收新候选；人工改动锁后摘要不匹配时拒绝覆盖。Actions 在确认远端 HEAD 未被人工提交改变后追加精确依赖锁与子模块引用；普通 push 的快进约束处理检查后的并发竞争。结果、日志和准备补丁在 `.upstream-evidence/` 中，并作为当前 Actions 运行的 artifact 保存；`DSH candidate compatibility` status 绑定被检查的精确 commit。失败状态是待适配，已验证基线不推进，draft 不自动变为 ready，也不自动合并。自动通过只证明记录中的安装、构建、smoke 和测试；原生会话、browser Tool → review → Effect、Windows 实际使用和业务闭环仍按[测试策略](testing.md)补充人工证据，由维护者决定合并。

故障恢复按原因处理：网络或权限故障修复后重跑发现；依赖或编译失败由维护者在同一升级分支追加适配；人工 HEAD 已变化时重新运行验收；基线发生变化或候选与人工支持 commit 冲突时先协调目标再运行。不要 force-push 自动分支、降低宿主到 alpha 或覆盖人工改动来消除失败。合并后新的基线摘要拥有下一轮升级分支。`automation/dsh-upstreams-validation` 是受控集成验证入口：推送该分支会针对它自身创建候选 PR 并执行相同权限与验收路径，不向 main 提交或合并更新。

旧候选缺少 `deployment/dsh/discovery.json` 时，发现停止而不猜测归属。维护者可从 Git 历史恢复最后一次机器人写入的候选到该文件；有人工目标差异时继续保留，由 PR 验收验证支持提交。只有决定将当前候选重新交给自动发现管理时，才把经确认的 `candidate.json` 同步为 `discovery.json` 并提交；下一次发现即可采用更新的上游目标。不要为了消除报错而把未经核对的人工修复标为机器人目标。

如果 Actions 报 `GitHub Actions is not permitted to create or approve pull requests`，需要仓库管理员在 Settings → Actions → General → Workflow permissions 开启 `Allow GitHub Actions to create and approve pull requests`。暂时无法开启时，有创建 PR 权限的维护者可把已生成的候选分支手动建为 draft PR，目标分支必须与该次发现一致，再重跑发现工作流；机器人可复用已有 PR 并显式执行验收。这只能证明更新与验收路径，不能替代首次自动创建 PR 的权限验收，也不会自动修复下一轮新基线的创建权限。

## 8. 升级与重置

当前病例架构包含破坏性的 operational database migration，不兼容旧的本地病例与安装数据。升级前停止 Server，重置 `CLINMESH_DATABASE_PATH` 指向的本地 operational SQLite：

```sh
rm -f .data/clinmesh.sqlite .data/clinmesh.sqlite-shm .data/clinmesh.sqlite-wal
pnpm --filter @clinmesh/server db:migrate
```

该操作删除本地 HIS 运行数据。独立的 `.data/clinmesh-reference.sqlite` 不在删除范围内，不需要重新导入；不要把 `CLINMESH_REFERENCE_DATABASE_PATH` 指向 operational database，也不要删除 Reference SQLite。备份与单实例约束的决策依据见 [Demo 部署架构](demo-architecture.md)。

## 模型用量

Web 与 DSH 的 ClinMesh 设置菜单均提供“模型用量”。默认总览展示 Server 直接调用、DSH bridge 调用及 Host 独立医生代问识别的请求、已知 Token、人民币费用估算、未知请求数、未决预占、趋势、功能分布和授权最近请求；已知部分不表示完整账单。功能筛选提供“医生代问识别”，详情保留调用时模型、阶段来源及计价依据。DSH 原生会话及其他插件在监控边界之外；Host 使用已有 `upstreamOrigin` 与 `bridgeSecret` 接入 Server，不新增本地账本。权限与统计口径见[模型用量查询](architecture/security-and-reliability.md#模型用量查询)。

“额度与策略”页签中，Workspace 管理员可停用或恢复本工作区的全部 ClinMesh 模型入口，分别设置请求次数、Token 与人民币累计上限或无限，并关闭自动重试；普通成员只读自身工作区政策及生效状态。页面显示各项余量、预占、等待恢复的任务和最近拒绝原因，部署总上限及累计量仅管理员可只读查看。默认启用、三项无限、保留原有有界重试；请求上限零会阻止新请求。`PUT /api/model-usage/control` 省略 `tokens` 或 `cny` 时保留原有限值，显式 `null` 才取消该项限制。

同一页签提供本 Workspace 的“明细保留”设置，默认 90 天。管理员输入正整数天数并保存，或选择永久保留；普通成员只能读取。刷新、重启与 Epoch reset 后设置继续生效，页面同时显示已清理明细数量及最后清理时间。缩短期限后立即检查到期明细，Server 启动、每小时及读取用量时也会检查；期限按每次真实调用开始时间计算。总览持续包含已清理请求的长期统计，最近请求和明细页仅展示仍留存且有权查看的记录，因此下钻数量可能小于汇总；延长期限或改为永久不会恢复已删除明细，也不能对其核对或补算。

在途、派发或实际消费未知及仍有任一未决预占的请求不受到期清理影响，可继续等待可信用量或管理员核对；仅缺价／缺汇率但实际消费已知且无未决预占的明细可以到期清理，长期统计仍显示未知金额。清理不恢复任何额度、不重置累计起点，必要核对审计独立保留。接口授权及字段见[模型用量查询](architecture/security-and-reliability.md#模型用量查询)，完整持久化边界见[明细保留与长期汇总](architecture/storage.md#明细保留与长期汇总)。

部署维护者可设置 `CLINMESH_MODEL_CONTROL_PATH=.data/model-control.json`，文件路径相对 `.env` 所在仓库解析；文件由部署方管理，不进入 Git。示例保留请求次数保护，其余两项无限：

```json
{ "enabled": true, "requests": 1000, "tokens": null, "cny": null, "automaticRetries": true }
```

`requests`、`tokens` 接受非负安全整数或 `null`；`cny` 接受最多六位小数的非负人民币金额或 `null`，省略的部署维度默认为无限。金额缩放为百万分之一单位后必须在 `Number.MAX_SAFE_INTEGER` 范围内。重启 Server 后配置生效；已配置路径不存在、JSON 无效或数值越界时启动失败。部署与 Workspace 任一层停用、余量不足或无法核算适用有限额度都会拒绝新派发，Workspace 设置不能放宽部署政策。每层的每个维度首次有限配置建立独立起点，之后改额、切回无限、重启或 Epoch reset 均不重置，无限期间仍累计。停用尽力取消在途调用，未知派发保留对应维度的占用。恢复条件只接续仍有效的待办并复用成功阶段，已派发而结果未知的请求不会自动重做。普通 HIS 读写和确定性检查继续可用。

部署统一价表与汇率通过 `CLINMESH_MODEL_PRICING_PATH=.data/model-pricing.json` 配置，路径解析方式相同，修改后重启 Server。未设置时价表为空，全部额度无限仍可调用并显示缺价；已设置文件无法读取或验证失败则停止启动。下面全部是合成价格，单价单位为原币／百万 Token，`cnyPerUnit` 表示一单位原币兑换多少人民币：

```json
{
  "prices": [
    {
      "provider": "synthetic.invalid",
      "model": "synthetic-model",
      "version": "synthetic-price-v1",
      "currency": "USD",
      "rates": { "input": 2, "output": 4, "cacheRead": 0.5, "cacheWrite": 2, "reasoning": 4 }
    }
  ],
  "exchangeRates": [
    { "currency": "USD", "version": "synthetic-fx-v1", "cnyPerUnit": 7 }
  ]
}
```

`provider` 与请求详情的 Provider 一致；直接调用取配置端点的 hostname。`model` 必须与 `requestedModel` 完全相同，DSH 填完整 `dsh:{"provider":"...","model":"..."}` 固定路由，含有的推理强度也保留；不按显示名、别名、响应中的 `actualModel` 或通配规则匹配。每个 Provider／模型只配置一项价格，每个币种只配置一项汇率。币种为三位大写字母，版本以字母或数字开头，后续可含字母、数字、`_`、`.`、`-`；每次改价或汇率应使用新版本。`input`、`output` 必填，缓存读写和推理单价省略时分别沿用输入、输出单价。单价非负、汇率为正，均最多六位小数且缩放后为安全整数。`CNY` 自动使用 `identity-v1` 的 1:1 汇率；若显式配置 CNY 汇率，其值必须为 1。零单价须显式填写，与缺价不同。

每次请求冻结准入时的价表与汇率，修改只影响后续调用；原币与人民币金额按对应计量分项估算，不能当作服务商扣费凭证。输入包含缓存、输出包含推理，分项不重复计价。缺价、缺汇率与未知用量分别显示；所有当前 Workspace 成员可从“计价说明”或 `GET /api/model-usage/pricing` 只读查看统一配置，Workspace 管理员也不能在界面修改价格。

当前三类入口的有限保护能力如下。`reservationBoundary` 随明细保存入口、版本及原因；请求次数限制与全部无限模式均保持可用。

| 入口 | 有限 Token／非零金额的可信边界 | 明细原因 |
| --- | --- | --- |
| Server 直接 OpenAI-compatible 请求 | 未发送硬输出 Token 上限；响应字节限制不能约束服务商计费 Token | `output-limit-unbounded` |
| Server 经 DSH bridge 调用 | SDK 准备句柄锁定配置，但未公开实际 wire adapter 的计量与硬上限保证 | `adapter-metering-unavailable` |
| Host 独立医生代问识别 | 使用同一准备句柄和既有 1024 输出配置，仍缺少可信计量保证 | `adapter-metering-unavailable` |

因此，为这些入口配置有限 Token 或非零人民币保护后，新派发以 `MODEL_METERING_UNAVAILABLE` 停止。SDK 上下文容量可能是目录回退值，输出配置也可能被底层协议省略；不能用 `contextWindow`、`maxTokens`、字符除数或历史均值代替上界。若人民币价表明确将所有适用分项配置为零，可信金额预占可为零；这不建立 Token 上界，也不能绕过其他有限维度。预占不足时显示所需量与剩余量，不自动降低输出上限、裁剪输入或改推理强度。

管理员可从请求详情核对未知消费，提供受限的依据标识并仅填写已核实的 Token 总量或人民币金额；两项可分次处理，未核实维度继续占用。仍留存的缺价或缺汇率请求可显式补算；缺汇率时保留原单价，只补汇率。原始服务商用量、调用时快照和原估算保留，修订独立留审计，不把补算显示成调用时已知，也不触发模型重发。HTTP 版本、幂等及授权合同见[模型用量查询](architecture/security-and-reliability.md#模型用量查询)，精度与持久化见[模型账本](architecture/storage.md#910-模型调用账本)。

## 实时病历整理模型

`CLINMESH_AI_RECORDING_MODEL` 可为实时整理固定独立模型；不设置时沿用问诊模型，DSH 使用完整 `dsh:{"provider":"...","model":"..."}` 路由。自动记录、核对和历史补录沿用 `CLINMESH_AI_TIMEOUT_MS` 的常规模型等待配置；DSH 默认每次桥接请求 120 秒，OpenAI 默认 60 秒，不另加 6 秒截止。既有 `CLINMESH_AI_RECORDING_TIMEOUT_MS` 不再读取。任务仍有覆盖模型解析和格式修复的有界总等待，关闭或任务失效继续取消请求；真实模型失败保留来源供恢复。取消短截止不能证明已达到实时性能目标。

实时路由应明确选择 Provider 支持的思考强度，不能从模型名称推断延迟。DSH DeepSeek 路由未指定强度时继承 Provider 策略，Provider 也未配置时默认为 high；需要关闭实时整理的思考时，可配置 `CLINMESH_AI_RECORDING_MODEL=dsh:{"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"off"}`，重启 ClinMesh Server 后对新批次生效。该覆盖只选择实时整理模型，语义核对与主会话继续沿用各自配置；性能参考与来源完整性合同见[低延迟记录规格](spec/2026-10-15-low-latency-document-recording.md)。

废弃自动记录压测入口已移除。日常开发与验收使用合成 Provider、受控模型流和临时数据库；真实模型开发验证或压测须取得用户针对本次运行的明确许可，执行边界见[工程规则](../AGENTS.md)。
