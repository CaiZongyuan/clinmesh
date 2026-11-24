# 临床数据与模型任务排障

处理 SQLite、迁移、持久回执、指南/DRG 资料、模型校验、Synthea 或影像病理素材时查阅；服务端硬约束见 [`apps/server/AGENTS.md`](../../apps/server/AGENTS.md)，数据与流程合同见 [`docs/architecture/storage.md`](../architecture/storage.md) 与 [`docs/architecture/clinical-workflows.md`](../architecture/clinical-workflows.md)。其他主题见[工程记忆入口](memory.md)。

## SQLite、领域投影与事务

- **临床结构投影陷阱**：本院分诊生命体征存于组合 `Observation.component`（只扫顶层 `code/value` 会漏掉异常脉搏）；`inpatient_surgery_execution.actual_procedure_json` 的 `coding` 是单个 `Coding`（不同于 FHIR `CodeableConcept.coding[]`）；冠脉造影内部 `conclusion` 可能为空，跨业务摘要须按 `report_id` 读取汇总了 QCA 与血管所见的正式 FHIR `DiagnosticReport.conclusion`。
- **时区、字符偏移与原型键**：不同偏移的 ISO 时间不能直接按 SQLite `TEXT` 比较先后，先统一为时间戳或 UTC，医院日界线按 `Asia/Shanghai` 计算；从出生日期算日龄先校验合法日期，未满周岁按日历整岁判断（禁用 `<365` 漏掉闰年第 365 日龄），读取精确体重须显式检查 `Quantity.comparator`；SQLite `length`/`instr` 按码点计数而 JS 按 UTF-16 code unit 计数，含非 BMP 字符的编辑范围统一在 JS 层计算；以编码查 JSON 参数表先用 `Object.hasOwn` 排除 `toString` 等原型属性。
- **嵌套事务、游标与快照隔离**：SQLite 嵌套事务内层 catch 写入仍属外层事务，需保留准入拒绝原因时必须在最外层回滚后再写入；禁止在未关闭的 `Statement.iterate()` 期间开启写事务（会被活跃 reader 阻塞）；在一致快照事务内复用业务读取前确认下游未直接执行独立 `BEGIN`（归档 DRG 先按归档态直读冻结 JSON）。打开 SQLite 后设置 PRAGMA 抛错时须在 catch 中关闭底层句柄。
- **旧库升级与共享目录副作用**：旧库迁移测试按目标迁移之前的连续前缀建库并顺序执行后续迁移，只复制当时已有的 outbox 事件类型与权限模型（门诊号旧库夹具须经真实 `CommandExecutor` 生成审计链）；开发库若报 `PAYMENT_CUTOVER_REQUIRED` 先核对旧资金表与 `0103` 状态，不盲删整库。向共享 `outpatient_catalog` 新增 active 住院药品时，必须补齐门诊疗程/数量/适应症字段或核对 `OutpatientPrescriptionService.prescriptionConclusionSupported`（其对全部 active 药品做 `every` 检查）。

## 指南库、DRG 与离线参考资料

- **指南 FTS5 校验与损坏修复**：FTS5 external-content 表的 `count(*)` 直接读正文表，必须用 `integrity-check`（`rank=1`，临时副本可写连接）核验索引完整性；正文失配重导前须先在同一事务内 `rebuild` 索引（直接删坏正文会让删除触发器留下坏词项使 `bm25` 返回 `null`）；`readonly` 连接在 WAL 下仍可能碰 `-shm`，无写入检查放在临时副本核对。来源损坏停用时须保留停用身份以阻止内置短引文回退，且派生副本不能反向停用原来源。
- **指南用途边界与容器持久化**：公开许可不替代部署用途声明，受限全文默认关闭，独立 worktree 同步的指南库不随 Git 进入主目录（用 `guidelines:sync -- --check --database <实际路径>` 核对，启动成功不代表全文已就绪）；容器指南库含运行期维护限制，必须挂载持久卷而非每次用镜像层覆盖；PDF.js 控制符与 MinerU 单位前缀（如 `μg`）可能失真，未人工核对原页的段落不送检索或模型。
- **参考库与 DRG 离线清单**：`pnpm reference:sync` 固定写默认 `.data/clinmesh-reference.sqlite`（不读 `.env` 自定义路径），不要在 `.env` 手抄 `releaseId` 制造双事实源，同步后重启 Server。`readInventory` 报缺 `storage` 时用只读查询检查 `reference_offline_inventory` 旧登记并按 [`docs/deployment.md#旧格式-drg-登记的局部恢复`](../deployment.md#旧格式-drg-登记的局部恢复) 处理；核验数十万行 JSONL 时将 Zod schema 提为模块常量，内容哈希在持久化 schema 规范化后再 `JSON.stringify`；`better-sqlite3` 编译默认 `cache_size=-16000` 会为 `main`/`temp`/`ATTACH` 各自预留约 `16 MiB` 页缓存，30 万行流式导入与哈希须显式收敛连接页缓存、复用归并头对象，并避免对同连接已校验 `TEMP` staging 行重复执行二次 `z.string().url()` 与对象展开分配；耗材工作稿指纹计算前先按稳定产品 ID 排序，避免模型与目录排序不同导致首次生成即误报 `stale`。

## 模型任务、Synthea 与影像病理素材

- **模型质量门、取消贯通与实模排障**：确定性临床一致性校验须放入 Provider `validate` 回调（在写入成功检查点缓存之前拦截，同时应对 OpenRouter 部分模型缺字段的降级判定），而语义核对的“否定结论”属于合法输出，不得当成格式错误诱导模型重试改口；任务失效取消信号须贯通底层请求与格式修复并共享原始总预算截止时间；包装真实 `DshModelProvider` 时保留 `supportsRequestControl`/`supportsUsageAccounting` 身份（或继承该类），避免重复预占额度；显式失败重试须递增恢复步骤键以区分已耗尽的旧尝试。排查 `outbox_event.status=completed` 但病历未更新时，同步检查 `consultation_recording_job` 与失败 Command 回执。
- **Synthea 病例与检验真值**：合成检验报告生成要求来源 `Observation.valueQuantity` 携带可换算的 UCUM `system` 与 `code`（仅写展示 `unit` 会报 `INVESTIGATION_TRUTH_INCOMPATIBLE`）；直接 `POST /api/his/v1/patients` 建档无合成来源，测试住院检验须从合成病例就诊链入院。Synthea 导出的急性病常带晚于就诊的 `abatementDateTime`，时间裁剪一律以 `Index Encounter` 为界；`-k` keep 模块内部重试不重抽人口年龄，低患病率定向生成须在外层换 seed 并收窄年龄段，GMF 条件须先写 `is not nil` 再写值比较（防 `NullPointerException`）。`PERSONA_DIAGNOSIS_LEAK` 豁免已知病史时保留分句边界。
- **影像与病理下载及复核签名**：`imaging:sync` 与 `pathology:sync`（TCIA / IDC `idc-open-data`）走代理时必须设 `NODE_USE_ENV_PROXY=1`，跨重启缓存在 `.data/` 下管理；素材 `ready` 但全报 `REVIEW_STALE` 时检查 `prompts/*.md` 是否被转成 CRLF 破坏原始字节签名；`jpeg-js` 解码 RGB 码流显式传 `colorTransform`，OpenJPEG 传入空 `print`/`printErr` 抑制逐瓦片刷屏；真实影像与切片验证只读文字快照与 canvas/通道聚合统计，绝不读取像素或含片截图。
