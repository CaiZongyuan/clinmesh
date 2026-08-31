# Agent Note: Synthea 缺译告警与全量目录默认浏览

Status: implemented

## Problem

全模块 Synthea 会随机产生尚未进入固定中文 catalog 的临床 display。把任何 translation gap 当作整份 Bundle 失败，会让一个英文名称阻塞整批患者；静默保留英文又无法安排后续校对。生成抽屉固定 population/clinical seed 还会反复得到相同患者。医生工作台虽然已经接入全局 Reference SQLite，但诊断和检验在少于三个字符时只显示少量本院常用项，药品在少于三个字符时不显示全局结果，使全量数据看起来没有接入。

本决策局部取代[可选 Synthea 生成 Provider](../architecture/2026-08-26-optional-synthea-provider.md)、[Synthea 来源病例与跨 Epoch 重放](../architecture/2026-08-30-synthea-case-source-and-replay.md)和[cn-health 数据与 Synthea 中国本地化接入](../architecture/2026-08-30-cn-health-synthea-localization.md)中的 translation gap 失败策略；三份原决策的其他边界继续有效。

## Decision

cn-health localizer 对合法但未命中翻译 catalog 的 display 保留来源英文，并以成功响应返回有界 `TRANSLATION_GAP` warning。warning 保存总缺口数、是否截断，以及最多 100 个包含 resource type/ID、FHIR path、coding 和来源 display 的缺口。Java Provider 严格验证 warning shape，并在批次 metadata 中按患者 ordinal 返回；ClinMesh adapter 拒绝重复或越界 ordinal，将 warning 保存到不可变 Synthetic Patient Profile，并在患者标题和来源页展示待校对数量与明细。FHIR Bundle 结构、身份/profile tag、catalog hash、localization provenance、资源白名单、引用闭包或复现 metadata 无效时仍然失败。

生成抽屉每次从关闭变为打开时重新随机生成两枚 31-bit seed；用户仍可在高级设置中修改当前值以复现某次生成，提交值必须与界面显示一致。

医生选择诊断、药品和检验时默认请求当前 Reference Release 的第一页。输入不足三个字符时继续浏览无 query 的稳定分页；达到三个字符后执行 FTS 搜索并从第一页开始。全局目录成功返回时不自动选择第一行，inactive 行可见但不可选。只有 Reference 请求失败，或无 query 的全局目录为空时，才回退到既有本院常用项。

上述关键词阈值和行内选择 UI 后来由[医生临床目录选择与草稿确认](../feature/2026-08-31-doctor-clinical-catalog-dialogs.md)局部取代；默认第一页、无自动选择、inactive 不可选和 fallback 语义不变。

## Alternatives considered

**继续让 translation gap 阻塞患者。** 这种策略可以保证界面没有英文，但全模块随机生成会被翻译目录的暂时缺口绑死，且一个患者可阻塞同批其他患者。

**静默保留英文。** 患者可以生成，但没有数量、位置和来源 coding，维护者无法稳定复现并补齐 catalog。

**允许在 ClinMesh 直接覆盖翻译。** 操作方便，却会让 cn-health catalog 和 ClinMesh Profile 出现两个翻译 owner，也无法给旧 Profile 提供可验证的 projection hash。

**继续使用小型下拉框，只在输入三个字符后访问 Reference SQLite。** 请求较少，但医生无法发现已导入的完整目录；一到两个字符也既不能浏览又不能搜索。

**每次生成使用固定默认 seed。** 最容易复现，却让普通点击反复生成同一人群；现在由界面随机默认值和可编辑高级设置同时满足多样性与复现。

## Consequences

患者生成可以包含少量明确标识的英文临床名称，管理员能在来源页定位并安排医学或药学校对；已生成 Profile 继续绑定原 Bundle 和 catalog provenance，补充 cn-health catalog 只影响以后生成的新 Profile，不原地改写历史。

多患者 Provider 响应会额外携带按 ordinal 关联的 warning metadata，消费者必须验证边界后再持久化。warning 不是错误豁免：任何无法证明来源完整性、结构正确性或复现一致性的响应仍然 fail closed。

医生打开诊断、药品或检验编辑器会产生一次有界 Reference 目录读取，并可继续翻页。FTS 仍要求至少三个字符，避免单字符无界匹配；本院常用项只是 Reference 不可用时的连续性 fallback，不再代表完整目录。
