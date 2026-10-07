# DSH 医院业务 Agent Harness

Status: implemented

实施跟踪：[GitHub Issue #156](https://github.com/CaiZongyuan/clinmesh/issues/156)。

## 问题与目标

DSH Web 的医院操作会话使用通用编码 preset，能够读取源码、运行 Shell 和猜测数据库结构；业务工具又要求模型填写短期 Page Context ID，页面续签或加载状态变化会在模型生成期间更换该 ID，导致合法意图在 browser Tool 参数校验阶段失败。医院业务会话需要独立的身份与工具装配，并在连续问诊时保持页面绑定的一致性。

## 范围

ClinMesh DSH Web bundle 提供 `clinmesh-assistant` 业务 preset，并设为部署默认；保留上游 `standard` 供开发排障，尊重用户已保存的默认 preset 选择。业务 preset 拥有医院助手身份、必要的用户澄清工具和会话压缩能力，页面仍按当前岗位、患者和栏目发布既有 `clinmesh_*` Tools。

模型调用携带稳定的 `scopeKey` 和语义页面版本。短期 `contextId`、Context token 和 execution proof 由受信执行链管理；Host 只为实际 pending call 签发一次 proof，签名关联真实 DSH Session、Tool、作用域、语义版本及浏览器实际使用的 Context。Server 保留当前 Context、资源、角色、Epoch、防重放和人工审阅校验。

## 用户故事

1. 作为医院工作台用户，我希望新业务会话只使用当前授权工具，以便业务任务不会变成源码或数据库排障。
2. 作为医生，我希望页面续签期间仍能读取病例和继续问诊，以便无需反复修正 Context ID。
3. 作为医生，我希望问诊超时后先核对已保存状态，再重试未完成的患者回复，以便同一问题不被重复发送。

## 验收条件

- [x] 新 preset 可通过 DSH 的真实 Loader 与 preset registry 装配，模型看到医院身份、澄清工具和当前页面的授权业务工具；工具目录不含 Shell、任意文件读写、源码搜索、插件管理或工程指令加载器。
- [x] 部署默认选择新业务 preset，既有 `standard` 声明保留；正在运行的会话不被强制切换。
- [x] 仅 Context ID/TTL 或加载状态更新、页面语义保持一致时，模型此前生成的业务参数可执行，不因 Context ID 的 const 变化失败。
- [x] Session、岗位、患者、栏目、资源版本、页面语义版本或草稿引用变化时，旧调用被拒绝，不产生业务 Effect；proof 不能替换这些绑定。
- [x] pending call 的 proof 只能签发一次，并绑定真实调用身份；调用完成、拒绝、取消或卸载后不能再次签发。
- [x] 问诊工具指引明确区分发送问题与重试患者回复；超时后读取状态，已成功的问诊不自动重放。
- [x] 连续问诊、Context 更新、切换患者、超时恢复和人工拒绝通过相关公开接口及真实 DSH Web 入口回归。

## 设计决定

业务 preset 随 ClinMesh 自有 bundle 声明，不修改上游默认 preset 或生成的宿主安装文件。指令与工具能力分开管理：身份和恢复流程由 preset 与工具描述负责，授权仍由工具与 Server 强制执行。

语义页面版本由 Page Context claim 的 `viewRevision` 和草稿引用确定，不纳入短期 Context ID、过期时间或 `ui.status`。它与既有 scope 一起进入 Host 的 pending call 和签名 proof；签发时才绑定浏览器实际使用的 Context，Server 验证签名语义版本与该 Context 的 claim 一致。此变更不通过替换旧意图的患者或版本来掩盖失败。

## 测试策略

在 DSH preset 的真实装配、Host proof issuer、Web Surface Tool 和 Server Agent HTTP 授权边界进行 TDD。用模拟时间验证续签与一次性 proof；用实际身份与版本负例验证跨 Session、患者、岗位和页面版本不能执行；问诊和审阅复用已有业务合同。浏览器从 DSH 原生入口核对新会话的 preset、实际工具清单和真实 Tool 结果。

完整 diff 涉及跨包 proof 契约与 DSH 部署装配，执行项目要求的类型、静态、测试、构建与文档检查，并进行 Standards/Spec 独立审查。

## 范围外

不更换模型、不微调模型、不重写 DSH 会话 UI、不复制医院状态机、不增加任意 SQL/URL/写入工具，不修改患者 Persona 或隐藏病例事实，不自动迁移正在运行的会话。

## 依赖与风险

DSH、React Surface 和 browser Tool broker 继续使用当前锁定版本。proof wire format 在同一 diff 更新 Host、Web 和 Server，旧产物与新 Server 混用会被拒绝，因此验证必须核对实际加载的宿主产物。用户保存的默认 preset 优先于部署默认；验证使用新建的独立会话，不改写既有会话的 transcript。
