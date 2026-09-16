# Agent Note: Windows DSH 开发入口与进程生命周期

Status: implemented

## Problem

Windows 的 npm/pnpm 通常是 `.cmd` 入口，Node 默认 `spawn` 不能直接执行。只替换命令名不能处理参数转义、无管理员权限的目录链接，以及命令退出后的后代进程。原 [DSH 一键入口](2026-09-15-dev-dsh-one-command.md) 的 Windows 排除范围由本 Note 取代，其版本来源、沙箱和重建策略仍然有效。

## Decision

运行时准备、数据源准备和开发命令使用 `cross-spawn` 解析 Windows 入口与转义参数；普通可执行文件和 POSIX 命令保持 argv 调用。缺失命令或工作目录的 ENOENT 直接失败并提示检查 PATH，不进入网络重试。

Windows 插件链接使用 junction；链接存在性通过 lstat 检查，包含目标已不存在的链接。删除链接不删除目标数据。POSIX 继续使用目录符号链接。

每个 Windows 开发分支由独立 PowerShell helper 创建带 `KILL_ON_JOB_CLOSE` 的 Job Object。helper 先以 suspended 状态创建 Node bootstrap，加入 Job 后再恢复线程，避免加入前已派生子进程的竞态。bootstrap 的命令与参数通过经过形状校验的 Base64 JSON 传入；实际命令经 cross-spawn 执行。bootstrap 退出后关闭 Job，或 helper 被终止导致内核关闭句柄，都会清理仍存活的后代，包括父命令已经退出的进程。Job 句柄不可继承；本次启动以外的进程不加入 Job。POSIX 仍向完整进程组发送原信号，包括组长已经退出的组。

## Alternatives considered

- 直接开启 `shell: true`：参数会被 shell 再次解释，路径和特殊字符不能保持 argv 合同。
- 仅调用 `taskkill /T`：命令已经退出时不能可靠地从已失效 PID 找到整棵后代树。
- 仅终止顶层 Node 或 cmd：不能证明长期运行的 watcher、构建器和宿主已退出。
- 普通目录符号链接：Windows 可能要求管理员权限或开发者模式，junction 足以表示本地插件目录。

## Consequences

开发命令在 Windows PowerShell、Linux 和 macOS 上使用相同入口。Windows 要求系统 Windows PowerShell 5.1 的完整语言模式，可通过 Add-Type 使用 Win32 API，不新增本机编译工具链。真实子进程测试覆盖特殊字符、非 ASCII 路径、中断、非零退出、后代清理与无关进程存活；文件系统测试覆盖失效链接和目标数据保留。部署步骤由 [部署指南](../../../../docs/deployment.md#dsh-web-原生入口) 拥有。

Issue: https://github.com/CaiZongyuan/clinmesh/issues/109
