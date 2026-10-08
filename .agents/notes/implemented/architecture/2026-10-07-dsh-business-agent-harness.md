# Agent Note: DSH 业务 Agent Harness

Status: implemented

针对医生纯查询绑定的后续提案见[医生 Agent 纯查询绑定](../../proposed/architecture/2026-10-08-doctor-agent-query-binding.md)，尚未实施；本文已有写入、proof 与交接决定继续适用。

## Problem

DSH 通用 `standard` preset 的编码身份与开发工具会使医院业务 Agent 转向源码或数据库排障，超出当前页面授权工具的使用方式。模型还需显式携带短期 Context ID，而页面状态发布与 TTL 续签可在模型生成调用期间替换该 ID，导致原调用参数与执行时 schema 失配。

允许当前 Context 自动接受任意旧调用会把可靠性问题变成授权问题：切换患者、岗位、资源或草稿版本后，旧意图可能作用于新的页面。正式医院 Command、人工决定与审计归属必须继续使用既有边界。

页面动作完成与新工具注册是异步过程。仅让浏览器延迟释放旧 registration 无法保证下一模型请求已取得新目录；立即释放则可能取消尚未送达宿主的原调用结果。

## Decision

ClinMesh 通过 DSH 原生 preset 声明医院业务 Agent，动态 Surface 仍拥有岗位与页面 Tools。业务装配及用户默认选择规则由 [系统架构](../../../../docs/architecture.md#7-agent-适配器与能力边界) 拥有，业务指引与问诊恢复由 [DSH 页面操作](../../../../docs/agent-capabilities.md#业务会话) 拥有。开发 preset 继续服务排障，不把工程指令与开发工具带入医院业务组合。

模型携带 page scope 与语义 page revision，执行桥接管理短期 Context ID。语义 revision 绑定 `viewRevision` 与完整草稿引用，排除 Context ID、TTL 和瞬态 UI 状态。Host 从真实调用参数捕获意图绑定；浏览器用执行时捕获的当前 Context 请求一次性 proof，Issuer 将实际 Context ID 与原调用的语义 revision 同时签名。Server 同时核对签名 revision、Context token、Session、scope、Tool 与当前人类身份。协议定义见 [execution proof 合同](../../../../docs/architecture.md#74-execution-proof-与调用记录)。

该决定局部取代 [DSH 原生 ClinMesh React Surface](2026-08-30-dsh-native-clinmesh-surface.md) 中把短期 Context ID 投影为模型 schema `const` 的机制；其他 Surface、Page Context、人工审阅、Command 与审计所有权保持原决策。普通调用的续签容忍不扩大人工审阅窗口，旧 Context 关联的未决定 review 仍失效。

Host 与浏览器采用结果交接：保留旧结果通道到 Host 收到同批原生结果，再发布页面最终目录；公开 `tools/post-execute` hook 等待该 Agent 的完整工具集合与目标绑定就绪后继续模型回合。交接以原调用实际签发的 proof 关联，不允许浏览器冒认其他调用；并行批次以执行 body 已收到为发布条件，不依赖按顺序进入的 finalize。详细协议归属 [execution proof 合同](../../../../docs/architecture.md#74-execution-proof-与调用记录)。

## Alternatives considered

**仅提醒模型使用最新 Context ID。** 模型生成期间仍可能发生续签，提示词无法协调工具定义与执行时机。

**直接将旧调用 Context ID 替换为最新值。** 只验证当前 token 会丢失原调用针对的页面版本；因此签名还必须携带实际调用捕获的语义 revision，并在 Server 核对。

**删除绑定校验或接受历史 Context。** 会削弱患者、岗位、资源版本与会话隔离；短期 Context 精确匹配与页面语义版本核对均保留。

**只给通用开发 preset 增加业务 prompt。** 不能隔离 Bash、文件读写与工程上下文，故使用已有原生 preset 的独立装配，无需新增 Agent runtime。

**固定延时等待注册。** 时长不能证明宿主已收到结果或新目录就绪；改为原生结果接收与实际目录确认。

**在浏览器 Tool 返回前等待新 lease。** 原生结果仅在 Tool 返回后提交，提前换 lease 会取消旧结果通道，等待则会死锁。交接请求与结果返回分离。

## Consequences

TTL 续签或加载状态变化不会迫使模型更新 schema 中的绑定值，页面与草稿语义变化仍拒绝旧意图。Preset 不是安全沙箱；真正授权仍由受信 Host proof、Server policy、资源状态与人工审阅完成。工具缺失、超时与结果不明仍需要公开状态核对，不能以绑定改进推断动作成功。

合同回归覆盖缺少绑定、Host 会话缺失、重复 proof、旧 scope 与语义 revision、同语义 Context 续签、旧 Context token，以及已有人工拒绝、review 失效与 Command 关联边界。真实 DSH Session 验证负责证明业务组合实际生效，不能只凭配置文件或单元测试推断运行中 Agent 已切换。

连续调用回归必须在同一用户回合观察第一条后续模型请求的实际 schema；多个用户回合分别等待新注册不能证明交接正确。同步失败保留原业务结果并停止回合，不把系统交接问题交给用户刷新，也不因此省略真实身份或意图冲突的澄清。

模型跨回合沿用旧参数仍会被拒绝。Host 提供从该 Agent 当前只读定义提取的恢复参数，不改写原调用；业务身份核对依赖随后的真实读取。未读到病例只意味着未知，不能推断病例没有记录。Prompt 约束这类表述，但不替代绑定校验或保证模型回答始终正确。
