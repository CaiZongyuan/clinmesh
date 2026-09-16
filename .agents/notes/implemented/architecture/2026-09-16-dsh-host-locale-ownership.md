# Agent Note: DSH 统一管理 Surface 语言

Status: implemented

## Problem

DSH 品牌入口读取宿主语言，ClinMesh 工作台读取本地偏好，医院导航又优先采用工作台语言，导致同一界面可能混用中英文。任务合同见 [issue #105](https://github.com/CaiZongyuan/clinmesh/issues/105)。[宿主主题归属](2026-09-15-dsh-host-theme-ownership.md)确定的 adapter 边界同样适用于语言；本决策接管语言选择，保留字号及主题合同。

## Decision

DSH 拥有 Surface 生效语言，ClinMesh 拥有业务文案。Client adapter 通过宿主 locale service 读取并订阅语言，共用一个规范化函数为品牌、医院导航和 Web runtime 提供受支持语言。Web 应用在渲染时派生生效语言，偏好更新仍作用于本地保存值，避免修改字号时把宿主语言写入独立 Web 偏好。错误边界直接接收宿主语言，因此应用子树失败后仍能同步。

完整产品合同由[系统架构](../../../../docs/architecture.md#71-surface-与-host-边界)拥有。Surface 设置显示语言由 DSH 管理，独立 Web 继续提供语言选择。语言变化不重建 Router、QueryClient 或表单组件。

人工确认请求保留业务事实与审批状态，只将可翻译的显示字段按当前语言解析。切换语言不重新创建请求、不结算审批，也不修改 Command 输入；患者标识、金额和待确认的项目数仍绑定请求发起时的事实。

## Alternatives considered

**同步写回本地偏好。** 会覆盖独立 Web 的选择，并引入宿主与本地两个可写来源。

**把翻译字典迁入宿主。** 语言选择的统一不要求翻译资源共用；迁移会使独立 Web 依赖 DSH 翻译运行时。

**只在挂载时读取宿主语言。** 无法更新已打开及隐藏保留的工作台，也无法保持宿主导航一致。

## Consequences

DSH locale API 的适配留在 client adapter。新增语言需要扩展 ClinMesh 文案及规范化映射，不能仅接受任意宿主标识。UI 翻译不改写患者档案、临床记录或参考目录内容。

WebApp 与 adapter 集成测试覆盖优先级、加载登录错误状态、弹窗与草稿保留、本地偏好隔离、隐藏订阅和卸载清理。真实 DSH 验收覆盖宿主切换、导航、设置、浮层与全屏往返。
