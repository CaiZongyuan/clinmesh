# Agent Note: SQLite 性能工作负载与稳定门禁分离

Status: implemented

## Problem

本地 SQLite 的交互延迟受机器、文件系统和缓存影响，直接把 P95/P99 设为 PR hard gate 会产生环境噪声；只报告延迟又无法阻止 query、write、Trace 或存储放大。SQLite 也不提供可在当前 adapter 中可靠采集的 rows-read，若用返回行数代替会形成虚假指标。本决策由 [issue 50](https://github.com/CaiZongyuan/clinmesh/issues/50) 交付。

## Decision

Performance runner 使用固定 `performanceResultSchema` 输出每个 workload 的 P50/P95/P99、transaction time、statement/query/write counts、rows written、数据库增长、Trace rows/bytes、吞吐和 busy/error/retry。可选 `SqlitePerformanceObserver` 只在 runner 显式创建的 Database adapter 上记录 statement 执行；默认 Server 不启用 observer，不改变 SQL、事务、审计或 Trace 行为。

`ci` profile 在隔离 file-backed SQLite 上运行合成参考导入、本院服务 HTTP 查询、普通 Command、25 行重 Command、同写入量的测试专用 SQL control，以及 Scenario install/reset。PR gate 只约束稳定的 count、query plan、Trace 和 storage 指标，延迟分位数始终报告但不作跨机器 hard gate。本院服务 workload 同时拒绝 `pageSize=101` 并要求 `hospital_service_catalog_search_idx`；结果 schema 不接受 rows-read 字段。

`trajectory` profile 通过 production application interfaces 完成高血压 Dataset generate/install、问诊、CBC 报告确认、I10、5 mg 本院处方、病历签署和完诊。`saturation` profile 使用 Worker threads 和独立 SQLite sandbox 覆盖 1、5、10、25 actors；runner 可以对 `SQLITE_BUSY` 做有界重试并报告次数，这不是生产 Command retry。`full-import` profile 要求调用者提供已合法取得的 manifest，在独立 Reference SQLite 中运行，不把原始目录提交到 Git。

Trace control 只是在测试临时表执行与重 Command 相同的 25 行写入；真实 Command 始终经过 CommandExecutor、Audit Event 和 Action Trace。系统没有关闭生产审计或 Trace 的性能开关。

## Alternatives considered

**以 P95/P99 作为 PR hard gate。** 能直接捕获慢化，但共享 CI 的调度、CPU 和文件系统抖动会使结果不可复现；离散 SQL/存储放大更适合作为稳定门禁。

**把返回行数命名为 rows read。** 实现简单，但不能反映索引扫描、临时 B-tree 或 SQLite 内部读取，因而不提供该指标。

**为 benchmark 关闭审计和 Trace。** 可以得到较低延迟，却测量了不存在的生产路径；测试专用 SQL control 保留可比较基线而不改变 production Command。

**在活动开发数据库运行并发和全量导入。** 更接近日常数据，但污染状态且结果不可重放；所有 profile 使用临时 sandbox，full import 只读取显式 manifest。

## Consequences

`pnpm check` 会运行短 `perf:ci` count/storage gate。维护者按需运行 trajectory、saturation 和 full-import profile，比较延迟时必须同时记录 Node、平台与 SQLite 版本。合成 load 只放大合法 schema 行、Trace 和隔离并发，不修改病例真值或把 `candidate` 冒充为临床审核的 golden 数据。
