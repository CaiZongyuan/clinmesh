# Agent Note: Better Auth 与 Workspace 岗位上下文

Status: proposed

## Problem

ClinMesh 的一个 User Account 可以参与多个 Workspace，也可能在同一医院扮演多个岗位。认证身份、医院工作人员、岗位分配、Workspace 资格和当前行动上下文具有不同生命周期。把这些概念压成 Better Auth 的用户或组织角色，会让角色切换、Epoch reset、委托、患者范围和审计无法表达，并可能把客户端声明的角色误当成服务端授权事实。

Web 用户和 Agent client 还需要不同的凭证形态。Web 使用交互式会话，Agent 使用 OAuth/SMART 风格的受限 token；两者最终必须解析为同一种受信 Actor context，才能调用相同 Command 模块。

## Proposal

Better Auth 负责 User Account、登录凭证、浏览器会话、会话撤销以及 OAuth 2.1/OIDC 协议端点。ClinMesh 自有 Identity & Access 模块负责 Workspace Membership、Practitioner 关联、Practitioner Role、委托、患者与地点范围、场景策略和审计上下文。首期禁用公开注册，只允许受控 seed 创建的合成演示账户登录。

不使用 Better Auth Organization plugin 作为医院授权权威。其通用 organization/member/role 模型可以用于产品型租户，但不能表达 ClinMesh 的 Workspace/Epoch 隔离、FHIR PractitionerRole、地点、患者 compartment、委托和场景限制。Better Auth schema 与 ClinMesh 领域 schema 通过稳定的 User Account ID 单向关联，认证库不能反向修改医院岗位事实。

每个受保护请求先验证 Better Auth session 或 OAuth access token，再由服务端解析：

```text
authenticated principal
  -> User Account or Agent client
  -> active Workspace Membership
  -> selected Practitioner Role or service role
  -> active Workspace Epoch
  -> organization/location/patient/delegation/scenario constraints
  -> Actor context
```

客户端可以请求切换 Workspace Membership 或 Practitioner Role，但切换必须经过显式 command、服务端资格校验和审计。后续请求从服务端会话上下文解析选择结果，并重新读取 active Epoch、membership、delegation 和 policy version。请求头中的 workspace ID 只可作为一致性断言，不能选择未绑定 Workspace；角色或地点 claim 不能替代数据库重验。

多名用户共享同一 Workspace 的 active Epoch，因此挂号员、分诊护士、医生、收费员、检验模拟器和药师观察并推进同一条患者流程。前端使用 TanStack Query 保存服务端状态，通过聚焦刷新、动作成功后的精确失效和短间隔轮询获得近实时更新。Zustand 只保存当前工作台、筛选器和面板等视图状态。首期不实现 WebSocket、共同编辑或离线写入。

业务写入携带资源或聚合的 expected version。其他 Actor 已推进流程时，旧页面提交返回可识别的并发冲突并刷新最新状态；系统不能用最后写入者覆盖来隐藏岗位间竞争。角色切换不会复制患者或重建 Epoch，reset 才产生新的 Epoch 并使旧上下文失效。

浏览器会话和 Agent access token 使用独立协议表面，但都只生成窄化 Actor context。Better Auth OAuth Provider 可以承载 authorization code + PKCE、OIDC discovery、client credentials、`private_key_jwt`、JWKS、introspection 和 revocation；SMART scope、FHIR resource scope、Workspace binding 和 Agent tool 风险策略仍由 ClinMesh 定义并求交集。实现只能声明经过互操作测试的 SMART 能力。

## Alternatives considered

**把 Workspace 映射为 Better Auth Organization，把岗位存为 organization role。** 这减少自有表，但通用角色不能稳定表达 FHIR 工作人员岗位、地点、Epoch、患者范围和委托。Better Auth 的多角色表示也不是 ClinMesh 要求的关系与约束模型。

**每个岗位创建一个独立登录账户。** 这简化当前上下文，却无法表达同一人多岗位、委托和“代表哪名 Practitioner 行动”，并使审计把身份和岗位混为一谈。

**在 token 中固化 Workspace、Epoch 和全部权限。** 读取速度快，但 membership、reset、委托撤销和 policy 更新在 token 过期前不能立即生效。token 只携带稳定主体和受限 scope，动态业务上下文每次重验。

**首期使用 WebSocket 同步所有岗位。** 推送延迟更低，但增加 Worker 连接生命周期、重连、顺序和缓存一致性复杂度。普通门诊原型可以用精确失效和轮询验证交互，再由测量结果决定是否增加推送。

## Acceptance criteria

- Better Auth 以固定版本接入 Hono 和 D1/Drizzle，公开注册被服务端禁用，seed 只创建合成 User Account。
- Better Auth 表和 ClinMesh membership/Practitioner/PractitionerRole 表有独立所有权，删除或禁用任一身份时具有明确的会话撤销和引用行为。
- 至少两个预置用户以不同岗位进入同一 Workspace/Epoch，能够依次完成普通门诊发热闭环并看到对方已提交的状态。
- 同一账户具有多个允许岗位时，显式切换后权限和工作台改变；越权切换、伪造 workspace 头和旧 Epoch 请求均被拒绝并写审计。
- 每个业务请求的 Actor context 同时记录认证主体、代表的 Practitioner、Practitioner Role、Workspace、Epoch、组织、地点、delegator 和 policy version；不适用字段显式为空而不是复用其他标识。
- Web 端服务端状态只进入 TanStack Query；角色、Workspace 或 Epoch 切换会清除或隔离旧 query cache，旧响应不能污染新上下文。
- 并发提交以 expected version 产生稳定冲突，不发生静默覆盖；轮询停止、页面后台和网络恢复具有测试覆盖。
- OAuth/OIDC 元数据、PKCE、client credentials、`private_key_jwt`、audience、scope、撤销和 JWKS 仅按实际启用能力发布，并有协议级集成测试。

## Risks

Better Auth OAuth Provider 与 SMART App Launch 不是同一份规范。scope 语法、launch context、token claims 和 discovery 元数据仍需由 ClinMesh 适配并以正式 SMART 测试验证。

D1 上的会话校验、权限重验和短间隔轮询可能放大读负载。首期先保持查询窄化并测量，再决定是否启用短时 cookie cache；敏感写入不得依赖可能延迟撤销的缓存角色数据。

多岗位切换容易让用户误以为自己仍在上一岗位。全局壳层必须持续显示 Workspace、当前岗位和地点，高风险动作的确认与审计使用服务端解析的上下文。

共享 Epoch 不等于共同编辑。同一病历草稿需要独立的锁或版本策略；在该策略交付前，首期流程不允许两个岗位同时编辑同一文书正文。
