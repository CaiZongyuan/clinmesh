# Agent Note: Better Auth 与 Workspace 岗位上下文

Status: implemented

## Problem

ClinMesh 的一个 User Account 可以参与多个 Workspace，也可能在同一医院扮演多个岗位。认证身份、医院工作人员、岗位分配、Workspace 资格和当前行动上下文具有不同生命周期。把这些概念压成 Better Auth 的用户或组织角色，会让角色切换、Epoch reset、委托、患者范围和审计无法表达，并可能把客户端声明的角色误当成服务端授权事实。

## Decision

Better Auth 负责 User Account、登录凭证、浏览器会话和会话撤销；ClinMesh 自有 Identity & Access 模块负责 Workspace Membership、Practitioner 关联、Practitioner Role、委托、患者与地点范围、场景策略和审计上下文，当前合同见[安全与可靠性](../../../architecture/security-and-reliability.md)及[系统边界](../../../architecture/system.md)。禁用公开注册，只允许受控 Scenario 安装过程创建的合成演示账户登录，schema 不把账户限制为单岗位。

不使用 Better Auth Organization plugin 作为医院授权权威；Better Auth schema 与 ClinMesh 领域 schema 通过稳定的 User Account ID 单向关联，认证库不能反向修改医院岗位事实。每个受保护请求先验证会话或受限凭证，再由服务端从数据库重验 active Workspace Membership、Practitioner Role、active Workspace Epoch 及场景约束，生成窄化的 Actor context。客户端切换岗位或 Workspace 必须经过显式 command、资格校验和审计；请求头中的 workspace ID 只作为一致性断言。

多名用户共享同一 Workspace 的 active Epoch，前端使用 TanStack Query 保存服务端状态，通过聚焦刷新、动作成功后的精确失效和短间隔轮询同步；Zustand 只保存视图状态。业务写入携带 expected version，不以最后写入者覆盖隐藏并发冲突。

## Alternatives considered

**把 Workspace 映射为 Better Auth Organization，把岗位存为 organization role。** 减少自有表，但通用角色不能稳定表达 FHIR 工作人员岗位、地点、Epoch、患者范围和委托。未采用。

**每个岗位创建一个独立登录账户。** 简化当前上下文，却无法表达同一人多岗位、委托和“代表哪名 Practitioner 行动”，并使审计把身份和岗位混为一谈。未采用。

**在 token 中固化 Workspace、Epoch 和全部权限。** 读取快，但 membership、reset、委托撤销和 policy 更新在 token 过期前不能立即生效。未采用；动态业务上下文每次重验。

**首期使用 WebSocket 同步所有岗位。** 推送延迟更低，但增加连接生命周期、重连、顺序和缓存一致性复杂度。未采用；先以精确失效和轮询满足多岗位协同。

## Consequences

认证主体与医院岗位授权解耦，角色切换、Epoch reset 和并发版本校验均由服务端统一执掌。SQLite 上的会话校验、权限重验和轮询与业务写入共享同一进程连接预算，查询保持窄化，敏感写入不依赖可能延迟撤销的缓存角色数据。全局壳层持续显示当前 Workspace、岗位和地点，切换上下文时隔离或清除旧 query cache。
