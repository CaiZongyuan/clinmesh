# 通用收费与住院账务

Node 与 Workspace Durable Object 都从 `builtinModules` 装配 `createBillingModule()`。收费岗位从就诊页打开「收费工作台」，切换门诊或住院队列，核对币种、余额、历史和冻结预览。选择模拟渠道响应可演练拒付、延迟成功与延迟拒付。正式资金动作要求人工确认。刷新中断请求后可用原幂等键核对回执。

内置 1.1.0 数据包声明了门诊挂号服务。接诊岗开诊时由 `encounterStarted` 在同一事务登记费用，收费员可办理收退。住院 Encounter 从开诊起即有独立预交金账户，首次封账读取实际住院出区事实。

## 临床接入

开立本院医嘱的同一写事务调用 `freezeCharge(tx, at, source)`。来源包含就诊、医嘱、品规 ID、数据包版本、数量、单价、币种、精度、业务时间及审计时间，可附发生科室。重复传入相同来源得到同一 Charge Item。受理检查或发药的事务通过 `readOrderFunds(reader, at, orderId)` 重读资金状态。`released` 体现预付或后付策略，`state` 提供药房核对结清所需的细分状态，`locked` 标记资金已涉及的账项。成功收款以及有效第三方覆盖足额后，持久化放行事实并在同一事务调用可选 `onRelease`。

未装配模块的宿主省略收费端口。启用模块且包策略为 `free` 时，端口可直接放行。来源医嘱撤回后，已有收付保留历史，未收款项目退出有效应收。清床的事务使用 `readAdmissionFunds(reader, at, encounterId)`，资金未知或待遇待复核时 `outstandingMinor` 返回 `null`。

住院耗材使用由 `freezeMaterialUse(tx, at, materialUseId)` 按已登记的使用量、预留批次和冻结品规单价记费，重复提交同一使用 ID 返回原费用。业务日期按医院数据包的时区计算。账项、冲减、收款、渠道、分配和历史退款均核对原币种与精度，冲突时暂停合计及收退操作，收费员可查看原币金额。

收费员预览与确认首次封账时，服务端在同一账务快照中核对已执行医嘱、报告、发药、手术和实际耗材使用。`unpostedSources` 列出待记费的来源。补齐账项并结清差额后可重新预览和确认，清床端口同步读取这项检查。

## 资金命令

`billing.account` 返回账项、资金尝试、分配、冲减、原始快照及账本版本。所有预览、确认和恢复通过 Operation Catalog 的 Command 事务执行，提交当前 `epoch`、`expectedVersion` 与 `idempotencyKey`。

| 操作 | 收费员核对内容 |
| --- | --- |
| `payment.preview` / `payment.confirm` | 单项可分次，合并 2–20 项须付清每项余额。现金、卡、移动渠道可组合。令牌冻结五分钟真实时间，绑定岗位、参与者、就诊及逐项账本指纹。 |
| `payment.recover` | 提交原 `paymentId` 及其版本，读取原渠道终态。每次未知尝试只可追加一次结果。 |
| `charge.adjust` / `refund.allocation.preview` / `refund.allocation.confirm` | 先指定账项与冲减原因，再按交易和账项分配逆序退回。硬限额为每笔十亿个当前币种最小单位。 |
| `inpatient.deposit.*` / `inpatient.refund.*` | 预交金与出区补缴进入本次住院资金池。多收部分按选定原款退回。 |
| `inpatient.settlement.preview` / `inpatient.discharge.settle` | 患者已实际出区并完成显式收退后封账。冻结逐项费用、分摊和实收快照，后续费用更正用 `inpatient.correction` 追加。 |

原款及退回均保留独立尝试、渠道和逐项分配。每项退款只退至原款实际分配给该项的渠道。冲减依据跨多次原款共享。门诊确认重验冻结费用和相关原款，住院确认重验全账。账本及资金端口的 `releaseRecorded` 记录该账项触发过临床放行，`released` 表示当前资金可执行性。结算后补收或退款须指定 `correctionId`，工作台列出各项更正的待收退额。第三方覆盖和待复核状态通过可选 `PayerBenefitHook` 提供。

## 验证

`pnpm exec vitest run src/packages/mod-billing/tests src/packages/mod-drg-cn/tests src/server/testing src/web/modules/billing/cashier.test.tsx` 覆盖 USD、CNY、JPY、预览过期、并发退款、跨年度待遇、Node SQLite、workerd SQLite 与 UI Agent 人工确认。两个包各自从公共入口验证本包行为，联合收费与医保流程在服务端组合测试中验证。`pnpm check` 和 `pnpm verify:worker` 分别验证完整应用与生产 Worker 打包。

基线 `2f49e201` 导出的[合成 v2 快照](../../server/testing/fixtures/2f49e201-v2.json)含原款 100、历史退款 10 及已实际出区的住院记录。两种 SQLite 宿主均从快照恢复，经正式收费路由处理剩余原款与住院封账。
