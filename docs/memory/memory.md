# 工程记忆

本文保存用户的稳定协作偏好，并按场景索引低频排障经验。产品合同归 [`docs/architecture.md`](../architecture.md) 与 [`docs/ui/design.md`](../ui/design.md)，包级硬约束归根与子目录 `AGENTS.md`，工程流程归 [`docs/agent-development.md`](../agent-development.md)。

开发、交付或验证前先读本页；仅在遇到下表对应场景时按需打开子页。

## 按场景查阅

| 当前任务或问题 | 经验入口 |
| --- | --- |
| 产品长期方向、参考优先级、模型切换或交互偏好 | [产品方向与交互偏好](product-references.md) |
| Worktree、锁文件、Windows/WSL、进程容器、飞书读取或文档构建 | [开发环境与跨平台运行](development-environment.md) |
| Vitest/Playwright 定向筛选、并发争用、替身、异步屏障或草稿恢复 | [测试与验证排障](testing.md) |
| DSH Page Context/Tool、Surface 产物、Profile 配置或模型桥日志 | [DSH 集成排障](dsh-integration.md) |
| SQLite 迁移、持久回执、指南/DRG 资料库、模型校验、Synthea 或影像素材 | [临床数据与模型任务排障](clinical-data.md) |
| 浏览器缩放/滚动/布局核对、`agent-browser` 会话、FFmpeg 或 PR 短片 | [浏览器与演示证据](browser-evidence.md) |
| `1x` 人眼观察节奏的完整操作导览视频（`HumanDriver` + 底部防遮挡字幕） | [人眼慢速操作导览录屏](video-walkthrough.md) |
| GitHub 网络排障、Actions 日志脱敏、PR 合并清理、媒体分支或上游升级 | [GitHub 与交付排障](github-delivery.md) |

## 协作与交付偏好

- **修复与 CI 优先**：复用仍有效的界面证据，仅按实际视觉改动补拍必要截图，不重拍完整矩阵，也不因补图阻塞提交、CI 或审查。
- **执行节奏**：要求先走规格与拆票的任务，审阅获准后连续实施；局部 UI 调整若用户明确“直接开干”，在关联已有或新建 Issue 后直接完成本地修改与最小验证，不重复阶段确认。仅按需借用 `superpowers:brainstorming` 可视化辅助，不启用其完整流程。
- **DSH 隔离与上游跟进**：全局 DSH 不再挂载 ClinMesh；开发验收一律使用项目隔离环境。持续适配 DSH 及桥接组件（React Surface、AG-UI）最新正式版与 RC（不跟 alpha，不改 `deepseek-ai/deepseek-harness` 官方源码），仅升级实际必需组件，自动创建升级 PR 交用户决定合并。
- **分支、PR 与合并收尾**：提交修改默认沿用当前非 `main` 分支，修已有 PR 默认提交并普通 push 到该 PR head 分支。合并前核对用户指定交付分支与 PR 实际 `base`（子 PR 合入集成分支，仅总成果获准后入 `main`）；合并后同步目标分支，确认无未保存修改、合并后新提交或其他 worktree 占用后再清理已合并分支（含子模块时同步核对子模块 PR 与父仓引用）。
- **审查闭环纪律**：PR 转为 Ready 前先在本地执行 `code-review` 双轴全量审查（Standards + Spec），不把外部 Codex 自动审查当兜底；收到任意一条审查意见后，必须先用 grep/全路径排查同类所有代码路径并一次性修完再推送，避免单点修补引发多轮往返。
- **保真纳入现有改动**：用户要求把当前工作区修改一并提交时，先辨认并原样保全再纳入目标提交，不丢弃或擅自改写。
- **手工测试与演示账号**：用户要求启动分支手工测试时，运行带已有 Provider、完整参考目录与持久化数据（需隔离时使用一致备份并说明边界）的真实应用，不用微型 fixture 冒充。询问合成演示账号密码时直接从当前 Scenario/seed 给出；真实凭证与患者信息永不入库。查询进度时先汇报“已完成 / 进行中 / 阻塞”后继续执行，除非用户要求暂停。
