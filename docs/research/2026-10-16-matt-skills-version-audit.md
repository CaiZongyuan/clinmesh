# Matt skills 更新前版本核查

核查日期：2026-10-16。本记录保留更新前的比较结果；本机安装状态不属于共享合同，使用边界见 [Agent 工程开发的 Skills](../agent-development.md#skills)。范围为本仓库 `.agents/skills/` 中来自 `mattpocock/skills` 的 skill 正文、宿主元数据及配套参考文件和脚本，不覆盖其他项目、全局安装或其他来源的 skills。

## 结论

更新前本地安装了上游现有 38 个 Matt skills 中的 34 个，内容不是核查时 `main` 的最新版本。与本次固定的上游 HEAD 比较，94 个对应文件中 78 个逐字节一致，16 个有实质内容差异，0 个只有 CRLF 或末尾换行差异。34 个 skill 包中，21 个全部文件一致，13 个至少一处不同。

本地这 94 个文件又全部逐字节匹配历史上游提交 `d81f3a183412e71a5b1e84ca21bc1a35eea03a60` 的对应文件。因此，本次差异可以由旧上游内容解释，没有发现这些 Matt skill 包内额外的本地文件或自改内容。匹配历史快照不等于能够确定最初安装日期。

## 固定来源与方法

| 对象 | 固定来源 | 提交时间（UTC） |
| --- | --- | --- |
| 当前比较基准 | [上游 main HEAD：49dd158d1076134a641b33efb035946536778336](https://github.com/mattpocock/skills/commit/49dd158d1076134a641b33efb035946536778336) | 2026-10-09 10:56:49 |
| 与本地全部已安装文件一致的历史快照 | [d81f3a183412e71a5b1e84ca21bc1a35eea03a60](https://github.com/mattpocock/skills/commit/d81f3a183412e71a5b1e84ca21bc1a35eea03a60) | 2026-09-29 12:37:40 |
| 先前比较材料引用的快照 | [f3fc5632f401156837ee3872f14fe33ccf1024ea](https://github.com/mattpocock/skills/commit/f3fc5632f401156837ee3872f14fe33ccf1024ea) | 2026-10-07 10:22:44 |

1. 从 GitHub 官方 API 读取固定 HEAD 的[完整递归 tree](https://api.github.com/repos/mattpocock/skills/git/trees/49dd158d1076134a641b33efb035946536778336?recursive=1)，返回 287 个条目，`truncated=false`；从 `skills/**/SKILL.md` 确定上游 38 个 skill 及所属目录。
2. 读取固定 SHA 的官方归档，将上游 skill 目录按名称映射到本地 `.agents/skills/<name>/`，逐一比较该目录下所有文件。对最新归档中的 94 个对应文件重新计算 Git blob SHA-1，全部与官方 tree 一致。
3. 第一轮直接比较原始字节；第二轮只将 CRLF 转为 LF，并统一末尾换行为一个 LF，区分换行差异与实质内容差异。没有运行归档内的任何脚本。
4. 对历史快照重复原始字节比较，确认本地全部 94 个文件匹配；检查每个已安装 Matt skill 包中的额外文件，结果为 0。

## 文件统计

| 文件范围 | 文件数 | 字节完全一致 | 仅换行不同 | 实质内容不同 | 缺少对应文件 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 已安装 skill 的 `SKILL.md` | 34 | 22 | 0 | 12 | 0 |
| 同一批 skill 的配套文件 | 60 | 56 | 0 | 4 | 0 |
| 合计 | 94 | 78 | 0 | 16 | 0 |

配套文件包括 `agents/openai.yaml`、参考文档和脚本。34 份 `agents/openai.yaml` 全部与最新上游逐字节一致；这些元数据本来就在上游，不属于本地额外适配。本表只覆盖本地已安装的 34 个 Matt skill；缺少的完整 skill 另列如下。

## 本地缺少的上游 skills

| Skill | 当前上游归属 | 来源 |
| --- | --- | --- |
| `implement-spec` | engineering | [SKILL.md](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/implement-spec/SKILL.md) |
| `pr` | engineering | [SKILL.md](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/pr/SKILL.md) |
| `retro` | engineering | [SKILL.md](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/retro/SKILL.md) |
| `chief-of-staff` | in-progress | [SKILL.md](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/in-progress/chief-of-staff/SKILL.md) |

`chief-of-staff` 仍归于上游 `in-progress`；未安装不等于应当安装。当前本地 `ask-matt` 已引用 `implement-spec`、`pr` 和 `retro`，引用存在不能证明对应 skill 文件已经安装或本轮宿主已发现它们。

## 有内容差异的文件

下表“当前上游变化”描述最新固定快照相对本地文件的差异，不代表已经更新到本地。

| 本地文件（`.agents/skills/` 下） | 当前上游变化 | 固定上游来源 |
| --- | --- | --- |
| `ask-matt/SKILL.md` | 推荐或跳过步骤前先读目标 skill；bug 修复后的反思明确转到 `retro`。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/ask-matt/SKILL.md) |
| `code-review/SKILL.md` | tracker 改为由项目提供；明确查找全部标准文件；要求前台并行发起并收回两轴审查。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/code-review/SKILL.md) |
| `diagnosing-bugs/SKILL.md` | 人为修改代码或 fixture 强制制造 red 时，先与原始副本比较，证明修改确实落地。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/diagnosing-bugs/SKILL.md) |
| `implement/SKILL.md` | 传入 ticket 引用时先读取并报告标题；TDD 和审查的调用方式改用 Skill tool 表述。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/implement/SKILL.md) |
| `setup-matt-pocock-skills/SKILL.md` | 配置 GitHub/GitLab triage 后，创建 tracker 中缺少的标签。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/setup-matt-pocock-skills/SKILL.md) |
| `setup-matt-pocock-skills/issue-tracker-github.md` | 用 JSON 读取 issue，补充 sub-issue 操作，外部 PR 列表改用 REST API。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md) |
| `setup-matt-pocock-skills/issue-tracker-gitlab.md` | `glab issue list` 的 JSON 参数改为 `-O json`，依赖查询明确使用 child IID。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/setup-matt-pocock-skills/issue-tracker-gitlab.md) |
| `setup-matt-pocock-skills/triage-labels.md` | 标签模板明确应编辑的列名。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/setup-matt-pocock-skills/triage-labels.md) |
| `tdd/SKILL.md` | 提议测试 seam 时说明各自能捕获和遗漏的行为。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/tdd/SKILL.md) |
| `to-tickets/SKILL.md` | 明确 parent/sub-issue 与 blocking 是不同关系；已有原生 blocking 边时省略重复文本。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/to-tickets/SKILL.md) |
| `wayfinder/SKILL.md` | 决策票不混用 triage 标签；用真实 issue ID 写引用；研究分支不提 PR；按票的类型执行。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/wayfinder/SKILL.md) |
| `wizard/template.sh` | 修复 Readline、EOF、`.env` 引号、文件权限和符号链接、浏览器打开失败提示，并将执行置于完整函数内。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/wizard/template.sh) |
| `claude-handoff/SKILL.md` | 摘要先存临时文件，再作为后台会话参数传入，避免将正文直接拼接到 shell 命令。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/in-progress/claude-handoff/SKILL.md) |
| `grilling/SKILL.md` | 问题表述使“yes”接受推荐答案。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/productivity/grilling/SKILL.md) |
| `handoff/SKILL.md` | 明确各平台临时目录的解析顺序。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/productivity/handoff/SKILL.md) |
| `teach/SKILL.md` | 明确课程路径相对工作区、格式文档相对 skill 目录；测验答案位置需要变化。 | [源码](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/productivity/teach/SKILL.md) |

全部文件与最新上游一致的 21 个 skill 为 `codebase-design`、`domain-modeling`、`grill-with-docs`、`improve-codebase-architecture`、`prototype`、`research`、`to-spec`、`triage`、`loop-me`、`setup-ts-deep-modules`、`writing-beats`、`writing-fragments`、`writing-shape`、`git-guardrails-claude-code`、`migrate-to-shoehorn`、`scaffold-exercises`、`setup-pre-commit`、`grill-me`、`to-questionnaire`、`wait-what` 和 `writing-for-agents`。

## 边界

本地同目录下的 `agent-browser`、`reduce-complexity`、`shadcn`、`vercel-react-best-practices` 不在 Matt 当前 tree 的 skill 清单内，未计入 Matt 版本统计。核查时 `.agents/skills/` 的 Git 工作树没有未提交修改；版本结论来自固定上游内容比较，不能由 Git 干净状态推出。

先前引用的 `f3fc5632f401156837ee3872f14fe33ccf1024ea` 是有效的固定研究来源，但已经不是此次查询到的 `main` HEAD。上游根 `package.json` 在最新固定提交中仍标为 `1.3.1`；仅比较版本字符串无法替代文件比较。本次基准是源码 `main`，没有将其等同于任一宿主 marketplace 的已发布版本或实际发现清单。

本次核查仅比较文件，没有运行下载内容、模型或产品测试，也没有修改全局配置。开发 skills 的使用边界由 [Agent 工程开发的 Skills](../agent-development.md#skills) 维护。文档检查按项目 [文档规则](../AGENTS.md) 执行，检查结果由实际交付记录报告。
