# Agent Note: 医生 Agent 纯查询绑定

Status: proposed

## Problem

页面动作共用精确语义绑定，连读取也要求模型复制随问诊和草稿变化的参数。真实会话中目录已经更新，模型仍复制历史值，造成连续读取反复拒绝。仅删除参数又会失去原请求对象，或把当前授权与旧 action/readState 混用。

## Proposal

仅对医生当前病例的一组纯查询，采用原请求来源核对与执行时绑定；详细合同由 [#176 规格](../../../../docs/spec/2026-10-08-doctor-agent-context-execution.md)拥有。运行继续使用现有 DSH 医院助手，不为此引入另一套 Agent 或持久 Task 表。

用公开 Session header 与原生 `tool/call` 关联真实请求和调用，按 Session、call ID、Tool 复用有界 pending。Header 只有快照含义，手动调用也能读取旧 header，因此必须核对原生来源、输入和目录。只保存必要元数据，不复制会话正文或 reasoning，不修改已记录 arguments。

读取 proof 区分原请求／任务对象与当前执行 Context，Server 用已有 Page Context 核对同一病例和身份，并执行当前权限检查。原 Context 的过期或撤销不赋予新权限；对象不明、角色变化或记录缺失均不能猜测恢复。Surface 在同一有效 frame 中取得当前 action 和状态，避免旧闭包。病例 Query 与历史投影仍归业务 owner，Agent 读取不得开放任意 caseId 或隐藏输入。

任务锚点还须关联输入时的真实医生消息，不能随下一步 header 自动迁移。原生来源只能证明模型调用，不能证明医生委托；代问许可建议复用现有人工审阅入口确认一次，再供同任务连续追问使用。该交互待用户确认，建立、失效与暂停规则仍由 #176 规格唯一维护。

该提案仅局部调整[业务 Agent Harness](../../implemented/architecture/2026-10-07-dsh-business-agent-harness.md)中医生纯查询的模型绑定方式；其 Host proof、结果交接、写入意图与人工审阅仍保留。问诊、草稿、选择和提交预览不因 `read-only` 或“尚未正式提交”标签而失去精确绑定。

## Alternatives considered

- 继续提醒模型抄写最新参数：真实记录已经表明新 schema 不保证模型采用新值，无法从根本上稳定连续读取。
- 一律改成执行时的最新绑定：不能区分生成期间的患者变化，也可能把旧意图带到新病例。
- 保留病例级模型参数：可减少普通更新造成的变化，但继续让模型管理绑定，不能完整隐藏这项恢复工作。
- 监听 `llm/stream` 建请求映射：公开 Session header 加原生调用事件已能完成正常 pipeline 的关联，无需增加流包装和另一套生命周期。
- 只从 header 签 proof：临时反证显示，无原生调用也能读取历史 header，不构成调用来源证明。
- 仅相信模型声明已获得代问委托：无法区分真实医生任务、历史消息与注入内容；任务范围的一次人工确认可提供明确的受信来源，但会增加首次代问的一次交互，须由用户确认。
- 新建任务运行器或读取框架：当前 Query、Context、proof、receipt 和公开 DSH hooks 足以承接本切片，新增框架不解决上述对象核对问题。

## Acceptance criteria

满足 #176 规格 C1–C8，并保留原严格写入和人工审阅合同。临时原生探针已验证并行、重试、重复 ID、前序异步 hook 下的 header 和来源时序；这不证明最终 proof、Server 权限或真实模型行为通过。对应事实与限制见[绑定执行研究](../../../../docs/research/2026-10-08-doctor-agent-binding-execution.md)。

## Risks

公开接口变化、原请求元数据缺失、过期 Context 保留范围以及跨步病例变动都可能使来源不可核实；实现必须停止而非退化为最新授权。读动作的缓存闭包、未保存表单和实际 Query 权限需要分别验证。跨包 proof 升级必须在同一 diff 完成，旧产物不能静默降级授权。
