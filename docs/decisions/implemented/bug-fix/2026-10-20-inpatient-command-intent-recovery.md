# Agent Note: 住院写入绑定原意图恢复

Status: implemented

## Problem

住院登记不改变 Patient 版本，并允许同一患者多次住院。首次已提交但 HTTP 回执丢失后，若页面换 key 重发，就会创建第二次住院并再次收预交金。床位互换若先刷新两侧版本，再当作新操作重做，还会把床位交换回去。场景重放又可能复用 Patient 标识及版本，旧人类 Cookie 自动解析新活动 Epoch，Patient 版本无法单独保护旧登记意图。

## Decision

当前住院登记、床位动作、住院证与场景时钟使用私有的 `inpatient-write-intent` 模块。发送前将完整命令输入、原预期版本和幂等键写入 sessionStorage，严格校验版本与窄命令 schema，并绑定 User Account、Actor、Workspace、Epoch、Scenario Run 和完整岗位上下文。存储不可读写或绑定不符时不发业务请求；发送及恢复前重新核对服务端 Session，异步等待期间再次检查已有意图，防止多个挂载覆盖同一岗位尚待确认的操作。只保存意图，不保存 token、凭据或查询结果。

同一岗位的原意图未确认时，表单锁定并提供恢复入口。HIS 恢复先按原 operation/key 查询 Command receipt；已完成时采用该回执，没有回执时只按原输入和原 key 重发。场景时钟保持原时间输入和原 key 重发，由同一 Command receipt 幂等恢复。成功或可信的业务拒绝才清除意图；网络错误、超时、不可信响应、5xx 和幂等键冲突保持待确认。非 JSON 的4xx也属于不可信响应，不能据其 HTTP 状态解锁新意图。Query refetch、页面刷新、重新挂载和输入变化均不改写原意图。

登记输入额外固定 `expectedEpoch`，在共享 Command 的事务授权检查中与认证解析的 Epoch 比较。该字段仅是乐观前置断言，不能选择 Workspace 或 Epoch。不一致稳定返回 `INPATIENT_EPOCH_CONFLICT`，不创建住院及资金事实；正常的同患者多次住院继续允许。协议由[幂等合同](../../../architecture/fhir-and-commands.md#65-idempotency)与登记 Catalog version 2 拥有。

岗位页面通过 `workspace-error` 按受控 code/conflict 显示本地化反馈，未分类异常及本地校验异常不显示原始消息。

## Alternatives considered

- 每次点击生成新 key，再刷新业务数据：无法证明旧请求未提交，资金动作会重复，互换床位还可能反向执行。
- 仅在组件 ref 保存 key：重新挂载及刷新会丢失原输入和身份绑定，且只保留 key 不能防止预期版本被换新。
- 禁止同患者再次住院：削减了独立多次住院需求，也未解决其他写操作的未知结果。
- 只依赖 Patient 版本或旧 Agent Grant 失效：人类 Cookie 会重新绑定当前 Epoch，重放的同标识同版本 Patient 仍会通过。

## Consequences

住院 UI 的未知结果可以跨刷新恢复，原意图确认前不能开始新的住院写入。登记的额外 Epoch 断言同时保护 Web 与 CLI，不依赖浏览器状态作为授权。持久意图损坏时保留阻塞，防止静默丢弃可能已经提交的资金操作。模块覆盖登记与床位、诊断和医嘱执行、检查、手术、转科、出院结算及场景时钟的已实现写操作；旧门诊 mutation 的实现保持各自归属。
