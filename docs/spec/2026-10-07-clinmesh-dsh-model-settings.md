# 在 DSH 设置中选择 ClinMesh 使用的模型

Status: implemented

## 问题与目标

目前 ClinMesh 的患者档案、自由问诊、检验结果生成和目录补全由独立 Server 读取 `CLINMESH_AI_*` 配置，并通过 OpenAI-compatible Provider 调用模型。即使从 DSH Surface 打开工作台，这些调用仍不使用 DSH 的 Provider 设置。用户需要维护两套模型配置，且无法在设置界面调整 ClinMesh 的模型。

目标是在 DSH 设置中提供独立的 ClinMesh 模型选择入口，共用 DSH 已配置的 Provider 与凭据。未指定 ClinMesh 模型时使用 DSH 默认模型；用户可以指定其他模型。模型选择独立于右侧会话，每个生成任务开始时固定所选路由，后续设置变更影响新任务。

## 范围

- DSH 设置新增“ClinMesh 模型”，提供“使用 DSH 默认模型”和从宿主可用模型目录选择具体 Provider／模型两种方式。
- 首期以一个选择统一控制患者档案、自由问诊、需要模型生成的检验结果，以及显式启用的目录补全。确定性模拟、精确病例事实匹配和冻结结果复用继续走现有流程，不增加模型调用。
- 设置保存在当前 DSH Profile 的持久配置中，刷新、重启和 ClinMesh Surface 开关后仍可读取；不同 Profile 独立。
- 将模型选择接通到 ClinMesh Server 的实际生成调用，使 DSH 模式无需重复配置 Provider 凭据与上述 `CLINMESH_AI_*_MODEL`。
- 独立 Web 的现有 `.env` 接入继续可用。实施时明确 Server 的模型来源模式，避免同一 Server 同时服务多个入口时由最近打开的页面改变全局配置。

## 用户故事

1. 作为用户，我希望在 DSH 设置里选择 ClinMesh 的模型，以便不修改 `.env` 就能调整患者模拟与生成任务。
2. 作为用户，我希望可以使用 DSH 默认模型，也可以给 ClinMesh 单独指定模型，以便分别调整医院仿真与右侧助手。
3. 作为用户，我希望切换右侧会话或会话模型不会改变 ClinMesh 的设置与正在执行的任务。
4. 作为用户，我希望模型不可用或设置保存失败时获得明确提示，并能修复配置后继续操作。

## 验收条件

- [x] 用户可从 DSH 设置找到“ClinMesh 模型”；无右侧会话或未打开 Surface 时仍可使用。
- [x] 初始值为“使用 DSH 默认模型”，界面可辨识当前解析到的 Provider／模型；用户可选择具体模型或恢复默认。
- [x] 候选来自 DSH 的模型目录，区分不同 Provider 的同名模型；不要求用户在 ClinMesh 再填地址或密钥。
- [x] 设置具有加载、无候选、保存中、保存成功及失败状态；保存失败不把未持久化的选择显示为已保存，过期请求不覆盖较新的选择。
- [x] 刷新、重启与 Surface 开关后选择保留；不同 DSH Profile 的设置互不覆盖。右侧会话创建、切换、关闭或更换模型不修改 ClinMesh 选择。
- [x] 选择模型 A 后，新问诊及各类实际模型生成任务通过 DSH Provider 使用 A；选择 B 后的新任务使用 B，已开始或排队且已绑定 A 的任务继续使用 A。
- [x] “使用 DSH 默认模型”在每个新任务开始时解析默认值；执行期间修改 DSH 默认模型不改变该任务的路由。
- [x] 记录足以辨识生成来源的 Provider／模型；相同模型名的不同 Provider 不混淆。已有 Persona Revision 和 Investigation Result Snapshot 不因更换模型而重写，reset/replay 保持原有复用合同。
- [x] Provider 缺失、凭据失效、模型移除、取消、超时及无效结构化输出有可恢复失败；不保存半成品，不悄悄改用其他 Provider。问诊失败继续保留医生发言并沿用受控重试入口。
- [x] 患者模拟请求仅包含现有业务所需输入，不带右侧医生 Agent 的 transcript、系统提示或 Tools；病例真值与生成输入不进入右侧会话、Page Context、Tool 或 CLI 输出。
- [x] 密钥不进入浏览器、ClinMesh DTO、审计正文或日志。模型桥接的实际调用只接受受信 Server 发起的受限生成请求，拒绝未授权调用与任意 URL／header 覆盖。
- [x] 设置在中文、英文、亮暗主题、窄窗口及键盘操作下可用；卸载 ClinMesh 插件后释放注册的入口与桥接能力。
- [x] 独立 Web 的现有模型配置与失败恢复正常；DSH 模式下移除重复的 `CLINMESH_AI_*` 配置后，生成仍可通过 DSH Provider 工作。

## 设计决定

- 已确认：ClinMesh 的模型选择独立于右侧会话；默认使用 DSH 默认模型，并允许用户单独选择。
- 已确认：首期一个 ClinMesh 模型供全部实际模型生成能力共用，设置作用域为当前 DSH Profile；不按医院岗位、病例或会话保存独立模型。
- 一个任务包括其内部结构化输出修复与自动重试，开始时固定 Provider／模型。持久任务将路由与任务一起保存，进程重启恢复时不重新读取当时的默认值。
- 新消息、新生成任务与新的人工重试采用当前 ClinMesh 模型选择；同一人工重试意图的重复发送保留本次成功解析的路由。问诊和检验的恢复不得因旧失败尝试的模型不可用而无法使用新选择；已有成功结果不自动重生成。
- DSH 插件拥有宿主模型配置和调用适配，ClinMesh 的业务服务继续拥有输入构造、结果验证、任务状态、幂等、预期版本与审计。业务层不直接依赖 DSH SDK。
- 使用 DSH 公开扩展能力，不修改官方源码，不维护宿主补丁或 fork。使用 `ctx.llm.stream()` 与 `ctx.agentDefaultModel.currentSelection()`，采用原生通用设置 slot 与 volatile Profile 字段，通过受限 HTTP loopback 桥接连接 Server。
- 已核对的 DSH 公共调用合同没有 ClinMesh 当前使用的 `response_format: json_schema`。适配层需要提供可验证的结构化结果，保留现有 schema 与诊断泄漏检查，不因 Provider 能返回文本就放宽业务校验。
- 模型来源、持久路由、宿主桥接和上下文隔离的取舍见 [Agent Note](../../.agents/notes/implemented/architecture/2026-10-07-clinmesh-dsh-model-binding.md)。

## 测试策略

DSH adapter 合同测试覆盖目录读取、选择与恢复默认、持久化失败、卸载及 Profile 隔离。Server 集成测试使用可记录调用路由的合成 Provider，证明患者档案、问诊、检验生成与目录补全均使用所选模型，并覆盖任务排队后改设置、执行中改默认值、重启恢复、内部自动重试、不同 Provider 的同名模型及未授权桥接请求。

保留现有 Persona／Investigation 严格输出、诊断泄漏、失败不提交、幂等与 reset/replay 测试。模型桥接测试同时断言输入不混入医生 Agent 上下文、输出与日志不暴露密钥或私有病例信息；独立 Web 测试继续覆盖 `.env` 模式。

通过 Playwright 从真实 DSH 设置入口验证模型选择、重启恢复，以及一次实际问诊与患者档案生成的路由。真实 Provider 验证仅使用合成数据，凭据与模型输入正文不进入截图或日志；常规测试与 CI 使用可控测试 Provider，不默认调用付费模型。共享对话框如有新增，按仓库规则覆盖 React 18／19 两个版本。

## 范围外

- 跟随右侧会话的模型、给患者模型注入医生 Agent 会话或开放医生 Tools。
- 为四类生成能力分别设置模型、按用户或病例切换模型，以及多 Provider 自动故障转移。
- 在 ClinMesh 中新增 Provider 连接或密钥管理、修改 DSH 官方发行包，以及改变独立 Web 的设置界面。
- 更换模型后重生成已有结果、修改确定性仿真规则、增加新的临床能力或读取影像像素。

## 依赖与风险

宿主基线由 [DSH 上游锁](../../dsh-upstreams.lock.json) 拥有，当前为 DSH `0.2.0-rc.2`。现有 ClinMesh DSH adapter 仅提供应用代理和 Tool execution proof，需要新增受限的服务端模型桥接与相应生命周期处理。任务恢复还依赖持久的 Provider／模型路由表示，不能只保存可能重名的 model 字符串。

设置沿用 DSH 的 Profile 设置管理权限，不增加 HIS 管理员授权；界面说明同一 Profile 下所有 ClinMesh 模型任务共用此选择。人工重试、自动重试与传输重发的模型绑定规则见[系统架构](../architecture.md#103-场景定义)。Server 来源由 `CLINMESH_AI_SOURCE=openai|dsh` 在启动时固定，`pnpm dev:dsh` 自动选择 `dsh`。

Server 与 DSH 位于不同进程，宿主不可用、插件热重载或已选 Provider 被移除时必须可控失败，并保留任务恢复依据。桥接不能依赖某个浏览器标签页存活，也不能使普通岗位获得隐藏病例事实；辅助调用的宿主日志与可见性边界需在接入时核验。
