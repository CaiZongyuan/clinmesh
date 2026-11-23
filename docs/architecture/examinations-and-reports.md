# 检验、检查与报告

本文定义检验、放射、病理会诊与无像素功能检查四类医技业务的共享申请生命周期内核、标本送检与真值换算、门诊预付费应收与执行放行门禁、各模态报告发布闭环、连续报告阅读与集中已阅、以及受控不可变报告修订合同。门诊完诊“必要报告已阅”门禁见[门诊业务流程](outpatient-workflows.md#主接诊责任与七项完诊门禁)，住院转科与出院在途检查门禁见[住院与手术流程](inpatient-workflows.md)，收退款与医保分摊见[收费、结算与医保](billing-and-insurance.md)。

## 四类医技共享申请生命周期内核

检验（`laboratory`）、放射（`imaging`）、病理会诊（`pathology`）与无像素功能检查（`examination`）统一构建在同一个申请生命周期内核之上。正式申请共用一张领域申请表并以开放类型列区分模态；扩展新模态仅需新增类型适配器与专属明细表，不重建申请主表与关联引用。

内核统一维护领域状态机（`issued` -> `accepted` -> `in-progress` -> `reported` -> `acknowledged`，以及 `cancelled` 与 `generation-failed`）、预期版本（CAS）、幂等回执、`AuditEvent` 与 `Action Trace`；各模态策略仅负责提供自身的 outbox 事件、受控系统执行者与报告资源组装。FHIR R5 `ServiceRequest`、`Specimen`、`Observation`、`ImagingStudy` 与 `DiagnosticReport` 各自维护标准生命周期，不把报告修订覆盖到旧资源上。“同一就诊／住院对同一服务同时只能存在一条进行中申请”的互斥约束覆盖全部四类申请，跨模态调用另一类型的操作接口统一返回确定性业务冲突。

## 门诊与住院检验申请及标本送检

### 门诊开立与住院护士送检门禁

门诊病例使用独立的病例级草稿聚合（如 `laboratory_request_state`）维护单调递增草稿版本，以 `Encounter` 与草稿预期版本做 CAS 更新；尚未分配主接诊医生的 `awaiting-doctor` 病例必须先完成接诊责任绑定，才开放医技草稿与正式开立。保存草稿读取当前启用且允许医生开立的 `Hospital Service` 冻结服务与报告定义快照，正式开立重验相同服务身份与版本（直接提交底层 Reference Concept ID 返回目录冲突），创建 `ServiceRequest.status=active` 与 `Task.status=requested`（`focus` 指向该 `ServiceRequest`），开立动作本身不推进门诊 `Encounter` 状态。

住院医技由 `InpatientInvestigations` 适配同一申请内核（严禁住院病例绕行门诊公开接口）：开立通过本次入院登记固定的私有 `source_case_id` 定位同 Epoch 的真实 `Synthetic Case` 解析真值，无合成来源的手工建档患者明确拒绝开立而不以正常值兜底；正式生成的 `ServiceRequest`、`Specimen`、`Observation`、`ImagingStudy` 与 `DiagnosticReport` 均归属当前住院 `Encounter`。住院目录明确区分“可开展”、“尚未开展”与“未计价”：门诊与住院国内核心检验（覆盖五分类血常规、心肌损伤标志物与高敏肌钙蛋白 `hs-cTnI`、血脂、肾功能、电解质、糖化血红蛋白、凝血与 D-二聚体）按精确 `system + version + code` 对齐共享合成价目表，未声明有效住院价格的项目禁止开立；申请开立时冻结服务版本、住院价目与 `execution-completed` 计费触发点，仅在首次报告完成时于同一事务计收一次住院费（报告修订不重收，患者已出区或已结算后拒绝补入账）。

住院检验与检查不设门诊预付费门禁，但增设病区护士标本／检查送检门禁：住院医生连续加入最多 20 项待开项目逐项签发后，仅生成待送检的 `issued` 申请；必须由当前责任病区护士核对至多 20 项尚无 `sent` 事实的申请并逐项调用 `inpatient.investigation.send`（校验申请、`ServiceRequest` 与 `Task` 版本），记录送检人与时间后才排入受理 outbox。晚到受理事件重验未取消状态及同一住院的 `sent` 送检关联，缺失送检关联一律拒绝执行。

### 受控 LIS 执行、真值单位换算与失败关闭边界

进入受理队列的检验申请由持久 outbox 绑定受控系统角色 `lis-system` 依次将申请与执行 `Task` 推进至 `accepted` 与 `in-progress`。报告执行器对暂时性故障或可恢复输出异常执行最多三次有界尝试（前两次保持 `in-progress`，第三次写入 `generation-failed`）；病例精确真值与报告定义单位不兼容或缺少必要结果底账属于确定性错误，首次即写入 `generation-failed` 且拒绝人工重试（可恢复故障允许原责任医生在冻结服务与报告定义上发起新的一轮三次尝试）。

检验发布基线支持成人参考范围与定量危急值阈值判定（报告叶子节点输出可选布尔 `critical` 供界面紧凑标记“危急值”，同时保持标准三态 `interpretation` 不变），并对 `Case Truth` 执行受控确定性单位换算，无法精确换算时严格失败关闭而不猜测数值。执行成功后在同一事务原子创建一份 `Specimen`、每个报告叶子一条 `Observation`、一份 `DiagnosticReport` 与 `Provenance`，完成 `ServiceRequest`、执行 `Task` 与领域申请；重复 outbox 投递幂等返回已关联快照，报告读模型始终从已签发 FHIR 资源还原而不依赖当前目录模板重建。服务发布与换算边界见[实验室服务发布与基线决策](../decisions/implemented/architecture/2026-09-01-laboratory-service-publication.md)与[检验真值单位换算决策](../decisions/implemented/bug-fix/2026-10-16-laboratory-truth-unit-conversion.md)。

## 门诊独立检查的应收与执行门禁

### 预付费冻结、逐项确认与首次放行快照

门诊检验、放射、病理会诊与无像素功能检查正式开立统一采用持久化的 `prepaid-v1` 预付费策略（历史存量无计费记录兼容保留 `legacy-unbilled`，不追溯补收）：在同一共享 Command 事务内原子创建 `ServiceRequest`、执行 `Task`、正式申请与唯一原 `ChargeItem` / `Charge Record`，冻结服务身份与版本、门诊价目版本、整数分单价、币种、计价单位与生效日期（每次申请数量固定为 1：检验按根组合／单项计价而不对叶子成员重复收费，病理按单次既往切片会诊计价）。缺价、零占位价或未到生效期的项目允许保存草稿但硬性阻止正式开立，草稿保存后服务或价目变更须重新保存审阅；正式开立后的目录改价、报告更正或失败重试均不改写原冻结价目。

门诊医生目录弹窗与准备清单支持在各模态内连续加入并勾选最多 8 项（人工草稿与 Agent 建议共用同一待开清单，检验建议接口按建议服务 ID 派生最多 8 项当前医院目录与价目投影 `laboratoryServices`）：提交确认统一要求携带审阅快照 `reviewedService`（含服务 `id`、`version` 与完整 `outpatientBilling`，缺价显式为 `null`），严禁在提交瞬间静默替换为最新目录价。外层统一核验医生身份与 Agent 建议代次／资料指纹（过期整批拒绝），随后对每项在独立 SQLite savepoint 内校验当前目录价目并落库申请与费用：单项发生 `CATALOG_CONFLICT` 仅回滚该项并保留待办重审，其余合法项正常生效，按冻结顺序返回单份对齐回执；退出登录或网络中断后的原意图恢复遵循[准备临床确认决策](../decisions/implemented/architecture/2026-10-18-prepared-clinical-confirmation.md)与[连续办理私稿与逐项原回执恢复](clinical-workflows.md#连续办理私稿与逐项原回执恢复)。

临床 `issued` 状态与财务状态正交投影（`pending` 待缴费、`partial` 部分缴费、`ambiguous` 资金结果未知、`paid` 已满足放行、`cancelled` 已取消）：收费员收款、原支付恢复或医保待遇确认仅在“净实收加有效医保覆盖已足额覆盖净应收且无任何未知收退款”时按原 `ChargeItem` 排入受理队列；共享内核在受理事务内再次复验资金确定性与未取消状态，原子冻结包含原费用版本与资金依据的首次放行快照并写入 `accepted`。后续开始执行与失败重试均强制核验该有效首次放行快照，严禁仅凭队列事件绕过门禁；受理前撤销医保待遇退回待补收状态，受理后发生医保撤销或财务更正仅产生独立财务补收待办，保留首次放行快照而不回退或重复执行检查。计费策略与持久边界见[门诊独立检查计费与门禁决策](../decisions/implemented/architecture/2026-10-26-outpatient-investigation-billing.md)与[存储合同](storage.md#门诊独立检查计费策略)。

### 临床取消、批量重试与退款收敛门禁

| 原申请状态与资金条件 | 临床取消与账务结果 |
| --- | --- |
| `issued` 或无报告的 `generation-failed`，无未知资金且无有效医保分配 | 原负责医生可取消（`ServiceRequest=revoked`、`Task=cancelled`）；同一事务追加原费用剩余全额冲减并将 `ChargeItem` 标为不可计费，原申请、原应收与原收款保留；已产生的实收由收费员另行按原成功交易办理退款 |
| 上述可取消状态仍存在未知收款或未知退款 | 拒绝取消；收费员须先查询收敛原资金尝试后再重验 |
| 上述可取消状态仍存在有效医保分配 | 拒绝取消；收费员须先撤销原医保待遇后再取消 |
| `accepted`、`in-progress`、`reported` 或 `acknowledged` | 关闭普通临床取消；价目错误在放行前由医生取消重开，放行后仅走受控财务更正，既有执行与报告保留 |

门诊与住院均支持按类别集中取消待执行申请或集中重试可恢复的 `generation-failed` 申请（每次最多 20 项，取消与重试分立办理，逐项调用原单项 Command）。临床取消不授予医生直接退款权限，也不代表资金已退回；存在净实收或未知退款的已取消门诊申请继续保留在收费员“已缴”待办视图供办理原路退款，且在取消退款责任完全归零前保持当前 `Scenario Run` 为 `active`（不阻断医生完诊或药房发药）。

## 无像素功能检查、放射与病理闭环

### 无像素功能检查（ECG 与 TTE）

功能检查以 `kind = 'examination'` 接入共享内核，提供本院常备的常规十二导联心电图（ECG：覆盖心律、心室率、PR/QRS/QTc 间期及前壁、下壁、侧壁导联组 ST-T 表现）与经胸超声心动图（TTE：覆盖 LVEF、左室舒张末期内径、节段室壁运动、瓣膜及舒张功能），使用独立的 `examination` 目录与操作集。门诊沿用预付费收齐放行，住院沿用护士送检后执行并在报告完成时入账。受控系统执行者经 outbox 生成包含检查方法、文字所见、诊断印象与结构化 `Observation` 的 `DiagnosticReport` 及 `Provenance`，不生成 `ImagingStudy`、波形流或图像像素，无需安装外部影像／切片素材即可完整运行。

结果生成优先消费病例完整的精确 `Case Truth`（仅存在部分精确指标时严格拒绝补造其余指标）；无精确真值时，仅当病例为普通成人 Synthea 病例、全部诊断与手术编码可经已知非心血管 SNOMED 白名单或非心血管 ICD-10 规则明确分类、且私有真值、可见既往史与本院正式临床记录均无任何心血管阳性冲突或异常心电／心超观测（同时校验 `Observation` 主值与 `component`）时，才生成确定性成人正常基线；存在阳性冲突、年龄不适用或单位无法判定时直接置为 `generation-failed`。生成结果冻结至 `Investigation Result Snapshot`，重试与相同临床证据的 Epoch 重放幂等复用同一快照。取舍见[无像素功能检查闭环决策](../decisions/implemented/architecture/2026-11-13-functional-examination-loop.md)。

### 放射检查阅片闭环

放射申请覆盖胸片与胸部 CT 平扫。放射服务为本院 `Hospital Service`，医生目录中的“已开展”状态在查询时由服务启用标志与本地对应检查影像素材就绪状态联合计算（与当前具体病例无关；未开展项目允许暂存草稿但阻止正式开立）。放射系统执行者经 outbox 受理、开始并在短事务内原子发布 `ImagingStudy`、`DiagnosticReport`、`Provenance` 与申请完成状态（检查与签发时间取开单虚拟时间）；病例无可用匹配影像结果或连续三次暂时执行失败时统一落为 `generation-failed`，错误信息不泄露底层真值匹配原因。患者对话模型仅获知“做过哪项检查及时间”，绝不注入影像所见、印象或报告卡片；不实现 PACS、DICOMweb、放射技师岗位流或增强扫描。阅片闭环见[胸部影像阅片闭环决策](../decisions/implemented/architecture/2026-10-01-chest-imaging-reading-loop.md)。

### 病理切片会诊闭环

病理申请覆盖乳腺既往手术、结直肠既往内镜活检或息肉切除、甲状腺既往手术的单张石蜡 H&E 切片会诊，“已开展”同样由服务启用标志与本地切片素材就绪状态联合决定。目录查询同时返回当前病例可送检的既往手术清单（仅筛选医生本已可见的来源病史中编码相容且早于本次就诊的手术，不读取隐藏病情或素材占用），草稿与正式开立均校验所选手术位于可送检清单内并冻结为申请明细快照，不将外院病史转换为本院 `Procedure`。

病理系统执行者经 outbox 完成收片登记（`accepted`）、阅片（`in-progress`）与报告签发：在同一短事务内创建采集时间为既往手术时间且接收时间为收片虚拟时间的 H&E 染色 `Specimen`、模态为 `SM` 的 `ImagingStudy`、同时引用二者的 `DiagnosticReport`（含标本信息、镜下所见、病理诊断、既有免疫组化结果与备注）及 `Provenance`；无相符切片时置为 `generation-failed`。患者对话模型仅获知“会诊已受理”，不注入镜下所见或病理诊断；不实现本院活检取材、冰冻切片、细胞学、免疫组化／分子湿实验制片或上述三类以外的会诊。切片导入与会诊闭环见[病理切片导入与乳腺会诊决策](../decisions/implemented/architecture/2026-10-02-pathology-slide-ingest.md)。

乳腺使用本地金字塔阅片，结直肠与甲状腺通过独立的 PathJX 专用页阅片；每次会诊按本院合成价目收取一次原申请费用，包含当前一张切片，不包含取材、制片或额外切片。外部会诊的授权、显示资格和恢复边界见[可插拔病理阅片](pathology-reading.md)。

## 连续报告阅读、集中已阅与不可变报告修订

### 门诊与住院连续阅读及集中已阅

门诊医生与住院医生分别在同次就诊或同次住院的统一报告阅读窗口内连续审阅检验、功能检查、放射与病理报告（住院读写校验当前责任科室与病区，转科后由新科室接管；住院报告发布不触发门诊对话卡片或门诊病历自动整理）。单纯打开或切换报告绝不隐式写入已阅事实：检验与功能检查报告必须在本轮阅读窗口实际打开，放射与病理报告还必须满足对应影像／切片素材当前可读且已在真实阅读器中成功渲染（外部切片同时核验当前受限会话的显示资格；素材缺失或损坏时仍可阅读文字报告，但禁止确认已阅；关闭窗口、刷新页面、切换患者或切换行动身份立即撤销内存中的本轮阅读资格，从 `sessionStorage` 恢复的选择草稿须重新打开核实）。

`Report Acknowledgement` 是绑定具体 `DiagnosticReport` 版本的独立领域事实，仅允许原开单责任医生（住院为当前责任科室医生）对 `DiagnosticReport.status=final` 且申请处于 `reported` 的报告确认（集中确认逐份调用原 `acknowledge` Command，携带独立幂等键）：成功后将申请推进至 `acknowledged` 并递增申请版本、记录 `ReportAcknowledgement/<id>` 审计与 `Action Trace`，但不修改 `DiagnosticReport` 内容或其 FHIR `meta.versionId`；不同幂等键重复确认同一报告版本幂等返回首次已阅记录。医生另可将放射或病理报告摘要（注明报告版本与签发时间）显式插入未签署门诊病历的“辅助检查”字段，后续报告晚到或修订不自动改写病历正文。

### 受控不可变报告修订

报告更正仅允许登录会话具备 `administrator` 能力的受信入口发起，由服务端绑定为受控系统执行上下文（如 `lis-system`），同时在回执与 `AuditEvent` 中完整保留操作者当前的 `Practitioner`、`Practitioner Role` 与 `Location`（普通临床账户与请求体严禁伪造系统角色；已归档住院病例受归档写锁保护而拒绝更正）。

更正请求校验申请当前处于 `reported` 或 `acknowledged`、申请 expected version 与原 `DiagnosticReport` expected version：检验更正要求提供更正原因、结论以及覆盖原报告全部结果编码且无重复的完整数值集合；放射与病理更正仅允许从同一影像／切片素材下另一份已预先核对发布的报告修订版本中选择，严禁自由改写文本或替换像素素材。每次更正均为 `DiagnosticReport`（及检验的全部 `Observation`）分配全新的 logical ID，保留原报告与原 `Report Acknowledgement` 历史只读可查，创建以标准 `Provenance.entity.role=revision` 引用被替代报告的新 `Provenance`（不在 R5 `DiagnosticReport` 上伪造非标准 `relatesTo` 字段），并在领域修订表通过 latest-only 唯一约束维护线性替代链。更正提交后，申请指向新报告版本并回退至 `reported`、清空当前已阅投影，临床责任医生必须对新报告版本重新阅读并确认已阅。
