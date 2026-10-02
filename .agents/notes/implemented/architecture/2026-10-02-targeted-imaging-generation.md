# Agent Note: 按影像适配条目定向生成患者

Status: implemented

## Problem

影像闭环只对少数来源病情可用：首批素材只覆盖存活的肺癌男性和本次就诊为急性支气管炎的成人。默认全模块生成时本次就诊可以是任何疾病，绝大多数病例影像准备为“未覆盖”；用模块过滤加换 seed 碰运气对存活肺癌患者命中率极低，批次中有人死亡时 Provider 还会因导出条数不符整批失败。需求见 [issue #137](https://github.com/CaiZongyuan/clinmesh/issues/137)，当前行为见 [系统架构 10.3 节](../../../../docs/architecture.md)。

## Decision

**保留条件提高命中率，匹配规则唯一判定。** Server 从所选适配条目推导保留条件交给 Provider，Provider 写成 Synthea keep module 以 `-k` 运行并只保留存活患者，Synthea 在同一次运行内部重试，不重启 JVM。Synthea 无法表达“该疾病就是 Index Encounter 的诊断”或“按就诊开始时间判断缓解”，所以 Server 生成后用影像准备的 `matchCaseImaging` 复核每位患者，不满足时沿用既有的确定性换 seed 重试。规则只有影像准备一个 owner，两处不一致时以匹配器为准，不放宽匹配器。

**Provider 只接受窄的保留条件。** 协议有须存在与须不存在的 SNOMED 数字编码两个有界列表，以及可选的 Observation 编码值条件（某个 LOINC Observation 的最新结果须为所列 SNOMED 编码值之一，最多 8 项，供病理适配条目按受体与分期筛选）；性别与年龄沿用人口参数；不接受数值比较、任意模块 JSON 或命令行参数。疾病和已做操作都用 Synthea 的 Active Condition 判断，因为操作编码在记录中永久存在。Synthea 对不存在的 Observation 做值比较会抛出异常，Provider 生成的条件先判断存在再比较取值。Provider 在健康检查中声明 `targetedGeneration`，在元数据中回显保留条件；旧 Provider 不声明该能力，定向提交被拒绝，而不是静默忽略条件；不认识 Observation 条件的 Provider 以请求无效拒绝，Server 同样报告为不支持定向生成。

**定向任务成功后立即准备影像。** 管理员拿到的病例已经是“已就绪”；准备失败不回滚已生成的患者，成功的任务带上 `IMAGING_PREPARATION_FAILED` 警告，界面提示管理员重新准备。生成任务因此区分“失败”与“成功但有后续步骤未完成”两种结果，后者使用独立的警告字段，不放宽“成功任务没有错误”的约束。

## Alternatives considered

**只在 Server 侧换 seed 重试。** 不需要改 Provider 镜像，但每次尝试都要重新启动 Synthea 并导出、本地化整批患者，存活肺癌病例往往需要几十次尝试，十次上限内经常失败。

**由条目自动填入 Synthea 模块过滤。** 过滤后只运行少数模块，患者缺少其他模块产生的合并症和属性，病史失真；保留条件已经承担了提高命中率的作用，因此定向生成不改模块设置。

**把保留条件直接写进素材清单。** 会出现与匹配规则平行的第二份病例条件，规则变化时两者漂移；从适配条目推导则只有一个事实来源。

## Consequences

Provider 镜像需要重新构建和发布，Compose 中的固定 digest 随之更新；未升级 Provider 的部署只能使用不定向生成。阴性条目的排除编码随未覆盖疾病清单增长，协议上限为 128 个。两个阴性条目适用同一类病例时按来源哈希二选一，定向到其中一个时约一半的命中会落到另一个条目并触发重试。
