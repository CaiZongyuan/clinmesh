# Agent Note: Host 独立识别复用 Server 模型账本

Status: implemented

## Problem

医生代问意图识别由 DSH Host 自发调用模型，未经过 Server Provider，不能靠桥接请求外的计数覆盖。医生输入来源证明只确认输入归属，不代表当前仍有病例权限；同病例页面续签也会撤销旧 Page Context，直接要求旧上下文 active 会破坏已接受任务。[正式规格](../../../spec/2026-10-19-model-usage-control.md)拥有需求，Server 既有逐次计量取舍见[账本决策](2026-10-21-server-model-usage-ledger.md)。

## Decision

Host 先通过 SDK 准备句柄锁定实际模型配置，预检失败不计实际请求；识别 stream 前向 Server 请求窄准入，Server 从同 client 的最新持久 Page Context 核对原身份并重验成员、岗位、Epoch、病例权限与既有任务连续性。输入证明不能代替准入；同一输入任务只在单 writer 事务中取得一次新尝试。模型配置由实际 Host 请求提供，输出上限和功能由 Server 固定。准入响应丢失也不重做该任务，保守保留派发未知。

识别器复用桥接的 DSH 用量映射，逐帧上报已知量，独立结算回执只绑定原尝试。固定识别期限后，Server 在读取或 Host 控制请求时将仍在途的原记录持久转为未知，不依赖失联 Host 的 finally，也不以超时释放消耗；进度不续期，迟到可信终态仍可结算。临床权限和来源证明过期不撤销历史消耗的结算能力。Host 不持久化第二套余额、账本或临床正文；结算失败只保留原尝试待确认，不重新调用模型。Server 经 bridge 发起的请求继续沿用原尝试身份，不再次进入自发识别准入。

## Alternatives considered

- 在 Host 维护独立余额或日志：无法与 Server 原子准入，重启和跨桥容易重复计数。
- 将医生输入证明作为通用模型许可：把来源证明扩大成生成权限，无法重新验证病例责任或保证一次性。
- 只要求原 Page Context active：同病例内容更新和续签会误拒仍有效的任务。
- 只在识别成功后上报总量：遗漏取消、断流与结算失败前已观察到的用量。
- 只依赖 Host 终态上报或 Server 重启：Host 完全失联时会持续显示在途；按访问收敛避免新增后台计时器生命周期，同时保留消耗。

## Consequences

Server 和账本可写性成为 Host 辅助识别的前置条件。识别失败保留原工具拒绝合同，不自动重发；未知记录可以继续接收可信用量与终态。统一开关与请求限额由[控制恢复决策](2026-10-21-model-request-control-recovery.md)拥有，Token／金额保护的生产适配器边界由[计价控制决策](2026-10-21-model-usage-pricing-control.md)拥有。当前接口与信任边界见[模型用量查询](../../../architecture/security-and-reliability.md#模型用量查询)，持久化见[账本合同](../../../architecture/storage.md#910-模型调用账本)，验证见[测试策略](../../../testing.md)。
