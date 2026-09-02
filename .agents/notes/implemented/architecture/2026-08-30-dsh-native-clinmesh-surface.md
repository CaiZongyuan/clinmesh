# Agent Note: DSH 原生 ClinMesh React Surface

Status: implemented

## Problem

ClinMesh 需要让 DSH 原生 Session 中的 Agent 感知当前 Web 工作台状态并执行受控前端动作，同时保留 standalone Web、Hono、SQLite、Command、审计和 outbox 的既有所有权。直接把 DOM、Query cache、浏览器存储或完整患者页面交给模型会扩大数据边界；让 Agent 直接提交挂号、分诊、临床、支付或药房 Command 又会绕过当前人类岗位的责任与审阅。

该集成还必须适应 DSH Web 的共享 React runtime、ShadowRoot、原生会话生命周期和动态 Tool broker。DSH transcript 不应复制进 ClinMesh，ClinMesh 的 Hidden Fact、Case Truth、Reveal Policy 和 Scenario authoring truth 也不能因模型位于同一页面而进入 Agent context。

Canonical implementation contract 是 [GitHub issue #60](https://github.com/CaiZongyuan/clinmesh/issues/60)。

## Decision

保留 standalone Web，并把 DSH Web 作为第二个应用 adapter。`apps/dsh-web` 使用固定的 DSH `0.1.1-rc.2`、`dsh-ag-ui@0c0b7e3608ac012dc2b053043fd0460d101b5db3` 和 `dsh-react-surface@e7b17dfd566f4a395027bc8ce1fd368b9fea1707`；后者以 git submodule 固定。pnpm 继续拥有仓库 workspace，内部样式生成由 pnpm/tsx 执行，Bun 只运行上游 React Surface builder 和 artifact verifier。

DSH 拥有模型 Session、transcript、Tool 调度、Surface 宿主、外壳 branding 和 resolved theme。ClinMesh 拥有页面上下文、前端 action、proposal、人工审阅、Command receipt、Audit Event 和 Action Trace 关联。Surface 复用 `apps/web` 的 application/runtime seam，使用 Memory Router、独立 QueryClient、作用域主题、ShadowRoot Portal 和 `/clinmesh-api` 同源代理；ClinMesh `system` 主题订阅 DSH theme，显式 light/dark 保持 Surface-local，standalone Web 保持 Browser History、系统主题与原有 API base。

浏览器发送严格的 `PageContextClaim`、当前 DSH Session 和 Surface client 单调 revision。Hono 根据当前 Better Auth session、Membership、Practitioner Role、Workspace/Epoch、岗位允许页面和权威资源重新签发五分钟 `PageContextSnapshot`；selection、Patient/Encounter 版本和资源状态不直接信任浏览器。snapshot 包含受信 Actor、DSH Session、页面 claim、当前允许 operation、短期 context ID 和 page scope。Capability availability 由 DSH bridge 拥有；Page Context 和 registration 不等待首次 status，因为先注册才能推动冷启动状态从 `unavailable` 进入探测和 `active`。lease 曾 active 后进入 `contended`、`error`、`unavailable` 或 `idle` 会撤销旧 binding，并用同一 Surface client 的下一 revision 重签和重新注册；registration 更新产生的正常 `connecting` 不再签发额外 context。Server 只在同一 client revision 链内撤销旧 context，Web Lock 与 DSH lease 再从并存的冷启动 registration 中选出唯一可取得 execution proof 的 leader；contender 因而不能通过预签 context 使 leader token 失效。Detached review 单独要求 lease 保持 `active`，离开时立即取消。Actor、岗位、Workspace/Epoch、DSH Session、view、active section、selection 或资源版本变化会替换 lease；页面 revision 或 TTL 替换 context 并关闭旧 review。事务内 revision 仲裁防止晚到的旧请求撤销新 context，续签失败则前端在到期时移除 Tools。Hidden Fact、Case Truth、Reveal Policy、作者数据、DOM、缓存和其他患者标签页不进入 claim 或 snapshot。

每个岗位、页面和 operation 使用独立 Tool 名称与窄 object schema。DSH `browser-tools` broker 把 page scope 绑定到当前原生 Session；Host 从真实 `tools/pre-execute` 事件签发一次性 execution proof，绑定 Session、call ID、Tool、Page Context ID、scope 和真实时间过期。浏览器再用当前 context token 与 proof 向 Hono 授权，proof 与 token 的 Context ID 必须精确一致，且浏览器不能自报 Actor、岗位、Workspace、Epoch 或任意资源路径。DSH 支持的 JSON Schema 是强制子集；Surface adapter 用单值 `const` 投影当前 Context ID/scope，并只投影 broker 支持的关键词，Web action 和 Hono authorization 在执行或持久化前都使用共享 Zod schema 恢复完整长度、格式、数组和数值范围校验。页面 action result 按标准 JSON 语义规范化可选 `undefined` 字段后再验证，不可序列化值失败关闭调用。

读取、导航、选择、表单填写、受控问诊、草稿保存和 preview 可以由 Agent 直接执行。正式医院状态变化只创建 proposal 并打开 ClinMesh 原生审阅框。proposal Tool 立即向 DSH 返回 `awaiting-human-review`，不占用 browser lease；Hono 保持 Tool call 与 proposal pending。人类点击决定时，Web 先调用 decision gate；Hono 重新验证 active context、DSH Session、当前资源和 Tool 后原子记录决定，成功后才允许 Web 以当前登录人类为最终 Actor 执行既有 Command。后台 completion 只接受同一个 Command receipt 中显式一致的 request、audit、trace、允许 operation 和 Acting Practitioner Role。明确拒绝记录人类 `rejected` decision；Surface 隐藏、Session/lease 失效、page scope、selection、资源版本、页面 revision 或 context 改变，以及超时或执行错误，会把尚未决定的 proposal 标记为 `stale`，不伪造人类拒绝，也不产生业务 Effect。

Host 代理只接受固定 loopback Hono origin，并限制路径、方法、请求体、响应体和超时；Cookie 与 Origin 语义保持同源。共享 bridge secret 只存在于 DSH Host 与 Hono 环境，不进入浏览器、日志、Tool result 或版本库。当前信任边界只覆盖安装在同一 DSH Web Profile 的受信插件和全合成 ClinMesh 数据。

## Alternatives considered

**删除 standalone Web，只保留 DSH。** 这会把医院产品入口和 DSH 宿主生命周期耦合，也会破坏现有部署与浏览器测试，因此保留两个 adapter。

**使用 iframe 或复制一套 DSH 页面。** iframe 增加认证、尺寸、焦点和样式协调边界；复制页面会分叉状态所有权。原生 React Surface 直接复用同一 Web application interface。

**通过 AG-UI Gateway 建立第二条模型会话。** DSH Web 已有原生 Session；再建 Gateway thread 会产生 transcript 与 Tool 生命周期双重所有权。当前只使用 `dsh-ag-ui/browser-tools` 的 always-on broker，Gateway 保持可选且未配置。

**让 Agent 直接提交正式 Command。** 即使 Tool schema 很窄，最终 Actor 与人类责任仍会混淆。当前所有正式挂号、分诊、临床、支付、药房和 Scenario Command 都要求原生人工审阅。

**提供通用 action、HTTP、FHIR write、Bundle、SQL、URL、DOM selector、JavaScript 或 JSON Patch Tool。** 这些接口把授权和状态机重新交给模型组合，无法对 operation、资源范围和审计做窄证明，因此不提供。

**把完整页面、Query cache 或 Scenario truth 作为模型 context。** 这会泄漏无关患者和仿真私有事实。当前只接受白名单 claim，并由服务端重新签名。

**把人工等待保持在一次 DSH Tool Promise 中。** browser lease 的寿命短于人工审阅窗口，等待会产生超时后仍残留审阅框的分裂状态。proposal Tool 因而先结束 DSH turn，review completion 独立关联同一 receipt。

## Consequences

Web 的服务端状态仍由 TanStack Query 拥有，Surface 隐藏时保留客户端草稿；Memory Router 不修改 DSH document pathname。Dialog、Menu、Select、Sheet、Tooltip 和 Toast 通过注入的 Portal 留在 ShadowRoot。`workspace` 是默认布局，Surface 小于 `1024px` 时退化到 `full-frame`；应用高度受宿主约束，业务 panel 是纵向滚动 owner，长患者历史不会被 DSH layer 裁剪。

医生 Agent registration 位于共享 `DoctorCaseController`，使用当前 `consultation/record/laboratory/diagnosis/prescription` 页面 ID 和 controller 已有 mutations。Agent 草稿动作通过同一保存接口持久化并刷新 Query；成功后 controller 按病例和草稿种类递增水合 revision，只重建受影响的本地编辑器，检验草稿同时同步 controller 持有的项目与适应证选择，避免旧 autosave state 回写覆盖 Agent 结果。病例级检验 Reference Catalog 是分页动态集合，Tool 使用共享契约限定的 ID 字符串，Hono authorization 和 Command 再按当前病例、目录状态与结果生成能力解析并验证。报告更正 Tool 还要求当前账户通过服务端 membership 持有 active administrator role，普通医生不会取得该 operation；正式动作继续复用 controller 的 Command mutation 与 detached review。

Agent integration 增加 Page Context、Tool call、proposal 和 review decision 持久表，所有运行事实使用 Workspace/Epoch 复合隔离键。Command receipt 显式保存 request、audit 和 trace 标识，并用一个 query-shaped 复合索引保护 execution-link 三元组；completion 与 receipt、Audit、Action Trace、review decision 做同 operation、Actor、Acting Practitioner Role、outcome 和时序联结。DSH transcript 不进入 SQLite；普通读取和草稿 Tool 记录调用结果，但不伪装成 Command、Audit Event 或 Provenance。

React Surface artifact 是一个 lazy-CJS 文件，React 与 DSH runtime 保持 external；构建验证拒绝动态 chunk、第二份 React、未服务资产和残留 `import.meta`。CI 递归 checkout submodule，并固定 Bun `1.4.0`。Desktop、Mobile、MCP、Agent OAuth/SMART、自治 Agent Run、Evaluation Spec 和评分不因该 Surface 存在而成为当前能力。

受信插件假设和全合成数据限制是当前方案的硬边界。接入不可信 marketplace 插件或真实患者数据前，必须重新设计浏览器代码信任、凭证隔离、内容安全和部署边界，不能沿用当前同 Profile 信任模型。
