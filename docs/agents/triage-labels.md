# Triage labels

| Matt role | GitHub label | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 需要维护者判断范围或优先级 |
| `needs-info` | `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | Spec 已批准且没有 open blocker |
| `ready-for-human` | `ready-for-human` | 需要人类实施或平台操作 |
| `wontfix` | `wontfix` | 不会实施 |

`spec` 是 ClinMesh 项目 label，用于标识 canonical spec issue（单票 spec Issue 或多票任务的父 spec Issue），拆出的执行子票不带 `spec`；它不替代 triage 状态。已随父 spec 审定范围但仍有前置依赖的子票保持空标签，由原生 `blocked_by` 表达阻塞，不标记 `needs-triage`。Assignee、native dependencies、draft PR 和 open/closed state 分别表示领取、阻塞、评审和完成，不再复制为 labels。
