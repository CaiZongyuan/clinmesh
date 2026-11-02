# dsh-our-free-model 项目解读

核验日期：2026-10-26。源码固定为 [`a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681`][commit]，根包版本 `2.7.1`。研究范围为 README、宿主接入、模型传输、账号渠道、独立入口、许可与发布元信息；仅静态阅读，没有安装插件、执行外部仓库代码、登录账号、解密 EAC 材料或调用真实模型。文中的模型名称和能力均来自项目或上游声明，没有独立确认实际底层模型身份。本文保存外部研究证据，不表示 ClinMesh 已接入、通过兼容验证或获得实施授权。

核验时 `v2.7.1` 标签指向 [`f449bbfc46c461e6791cbf175d834ec2c5d38f12`][release-commit]，与本文主干快照不同；相同包版本号不表示源码或发布附件的字节相同。以下实现结论针对固定主干快照，未独立检查发布附件的内容。

## 定位与用途

它是把多种模型来源接入 DSH 和本地客户端的模型接入层，已扩展为包含账号管理、协议网关、路由、用量面板和独立桌面入口的模型工作台。它不训练模型、不提供本机模型权重，也不拥有匿名免费渠道的持续供给权。根包提供 DSH Host 入口 `index.js` 与浏览器入口 `client.js`；`packages/standalone` 提供不依赖 DSH 的服务，另有 Windows 桌面打包路径。[包入口][package]、[独立服务说明][standalone]、[打包说明][packaging]。

“免费模型”是部分渠道的服务政策，不能概括整个项目：匿名、协付、个人账号免费额度、自带 Key 和本机模型有不同的认证、费用与数据边界。

| 模型来源 | 实际工作方式 | 用户需要提供什么 | 主要边界 |
| --- | --- | --- | --- |
| OpenCode 匿名车道 | 请求 `opencode.ai/inference/v1/*`，使用公开 `Bearer public`；按模型选 Chat、Responses 或 Messages 协议 | 不需要个人账号或个人 Key | 模拟官方 CLI 的 UA、会话和工具声明以满足免费层指纹检查；可受地区、限流和上游改动影响 |
| Kilo 免费池 | 请求 `api.kilo.ai/api/gateway`，从清单选择 `isFree: true` 模型 | 不需要账号或 Key | 非免费模型不属于该免密入口；项目转引的上游说明允许记录提示词 |
| EAC 协付车道 | 使用随包密封材料连接维护者配置的中继或签名网关 | 通常需要 GitHub 登录并满足 star 校验 | 依赖维护者资源、网关策略及授权，不属于匿名车道 |
| 十个账号渠道 | 集成供应商登录、账号池、额度领取、轮换和本地网关 | 登录自己的对应供应商账号 | 额度、账号可用性与使用条款由供应商决定 |
| 聚合 / BYOK | 按提供商注册表，以用户配置的 Key、端点及协议发送请求 | 自己的 API Key；本机服务可免 Key | 注册表列出不等于当前认证方式都能驱动，也不等于免费 |
| 个人订阅接入 | 按 Codex、Claude、Gemini 的凭据形态接入对应供应商端点 | 自己的账号凭据及可用额度 | 与匿名免费池独立，订阅授权与额度由供应商决定 |
| Magpie 工作台 | 启动受管侧进程，将其模型合入同一目录与运行时 | 按对应入口配置 | 引入平台二进制及额外供应链，已超出早期“两个脚本”的插件形态 |

来源：[OpenCode 传输][upstream]、[Kilo 传输][kilo]、[Kilo 清单过滤][catalog]、[EAC 凭据模型][vault]、[账号包出处][channel-notice]、[聚合认证][aggregate]、[个人订阅端点与凭据][subscriptions]、[Magpie 接入][magpie-entry]。

## 与 DSH、外部客户端的关系

DSH 负责 Agent 会话、工具执行和宿主服务；本项目向其 `llm` 注册模型 adapter。`listModels`、`resolveModel`、`prepareCall` 将目录、模型能力和调用准备集中在 adapter，传输层负责协议形状、工具调用、思考预算、错误和流式响应的适配。它利用宿主扩展能力挂载，不需要修改 DSH 内核。[宿主注册][host-register]、[模型 adapter][adapter]。

调用关系可按下面的顺序理解：

```text
DSH Agent 会话 ─────────────────────┐
                                  ├─ 共享模型 adapter / runtime ─ 各模型渠道
外部客户端 ─ 本机兼容 API 网关 ─────┘
```

本机网关支持 Chat Completions、Responses 和 Anthropic Messages 等入口，所以用途不限于 DSH 自身的模型选择器；其他客户端也可配置本地 Base URL 和插件签发的 API Key。网关和 DSH 共用 adapter，有助于减少两条调用路径各自实现一套模型逻辑；协议兼容仍需按客户端和模型验证，接口存在不能证明所有工具语义与特性均兼容。[共享 completion][completion]、[网关路径][forward]。

值得借鉴的实现包括多来源目录归一、按模型选协议、SSE 形状识别、取消和超时处理、用量统计，以及具名降级链。自动切换模型会改变实际处理请求的供应商、模型能力和用量归属，依赖精确模型身份的业务应显式约束路由。[README 功能说明][readme]。

## “免费、不限量、零依赖”应怎样理解

1. **“不限量”不代表无限吞吐或稳定保障。** README 的已知边界将它解释为不充值、不按 token 计费、没有套餐；同一处明确承认按 session 限流会返回 `429`，免责声明也说明免费额度可以变化或下线。源码对地区与额度错误有专门处理，不能据首页宣传推断可用于持续批量负载。[已知边界][limits]、[免责声明][disclaimer]。
2. **免登录只适用于匿名渠道。** 账号渠道需要登录；EAC 有自己的 GitHub 授权；聚合提供商通常需要 Key。因此不能把“装上即可、完全免账号”推广到全部模型。[渠道说明][channel-notice]、[EAC 授权][eac-auth]、[聚合认证][aggregate]。
3. **OpenCode 适配依赖上游客户端形状。** `upstream.js` 固定官方风格 UA、构造会话头，并补入要求的 `read` / `shell` 工具声明、处理冲突重命名。这是源码事实，说明它并非只转发一个稳定的公开标准 API；源码注释已记录多次上游形状变化。这里不据此推断供应商是否授权该用法，也不保证未来可用。[指纹处理][fingerprint]。
4. **“零依赖、无构建”应限定入口。** 用户安装已打包插件可以不自行构建；完整项目仍有 DSH peer dependencies、内联 `undici` 的账号包、WASM、Magpie 二进制和独立前端构建流程。不能据徽章判断整个工程没有依赖或供应链。[包配置][package]、[账号包构建][channel-notice]、[Magpie 出处][magpie-notice]。
5. **可用性不是已替用户实测。** 当前运行时已关闭自动生成式探测，显式探测动作才发送该类请求；“清单刷新”“读取统计”与“真实模型可达/质量验证”是不同证据。主干、README 和发布说明不总同步，应以当前实现为准。[运行时探测策略][runtime]。

## 数据、安全与信任边界

本机保留用量数据，不表示推理内容留在本机。所选渠道仍收到 prompt、工具结果以及支持的图片输入。匿名 OpenCode 与 Kilo 直接访问相应网关；EAC 经过其配置的中继；账号渠道访问各供应商端点；BYOK 发往配置的提供商。Kilo 记录提示词的说法来自本项目对上游模型卡的转引，本次没有向真实模型接口求证。[来源披露与隐私说明][disclaimer]、[Kilo 代码说明][kilo]。

可以看到实际安全措施：本地 Key 使用随机数生成，比较采用 `timingSafeEqual`；本机监听限制回环地址；LAN 功能需单独开启，使用独立 Key 和路径白名单；插件管理接口复用宿主准入或结构化同源围栏；JSON 状态经临时文件原子替换，并设置 `0600`。这些是已阅读的机制，不能替代全仓安全审计或 Windows 权限实测。[转发鉴权][forward-auth]、[信任围栏][trust]、[状态持久化][store]。

应用内更新不只比较下载哈希：源码固定 Ed25519 验签公钥，拒绝未签名或验签失败的清单，再按文件验证 SHA-256，并实现 staging、备份和回滚。它保护发布完整性，仍要求信任发布者及其签名密钥；不等于下载内容经过独立安全认证。[更新实现][updater]。

EAC 的密封机制需要准确理解：AES-256-GCM 密文、掩码分片与派生代码一起分发，客户端运行时可还原直连凭据或共享签名材料；这主要减少明文暴露，不能等同于服务端独占秘密。源码同时提供真正的服务端闸门：签名网关可以保存上游 Key，并验证用户令牌、复查 GitHub star、吊销授权。本次没有解密材料或验证实际部署配置。[密封实现][vault]、[EAC 用户令牌][eac-user]、[服务端授权][github-auth]。

README 中三处表述不能作为全项目保证：

| 表述 | 当前证据与正确边界 |
| --- | --- |
| “没有号池、没有中转、上表即全部出网目标” | 当前明确集成账号池、EAC 中继和 BYOK，最多适用于所讨论的匿名车道，不能覆盖完整产品 |
| “本仓库不含任何硬编码凭据” | 本机转发 Key 确实运行时生成；EAC 另有随包密封的共享认证材料，应分别描述 |
| “EAC 桌面端专属” | 当前 `detectSealedHost` 同样接受内核声明的 `web` / `web-desktop`；独立服务还有自己的 EAC 入口 |

来源：[README 全部出网目标表述][disclaimer]、[账号包实际挂载][channels]、[密封宿主判断与凭据][vault]、[独立 EAC][standalone-eac]。

## 成熟度、许可与采用建议

核验时根包为 `2.7.1`，GitHub 最新发布是 [`v2.7.1`][release]。该发布含插件 tarball 和 Windows x64 Tauri 安装包，Windows 安装包发布说明标注未作 Authenticode 签名。README 的独立服务章节仍说“安装制品与 Release 尚未发布”，应区分通用独立服务源码入口与已经出现的 Windows 桌面制品，不能概括为整个项目没有独立发布。[独立入口][standalone]、[打包合同][packaging]、[发布附件][release]。

当前受管 Magpie 引擎清单仅含 `win32-x64` 二进制；有独立 Node 服务入口不表示所有平台拥有同等完整功能。README 还明确警告 npm 上同名包不是本仓库发布的版本，安装来源应以官方仓库的发布附件或可信源码为准。[引擎清单][magpie-engine]、[安装警告][install-warning]。

项目包含离线测试、宿主测试、独立服务、打包与协议测试入口；主干对应 GitHub 工作流成功、发布说明自述离线套件通过，只能算上游提供的维护证据。本次未运行这些检查，也未验证所有宣称支持的模型、地区、供应商、平台及更新回滚路径。[测试脚本][package]、[工作流][actions]。

主项目采用 MIT；账号包保留 Jet 的 MIT 许可及固定吸收提交，运行时加载的是打包后的 `pack.js` 与随包 WASM；Magpie 标明上游固定提交、MIT 以及 Go 依赖 notices。研究确认了出处记录存在，没有从原始上游独立重建 `pack.js`、WASM 或 Magpie 来证明字节对应。复制代码或重新分发时应保留各自许可与 notice；MIT 不授予模型额度、供应商账号使用权或违反上游服务条款的权利。[主许可][license]、[账号包出处][channel-notice]、[Magpie 出处][magpie-notice]。

对个人学习、匿名模型试用、非敏感原型和合成数据演示，它提供了方便的模型入口及协议适配参考。对需要稳定模型身份、可追踪用量、固定数据去向和可靠服务保障的业务，应逐渠道评估，把匿名免费源视为可变外部依赖。

对 ClinMesh，它适合作为 DSH 模型供应层的候选，不构成另一个业务 Agent 或 HIS 集成层。ClinMesh 原生 DSH session 由宿主拥有模型，服务端模型请求通过本地桥接调用宿主；增加供应层理论上可以复用这条边界。但工具调用、结构化输出、模型标识、计量、超时和恢复语义仍需以合成数据分别验证，不能据本项目的兼容 API 宣称已经兼容。ClinMesh 当前合同见[Agent 集成](../architecture/agent-integration.md)，本文没有修改该合同。

## 来源

[commit]: https://github.com/Ebony-Vinyl/dsh-our-free-model/commit/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681
[release-commit]: https://github.com/Ebony-Vinyl/dsh-our-free-model/commit/f449bbfc46c461e6791cbf175d834ec2c5d38f12
[readme]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/README.md
[package]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/package.json#L1-L79
[standalone]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/packages/standalone/README.md#L1-L41
[packaging]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/PACKAGING.md#L26-L58
[upstream]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/upstream.js#L308-L350
[kilo]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/kilo.js#L1-L88
[catalog]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/catalog.js#L498-L500
[vault]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/vault.js#L73-L164
[aggregate]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/aggregate.js#L264-L310
[subscriptions]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/subscriptions.js#L14-L31
[magpie-entry]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/index.js#L415-L434
[host-register]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/index.js#L431-L454
[adapter]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/adapter.js#L48-L161
[completion]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/core/completion.js#L9-L65
[forward]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/forward.js#L484-L490
[limits]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/README.md#L605-L619
[disclaimer]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/README.md#L692-L742
[fingerprint]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/upstream.js#L494-L565
[runtime]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/core/runtime.js#L140-L180
[forward-auth]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/forward.js#L101-L117
[trust]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/trust.js#L77-L158
[store]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/store.js#L100-L111
[updater]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/updater.js#L397-L433
[eac-user]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/src/eac-user.js#L1-L28
[github-auth]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/worker/auth-github.mjs#L1-L32
[eac-auth]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/README.md#L672-L690
[channels]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/index.js#L1024-L1058
[standalone-eac]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/packages/standalone/eac.mjs#L1-L43
[release]: https://github.com/Ebony-Vinyl/dsh-our-free-model/releases/tag/v2.7.1
[actions]: https://github.com/Ebony-Vinyl/dsh-our-free-model/actions
[license]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/LICENSE
[channel-notice]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/vendor/channel-pack/NOTICE.md#L1-L45
[magpie-notice]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/vendor/magpie/NOTICE.md#L1-L12
[magpie-engine]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/vendor/magpie/engine.json
[install-warning]: https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/a553cc2e7bf4b511d57b7f6dc4e7b2a9723f7681/README.md#L119-L131
