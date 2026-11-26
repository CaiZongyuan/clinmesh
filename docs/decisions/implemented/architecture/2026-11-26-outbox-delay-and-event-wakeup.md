# Agent Note: Outbox 延迟入队原语与事件驱动即时唤醒

Status: implemented

## Problem

ClinMesh 单进程 SQLite Outbox 原本完全依赖 `apps/server/src/index.ts` 的 `250ms` 周期定时器盲扫（`autoDispatchIntervalMs: 250`）推进所有 lane。这带来两个问题：

1. 正常业务事务提交即时 Outbox 事件后，需要额外空等平均 `125ms`、最长 `250ms` 的定时扫描延迟；对于 `accept -> start -> report` 这类多跳级联任务，固定空等会被逐跳叠加。
2. `CommandTransaction.enqueue` 仅支持按当前时间写入 `next_attempt_at`，缺少声明式延迟调度原语，无法在单一事务内安全表达上游所需的合批或防抖延迟窗口（例如实时病历整理来源合批），且盲扫周期过短会在空闲期产生不必要的 SQLite 轮询争用。

同时，既有大量服务端集成测试依赖省略 `autoDispatchIntervalMs` 的被动模式，通过 `runtime.dispatchPending()` 与 `dispatcher.dispatchOnce()` 确定性逐步推进队列；任何自动唤醒改造都不得破坏这一测试隔离边界。

## Decision

1. **延迟入队原语与提交后通知（`CommandTransaction` / `CommandExecutor`）**：
   - `EnqueueInput` 新增可选字段 `delayMs?: number`（非负安全整数，默认 `0`；负值、非整数或导致 `next_attempt_at >= 9999-12-31T23:59:59.999Z` 哨兵/四位年份越界的入参抛出 `RangeError` 并随事务回滚）。`outbox_event.next_attempt_at` 按 `new Date(now.getTime() + delayMs).toISOString()` 写入，`created_at` 与 `updated_at` 保持 `now`。
   - `CommandExecutor` 提供 `subscribeOutbox(listener)`，在 `execute()` 事务成功 `COMMIT` 且本次至少产生一条新入队事件时，发送只读元数据数组（`kind`、`nextAttemptAt`）；事务回滚、未入队或幂等回放均不通知，监听器异常按 best-effort 捕获以免污染已提交 Command。
2. **自动调度模式下的按 lane 事件唤醒与单最早延迟定时器（`OutboxLaneScheduler` / `runtime.ts` / `OutboxRepository`）**：
   - 仅当 `options.autoDispatchIntervalMs !== undefined` 时向 `commands.subscribeOutbox` 注册唤醒器：
     - 即时事件（`nextAttemptAt <= now`）通过 `queueMicrotask` 异步定位对应 lane 并唤醒所需数量的空闲 `pumpSlot`（避免同步重入 `CommandExecutor.execute()` 调用栈）；若所有槽位均在途，则按 lane 累计待唤醒槽位需求并在槽位退出循环时补唤，消除多槽位并发与微任务窗口内的丢唤醒竞态。
     - 延迟事件（`nextAttemptAt > now`）按 lane 维护单个最早到期 `setTimeout`（延迟上限钳制为 Node.js 32 位安全值 `2_147_483_647ms`），新到更早事件重排该定时器；到期时若系统时钟早触发（`remainingMs > 0`）则重排补齐，否则先经 `OutboxDispatcher.nextDelayedAttemptAt(lane.filter)` 查询同 lane 下一条活跃未耗尽未来事件并重武装定时器，再唤醒对应 lane 槽位。
     - `runtime.close()` 立即退订 `subscribeOutbox`、清理 `delayedTimers` 全部句柄并清空 `pendingWake`，确保无残留活跃定时器。
   - `apps/server/src/index.ts` 将兜底轮询周期从 `250ms` 放宽至 `1_000ms`，仅用于租约过期回收、失败退避重试与重启扫描。
3. **测试被动模式零破坏**：
   - 省略 `autoDispatchIntervalMs`（`undefined`）时，运行时不订阅 `subscribeOutbox`，不启动任何自动 `pumpSlot` 或延迟定时器，所有依赖 `dispatchPending()`/`dispatchOnce()` 的集成测试行为保持完全确定。

## Alternatives considered

1. **缩短固定定时扫描周期（例如降至 `20ms`）**：
   - 否定原因：无法消除空闲与高并发下的 SQLite 持续轮询开销，也无法提供精确的延迟入队与到期即刻触发语义。
2. **引入外部消息队列或独立 Broker 进程**：
   - 否定原因：违背 ClinMesh 单进程 SQLite 原子事务与轻量部署边界，且跨进程双写会破坏业务表与 Outbox 同事务一致性。
3. **在内存中维护每个 lane 的全量延迟事件优先队列而不回查 SQLite**：
   - 否定原因：Epoch reset 放弃事件、并发失败重试或超量延迟事件容易导致内存队列与持久化状态漂移或增长；仅在内存保留每 lane 单一最早定时器、到期后通过已有 `outbox_kind_ready` / `outbox_claim_idx` 索引查询 SQLite 下一条最早事件，既简洁又以 SQLite 为唯一事实源。
4. **对所有运行时无条件开启事件驱动唤醒（忽略 `autoDispatchIntervalMs === undefined`）**：
   - 否定原因：会破坏既有依赖手工 `dispatchPending()` / `dispatchOnce()` 分步断言中间状态与故障注入的集成测试确定性。

## Consequences

- 正常业务提交即时 Outbox 事件后在微任务级（实测 `< 50ms`）进入 handler 执行，多跳级联（如 `accept -> start -> report`）连续无空等推进，同时服务端默认盲扫频率降低为原来的四分之一（`1_000ms`）。
- 下游业务（如实时自动病历整理来源合批）可直接复用 `transaction.enqueue({ ..., delayMs })`，由 Outbox 统一承载延迟持久化、重启安全与到点即刻唤醒。
- 仍存在少量绕过 `CommandExecutor.execute()` 直接构造 `CommandTransaction` 或原地 `UPDATE outbox_event` 的历史刷新路径（如住院 DRG 跟进的 `refreshPending`），它们仍由既有 `1_000ms` 兜底扫描与 `dispatchPending()` 覆盖，保持本切片窄边界不扩散修改。
