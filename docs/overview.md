# 项目介绍与架构概览

本文面向刚加入项目的同事，用一次阅读讲清 ClinMesh 是什么、能做什么、整体如何组织、核心流程如何运转，以及接下来该读哪份文档。这里只做摘要；每个结论的详细合同由链接指向的 owner 文档拥有，二者不一致时以 owner 和实现为准。

## ClinMesh 是什么

ClinMesh 是面向 Agent 的中国公立医院仿真 HIS（医院信息系统）。它用可重复、可审计的合成医院场景，让人类岗位和 Agent 在同一套业务内核上完成挂号、分诊、诊疗、检验检查、收费、医保、药房、住院和病案等真实院内交接，用于 Agent 评测、产品验证和医疗信息系统研究。

| 维度 | 说明 |
| --- | --- |
| 核心用户 | 扮演医院岗位的人类用户、在页面中协作的交互式 Agent、通过 CLI 执行受限任务的任务 Agent |
| 标准接口 | FHIR R5 `5.0.0`，只读互操作面：read、vread、instance history 和白名单 Search |
| 业务写入 | 只通过显式、受控的业务 Command，不开放通用 FHIR 写入或任意 CRUD |
| 病例数据 | 患者、就诊、费用等 HIS 数据全部为虚构或合成数据，不存储真实患者信息 |
| 影像与病理素材 | 阅片使用[影像素材清单](../imaging-assets/README.md)与[病理切片素材清单](../pathology-assets/README.md)登记的公开授权、已去标识像素；仓库只提交清单，像素留在本地素材目录 |
| 外部依赖 | 医保、支付、LIS 等院内外围系统均为确定性模拟器，不连接真实平台；病例档案、问诊对话等生成能力可按[部署指南](deployment.md)配置外部模型 Provider，开发与验收默认使用合成 Provider |

ClinMesh 不是生产医院信息平台，也不是完整 FHIR Server。它不用于真实诊疗、真实结算或真实患者信息存储；明确不做的范围见[系统范围：明确不做](architecture/system.md#14-明确不做)。

## 能做什么

ClinMesh 以“岗位”组织功能。每个岗位登录后进入自己的工作台，只能看到和操作本岗位授权范围内的事实；合成账号及入口见[部署指南](deployment.md)。

| 业务线 | 主要岗位 | 当前能力 |
| --- | --- | --- |
| 仿真病例 | 管理员 | 用中文化 Synthea 生成合成患者，查看来源病史，生成 Patient Brief，直接开始病例；新 Epoch 重置并重放同一病例 |
| 普通门诊 | 挂号员、分诊护士、门诊医生、收费员、药师 | 一个 Encounter 贯穿挂号、分诊、问诊、检验、复诊、诊断、处方和结构化病历签署；收费后药房发药完成本次场景 |
| 检验检查 | 门诊医生、住院医生、LIS（系统 Actor） | 检验申请、标本与结构化报告；胸片、胸部 CT 平扫阅片和乳腺切片病理会诊 |
| 住院 | 登记员、病区护士、住院医生、病案人员 | 住院证、登记入科、床位、长期与临时医嘱、校对执行、发药给药、转科、手术、出院结算清床、病案首页审核归档 |
| 收费与医保 | 收费员 | 费用预览、成功／拒绝／结果未知三种支付结果、退款，以及使用合成参数的门诊与住院医保待遇模拟 |
| DRG | 住院医生、病案人员、医保办 | 按[运行时 DRG 规则启用](deployment.md#运行时-drg-规则启用)配置后，按 CHS-DRG 3.0 预分组和费用推演，归档时冻结分组，医保办以合成支付参数模拟核定；PCI 住院后台跟进与术后核查 |

业务流程、状态机和每条线的限制见[临床业务流程](architecture/clinical-workflows.md)；固定 PCI 病例的完整跨岗位演示见 [PCI 黄金病例演示](pci-demo.md)。

## 三种使用入口

三种入口共用同一个业务内核。区别只在于由谁操作，以及最终由谁对正式业务动作负责。

| 入口 | 谁在使用 | 正式业务动作由谁提交 |
| --- | --- | --- |
| standalone Web | 人类岗位直接在浏览器中操作 | 登录的人类 |
| DSH React Surface | 人类与 DSH 原生 Agent 在同一页面协作；Agent 读取页面、导航、填写草稿并准备审阅 | 登录的人类在 ClinMesh 原生审阅框中确认 |
| `clinmesh` CLI | 运维人员，或由 runner 注入单岗位短期授权的任务 Agent | CLI 调用者；Agent 只能执行其 Grant allowlist 中的 operation |

## 整体架构

ClinMesh 是运行在单个 Node.js 进程中的 TypeScript 模块化单体。Hono 同时提供 Web 静态资源、认证、业务 API 和 FHIR API；所有业务状态持久化在一个 file-backed SQLite 文件中。

```text
standalone Web ─┐
DSH Surface ────┼── /api/his/v1 · /api/sim/v1 · /api/agent/v1 · /fhir/R5 ──┐
clinmesh CLI ───┘                                                          │
                                                                           v
                                                         apps/server（Hono，单进程）
                                                                           │
                              身份解析（IdentityService → 受信 Actor context）
                                                                           │
                              Query／Command handler（共享状态机与业务规则）
                                                                           │
                              CommandExecutor：事务、幂等、expected version、
                              审计、Action Trace、outbox 原子提交
                                                                           │
                     ┌──────────────────────┬──────────────────────────────┤
                     v                      v                              v
             FHIR Resource Store      HIS 领域表                 持久 outbox → LIS／支付模拟器
                     └──────── operational SQLite ────────┘

        Reference SQLite（全国疾病、药品、检验目录；全局只读，独立于业务库）
```

理解这套架构的五个关键原则：

1. **多种 adapter，一个业务内核。** Web、DSH Surface 和 CLI 最终调用相同的 Query 与 Command handler。HTTP 路由、页面 Tools 和 CLI 都不复制状态机，也不直接写库。详见[多种 adapter、一个业务内核](architecture/system.md#32-多种-adapter一个业务内核)。
2. **标准接口与业务命令分层。** FHIR R5 只负责标准资源的读取、历史和白名单搜索，并且只声明实际实现的能力；挂号、签发、发药、支付等业务动作走显式 Command。详见 [FHIR 与 Command 合同](architecture/fhir-and-commands.md)。
3. **每类数据只有一个权威来源。** 资源能力注册表为每类数据声明所有权：`fhir-native` 以 FHIR JSON 为权威，`domain-native` 以领域表为权威并生成只读 FHIR 投影，`simulation-private` 只对仿真运行时可见。禁止同一事实被两边双向修改。详见[权威数据所有权](architecture/system.md#33-权威数据所有权)。
4. **每次写入都可恢复、可追溯。** Command 要求幂等键，修改既有事实还要求 expected version；同一事务内写入业务事实、审计、Action Trace 和 outbox。客户端遇到结果未知时按原幂等键查询 receipt，而不是直接重发。详见[存储与事务](architecture/storage.md)和[安全与可靠性](architecture/security-and-reliability.md)。
5. **仿真是一等领域。** Workspace／Epoch 隔离每次运行，虚拟时钟和不可变的 Synthetic Case Instance 让每次重放面对同一病例；隐藏的 Case Truth 不进入普通 HIS、FHIR 或岗位 Agent。详见[仿真、病例与素材](architecture/simulation.md)。

首期只交付 Web 与 SQLite 单实例，不支持多实例或远程数据库；运行与部署取舍见 [Web Demo 运行与部署架构](demo-architecture.md)。

## Agent 集成设计

Agent 是 ClinMesh 的一等用户，但不拥有第二套业务内核。两条 Agent 路径共享同一组约束：窄 schema、受信 context、幂等键、预期版本和完整审计，并且都不提供任意 URL、SQL、FHIR Bundle 或任意 method/path/body 写工具。

```text
交互式 Agent（DSH 原生 Session）
  页面提交 Page Context ─> Server 重新解析身份与资源版本，签发短期 context
  按当前岗位、页面和诊疗栏目动态发布窄 Tools（query / ui / draft / preview / proposal）
  proposal ─> ClinMesh 原生审阅框 ─> 人类批准 ─> 既有 Command
  审阅关联 Tool call、proposal、review、Command receipt、Audit 和 Trace

任务 Agent（clinmesh CLI）
  管理员签发 Capability Grant：单一岗位、单一 Scenario Run、显式 operation allowlist、真实过期时间
  CLI 命令树由 Operation Catalog 生成 ─> Agent API ─> 同一 Query／Command
  写入必须带幂等键；结果未知时用原 operation ID 与原 key 查询 receipt
```

- **交互式 Agent** 运行在 DSH 中，DSH 拥有模型 Session 和 transcript。ClinMesh 只发布当前岗位和页面允许的 Tools；页面范围、资源版本或会话变化都会撤下旧 Tools 并关闭未决定的审阅。正式挂号、临床、支付和药房动作的最终 Actor 始终是点击审阅框的登录人类。详见 [Agent 接入与能力边界](architecture/agent-integration.md)，实际用法见 [Agent 操作与反馈](agent-capabilities.md)。
- **任务 Agent** 通过 CLI 行动，只能使用 Grant 中的单一岗位；跨岗位流程由 runner 签发多个 Grant，不能在一个 token 内切换岗位。根目录 [`skills/`](../skills) 的运行时 Skills 按岗位说明意图路由和恢复方法，命令示例由测试保证与真实 Catalog 一致。详见 [Agent CLI 与 Operation Catalog](architecture/agent-integration.md#77-agent-cli-与-operation-catalog)。
- **后台住院跟进** 是独立于页面的持久任务：住院医生主动开启后，任务每次工作前重新验证授权，失权或归档即停止新分析，模型用量按本次住院如实计量。详见[住院后台规则跟进](architecture/clinical-workflows.md#住院后台规则跟进)。

病历、备注、术语和工具结果都视为不可信数据，不能改变 Tool 目录、岗位权限或 Command 状态机；Agent 结果不包含 prompt、密钥、reasoning 或仿真私有事实。

## 核心流程

本节从三个角度串起系统：患者在医院中如何流转、一次写入在系统内如何处理、一项需求如何从提出走到合并。

### 医院业务流程

每一步由对应岗位在自己的工作台完成，岗位之间通过持久的业务事实交接，而不是共享页面状态。

**普通门诊**：一个 Encounter 贯穿挂号到复诊；医生完诊与发药完成本次场景是两件独立的事。

```text
管理员   生成合成患者 → 开始病例（固定患者档案与隐藏 Case Truth）
挂号员   挂号：同时创建 Registration、Encounter、候诊 Task、Account 和挂号费用
分诊护士 录入生命体征，送入医生候诊
门诊医生 问诊 → 首诊草稿 → 开检验申请
收费员   检验费用预览 → 支付（成功／拒绝／结果未知）
LIS      经持久 outbox 受理、执行并签发结构化报告
门诊医生 复诊 → 确认诊断 → 开具处方 → 签署结构化病历 → Encounter 完诊
收费员   药品费用支付
药师     部分或完整发药，扣减库存；全部处方行完成后 Scenario Run 结束
```

**住院**：出院、财务结算、清床和病案归档是四个不同动作，DRG 分组在归档时冻结。

```text
门诊医生 开住院证
登记员   登记入院（直接入院／门诊转收／转院），收取预交金
病区护士 接诊分床
住院医生 确认诊断，开长期／临时医嘱 → 病区护士校对 → 发药、给药、执行，逐项记费
         检查检验送检与报告；需要时转科（医生申请 → 原病区交接 → 目标病区接收）
         手术：术前计划与耗材建议 → 术中逐笔登记实际使用 → 完成手术
住院医生 开出院医嘱 → 病区护士办理出区
收费员   出院结算 → 清床
住院医生 提交病案首页 → 病案人员审核归档，同时冻结 DRG 分组与医院支付预估
医保办   读取冻结分组，预览并确认模拟核定
```

门诊与住院的状态机、门禁与每条线的限制见[临床业务流程](architecture/clinical-workflows.md)；按岗位实际操作一遍，可跟随 [PCI 黄金病例演示](pci-demo.md)。

### 系统内部处理流程

所有入口发起的业务写入都走同一条 Command 路径，正确性由数据库事务和约束保证，而不是由调用方编排。

```text
Web / DSH Surface / CLI
  → 解析受信身份与岗位
  → 共享 Command：一个短事务内提交业务事实、审计、Action Trace 和 outbox
  → 事务外的 dispatcher 处理 outbox，调用 LIS／支付模拟器并回写结果
```

DSH 页面 Agent 的写入在这条路径前多一道人工审阅：人类批准后，浏览器调用同一个 Command。事务步骤、幂等与结果未知的恢复见 [SQLite 事务](architecture/storage.md#96-sqlite-事务)与 [Outbox](architecture/storage.md#97-outbox)，审阅语义见[人工审阅语义](architecture/agent-integration.md#75-人工审阅语义)。

### 开发协作流程

ClinMesh 默认由主 Agent 与开发者协作推进开发：先把需求说清，再连续实施，最后通过 PR 合入 `main`。

```text
澄清需求   目标、范围、验收条件、设计取舍和验证方式；现成事实由 Agent 查证
  ↓
记录需求   非平凡需求在 docs/spec/ 维护唯一正式版本（draft → approved → implemented）
           GitHub Issue 只追踪执行并引用该规格；需要时拆成可独立验收的切片
  ↓
实施       独立工作分支；可并行的切片使用仓库外 worktree，由主 Agent 集成
           行为变化测试先行；复杂状态变化只进共享 Command 模块
  ↓
同步文档   同一 diff 更新受影响的合同文档；非平凡架构、流程、协议或测试策略新增 Agent Note
  ↓
验证       先跑覆盖变更的最小检查；跨包接口、构建或发布路径变化再跑 pnpm check
           UI 变化用 Playwright 从真实入口验证
  ↓
审查       code-review：Standards 与 Spec 双轴并行审查同一份完整快照，修复 findings
  ↓
交付       简体中文 Conventional Commit → push 工作分支 → PR（仓库模板，附真实验证证据）
  ↓
合并收尾   合入 main 后同步本地 main，清理已合并的本地分支；可复用的坑写入工程记忆
```

每一步的授权边界以对应规则为准：哪些外部写入需要用户确认见[实施与交付](agent-development.md#实施与交付)，提交与 PR 格式见[消息与提交规范](agent-development.md#消息与提交规范)，规格状态见[需求规格](spec/README.md)，检查选择见[测试策略](testing.md)。

## 代码地图

仓库是 pnpm workspace + Turborepo 的 TypeScript monorepo。

| 路径 | 职责 |
| --- | --- |
| `apps/server` | Hono 后端：HTTP／FHIR adapter、应用服务、Command、SQLite 迁移与 Web 静态资源入口 |
| `apps/web` | Vite + React 岗位工作台，同时作为 DSH Surface 的应用本体 |
| `apps/dsh-web` | DSH Host 代理、execution proof 与 React Surface adapter |
| `apps/cli` | `clinmesh` CLI、human profile 与 Agent task runtime |
| `apps/desktop`、`apps/mobile` | Electron 与 Expo 工程壳，首期不承载产品行为 |
| `apps/docs` | VitePress 文档站配置和公开页面清单 |
| `packages/contracts` | Zod schema、DTO、HIS Operation Catalog 与 Agent Tool 目录 |
| `packages/core` | 无平台依赖的领域纯函数和客户端规则 |
| `packages/ui`、`packages/views` | Web／Desktop 共用的视觉 primitives，以及 Desktop 工程壳视图 |
| `skills/` | 项目运行后供 Agent 使用的 `clinmesh-*` 运行时 Skills |
| `docs/` | 架构合同、规格、Agent Notes、测试策略、工程记忆与研究 |

包之间的依赖方向是 `contracts -> core -> ui/views`：`contracts` 和 `core` 不读取 DOM、存储、Electron 或环境变量，Mobile 只复用协议、类型和纯函数。详见[跨端前端架构](frontend-architecture.md)。前端状态分工固定：TanStack Query 拥有服务端状态，Zustand 只保存客户端视图状态。

## 第一天上手

1. 按[部署指南](deployment.md)初始化子模块、安装依赖并运行 `pnpm dev:server`，用合成账号登录。
2. 以管理员生成一个合成患者并开始病例，再依次切换挂号员、分诊护士、门诊医生、收费员和药师，走完一次门诊闭环。
3. 浏览[领域词汇](../CONTEXT.md)，熟悉 Workspace、Epoch、Synthetic Case、Encounter、Command 等统一术语。
4. 运行 `pnpm clinmesh operations list`，离线查看 Agent 可用的全部 operation。

## 按方向继续阅读

| 你要做的事 | 先读 |
| --- | --- |
| 任何业务或接口修改 | [系统架构导航](architecture.md)、[领域词汇](../CONTEXT.md) |
| 后端业务流程 | [临床业务流程](architecture/clinical-workflows.md)、[FHIR 与 Command 合同](architecture/fhir-and-commands.md)、[存储与事务](architecture/storage.md) |
| 前端界面 | [跨端前端架构](frontend-architecture.md)、[临床 UI 设计合同](ui/design.md) |
| Agent 能力 | [Agent 接入与能力边界](architecture/agent-integration.md)、[Agent 操作与反馈](agent-capabilities.md) |
| 病例、仿真与 DRG | [仿真、病例与素材](architecture/simulation.md)、[DRG 条件分组](architecture/drg-grouping.md) |
| 参与开发与交付 | [Agent 工程开发](agent-development.md)、[测试策略](testing.md)、[文档规则](AGENTS.md) |
| 需求与决策背景 | [需求规格](spec/README.md)、[Agent Notes](decisions/README.md) |
