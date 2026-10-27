# Agent Note: 住院 DRG 仿真链——双轨编码、归档冻结与受控核定

Status: implemented

Web 入口、读取审计、支付缺项判定和当前事实评估由[联合入口与审阅绑定](2026-10-25-drg-joint-acceptance-and-review.md)部分替代；本 Note 保留双轨编码、归档冻结与确定性核定的决策理由。

本 Note 的简化分组、MDC 回填和新生儿参数取舍由[完整条件程序决策](../architecture/2026-10-25-drg-condition-program.md)替代；双轨编码、归档冻结和受控核定的决定继续有效。当前分组合同见[DRG 条件分组](../../../architecture/drg-grouping.md)。

## Problem

_issues #273–#276（规格：门诊住院共享支付与 DRG 一体化）要求把 CHS-DRG 3.0 从静态参考资料变成可运行的住院仿真链：在院预分组、处方推演、归档冻结分组与医保办模拟核定。三个结构性难题：病案首页使用的临床版编码与分组规则字典的医保版编码是两套码域；归档后的分组不能随规则包升级漂移；医保办核定不能被手填金额伪装成医保返回。

## Decision

- **双轨编码**：病案首页诊断/操作锁定临床版 `nhc-icd10-clinical@2022.r4`（提交与审核强制完整来源校验）；分组规则字典吃医保版码域。两套码同码直通，未同码的诊断/操作如实报告为无法入组，不做名称模糊映射。口径声明随每次预分组结果以 `codingNote` 返回。
- **分组内核**：`groupDrgCase` 是固定规则纯函数，规则集在 `loadDrgRules` 装载期经 `drgRulesSchema` 一次性校验，内核不再重复校验规则；结果四态显式（grouped/ungroupable/ambiguous/invalid-input）并携带逐步解释。MDC 前缀表未命中时按候选 ADRG 归属回填，回填步在解释路径中如实标注。
- **归档冻结**：归档事务内按首页快照分组，与快照同事务落 `inpatient_record_archive.drg_result_json`；规则包未配置时冻结结果为 null，归档不被 DRG 仿真可用性阻塞。预分组双态：归档病例直读冻结结果（不依赖当前规则包），未归档病例实时分组。
- **推演过期口径**：`simulate` 是无状态只读评估，`fingerprint`（规范哈希）绑定病例、临床修订、医嘱、执行、手术、预留、目录价格与规则版本；服务端不落评估实体，迟到响应由调用方凭 fingerprint 隔离，草稿只参与计价不落库。
- **受控核定**：模拟核定金额由服务端按固定版本的合成支付参数确定性计算（基础费率×病组权重），不接受请求传入金额；复核记录 append-only，绑定归档 `sourcesHash`、冻结结果哈希与参数身份。
- **医保办入口边界**：本链交付公开 HTTP 接口与岗位身份（合成账号、PractitionerRole、workspace 角色注册、越岗 403）；Web 复核视图后置到医生工作台 DRG 面板一并实现。

## Alternatives considered

- **手填核定金额**：拒绝——不可追溯，等于允许把任意金额伪装成医保返回。
- **评估落库实体**（持久化每次 simulate 结果并标记过期）：拒绝——只读评估加指纹已满足迟到响应隔离，落库引入第二份需要保持一致的状态。
- **MDC 前缀未命中直接报无法入组**：拒绝——在参考资料未全量提取的现状下会误伤可入组病例；回填步如实标注，前缀表补全后回填自然退化为空路径。
- **归档被规则缺失阻塞**：拒绝——病案归档是法定流程，DRG 仿真是增值评估，可用性耦合会反向阻塞归档。

## Consequences

- 「主诊断+其他手术」组合 ADRG 判定与条件型（并发症表格驱动）判定不进首版，已在规则包 manifest 的 `extraction.comboOperationAdrgs` 如实登记；合成支付参数仅覆盖演示病组（如 RA15），真实 DRG 码参数清单是后续数据工作。
- 新生儿分组字段（`ageDays`、`birthWeightGrams`）已进合同但内核不消费，非新生儿输入恒为 null；补新生儿组时是加分支而非改合同。
- `incompleteness.costMissing/paymentReferenceMissing` 恒为 true，反映当前无成本与支付参数 owner；接入后须改为按数据判定。
- 读取类接口（pregroup/simulation/payer-reviews）未引入读取审计，与全仓现状一致；spec 验收字面要求「读取保留审计」，属全仓既有差距，不在本链单独引入新模式。
- 规则参考资料清单与来源核验见 [2026-10-21 离线 DRG 参考资料清单](../architecture/2026-10-21-offline-drg-reference-inventory.md)。
