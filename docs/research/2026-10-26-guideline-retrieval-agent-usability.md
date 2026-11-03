# 指南检索与 Agent 使用能力优化研究

核对日期：2026-10-26；源码基线 `91f3cce794e1`。本文依据当前源码、已有测试定义、本地冠心病资料阅读记录及临时库的 7 次合成查询提出候选优化；未访问部署中的病例数据库，未运行真实模型、检索性能测试或压测，不能据此判断线上命中率和延迟。当前合同由[临床流程](../architecture/clinical-workflows.md#81-门诊闭环)、[指南全文规格](../spec/2026-10-16-free-guideline-corpus.md)及[诊疗建议规格](../spec/2026-10-13-doctor-guideline-recommendations.md)拥有；外部 Agent 的授权与操作合同见 [Agent 集成](../architecture/agent-integration.md)。本文不表示已批准业务实施。

## 核心判断

当前检索已经具备可复用的来源、用途过滤、完整原文、物理页定位、中文全文和登记主题跨语言检索，优先工作应是验证医学检索质量、补全条款上下文和解释证据覆盖范围。不能把优化概括为“补一个向量库”，也不能把已有中文及跨语言能力当作空白重做。对 Agent 而言，找到相关词只是第一步；还须取得完整适用条件、例外、推荐强度与版本，并知道哪些必要依据尚未找到。

## 已核验的检索事实

| 环节 | 当前实现 | 对优化的含义 | 源码与已有测试 |
| --- | --- | --- | --- |
| 来源接入 | 登记格式为 PDF 或 UTF-8 text；下载和重定向仅接受允许的官方 HTTPS 域名，原始字节校验 SHA-256，32 MiB 上限及有界超时；缓存通过校验后复用 | 本地资料和 ESC/ACC/AHA 出版方不能直接通过现有同步入口导入；需要受控来源适配，不能用开放任意 URL 代替 | [导入器](../../apps/server/src/infrastructure/guidelines/import-guideline-source.ts)、[导入测试](../../apps/server/tests/import-guideline-source.test.ts) |
| 正文分段 | 按原文行和句末标点形成单元，每段最多 12,000 字符，尽可能重叠上一完整句；超长不可分单元拒绝，不截断原文 | 这是完整性基础，可以保留；医学条款边界、表格行和脚注不一定等于句末或行边界 | [分段函数](../../apps/server/src/infrastructure/guidelines/import-guideline-source.ts#L76)、[条件句和覆盖测试](../../apps/server/tests/import-guideline-source.test.ts#L146) |
| PDF 处理 | PDF.js 按页读取文本项及换行，每个物理页单独分段；没有文字的非空绘制页拒绝，能证明空白的页可跳过并保留物理页号 | 能防止整张图片页静默消失；未建立章节、跨页条款、列布局、表格/脚注关系，非空文字也不证明内容正确 | [PDF 提取](../../apps/server/src/infrastructure/guidelines/import-guideline-source.ts#L116)、[PDF 测试](../../apps/server/tests/import-guideline-source.test.ts#L195) |
| 中文词项 | 汉字连续串及英文数字串作为初始 token；至少 4 个汉字的串扩为原串及三字片；独立二字词或主题二字别名用 `instr` 兜底；查询通用词项最多 96 个 | 已支持中文长句及二字兜底，但不等于中文医学分词；二字病词嵌在长汉字串且没有登记主题时，可能无法凭该病词召回 | [查询构造](../../apps/server/src/infrastructure/sqlite/guideline-corpus.ts#L138)、[中文长串测试](../../apps/server/tests/guideline-corpus.test.ts#L70)、[二字别名测试](../../apps/server/tests/guideline-corpus.test.ts#L170) |
| 跨语言主题 | `topics.terms` 同时登记中英文；病例字符串命中主题任一词后扩为该主题全部词；`diagnosisQueries` 仅返回病例与段落共同命中的主题中文诊断词 | 现有人工登记别名已能把中文病例连接到英文原文；未知同义词、缩写和译名仍可能缺失，不是任意跨语言语义检索 | [来源模型](../../apps/server/src/application/guideline-corpus.ts)、[跨语言测试](../../apps/server/tests/guideline-corpus.test.ts#L83) |
| 召回与排序 | FTS5 trigram，候选词用 OR；逐来源查询，FTS 最多 64 段，二字 `instr` 最多 64 段；同段 ID 去重后，先按病例与段落共同命中的主题数，再按 BM25、证据 ID 排序 | 已有确定顺序及具体主题优先；没有医学适用性排序或同一条款上下文覆盖保证。二字兜底固定 rank=0，不能与 FTS 分值直接解释为同一相关性尺度 | [检索实现](../../apps/server/src/infrastructure/sqlite/guideline-corpus.ts#L151)、[跨来源排序测试](../../apps/server/tests/guideline-corpus.test.ts#L264) |
| 返回预算 | 全局最多 8 段，加入候选前试算序列化结果是否超过 48 KiB，超限整段跳过；段内原文不截断 | 能保留入选段落的限定语，但必要的相邻条款可能未入选；结果没有候选总数、跳过原因或覆盖不足状态；同源不同 ID 的重叠段未按区间去重 | [预算实现](../../apps/server/src/infrastructure/sqlite/guideline-corpus.ts#L189)、[预算测试](../../apps/server/tests/guideline-corpus.test.ts#L140) |
| 来源版本与用途 | 每条证据含版本、出处、scope、sourceHash、locator；active 且用途允许才检索；撤回或替代来源进入 `inactiveSources`；全部源 digest 及部署用途构成 revision | 可以保留当前失效与用途边界；日期和 scope 是元数据，并未自动执行疾病阶段、人群及时间有效性判断，也没有自动检查外部新版 | [来源模型](../../apps/server/src/application/guideline-corpus.ts)、[存储检索](../../apps/server/src/infrastructure/sqlite/guideline-corpus.ts)、[同步测试](../../apps/server/tests/guideline-sync.test.ts) |

## 优先解决的质量问题

### P0：正文可靠后再成为可引用证据

现有提取检查拒绝空正文、NUL、伪装成文本的 PDF/HTML、完全没有文字的非空 PDF 页，以及不可安全拆分的超长片段；原始文件哈希也已校验。这些检查不能证明文字顺序、编码和图表条件正确。前次本地资料阅读发现两份中文 PDF 的文字层有字符却不能可靠还原中文，说明仅用字符数量或提取命令成功作为可读性标准不足；当时使用的是独立阅读提取工具，不能据此断言同文件已经通过或必然不能通过当前 PDF.js 导入器。来源：[导入器](../../apps/server/src/infrastructure/guidelines/import-guideline-source.ts)、[冠心病资料阅读范围](2026-10-26-coronary-guidelines-project-reference.md#文件核对与阅读范围)。

候选方案是在现有来源及哈希模型上增加提取器/规则版本、质量状态和人工核对范围。乱码、疑似双栏串行、图表条件缺失或 OCR 尚未复核的资料保持明确不可引用状态；OCR 结果不能直接冒充出版方原始文字层。优先核对影响行动的阈值、单位、否定词、例外和推荐表注，再扩大资料数量。接入新增出版方时保留原始来源验证、逐跳重定向、字节预算、用途检查和失败不替换原版本的边界。

### P0：建立贴近病例的检索回归集

现有合成测试验证了中文长句、未登记主题、登记主题跨语、二字别名、特殊字符、跨来源主题排序、全文完整性、用途限制、撤回及 revision 失效。它们是存储和检索合同基础，不能替代冠心病检索质量评估，也不能当作本轮已运行证据。来源：[检索测试](../../apps/server/tests/guideline-corpus.test.ts)、[导入测试](../../apps/server/tests/import-guideline-source.test.ts)、[同步测试](../../apps/server/tests/guideline-sync.test.ts)。

候选回归集应包含中文主诉、医学同义词、英文缩写、长病史、否定和时间限定，并由人独立指定必须返回的完整证据和不适用证据。首批可覆盖稳定性中度狭窄的 FFR/iFR 条款、ACS 与择期 PCI 区别、DAPT 的人群/阶段例外、对比剂肾功能与容量风险、术后 cTn 与梗死的区别。实际原文入库和测试分发范围须符合用途；没有适当用途时使用保持同等结构与陷阱的合成原文，不把受限全文作为公开 fixture。评价至少区分必要证据召回、错误适用版本或人群、否定/表注保留、出处可解析和覆盖不足是否可识别。

本轮另通过公共 `GuidelineCorpus` 接口做了一个极小的合成样例核对：单个临时库、1 个来源、3 个段落、7 次查询，没有网络、模型或压测，完成后删除临时库。脚本保存在仓库外，通过 `node node_modules/tsx/dist/cli.mjs <临时脚本路径>` 运行，退出码 0，约 2.9 秒是整个脚本运行时间，不是检索性能指标。观察如下，不能推广为所有中文或长句均会失败：

| 合成输入条件 | 查询 | 观察 |
| --- | --- | --- |
| `topics=[]`，存在原文“胸痛需要进一步核查。” | `胸痛` | 命中该段 |
| 同上 | `患者胸痛持续三天` | 无命中 |
| `topics=[]`，存在英文 `For coronary artery disease, assess bleeding risk.` | `冠心病` | 无命中 |
| 同上 | `coronary artery disease` | 命中英文段 |
| 同一来源补充已知中英别名 `冠心病` / `coronary artery disease` | `冠心病` | 命中英文段 |
| 存在“靶向病的合成测试段落。”，查询时没有该主题别名 | `靶向病` | 命中该段 |
| 同上，查询前置 100 个各不相同的 `metadata0` 至 `metadata99` 词项 | 前置词项后接 `靶向病` | 无命中 |

该样例确认了二字词嵌入、未登记跨语别名和前部词项占满预算这三个具体复现条件，尚未衡量真实病例分布中的发生频率或临床影响；它们适合作为后续质量回归的起点。

### P0：说明证据缺口，补齐真正的预算边界

当前 `GuidelineSearchResult` 只有 `guidelines`、`diagnosisQueries`、`inactiveSources`、`revision`。零命中无法独立区分“没有相关来源”“来源用途不可用”“词项没有匹配”或“候选因预算被跳过”，正常有命中也不说明必要限定条款是否完整。候选改进是返回受限、结构化的检索说明，如实际采用的查询策略版本、候选数、入选数、预算丢弃数及不完整原因；这些信息说明系统处理状态，不应被写成患者缺少病史。来源：[结果模型](../../apps/server/src/application/guideline-corpus.ts)、[检索返回](../../apps/server/src/infrastructure/sqlite/guideline-corpus.ts#L189)。

48 KiB 当前只在尝试加入证据时校验；`inactiveSources` 先全量收集，缺少最终输出大小校验。大量撤回来源时，仅该列表也可能超过预算，不能把现有单例预算测试解释为对任意规模的完整保证。候选验收应覆盖零命中但大量 inactive metadata、所有相关段落均因预算跳过、少数超长条款，以及同源重叠段耗尽名额；继续保留不可静默截断医学原文的要求。来源：[检索实现](../../apps/server/src/infrastructure/sqlite/guideline-corpus.ts#L130)、[现有预算测试](../../apps/server/tests/guideline-corpus.test.ts#L140)。

## P1：在证据质量确定后改进召回与上下文

| 候选改进 | 解决的问题 | 保留的边界 |
| --- | --- | --- |
| 受控医学术语与查询分面 | 在现有 topics 上补充稳定冠心病/CCS、ACS、PCI、DAPT、肾功能等术语及同义词关系；针对二字词嵌入长句、查询前 96 词截断和普通词 OR 命中做回归 | 查询术语不能等同患者已确诊事实；原始病例出处及否定、时间仍须保留；不能靠无限扩词召回所有资料 |
| 明确疾病阶段和任务 | 将“择期 PCI 适应证”“术前风险”“术后抗栓”“出院”分为可解释的检索需求；先排除明确不适用的人群和来源，再排序 | source.scope 不能通过简单关键词猜测变成可靠医学规则；不把所有 ACS 建议强行套到择期病例 |
| 条款和相邻证据读取 | 保存文档内顺序、章节、推荐表、图表标题与脚注关系；从命中条款取必要上文、例外及跨页延续，完整证据作为一次可引用集合 | 相邻页不是自动全部有关；原文、物理页和印刷页映射保留，不把模型生成摘要代替引用依据 |
| 排序与多样性 | 在固定回归集上比较当前主题数优先/BM25与候选排序；去掉重复重叠证据，避免单一来源占满 8 段，并保留相互冲突版本的可识别关系 | “更新”不必然“适用”；不为增加来源数拆散同一推荐及其例外；分数不当作临床置信度 |
| 版本及提取身份 | 在已有版本、sourceHash、revision上补充替代关系、条款稳定定位、提取规则版本和复核状态 | 保留当前已确认来源的可追溯性及用途撤销；新版本失败不覆盖原有可用内容，不自动认定源文件年份最新 |

资料类型也应区分。当前 `documentType` 枚举包含标准、指南、官方方案及药品信息，没有单列专家共识、科学声明、决策路径和立场文件；本地冠心病资料含有这些不同类型。候选扩展须保留发布机构、适用地区、原文推荐分级体系及分级原文；没有分级就明确未知，不能把不同机构的 Class/Level 机械合并为统一分数，也不能把共识自动标成指南。来源：[证据合同](../../packages/contracts/src/doctor-recommendations.ts#L13)、[本地资料题录](2026-10-26-coronary-guidelines-project-reference.md)。

上述方案改变原文结构、检索输入或公开结果合同时，需要相应规格、Agent Note 和迁移/失效策略；本轮只提出候选。单独添加向量召回可以作为后续对照项，但应先证明它改善固定回归集的必要证据召回，并保留关键词精确阈值、来源用途过滤及完整条款核验。

## Agent 如何取得并使用证据

### 当前两条使用链

| 使用者 | 已有行为 | 主要缺口与边界 |
| --- | --- | --- |
| 内置诊疗建议模型 | 服务端从有权读取的当前病例及可见历史构造快照，将除人口学外的证据正文拼接为一次检索；生成请求得到本次建议类型、完整入选指南、选定病例资料与实际目录 | 检索发生在可选历史筛选之前，未把建议类型、当前临床问题或 ACS/CCS 阶段传给检索；生成过程中没有再搜索及展开条款的工具回合。来源：[快照与检索](../../apps/server/src/application/doctor-recommendations-service.ts#L179)、[模型输入](../../apps/server/src/application/doctor-recommendations-service.ts#L922) |
| 外部 DSH/CLI Agent | 已有受控病例读取及业务操作；建议读取/生成明确排除在现有 CLI/Agent tool 授权外；没有独立指南 search/read 操作 | 需要评估新增窄范围只读能力，才能自主补查指南；不能把“内置模型收到过指南”解释为外部 Agent 已可搜索全文。来源：[操作排除项](../../packages/contracts/src/his-operations.ts#L3050)、[医生运行时说明](../../skills/clinmesh-doctor/references/clinical-workflows.md#L15)、[接入合同](../architecture/agent-integration.md) |

当前确定性合同检查引用 ID 属于本轮输入；生成后的独立核验另行判断指南支持、病例支持、适用性、否定/时间/限定语、诊断主次及处方各字段，要求覆盖全部候选。因此现状不能概括成“只检查引用是否存在”。独立核验与生成使用同一个已绑定模型，独立的是请求和任务阶段；两者看到同一批检索指南，不能补救未召回的例外和反证。来源：[引用合同](../../packages/contracts/src/doctor-recommendations.ts#L132)、[核验提示](../../apps/server/src/application/doctor-recommendations-service.ts#L95)、[绑定模型](../../apps/server/src/application/doctor-recommendations-service.ts#L898)、[核验请求](../../apps/server/src/application/doctor-recommendations-service.ts#L1009)。

当前界面已经展示原文、出处、版本、locator、scope 和外链；无依据处方字段置空、诊断/检查的只读思路、缺证提示、旧输入失效、确认前检查及有限恢复也已有实现。优化应扩展证据覆盖和可核对程度，继续复用这些保障。来源：[指南展示](../../apps/web/src/app/doctor/doctor-recommendations.tsx#L203)、[缺证处理](../../apps/server/src/application/doctor-recommendations-service.ts#L875)、[处方字段降级](../../apps/server/src/application/doctor-recommendations-service.ts#L1099)、[执行状态](../../apps/server/src/application/doctor-recommendation-execution.ts)。

### 候选只读能力与使用流程

建议内置模型与外部 Agent 复用同一个检索和证据读取内核。下列名称仅表达候选职责，不是当前可调用的工具或已批准的接口：

| 候选职责 | 输入及授权 | 输出及完整性 |
| --- | --- | --- |
| `guideline.search` | 当前受信病例绑定、任务、临床问题及需要核实的分面；由服务端校验岗位和病例可见范围，并生成少量查询 | 返回证据 ID、来源/版本、定位、原文、适用条件、用途状态及检索覆盖说明；区分没有命中、没有可用来源和预算排除 |
| `guideline.passage.read` | 上一步返回的来源及段落 ID、版本/hash，选择有界的章节或条款上下文；复查来源是否仍可用 | 返回该推荐与关联的例外、表注及跨页延续；无法取得完整上下文时明确不完整，不能只给一句摘要冒充完整条款 |

临床适用条件、推荐等级及关系索引须能追溯到复核过的原文；尚未提取或未确认的字段保持未知。工具不接收任意 URL、SQL 或开放文件路径；每次读取复查部署用途和撤回状态。查询只消费有权可见的病例，不接入 Case Truth/Hidden Fact。指南、病历及检索正文作为证据资料处理，其中的指令不能改变系统任务或工具权限。来源隔离边界见 [Agent 集成](../architecture/agent-integration.md)，当前有权病史读取见 [workflow-service](../../apps/server/src/application/workflow-service.ts#L2860)。

候选运行流程如下：

1. 从当前任务提出具体问题，例如“该合成择期 PCI 场景应核对什么适应证”，按疾病阶段、决策和关键风险拆为少量查询；保留“否认、既往、待排”的事实属性，检索词不变成确诊。
2. 先搜索，再展开拟引用条款及必要例外；对于适应证、风险、抗栓等分面，分别记录已取得依据和未覆盖部分。模型可提出补查需求，服务端限制回合、返回大小和总预算，不用无上限的搜索循环。
3. 生成可核对的证据说明：建议或判断、实际病例证据、指南原文位置、适用条件、支持与反对依据、尚缺什么。指南给出的一般推荐不直接补成患者事实；药品名称有依据也不代表剂量、频次和疗程都有依据。
4. 沿用现有生成后核验、目录身份校验和医生确认；为关键结论及处方字段建立更细的引用映射。补查后将查询策略、语料版本和证据身份纳入既有输入指纹及过期机制，防止新版或撤回后继续使用旧结果。

外部能力正式实施时，需要同一 diff 更新 owning Operation Catalog、窄 schema、受信 context binding、CLI 命令示例、`clinmesh-doctor` 运行时说明及合同/漂移测试；只读检索不同时授予正式确认或开立权限。合同归属见 [Agent 集成](../architecture/agent-integration.md)、[操作目录](../../packages/contracts/src/his-operations.ts)，不以本研究替代正式规格。

## 临床依据与验收如何衔接

建议先由临床负责人复核约 20–30 个代表性问题及少量合成 PCI 分支，冻结来源版本、物理页/条款、完整必需原文和可接受判断，再比较当前方案与候选优化。数量是启动建议，不是已批准门槛；严重错误定义、临床结论和扩大范围条件应在正式需求中确定。编写病例与确定答案应独立于待验收的检索和生成模型，避免用同一模型的输出充当正确答案。

| 验收层 | 冻结的依据与输入 | 可观察的通过/失败条件 |
| --- | --- | --- |
| 文献与提取 | 出版方原件、原始 hash、版本、用途、人工核对的页及条款 | 阈值、单位、否定和表注与原件一致；乱码、未复核 OCR、错误页码可阻止引用；原件保留，Markdown/JSON 是可追溯派生物 |
| 检索 | 短词/长句、中文/英文缩写、长病史、否定、时间和噪声输入；每题指定必须召回的条款及例外 | 分别统计必要证据与例外召回、错误适用证据、定位可解析性；不因“有一个命中”判通过；报告预算丢弃与未覆盖状态 |
| Agent 推理与引用 | 同一可见病例、完整或刻意缺失/冲突的证据包 | 判断与引用原文相符，保留适用条件；未知不写成阴性，无证不编条款；无剂量依据时字段为空；失败可定位到具体判断及原文 |
| HIS 行为 | 同一合成病例的不同分支及真实院内目录，使用受控 Provider 和临时数据库 | 正式诊断、申请或处方只按既有授权和确认执行；来源撤回、版本/病例变化后旧结果失效；验证实际资源、状态及审计，不能只验聊天措辞 |

例如同一冠心病病例可以冻结“稳定择期评估”与“出现急性证据后需重新评估”等分支，分别列明允许引用的 CCS/ACS 依据、必须核实的资料和禁止偷换的前提；不是预先要求模型无论输入如何都得出同一个 PCI 结论。详细临床分支来源见[本地资料的采用与验收建议](2026-10-26-coronary-guidelines-project-reference.md)。

这条链让指南成为可追溯的临床参考，也让它成为工程验收的外部依据；检索测试或仿真流程验收通过，不能单独证明真实临床疗效或构成医疗器械注册结论。当前项目的实施范围仍由既有仿真 HIS 合同和后续批准规格决定。

## 查询成本与后续性能核对

每次 `search` 读取全部来源元数据、digest 及分段计数，逐项解析来源 JSON，再对每个允许使用的来源执行相应的 FTS 和二字兜底查询；每来源可形成最多两组各 64 条候选，汇总后才排序并选取 8 条。全库 revision 每次由完整源 digest 列表计算，未命中的其他来源变化也使 revision 变化。这是可从源码确认的操作形状，不是已经测得的性能瓶颈。来源：[search](../../apps/server/src/infrastructure/sqlite/guideline-corpus.ts#L130)、[sourceRows](../../apps/server/src/infrastructure/sqlite/guideline-corpus.ts#L207)、[全库失效测试](../../apps/server/tests/guideline-corpus.test.ts#L203)。

候选核对顺序是先记录代表性合成语料下的来源数、段数、查询数、候选数、检索耗时和内存，再查看真实查询计划。若成本确有问题，可比较受用途/状态过滤的统一候选召回、来源元数据缓存、预备语句及 source revision 缓存；保留已有只读连接立即看到独立 writer 更新的行为，不能为了缓存丢失撤回与用途收紧。是否改变全库失效粒度应另作取舍，不能把缩小 revision 简单当成无行为变化的性能整理。本轮未运行任何上述性能核对。

## 可复用的基础与验收边界

- 复用既有 SQLite、FTS、来源定义、哈希缓存、用途过滤、同步失败隔离、完整原文和证据 identity；无需先替换整套存储。
- 先验证语料质量与固定检索集，再验证证据被 Agent 正确读取和引用；检索命中、引用存在、临床适用性和最终业务动作是不同验收项。
- 原始指南全文、提取缓存和索引继续保存在本地数据目录；公开仓库只保存允许公开的元数据、实现及合成验证输入。患者事实必须使用合成数据，模型运行与压测遵守本次明确授权边界。

当前采用规则及实现 owner 见文首链接，指南包的逐篇题录、临床采用价值和使用限制见[本地冠心病指南分析](2026-10-26-coronary-guidelines-project-reference.md)。
