# OpenHIS ITAI Pro 架构与业务研究

## 文档定位

本文是对本地只读参考仓库 `references/openhis-itai-pro` 的源码研究，不是 ClinMesh 的现状规范。它描述 OpenHIS ITAI Pro 在固定版本中表现出的业务语义、应用边界和数据关系，并给出不绑定编程语言、框架、数据库或部署形态的重建模型。

研究对象固定为以下版本：

| 项目 | 值 |
| --- | --- |
| 上游仓库 | `https://github.com/tntlinking-opensource/openhis-itai-pro.git` |
| Commit | `af34ab973eb4550e785df2f669481a597516d4eb` |
| Commit 时间 | `2026-08-15T11:49:23+08:00` |
| Commit 标题 | `2.0.5前端更新` |
| 后端源码根 | `openhis-health-opensource` |
| 前端源码根 | `openhis-pro-ui` |

本文只采用静态源码证据，没有启动参考系统、连接数据库、执行迁移、调用外部平台或运行参考仓库测试。文中的“闭环”表示源码中可以追踪到相互衔接的应用服务、领域状态变化和数据写入，不表示运行时已经通过本文验证。

### 证据等级

| 标记 | 含义 | 可作出的判断 |
| --- | --- | --- |
| 完整源码闭环 | 正向路径、逆向路径、状态门禁和持久化均可在源码中串联 | 可以重建相同业务契约；仍需动态测试验证 |
| 局部实现 | 主路径存在，但适配器、异常补偿、解析器或部分分支不完整 | 只能采用已闭合部分，不应宣称全功能可用 |
| 占位或空实现 | 方法、菜单或端口存在，但返回固定值、NoOp 或 TODO | 只能作为规划痕迹，不能作为能力证据 |
| 静态无法确认 | 需要运行配置、第三方环境、真实数据或端到端行为才能判断 | 重建时必须显式形成待验证项 |

以下路径均相对于 `references/openhis-itai-pro`。源码路径用于定位证据，不表示目标实现必须保留相同目录、类名或技术栈。

## 执行摘要

OpenHIS ITAI Pro 是面向中国医院业务的模块化单体。后端把通用框架、医院核心业务和可选地区或平台集成分开构建，运行时由一个应用进程装配启用的模块。前端是独立的多包 Web 工作区，通过统一应用服务 RPC 访问后端。核心装配关系见 `openhis-health-opensource/pom.xml`、`openhis-health-opensource/whale-health/health-app/pom.xml` 和 `openhis-pro-ui/pnpm-workspace.yaml`。

业务主干由患者、就诊、诊断、医嘱、发放、费用、账户、支付、库存和组织机构组成。门诊形成“建档/匹配患者 → 挂号预结算 → 支付确认 → 接诊 → 诊断与医嘱 → 收费 → 药房发药 → 完诊”的正向链路，并有退号、取消接诊、退费和退药逆向链路。住院形成“入院申请 → 登记 → 入科分床 → 在院医嘱与计费 → 出院执行 → 结算 → 清床离院”的链路，并支持取消登记、转床、换床、结算冲正和出院召回。

接口不是资源式 REST。框架把每个应用服务的公共方法反射注册为 `POST /api/app/{serviceName}/{methodName}`，请求和响应由方法级 DTO 定义。系统大量使用 FHIR R5 风格的资源名、状态枚举和值集，但仓库没有 FHIR REST 路由、`CapabilityStatement` 或 `OperationOutcome`，因此不能把它描述为 FHIR Server。证据见 `openhis-health-opensource/whale-framework/whale-web/src/main/java/com/openhis/whale/web/api/AppServiceControllerRegistrar.java` 及 `openhis-health-opensource/whale-health/health-domain-shared/src/main/java/com/openhis/health/domain/share/enums`。

身份模型是“认证用户 + 当前租户 + 当前医院 + 可选当前科室”。租户和科室来自服务端登录上下文，不信任客户端自行声明的请求头。菜单权限、角色授权和服务端方法授权并未形成全面一致的强制边界：静态扫描中，健康业务应用服务极少使用方法级权限注解。重建时不能把前端菜单隐藏当作服务端授权。

数据层按管理/就诊、临床、财务、药品、工作流/库存、术语/自定义关联、病案/打印和体检分区。多数业务表具有应用生成标识、审计字段、软删除字段和 `tenant_id`；租户读取隔离依赖查询显式添加条件，而不是数据库行级安全。Encounter、部分库存、Booking 号源/预约和少量报表对象使用乐观锁，库存、床位、请求和支付的部分竞争路径使用悲观锁。

从可迁移性看，应保留的是领域状态机、跨岗位交接、逆向流程、事务边界、幂等要求和集成端口；不应照搬的是 Java 包层次、Spring 反射路由、Vue 组件结构、数据库表名前缀或单进程部署方式。任何语言和架构都可以实现本文契约，只要保持命令原子性、状态门禁、数据所有权和一致的授权语义。

## 系统上下文

### 参与者

| 参与者 | 主要职责 | 典型工作区 |
| --- | --- | --- |
| 患者/就诊人 | 提供身份和就诊信息，预约、挂号、支付、接受诊疗 | 患者档案、挂号、预约、收费 |
| 挂号收费员 | 患者匹配、挂号、收费、退号、退费、票据打印 | 门诊挂号、门诊收费、门诊退费 |
| 门诊医生 | 接诊、诊断、开立/撤回医嘱、完诊 | 门诊医生站 |
| 住院处 | 入院登记、账户和预交金处理、取消登记 | 住院登记、住院账户 |
| 病区护士 | 入科、分床、转床、医嘱执行、出院执行、清床 | 住院护士站、床位看板 |
| 住院医生 | 在院诊疗、长期/临时医嘱、出院申请 | 住院医生站 |
| 药师 | 处方审核、配药、发药、退药、追溯码处理 | 门诊/住院药房 |
| 库管员 | 采购入库、出库、请领、调拨、退库、盘点、损益 | 库存与供应链工作区 |
| 医技人员 | 预约、执行检查检验、记录结果 | 医技预约与执行工作区 |
| 体检人员 | 个检/团检登记、分科检查、总检、复查和报告 | 体检工作区 |
| 病案人员 | 病案接收、质控、归档、借阅、医保上传 | 病案管理工作区 |
| 医院管理员 | 机构、岗位、人员、字典、价表、模板和权限配置 | 系统管理与基础数据 |
| 定时任务执行器 | 滚费、逾期扫描、库存备份 | 后台任务，无交互页面 |
| 外部平台 | 医保、电子处方、电子票据、支付、工伤等 | 通过扩展端口交换业务凭证和结果 |

参与者与页面入口可由 `openhis-pro-ui/apps/web-ele/src/router/routes/modules` 和 `openhis-pro-ui/apps/web-ele/src/views` 交叉确认；业务动作以 `openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application` 中的应用服务为准。

### 逻辑上下文图

```text
浏览器用户
    |
    | 认证、选择租户/医院/科室、应用服务调用
    v
Web 前端 ------------------------------------------------------+
    |                                                          |
    v                                                          |
应用服务入口 -> 身份/租户/科室/权限拦截 -> 应用服务事务          |
    |                                      |                   |
    |                                      +-> 领域对象/领域服务|
    |                                      +-> 仓储 -> 业务数据库
    |                                      +-> 事务内领域事件   |
    |                                                          |
    +-> after-commit 集成端口 ---------------------------------+
                        |
                        +-> 医保/电子处方/电子票据/支付/工伤

数据库持久任务 -> 恢复租户上下文 -> 调用指定应用服务方法
```

该图表达逻辑职责，不要求一个进程。原实现的单体装配、拦截器和事务切面见 `openhis-health-opensource/whale-health/health-app/pom.xml`、`openhis-health-opensource/whale-framework/whale-core/src/main/java/com/openhis/whale/core/infrastructure/transaction/AppServiceAspect.java`、`openhis-health-opensource/whale-framework/whale-core/src/main/java/com/openhis/whale/core/infrastructure/multitenancy/TenantInterceptor.java` 和 `openhis-health-opensource/whale-framework/whale-core/src/main/java/com/openhis/whale/core/infrastructure/job/JobScheduler.java`。

### 部署和装配

| 部分 | 原实现 | 技术无关含义 |
| --- | --- | --- |
| Web 客户端 | 独立 Vue monorepo 的 `web-ele` 应用 | 面向医院岗位的浏览器客户端 |
| 应用入口 | `health-app` 装配 framework、health、EMR、Booking、Campus | 一个可组合的业务运行单元 |
| 核心模块 | health 的 shared/domain/application/infrastructure/starter/app | 领域模型、用例编排、适配器和启动装配分离 |
| 可选模块 | CHS、电子处方、电子票据、银联、工伤等 Maven profile | 按地区或客户启用的集成插件 |
| 存储 | 关系数据库迁移脚本和仓储实现 | 事务型业务存储及迁移机制 |
| 后台任务 | Quartz 数据库存储 | 可恢复、带租户上下文的调度执行器 |

装配清单见 `openhis-health-opensource/whale-health/health-app/pom.xml` 和 `openhis-health-opensource/whale-health/health-app/src/main/resources/application.yml`。配置中出现 embedded/remote 模式不代表每个模块都具有完整远程实现；必须逐个以端口和适配器为证据。

## 后端模块地图

### 通用框架

| 模块 | 职责 | 关键证据 |
| --- | --- | --- |
| `whale-core` | 事务、领域事件、审计实体、租户/科室上下文、权限切面、任务调度基础 | `openhis-health-opensource/whale-framework/whale-core` |
| `whale-web` | 应用服务自动注册、统一 Web 入口和请求处理 | `openhis-health-opensource/whale-framework/whale-web` |
| `whale-identity` | 登录、令牌、租户/医院/科室选择和会话上下文 | `openhis-health-opensource/whale-framework/whale-identity` |
| `whale-permission` | 用户直授、角色授权、权限检查 | `openhis-health-opensource/whale-framework/whale-permission` |
| `whale-audit` | 异步记录操作审计日志 | `openhis-health-opensource/whale-framework/whale-audit` |
| 其他 framework 模块 | 字典、文件、消息、组织、配置等通用能力 | `openhis-health-opensource/whale-framework` |

### 健康核心分层

| 层 | 责任 | 允许包含的内容 | 不应包含的内容 |
| --- | --- | --- | --- |
| `health-domain-shared` | 跨领域稳定语义 | 标识、值对象、状态枚举、共享规范 | 页面 DTO、数据库访问、第三方 SDK |
| `health-domain` | 聚合和业务不变量 | 实体、聚合、领域服务、领域事件、仓储端口 | HTTP、页面状态、具体外部平台调用 |
| `health-application` | 用例和岗位工作流 | 应用服务、请求/响应 DTO、跨聚合编排 | UI 渲染、通用传输协议反射 |
| `health-infrastructure` | 技术适配 | 仓储、迁移、集成端口实现、打印和配置 | 新业务状态机的复制实现 |
| `health-starter` | 自动装配 | 模块启用、Bean/组件组合 | 业务规则 |
| `health-app` | 可运行应用 | 依赖选择、启动和环境配置 | 领域实现细节 |

分层依赖可从 `openhis-health-opensource/whale-health/pom.xml` 及各子模块 `pom.xml` 确认。目标实现可以采用模块化单体、服务化或事件驱动部署，但用例层必须仍是业务命令的唯一编排入口，不能让 HTTP、页面和外部回调各自复制状态机。

### 可选业务和集成模块

| 模块 | 能力 | 装配结论 |
| --- | --- | --- |
| `whale-module-emr` | 文书类型、模板、文书、元数据和版本 | 默认核心装配；部分质控接口为占位 |
| `whale-module-booking` | 门诊、医技、床位、体检预约及排班 | 默认通过 bridge 接入 health |
| `whale-module-campus` | 校区/院系、学生/教工档案和公费资格、审批、分摊 | 默认通过 bridge 接入 health |
| `whale-module-chs-jilin` | 吉林医保人员、登记、费用、结算、清算、目录和审核 | 可选；部分解析/目录通知路径局部实现 |
| `whale-module-elep-jilin` | 电子处方上传、查询、撤销和历史 | 可选外部集成 |
| `whale-module-einvoice-boss` | 电子票据开具、冲红、对账和补偿 | 可选外部集成 |
| `whale-module-unionpay-bpc` | 银联订单、支付、查单和退款 | 可选外部集成 |
| `whale-module-work-injury` | 工伤审批、登记、结算和对账 | 可选；真实平台可用性静态无法确认 |

模块目录分别位于 `openhis-health-opensource/whale-module-*`；核心使用的 bridge/NoOp 适配器位于 `openhis-health-opensource/whale-health/health-infrastructure/src/main/java/com/openhis/health/infrastructure/integration`。

## 核心业务对象

### 对象关系

```text
Patient 患者
  +-- PatientIdentifier 身份标识
  +-- Encounter 就诊 --------------------------------+
        +-- Diagnosis 诊断                           |
        +-- Clinical Request 医嘱/申请               |
        |     +-- MedicationRequest 用药请求         |
        |     +-- ServiceRequest 服务请求            |
        +-- Dispense 发放/执行                       |
        |     +-- MedicationDispense 药品发放        |
        +-- ChargeItem 费用明细                      |
        +-- Account 账户                             |
        |     +-- Invoice/Bill 结算单                |
        |     +-- Payment/Reconciliation 支付与核销  |
        +-- Appointment/Slot 预约与号源              |
        +-- Bed/Location 床位与位置                  |
                                                      |
Organization/Tenant/Hospital/Department/Position -----+
Catalog/Terminology/Price/InventoryItem ---------------+
```

关系图是跨表、跨聚合的语义视图，不代表一个统一大聚合。证据分布在 `openhis-health-opensource/whale-health/health-domain/src/main/java/com/openhis/health/domain/administration`、`.../clinical`、`.../financial`、`.../medication` 和 `.../workflow`。

### 对象职责和所有权

| 对象 | 业务身份 | 拥有的关键状态 | 典型引用方 |
| --- | --- | --- | --- |
| 患者 | 接受医疗服务的人 | 人口学信息、证件/院内标识、联系方式 | 预约、就诊、收费、病案、体检 |
| 就诊 | 一次门诊或住院服务上下文 | 类型、状态、医院/科室/医生、时间和床位关系 | 诊断、医嘱、费用、病案 |
| 预约 | 对号源或资源的预占 | 服务、时段、参与者、状态 | 挂号、医技、床位、体检 |
| 诊断 | 医生对就诊作出的临床判断 | 类型、顺序、状态、编码和说明 | 病历、结算、医保、病案 |
| 请求/医嘱 | 对药品、检查、检验、治疗或护理的正式请求 | 草稿、签发、审核、执行和停止状态 | 执行科室、药房、收费 |
| 发放/执行 | 对请求的履行记录 | 准备、进行、完成、拒绝和退回状态 | 药房、护士、库存、费用 |
| 费用明细 | 应计费的最小业务项目 | 计费、待结算、已结算、退款状态 | 账户、结算、医保、票据 |
| 账户 | 就诊相关的财务归集边界 | 应收、预交、结算和余额 | 收费、住院处、清床门禁 |
| 支付 | 一次资金尝试或结果 | 渠道、金额、成功、取消、退款和错误状态 | 挂号、收费、银联、对账 |
| 库存批次 | 某物资在地点和批次维度的可用量 | 数量、锁定、效期、来源和追溯信息 | 入出库、发药、退药、盘点 |
| 床位 | 可分配的住院位置 | 空闲、占用及与就诊的关联 | 入科、转床、出院、清床 |
| 组织和岗位 | 授权与业务数据范围 | 租户、医院、科室、岗位和管辖范围 | 所有岗位工作流 |

名称和状态来自 `health-domain` 与 `health-domain-shared`；每个对象的实际事务边界以其领域服务和应用服务为准，不能仅由外键关系推断。

## 门诊业务流程

### 正向主流程

```text
患者匹配/建档
  -> 选择科室、医生、号源或既有预约
  -> 挂号预结算
       创建计划就诊、账户、费用和支付草稿
  -> 支付挂号费
       确认支付、激活挂号
  -> 门诊医生接诊
       就诊进入进行中
  -> 录入诊断和医嘱草稿
  -> 批量签发医嘱
       形成待收费/待执行工作项
  -> 门诊收费预结算并确认
       费用进入已结算
  -> 药房配药和发药
       发放完成并扣减库存
  -> 医生完诊
       就诊进入已完成/离诊状态
```

#### 1. 挂号准备

挂号页先加载初始化数据、患者候选、科室、医生、可预约号源和既有预约。患者可以从已有档案选择，预约也可以被装载为挂号上下文。代表接口是 `loadRegisterFormInit`、`pagePatientsForSelect`、`listDepartments`、`listPractitioners`、`listBookableSlotHints` 和 `loadAppointmentForRegister`，见 `openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application/outpatient/financial/registration/service/OutpatientRegistrationAppService.java`。

#### 2. 挂号预结算

`preRegisterSettlement` 或 `preRegisterFromAppointment` 先计算挂号费用和支付责任，再创建尚未最终确认的就诊、账户、费用和支付上下文。医保路径可以刷新预结算结果。这个阶段必须可重试，不能因页面重复提交产生两个有效挂号；目标实现应把“计算报价”和“确认支付”作为两个显式命令。

#### 3. 支付确认

`payRegisterFee` 处理支付并确认挂号。成功后，挂号进入医生站队列。查询、当日汇总、票据打印由 `pageClinicRegisters`、`getTodayRegisterSummary` 和 `printRegisterTicket` 提供。支付成功与本地状态提交涉及本地事务及可选支付/医保端口，目标实现必须为外部请求保存幂等键和外部流水号。

#### 4. 接诊

医生工作站按岗位数据范围分页查看患者。`startOutpatientReception` 把已挂号就诊从 `REGISTERED` 推进为 `IN_PROGRESS`；`markOutpatientLeave` 表示患者暂离；`completeOutpatientEncounter` 完诊；`cancelOutpatientReception` 在允许时撤销接诊。证据见 `openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application/outpatient/doctorstation/encountermanage/service/DoctorStationEncounterManageAppService.java`。

#### 5. 诊断和医嘱

医生可以加载目录和执行地点，保存服务申请单，批量保存医嘱草稿，再批量签发或撤回。药品医嘱还具有成组关系。代表接口是 `saveDoctorStationAdviceDraftBatch`、`signDoctorStationAdviceBatch`、`withdrawDoctorStationAdviceBatch` 和 `updateDoctorStationMedicationAdviceGroups`，见 `openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application/outpatient/doctorstation/advice/service/DoctorStationAdviceAppService.java`。

签发是临床草稿与正式请求的边界。目标实现应在签发命令内一次性验证就诊状态、开立人权限、项目有效性、剂量/频次、执行地点、价格和预期版本，并只让签发后的请求进入收费或执行队列。

#### 6. 收费

收费员从待收费队列加载一个就诊的费用明细，可在自费和医保账户之间切换符合条件的项目。`preSettleOutpatientCharges` 产生本次结算预览，`confirmOutpatientChargeSettlement` 才确认结算，之后可以打印票据。银联补收和医保扫码是同一用例的可选渠道分支。证据见 `openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application/outpatient/financial/charge/service/OutpatientChargeAppService.java`。

#### 7. 药房发药

药房从已签发且满足收费门禁的用药请求形成发放工作项，经历配药、复核/准备、发药，最终完成发放并扣减库存批次。发药服务见 `openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application/outpatient/pharmacy/dispense/service/OutpatientPharmacyDispenseAppService.java`；领域不变量见 `openhis-health-opensource/whale-health/health-domain/src/main/java/com/openhis/health/domain/medication/medicationdispense/service/MedicationDispenseDomainService.java`。

### 退号、退费和退药

```text
退号请求
  -> 校验就诊是否已接诊
       已接诊：必须先取消接诊回到 REGISTERED
  -> 校验费用、支付和执行项是否允许撤销
  -> 取消挂号并退款

退费请求
  -> 装载原结算和可退明细
  -> 检查已执行/已发药限制
  -> 按原渠道或允许渠道退款
  -> 保留未退项目或切换其账户归属

退药请求
  -> 从原发放形成独立待退发放行
  -> 药房确认实物和数量
  -> 完成退药并回补对应库存
```

`validateCancelable` 和 `cancelWithRefund` 负责退号前校验及退款，位于挂号应用服务。`verifyRefundableBeforeExecution`、`executeOutpatientBillRefundByPayment` 和原支付渠道查询位于 `openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application/outpatient/financial/refund/service/OutpatientRefundAppService.java`。退药应用服务位于 `openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application/outpatient/pharmacy/returnmedicine/service/OutpatientPharmacyReturnMedicineAppService.java`。

逆向流程不是把原记录改回初始值：退款、退药和冲正都需要保留原交易、逆向交易及其对应关系。重建模型必须支持部分退、重复请求幂等、原渠道不可用、外部成功但本地超时、本地成功但回执丢失等恢复场景。

### 门诊成熟度

门诊挂号、收费、发药及相应逆向路径属于“完整源码闭环但本文未执行验证”。仓库没有覆盖整个跨岗位链路的端到端测试，因此支付渠道、医保平台、发药库存和票据的组合行为仍需要运行环境验证。

## 住院业务流程

### 正向主流程

```text
入院申请 PLANNED
  -> 住院登记 REGISTERED
  -> 病区接收入科并分床 IN_PROGRESS
  -> 在院医嘱、执行、发药、计费、预交金管理
  -> 出院申请/待出院 ON_HOLD
  -> 护士执行出院 PENDING
  -> 住院结算 COMPLETED
  -> 清床离院 DISCHARGED
```

#### 1. 入院登记

住院登记页加载待登记队列和登记上下文，确认患者、住院申请、科室、病区、床位容量、支付责任和账户信息。`submitInpatientRegistration` 创建或确认住院就诊及财务上下文；尚未入科时可通过 `cancelInpatientRegistration` 撤销。医保入院登记有独立撤销分支。证据见 `openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application/inpatient/financial/registration/service/InpatientRegistrationAppService.java`。

#### 2. 入科与床位

护士站床位看板以病区为范围展示床位和患者。首次分床要求就诊处于待入科/已登记状态；转床和换床要求患者已在院。床位操作必须同时维护床位占用、患者当前位置和就诊状态，不能由三个独立接口无事务地更新。入口见 `listBedBoard` 和 `executeBedOperation`：`openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application/inpatient/nursestation/ATDManager/service/NurseStationATDManagerAppService.java`。

#### 3. 在院诊疗

医生开立长期或临时医嘱，护士审核/执行，药房按病区或批次发放药品，费用持续归集到住院账户。滚费任务把按日或按规则产生的费用写入账户。医嘱、发放和费用共享后文状态机；任务绑定见 `openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application/inpatient/nursestation/inpatientbilling/service/NurseStationInpatientBillingAppService.java`。

#### 4. 出院执行

出院前，护士站查询未完成执行项和待发/待退药品。存在未完成长期医嘱、临时医嘱或药品交接时，业务门禁阻止出院。`executeInpatientDischarge` 通过校验后把患者推进到待结算。`listDischargePendingExecutions`、`listDischargePendingMedications` 和 `executeInpatientDischarge` 位于护士站 ATD 管理应用服务。

#### 5. 住院结算

结算员加载费用摘要和明细，执行预结算，再确认结算。`preSettleInpatientCharges` 只计算患者、医保和其他责任方金额；`confirmInpatientSettle` 才提交结算。已结算记录可通过 `reverseInpatientSettle` 冲正，不能直接覆盖。证据见 `openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application/inpatient/financial/settle/service/InpatientSettleAppService.java`。

#### 6. 清床

`clearDischargedBed` 要求就诊已经结算、账户展示余额为零，并且就诊记录与床位记录相互一致。成功后解除占床关系并使就诊进入最终离院态。清床是床位重新可售/可分配的业务命令，不应由页面直接把床位状态改为空闲。

### 逆向和异常流程

| 场景 | 前置条件 | 结果 |
| --- | --- | --- |
| 取消住院登记 | 尚未入科且外部登记允许撤销 | 撤销登记、释放相关预占并保留撤销痕迹 |
| 转床/换床 | 患者在院，源/目标床位和病区规则满足 | 原子变更床位占用和患者位置 |
| 出院召回 | 已结算或已清床，满足召回门禁 | 恢复住院流程所需状态并重新建立必要关系 |
| 结算冲正 | 原结算可撤销，支付/医保允许 | 创建逆向财务记录并恢复待结算状态 |
| 待执行项阻断 | 尚有未完成医嘱、发药或退药 | 保持当前状态，返回可处理的阻断清单 |

出院召回接口 `recallInpatientDischarge` 位于住院结算应用服务；状态转换的领域规则位于 `openhis-health-opensource/whale-health/health-domain/src/main/java/com/openhis/health/domain/administration/encounter/entity/Encounter.java` 和 `.../encounter/service/EncounterDomainService.java`。

### 住院成熟度

住院登记、床位、医嘱、出院、结算、清床和主要逆向路径属于“完整源码闭环但本文未执行验证”。并发集成测试 `openhis-health-opensource/whale-health/health-application/src/test/java/com/openhis/health/application/inpatient/concurrency/SysImp004AtdConcurrencyIntegrationTest.java` 仍含 TODO，因此同时分床、转床、出院和召回的竞争行为不能视为已有充分测试证据。

## 预约与资源排程

Booking 模块把预约对象与可预约资源分开：排班或模板先产生可用时段，门诊、医技、床位或体检预约再占用时段。候补在资源释放时提供补位机会；停诊使未来号源不可用；叫号负责已到场对象的排队顺序。源码位于 `openhis-health-opensource/whale-module-booking/module-booking-domain/src/main/java` 和 `openhis-health-opensource/whale-module-booking/module-booking-application/src/main/java`。

技术无关流程如下：

```text
定义服务与资源
  -> 创建排班模板
  -> 生成具体日期的时段/号源
  -> 查询可预约容量
  -> 创建预约并占用容量
  -> 确认、改约、取消或进入候补
  -> 到场后交接给挂号/医技/体检/床位业务
```

预约与挂号不是同一对象。预约表达未来资源承诺，挂号创建实际门诊就诊和费用上下文；两者通过预约标识交接。目标实现必须使用原子容量扣减或等价并发控制，避免仅在页面查询剩余量后再无条件写入。

## 体检业务流程

体检域覆盖个人体检和团体体检。典型流程是：

```text
维护体检套餐/项目
  -> 个人或团体登记
  -> 生成受检人任务和费用
  -> 收费确认
  -> 分科室签到与检查
  -> 采集各项目结果
  -> 总检汇总、异常判断和建议
  -> 必要时发起复查
  -> 签发并打印体检报告
  -> 更新健康档案
```

应用服务位于 `openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application/peis`，表结构位于 `openhis-health-opensource/whale-health/health-infrastructure/src/main/resources/db/migration/peis/V1__peis_ddl.sql`。源码可追踪登记、收费联动、科室检查、总检、复查和报告产物，但本文没有运行完整团检批次或跨科室流程，因此按“完整源码闭环但本文未执行验证”处理。

## 库存与供应链

### 库存层级

库存按仓库、药房和科室等地点管理，同一品种继续按批号、效期、供应来源和追溯信息区分。`InventoryItem` 表示特定库存维度上的数量；供应请求和供应交付分别表达需求单据与实际出入库履行。领域模型位于 `openhis-health-opensource/whale-health/health-domain/src/main/java/com/openhis/health/domain/workflow/inventoryitem`、`.../supplyrequest` 和 `.../supplydelivery`。

### 单据流程

| 流程 | 业务方向 | 核心步骤 |
| --- | --- | --- |
| 订货/采购 | 医院向供应商提出需求 | 建单 → 审核 → 到货交接 |
| 进货入库 | 外部供应进入医院库存 | 验收 → 确认批次/效期/价格 → 增加库存 |
| 出库/请领 | 仓库向药房或科室供货 | 申请 → 审核 → 拣货 → 发出 → 接收 |
| 调拨 | 库存地点之间转移 | 调拨申请 → 源端扣减 → 在途/交接 → 目标端增加 |
| 退库 | 下级库存退回上级 | 申请 → 验收 → 下级扣减 → 上级增加 |
| 退供应商 | 医院库存退回外部 | 审核 → 出库 → 建立供应商退货凭证 |
| 盘点 | 实物和账面核对 | 冻结范围/生成快照 → 录入实盘 → 审核差异 → 调账 |
| 损益 | 非正常数量调整 | 说明原因 → 审核 → 增减库存 → 审计 |
| 临床发药 | 库存履行用药请求 | 配药 → 发药 → 批次扣减；退药反向回补 |

各岗位用例位于 `openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application/inventory`。多类单据可以从申请、审批追踪到库存批次变化，属于“完整源码闭环但本文未执行验证”。

### 库存不变量

1. 数量变化只能由已接受的业务命令产生，并保留来源单据和行号。
2. 同一库存维度的并发扣减必须锁定或使用条件更新，不能出现负库存或超发。
3. 调拨和退库必须同时表达发送方、接收方和在途/交接状态，不能伪装成两个无关调整。
4. 盘点差异在审核前是提议值，审核后才成为库存交易。
5. 退药应引用原发放和原批次；无法回到原批次时必须记录明确的替代策略。
6. 每次库存变化都应能够回溯到患者业务、供应单据、盘点或损益原因。

原实现对库存部分路径使用悲观锁。目标实现可以使用数据库行锁、序列化事务、版本条件更新或单分区命令队列，只要在并发下保持这些不变量。

## 病案、电子病历、打印与报表

### 病案管理

病案域覆盖病案首页、提交、接收、质控、归档、借阅和医保上传。业务链路为：

```text
临床完诊/出院
  -> 生成或补全病案首页
  -> 临床科室提交
  -> 病案室接收
  -> 质控与退回整改
  -> 归档
  -> 按授权借阅/归还
  -> 按外部要求上传医保
```

应用服务和领域对象位于 `openhis-health-opensource/whale-health/health-application/src/main/java/com/openhis/health/application/mrms` 及 `openhis-health-opensource/whale-health/health-domain/src/main/java/com/openhis/health/domain/mrms`；数据库定义位于 `openhis-health-opensource/whale-health/health-infrastructure/src/main/resources/db/migration/health/V9__mrms_prt_ddl.sql`。

病案提交、接收和归档必须是有操作者、时间和退回原因的状态变化。借阅是对归档病案的临时访问授权，不应改变病案归档所有权。

### 电子病历

EMR 模块管理文书类型、模板、元数据字段、文书实例和版本。临床文书引用患者和就诊，由模板/元数据决定结构，并通过版本保存编辑历史。源码位于 `openhis-health-opensource/whale-module-emr`。

模块中的 `validate` 和部分质量结果接口存在占位实现，因此只能确认文书和模板主干，不能把完整病历质控描述为已实现能力。重建时应把“结构校验”“内容质控”“签名/封存”拆成不同契约，并分别建立动态验收。

### 打印和报表

系统包含费用、发药、耗材、工作量、登记明细和追溯码等报表。打印模板采用草稿和发布版本，使已发布版可供业务打印，同时允许编辑下一版。相关表位于 `V9__mrms_prt_ddl.sql`，应用服务分布在 `health-application` 的报表和打印子域。

报表是从业务事实派生的查询模型，不应拥有业务状态；打印产物必须记录模板版本、生成时间和关联业务标识，避免模板更新后无法解释历史票据。

## 核心状态机

### 就诊状态

| 当前状态 | 允许的主要动作 | 目标状态 | 业务含义 |
| --- | --- | --- | --- |
| `PLANNED` | 确认挂号或住院登记 | `REGISTERED` | 已有计划，尚未实际开始 |
| `REGISTERED` | 分诊或接诊/入科 | `TRIAGED` 或 `IN_PROGRESS` | 已登记，等待临床服务 |
| `TRIAGED` | 接诊 | `IN_PROGRESS` | 已完成分诊 |
| `IN_PROGRESS` | 暂停、待出院或完诊 | `ON_HOLD` 或 `DISCHARGED` | 正在接受服务 |
| `ON_HOLD` | 恢复、进入待结算 | `IN_PROGRESS` 或 `PENDING` | 暂停/待出院上下文 |
| `PENDING` | 完成住院结算 | `COMPLETED` | 已出院执行，等待结算 |
| `COMPLETED` | 清床或出院召回 | `DISCHARGED` 或恢复流程 | 结算完成，可能仍占床 |
| `DISCHARGED` | 特定场景重新接诊/召回 | 受门禁约束的前序状态 | 已离开本次服务 |

门诊只使用该通用状态集的子集，住院使用更完整序列。转换规则见 `openhis-health-opensource/whale-health/health-domain/src/main/java/com/openhis/health/domain/administration/encounter/entity/Encounter.java` 和 `.../encounter/service/EncounterDomainService.java`。状态名相同不代表门诊和住院可执行同一动作，命令必须同时校验就诊类型。

### 请求/医嘱状态

```text
DRAFT -> ACTIVE -> VERIFIED -> COMPLETED
           |          |
           +-> HOLD <-+
           +-> CANCELLED / STOPPED
```

`DRAFT` 是可编辑但未签发；`ACTIVE` 是已签发待审核或执行；`VERIFIED` 表示审核通过；`COMPLETED` 表示履行完成。`HOLD`、`CANCELLED` 和 `STOPPED` 分别表达暂停、未继续生效和已生效后的停止，不能互相替换。状态定义见 `openhis-health-opensource/whale-health/health-domain-shared/src/main/java/com/openhis/health/domain/share/enums/RequestStatus.java`，用药和服务请求规则见 `MedicationRequestDomainService.java` 与 `ServiceRequestDomainService.java`。

### 发放/执行状态

```text
DRAFT -> PREPARATION -> PREPARED -> IN_PROGRESS -> COMPLETED
             |             |
             +-> HOLD / DECLINED
             +-> RETURN_PENDING -> PARTIALLY_RETURNED -> RETURNED
```

实际枚举还包含汇总等业务状态。定义见 `openhis-health-opensource/whale-health/health-domain-shared/src/main/java/com/openhis/health/domain/share/enums/DispenseStatus.java`。“请求已完成”和“发放已完成”是两个不同事实；发放必须引用被履行的请求，退回必须引用原发放。

### 费用状态

```text
DRAFT -> PLANNED -> PENDING_SETTLEMENT -> SETTLED
                                      \-> REFUNDING -> REFUNDED
```

状态定义见 `openhis-health-opensource/whale-health/health-domain-shared/src/main/java/com/openhis/health/domain/share/enums/ChargeItemStatus.java`。费用草稿、已计费、待结算和已结算不能由页面展示状态代替；只有财务命令可以推进。退款保留原费用明细及退款金额，部分退款不能把整条费用直接标为全额已退。

### 支付状态

支付包含草稿、成功、取消、部分退款、全额退款、退款处理中和错误等状态，定义见 `openhis-health-opensource/whale-health/health-domain-shared/src/main/java/com/openhis/health/domain/share/enums/PaymentStatus.java`。支付状态必须与业务结算状态分开：外部支付成功不自动等于本地结算已提交；两者之间需要可恢复的确认或补偿流程。

## 跨模块交接

| 上游 | 交接事实 | 下游 | 下游门禁 |
| --- | --- | --- | --- |
| 预约 | 已确认预约和时段标识 | 门诊挂号 | 预约有效、未取消、容量仍归属该患者 |
| 挂号收费 | 已支付/确认挂号的就诊 | 门诊医生站 | 当前科室/医生数据范围允许，状态可接诊 |
| 医生站 | 已签发请求 | 收费或执行科室 | 请求有效，项目、执行地点和支付规则满足 |
| 门诊收费 | 已结算用药费用 | 门诊药房 | 处方已签发、收费门禁通过、未取消 |
| 住院登记 | 已登记住院就诊 | 病区护士站 | 病区匹配、待入科、床位可用 |
| 医生/护士 | 已完成或已停止医嘱 | 出院执行 | 不再存在阻断性待执行/待发退药任务 |
| 出院执行 | 待结算就诊 | 住院结算 | 费用归集完整、医保/支付上下文可用 |
| 住院结算 | 已结算且余额为零 | 清床 | 床位关系一致、就诊状态允许 |
| 临床完诊/出院 | 完整病历上下文 | 病案管理 | 必填内容和提交条件满足 |
| 发药/耗材执行 | 已确认出库需求 | 库存 | 批次可用、数量充足、并发版本一致 |
| 业务交易 | 已提交本地事实 | 外部平台 | after-commit 调用，支持幂等、查单和补偿 |

这些交接不是 UI 跳转，而是由可持久化事实和状态门禁组成。目标实现即使拆成多个服务，也必须让交接消息可重放，并使消费者按业务标识幂等处理。

## 事务、事件与一致性

### 本地事务

框架默认让 `com.openhis..*AppService.*` 公共方法进入读写事务，见 `openhis-health-opensource/whale-framework/whale-core/src/main/java/com/openhis/whale/core/infrastructure/transaction/AppServiceAspect.java`。因此一个应用服务方法是原实现的主要命令原子边界。目标实现不需要沿用切面，但必须明确每个命令的一致性集合。

典型单事务集合包括：

- 挂号确认、就诊状态、挂号费用和本地支付记录；
- 分床时的就诊位置、源/目标床位占用；
- 签发时的请求状态、行项目和领域事件；
- 发药时的发放记录、库存批次扣减和费用/追溯关联；
- 结算时的费用状态、账单、账户余额和本地支付核销；
- 盘点审核时的差异单和库存调整记录。

### 领域事件

领域事件在事务 `beforeCommit` 同步发布，监听器异常会使业务事务回滚，见 `openhis-health-opensource/whale-framework/whale-core/src/main/java/com/openhis/whale/core/infrastructure/event/DomainEventPublisher.java`。仓库未发现持久化 outbox。这个机制适合同进程一致性反应，不适合直接保证跨进程消息“至少一次”投递。

若目标实现拆分服务，应将跨服务事件写入与业务事务一致提交的 outbox，由独立发布器投递；消费者按事件标识和业务键幂等。不能把原实现的同步内存事件等同于可靠消息总线。

### 外部副作用

外部扩展通常通过 after-commit helper 执行，见 `openhis-health-opensource/whale-health/health-infrastructure/src/main/java/com/openhis/health/infrastructure/integration/noop/IntegrationAfterCommitSupport.java`。这避免外部失败回滚已经提交的本地业务，但也产生“本地成功、外部失败”的状态。目标实现必须持久化待发送、发送中、成功、可重试失败和人工处理状态，并提供按外部流水查单与补偿。

### 审计一致性

实体审计字段由监听器自动填充；操作审计日志异步写入且失败只记录日志，分别见 `openhis-health-opensource/whale-framework/whale-core/src/main/java/com/openhis/whale/core/infrastructure/auditing/AuditingEntityListener.java` 和 `openhis-health-opensource/whale-framework/whale-audit/src/main/java/com/openhis/whale/audit/infrastructure/AuditLogService.java`。因此原操作日志是尽力而为，不与业务事务原子。对处方签发、退款、结算冲正、库存调整、权限变化等高风险动作，目标实现应把最小不可抵赖审计记录与业务状态同事务提交，再异步扩展检索型日志。

### 后台任务

Quartz 使用数据库保存调度定义和执行状态，任务调用时恢复租户上下文。固定源码中可确认三个业务调度入口：病案质控逾期扫描、住院自动滚费和库存备份。持久调度只解决“何时再次执行”，不自动保证业务幂等；每个任务仍要定义业务日期、租户分区、游标/租约、单对象失败隔离、重复执行结果、运行日志和人工重放入口。

## 接口设计

### 传输入口

原实现没有为每个业务对象编写独立 REST Controller。`AppServiceControllerRegistrar` 扫描所有带服务标记、类名以 `AppService` 结尾的运行时对象，并把每个非静态公共方法映射为：

```text
POST /api/app/{serviceName}/{methodName}
```

`serviceName` 通常是删除 `AppService` 后缀并把首字母改成小写的类名。应用配置服务有一个保持前端兼容的别名。未装载的可选模块返回 `MODULE_NOT_AVAILABLE`，普通未知服务或方法返回 `NOT_FOUND`。固定入口证据见 [AppServiceControllerRegistrar][source-app-service-registrar]。

静态源码中有 214 个 `*AppService.java`：framework 15 个、health 核心 137 个、扩展模块 61 个、health-starter 1 个。按公共方法的近似静态扫描约有 1,598 个方法。这个数量是源码上限，不是某次部署的接口清单；条件装配、profile、代理继承和同名服务特判都会改变运行时结果。部署验收应从实际 `/v3/api-docs` 保存接口快照，并与启用模块清单共同版本化。

### 请求绑定

反射入口兼容多种历史请求形态：

| 方法签名形态 | 接受的 JSON | 绑定语义 |
| --- | --- | --- |
| 无参数 | 空 body、`null` 或空对象 | 直接调用 |
| 单一复杂参数 | DTO 对象 | 整个对象转换为参数类型 |
| 单一简单参数 | `{"value": 42}` 或可转换标量 | `value` 或标量转换为目标类型 |
| 多个命名参数 | `{"id": 42, "request": {...}}` | 按运行时参数名绑定 |
| 单一列表参数 | JSON 数组 | 整个数组转换为元素列表 |
| 多参数兼容形态 | JSON 数组 | 按位置绑定 |

缺失值会落为引用类型 `null` 或基本类型默认值，所以 transport 绑定成功不等于业务输入有效。运行时边界必须在调用用例前执行完整结构校验、枚举校验、跨字段校验和上下文校验，不能依靠目标语言的默认值。

技术无关实现不必保留反射路由。可以使用 REST、RPC、消息命令或进程内调用，但每个操作至少应有稳定的操作标识、版本化请求 schema、版本化响应 schema、认证与授权策略、幂等策略、事务边界和错误目录。兼容层可以继续接受旧路径，同时将其翻译为显式命令或查询。

### 响应和错误

应用服务成功或失败通常包在统一信封中，字段来自 [Result][source-result]：

```text
Result<T>
  code: 数字状态
  success: 是否成功
  data: 成功载荷
  message: 人类可读信息
  errorCode: 稳定机器错误码
  errors: 字段或规则错误集合
```

业务成功信封内部 `code` 为 200，失败工厂内部 `code` 为 500。全局异常处理又把校验/业务错误映射为 HTTP 400、未找到映射为 404、未认证映射为 401、拒绝或服务不可用映射为 403、完整性和未知错误映射为 500。反射参数转换错误和未找到动态路由可直接返回失败信封而保持 HTTP 200，因此调用方必须同时检查 HTTP 状态和 `success/errorCode`，不能只检查一层。

目标接口应消除这种双重歧义：传输状态表达 transport 结果，稳定业务错误码表达领域失败；相同错误在所有入口保持同一语义。建议的错误族包括 `VALIDATION_FAILED`、`NOT_AUTHENTICATED`、`NOT_AUTHORIZED`、`NOT_FOUND`、`STATE_CONFLICT`、`VERSION_CONFLICT`、`DUPLICATE_COMMAND`、`EXTERNAL_RESULT_UNKNOWN`、`EXTERNAL_REJECTED` 和 `MODULE_NOT_AVAILABLE`。

### OpenAPI 能力和限制

`DynamicOpenApiCustomizer` 从同一反射元数据生成 POST path，并读取参数类型和部分验证注解；被隐藏的方法不进入文档。返回值目前只生成通用 object，没有还原 `Result<T>` 的具体泛型，复杂列表和嵌套泛型也可能退化为 object。证据见 [DynamicOpenApiCustomizer][source-openapi-customizer]。

因此 OpenAPI 可用于发现“部署中有哪些入口”，不能单独作为完整客户端生成契约。可移植实现应让接口 schema 成为一等源文件或可验证代码契约，并在 CI 中检查破坏性变更；动态接口快照用于部署证据，不代替领域文档。

分页查询的主约定是请求 `pageNo`（对外从 1 开始）与 `pageSize`，响应 `content`、`totalCount`、`pageNo` 和 `pageSize`。部分旧 helper 的注释和页码换算不完全一致，所以兼容实现应在入口收敛成一种页码基准，并为越界、最大页长、稳定排序和游标替代方案写明契约。

统一 RPC 之外还有少量专用入口：健康检查 `GET /api/health`，CHS remote host 的调用、签到、文件下载和健康检查，以及 Boss 电子票据 host 的 `POST /eleInvoice/forward/{serviceId}`。这类 host 是受保护的集成边界，不是通用业务 API；文件上传下载、回调验签和大报文应使用专用流式或消息接口，而不是塞进反射 DTO。

### 逻辑接口目录

以下目录按业务能力归组。它比逐一抄录反射 URL 更稳定，也适合映射到任意 API 风格。

| 能力组 | 约数 | 主要查询 | 主要命令与逆向命令 |
| --- | ---: | --- | --- |
| 身份、租户、组织、菜单 | 15 个 framework 服务中的主体 | 登录上下文、租户/医院/科室候选、菜单树、用户角色 | 登录/刷新、选择作用域、授权/撤权、模拟身份/停止模拟 |
| 基础资料 | 23 | 患者、医护、科室、位置、收费类型、目录、模板 | 新增/修改/启停、导入、发布模板、软删除 |
| 门诊 | 19 | 待挂号、医生队列、费用、处方、治疗、日结 | 挂号/退号、接诊/取消/完诊、签发/撤回、收费/退费、发药/退药 |
| 住院 | 24 | 待入院、床位、医嘱、执行、账户、结算 | 登记/取消、入转出、审核/执行/跳过、预交/退预交、结算/冲正/召回/清床 |
| 库存 | 29 | 各地点库存、批次、单据、期间结存、追溯 | 采购、入出库、请领、调拨、盘点、损益、审批、撤回和退回 |
| 体检 | 15 | 受检人、批次、科室任务、总检、报告 | 个检/团检登记、收费、检查、总检、复检、授权、归档 |
| 病案 | 8 | 病案首页、质控队列、卷宗、借阅 | 提交/接收/退回、质控、归档/解档、借阅/归还、上传 |
| 报表、打印、财务 | 19 | 费用、用药、耗材、工作量、单据、追溯、模板 | 导出、打印、调价、财务审核、日结审批 |
| 预约扩展 | 11 | 排班、号源、候补、队列、预约 | 生成号源、预约/改约/取消、签到、叫号、释放容量 |
| 校园扩展 | 13 | 校区/院系、学生/教工、公费资格和记录 | 档案维护、组织转移、公费申请、审批和分摊 |
| 吉林医保 | 16 | 人员待遇、目录映射、调用日志、清算数据 | 签到、登记、明细审核、预结算/结算/撤销、上传、对账 |
| 票据、电子处方、银联、工伤 | 16 | 外部订单、票据、处方、任务和调用结果 | 开具/冲红、上传/撤销、支付/退款、工伤登记/预结算/结算/撤销 |

批量目录导入采用“上传工作簿内容 → 返回作业标识 → 轮询阶段和进度 → 下载错误工作簿”的异步接口。部分导入任务和下载 token 只存在进程内存中，进程重启会丢失；普通导出常把文件字节放进 JSON 并以 Base64 传输。目标实现应使用持久作业表和对象存储/受控下载地址，记录租户、发起人、输入摘要、状态、进度、错误产物、过期时间和重试次数。

## 前端架构与页面

### 客户端边界

主客户端位于 `openhis-pro-ui/apps/web-ele`，使用 Vue 3、TypeScript、Vite、Vben Admin、Element Plus、Pinia、Vue Router 和 Axios 风格请求库。`views` 目录有 515 个 `.vue` 文件，其中 204 个采用 `index.vue` 入口命名；医保 `chs` 目录另有 22 个 `.vue` 文件和 12 个 `index.vue`。文件数量不能直接解释为产品能力数量：目录中同时存在真实页面、隐藏深链、兼容壳、演示/测试页、可选模块页、站点覆盖点和 mock 支撑代码。

服务端状态由接口重新查询，前端本地状态主要是筛选条件、当前选择、弹窗、草稿快照、未保存保护和轻量偏好。可移植客户端也应保持这一边界，不能把同一业务状态机复制到多个页面 store。

请求层发送 Bearer token 和语言偏好，不发送租户请求头；它会解析成功或失败的 `Result` 信封，负责 token 刷新，对网关 502/503 做一次受控重试，并在服务端作用域丢失时恢复租户/医院/科室后单次重试。写命令的重试必须依赖幂等键；网络层不得在不知道命令是否已提交时盲目重复支付、结算、发药或库存过账。

### 登录、作用域和动态导航

登录后的初始化顺序是：

```text
认证
  -> 选择租户
  -> 选择医院/组织科室
  -> 绑定从业者身份
  -> 刷新应用配置
  -> 读取当前登录人的菜单树
  -> 将菜单组件标识映射到编译期页面注册表
  -> 注册可访问路由并进入工作台
```

前端只有在作用域就绪后才生成动态路由。后端菜单树决定当前身份可见的导航，前端 `views/**/*.vue` 与 `chs/**/*.vue` glob 决定组件是否真实存在。菜单节点、可见页面、隐藏深链、无布局全屏页、源码候选和“配置有但源码无”的孤儿项必须被建模为不同状态。菜单可见性是用户体验控制，不是 API 授权证据。

静态核心路由主要覆盖认证、个人中心、少量病案隐藏页和错误页；叫号大屏、部分医保页和电子票据调整页以静态隐藏路由补充。旧独立 Tiptap EMR 工作台路由已被注释，不能计为可达页面。首页 `/analytics` 实际是岗位工作台，聚合权限内快捷入口、库存/效期预警和医护工作量。

### 页面族与服务映射

| 页面族 | 主要页面/信息结构 | 对应服务能力 | 关键动作与页面状态 | 证据成熟度 |
| --- | --- | --- | --- | --- |
| 基础配置 | 过滤表格、编辑弹窗、启停、批量导入 | 患者、科室、位置、床位、药品/耗材/服务/诊断/手术、模板、LIS/PACS 映射 | 新增、修改、启停、导入、发布、失败重发 | 多数服务化；部分现场接口仅前端契约 |
| 门诊挂号 | 患者检索/建档、科室医生号源、预约、待遇预览、支付 | `outpatientRegistration` | 预结算、支付确认、退号；loading/no-scope/duplicate/payment-unknown | 主链完整，外部渠道需动态验证 |
| 门诊医生站 | 患者队列、稳定患者栏、病历/诊断/医嘱/申请/报告 tabs | doctor-station 服务族 | 接诊、暂离、保存草稿、签发/撤回、完诊、未保存保护、stale 冲突 | 主链服务化 |
| 门诊护士站 | 治疗队列、皮试、耗材、打印 | outpatient nurse-station 服务族 | 批量执行/取消、记录结果和异常原因 | 主链服务化 |
| 门诊收费/退费 | 待收费队列、费用核对、预结算快照、支付、票据 | `outpatientCharge`、`outpatientRefund` | 正式结算、部分失败补偿、原支付组退款、医保/工伤冲正 | 主链完整，必须保留结果未知恢复 |
| 门诊药房 | 待发/已发队列、处方、批次、追溯码 | `outpatientPharmacyDispense`、return-medicine | 配药、复核、发药、打印、退药 | 服务化；库存和外设需动态验证 |
| 住院登记/结算 | 待登记、病区床位、预交金、费用摘要、预结算 | inpatient registration/prepay/settle | 登记/取消、缴退预交、结算/冲正/召回 | 主链服务化；`charge/fee` 页面本身是占位 |
| 住院医生站 | 患者队列、病历/诊断/长期临时医嘱/报告 | inpatient doctor-station 服务族 | 保存、签发、停止；待结算/已结算/出院后只读 | 主链服务化 |
| 住院护士站 | 入出转、床位、医嘱校对/执行、领药、护理、体温、费用、打印 | inpatient nurse-station 服务族 | 分床/转床、审核、执行/跳过、出院、清床 | 主链服务化；部分 tab 配置隐藏 |
| 住院药房 | 按患者或汇总单工作队列、病区接收、追溯码 | inpatient pharmacy dispense/return | 汇总、拒绝、配发、退药 | 主链服务化 |
| 新库存工作台 | 左侧单据队列 + 右侧单头/明细，按仓库/药房/科室分区 | `api/inventory/**` | 草稿、提交、撤回、审批、过账、导入上游单据 | 新实现为主；旧 `warehouse/**` 已冻结 |
| 预约 | 模板、排班、号源日历、预约、候补、叫号/大屏、医技/床位/体检预约 | booking 服务族 | 生成号源、预约/取消、签到、叫号、释放 | 模板/排班/号源可见，其余多为隐藏或可选 |
| 体检 | 个检/团检、收费、科室检查、总检、报告、复检、历史 | PEIS 服务族 | 名单导入、到检、检查、总检、授权、归档 | 主链服务化；部分内部页无直接菜单证据 |
| 病案/EMR | 首页、质控工作台、卷宗、借阅、门住院病历查询、模板 | MRMS 与 EMR 服务族 | 提交/接收/退回、质控、归档、借阅、医保上传 | 病案主链完整；EMR 质控局部占位 |
| 医保 | 目录、映射、库存上传、医疗信息、调用日志、审核、对账清算 | `src/chs/api/**` | 签到、下载、映射、试调、上传、撤销、重试 | 页面丰富；按外部适配器成熟度验收 |
| 财务和外设 | 单据审批、日结审批、调价、电子票据、银联订单 | finance/einvoice/payment 服务 | 审批、开票/冲红、对账、支付/退款、HIS 落账重试 | 电子票据补偿较完整；银联服务端分支局部 |
| 报表 | 日期/关键字筛选、分页、合计、导出/打印、明细抽屉 | report 服务族 | 查询、导出、打印 | 具体报表存在；通用报表中心配置有孤儿 |
| 系统管理 | 用户、角色、权限、租户、菜单、设置、定时任务 | framework/system 服务 | 授权、菜单配置、cron、暂停/恢复/立即执行、日志 | 服务化 |

前端页面证据可从 [门诊医生站][source-outpatient-doctor]、[住院护士站配置][source-inpatient-nurse-tabs]、[门诊发药][source-outpatient-dispense]、[门诊结算][source-outpatient-settlement] 和 [动态菜单转换][source-menu-conversion] 进入。

### 页面成熟度和缺口

1. `views/inpatient/charge/fee/index.vue` 只有标题文本，是明确占位。
2. 新库存目录 `views/inventory/**` 是当前主实现；`views/warehouse/**` 的说明文件明确将旧目录冻结为兼容壳和遗留页。旧仓储 API 中若干环境开关会启用内存 mock，不能作为后端完成证据。
3. 采购入库页面仍有硬编码从业者标识的联调 stub，说明页面主体存在但人员集成未闭合。
4. seed 中存在打印绑定/日志、通用报表中心/设计器/模板、院长/临床/财务报表首页等组件路径，但当前 `src/views` 没有对应文件。这些属于配置孤儿，不可运行。
5. 若干 booking、医保通知、位置、设备和体检打印页有源码但没有默认可见菜单证据，只能称隐藏深链、内部页或可选能力。
6. LIS/PACS 对码、重发和报告相关页面调用了一些当前后端快照中不存在的站点服务名。这些是前端契约，不是已证实的端到端实现。
7. 构建工具允许 `projects/project-H{code}` 通过 env 和 `overrides/` 覆盖主线页面；当前快照没有实际院点目录，因此只能确认扩展机制，不能推断任何院点交付内容。

### 通用交互状态

任何技术栈的页面至少要区分 `loading`、`empty`、`error`、`no-scope`、`no-practitioner`、`no-selection`、`draft`、`editable`、`submitted`、`pending-approval`、`approved`、`rejected`、`completed`、`read-only`、`stale-conflict` 和 `partial-external-recovery`。收费、支付、医保、票据和外设调用不能只用一次 toast 表示结果；结果未知必须进入可查询、可重试且阻止重复扣款的工作队列。

## 数据设计

### 迁移、标识和租户基线

原实现使用 PostgreSQL 和 Flyway。模块化迁移先执行 health 核心，再执行已启用扩展，各模块可使用独立历史表，最后执行收尾迁移；开发 seed 是可选阶段。迁移保持在同一逻辑 schema 中，并允许 out-of-order、禁止 clean。装配证据见 [ModularFlywayConfiguration][source-modular-flyway]。

业务实体普遍使用应用生成的 64 位 Snowflake 风格标识。审计基类提供创建、更新、删除操作者与时间、`is_deleted`，租户实体再提供 `tenant_id`。Repository 删除被切面转换为软删除，默认查询过滤已删除数据；大量唯一索引以 `is_deleted=false` 为条件，使软删后业务键可以复用。高风险历史事实不应依赖软删除恢复，应采用不可变流水或显式冲正记录。

### 表域清单

排除迁移模板后，静态 DDL 定义 222 张不同表。它们是一个物理 schema 中的逻辑域，不是数据库 schema 声明的硬隔离。

| 逻辑域 | 表数 | 主要数据所有权 |
| --- | ---: | --- |
| 平台 | 29 | 用户、角色、权限、租户、组织、菜单、设置、审计、安全日志、会话、Quartz、序列 |
| `adm` | 23 | 患者、从业者、地点、就诊、参与者、账户关联、收费目录、标本等管理事实 |
| `cln/dia` | 13 | 过敏、诊断、操作、生命体征、观察和报告 |
| `fin` | 7 | 合同、支付、对账、财务锁定和结算关联 |
| `med` | 3 | 药品定义、用药请求和药品发放 |
| `wkf` | 15 | 服务请求、预约/号源、器械/物资请求和交付 |
| `ter/cus/doc` | 19 | 术语、供应商、价表、模板、自定义关联、库存快照和追溯记录 |
| `mrms/prt` | 15 | 病案、质控、借阅、打印模板与版本 |
| `peis` | 12 | 体检登记、检查、总检、报告和档案 |
| Booking | 21 | 排班模板、时段、预约、候补、策略和队列 |
| Campus | 13 | 校区/院系、学生/教工、公费资格、审批和分摊 |
| 吉林医保 | 33 | 会话、登记、结算、目录、映射、上传、审核、调用日志和清算 |
| Boss 电子票据 | 6 | 请求、任务、票据结果、补偿和对账 |
| 电子处方 | 3 | 处方上传、平台结果和调用记录 |
| EMR | 6 | 文书类型、模板、元数据、文书和版本 |
| 银联 BPC | 1 | 支付订单和本地/外部状态 |
| 工伤 | 3 | 就诊、会话和预结算锚点 |

核心 DDL 入口依次是 `V1__whale_platform.sql`、`V2__adm_ddl.sql`、`V3__cln_ddl.sql`、`V4__fin_ddl.sql`、`V5__med_ddl.sql`、`V6__wkf_ddl.sql`、`V7__ter_cus_ddl.sql`、`V9__mrms_prt_ddl.sql` 和 PEIS 的 `V1__peis_ddl.sql`；扩展模块各自拥有 `V1` DDL。表数用于说明规模，不能替代逐用例的数据所有权设计。

### 关系和约束策略

DDL 中只有少量显式外键和没有 SQL `CHECK`；多数状态是字符串或整数枚举，引用完整性和状态迁移依赖应用服务、领域服务及查询条件。常见关系形态包括：

| 关系形态 | 原实现用途 | 重建要求 |
| --- | --- | --- |
| 直接标识引用 | 患者、就诊、科室、人员、账户等稳定关系 | 同租户校验；能在单一存储边界内强约束时使用 FK |
| 多态 `table + id` | 费用来源、服务/产品/发放、库存或追溯业务锚点 | 用有界类型枚举和每类解析器；禁止任意表名；优先拆成类型化关联 |
| JSON/JSONB 扩展 | 模板、打印、平台扩展属性和外部数据 | schema 版本化、边界校验、大小限制和可查询索引 |
| JSON 文本报文 | 医保等外部请求/响应审计 | 加密/脱敏、访问控制、保留期，不参与核心业务判断 |
| 标识集合序列化 | 少数诊断/关联快照 | 优先改为关联表；必须保留顺序时增加显式序号 |
| 业务快照 | 预结算、库存、病案和打印的历史解释 | 提交后不可变；同时保存来源版本与生成时间 |
| 追加式流水 | 追溯码、库存变化、支付/冲正和调用日志 | 禁止原地覆盖；通过关联的逆向记录修正 |

迁移使用 PostgreSQL `pg_trgm` 和 GIN 支持医保国家目录模糊检索；部分大字段保存大量追溯码或外部报文。其他数据库可以使用全文/倒排索引、独立搜索服务或规范化子表，只要保持查询语义、租户隔离和历史可解释性。

### 逻辑实体关系

一个可移植的最小数据模型应至少保留以下聚合和引用：

```text
Tenant
  +-- Organization/Hospital/Department/Location/Bed
  +-- User/Role/Permission/Practitioner/Position
  +-- Catalog/Terminology/Price/Template

Patient
  +-- Identifier/Contact
  +-- Encounter
        +-- Participant + LocationHistory
        +-- Diagnosis + ClinicalDocumentVersion
        +-- Request
              +-- Execution/Dispense
                    +-- InventoryTransaction -> InventoryLot
        +-- ChargeItem -> SettlementSnapshot -> Bill
              +-- PaymentAttempt -> Refund/Reversal
        +-- Appointment -> Slot/Schedule
        +-- CaseRecord -> QC/Archive/Borrow
```

`Patient`、`Encounter`、`Request`、`Dispense`、`ChargeItem`、`PaymentAttempt` 和 `InventoryTransaction` 是不同生命周期，不能合并成一张“全流程状态表”。跨聚合只保存稳定标识和必要快照；展示查询可以建立派生读模型，但不能反向成为业务事实所有者。

### 并发和版本

乐观版本并非覆盖所有实体，只出现在 Encounter、部分库存、Booking Slot/Appointment、部分报表等竞争对象上；床位、库存和部分请求/支付路径还使用悲观锁或锁定查询。目标实现应逐命令选择并发策略：

| 竞争点 | 最低保证 | 可选实现 |
| --- | --- | --- |
| 同一号源预约 | 容量不超卖、重复请求只产生一份预约 | 条件更新、唯一占位、串行队列 |
| 同一床位分配 | 同一时刻最多一个有效占用 | 唯一有效占用约束、行锁、版本条件 |
| 同一库存批次扣减 | 可用量不为负，流水与余额一致 | 行锁、原子条件更新、单分区日志 |
| 同一医嘱签发/撤回 | stale 写不覆盖已签发或已执行状态 | expected version、状态条件更新 |
| 同一支付/退款 | 相同幂等键只产生一个业务结果 | 唯一幂等记录、外部流水唯一约束 |
| 同一结算 | 费用快照只被一个有效结算消费 | 快照版本、消费唯一约束、串行化 |

所有写命令应接受 `expectedVersion` 或等价前置条件；重复命令应返回原结果，而不是把重复视为新的业务动作。

### 数据分类和保留

至少区分当前态、不可变业务流水、快照、后台作业、外部报文审计和检索投影。患者身份、诊断、处方、支付、医保和工伤数据属于高敏面；权限必须按用途授予，日志和导出要单独授权。删除账户或软删主数据不应级联擦除依法需要保留的医疗、财务和审计事实，具体期限由部署地区法规和医院制度决定。

## 身份、授权与安全

### 认证和服务端上下文

安全配置采用无状态 JWT Bearer。登录、刷新、登出、运行时采集和健康检查是公开入口，其余请求要求认证，见 [SecurityConfig][source-security-config]。认证后服务端上下文拥有用户标识；当前租户、医院、科室和从业者身份在登录/选择流程中确定。`TenantInterceptor` 忽略客户端 `X-Tenant-Id` 并使用服务端会话租户，不匹配请求头只记录警告。目标实现也应从受信会话或签名令牌解析作用域，不允许调用者用普通请求头扩大数据范围。

### 授权缺口和目标策略

方法级 `@RequirePermission` 由权限切面执行，但静态扫描显示健康业务服务的显式注解覆盖有限；部分服务改用角色、岗位或查询范围手工检查。动态菜单又只控制页面可见性。因此原实现不能证明每个 AppService 方法都有一致的最小权限策略。

可移植实现必须为每个操作声明：允许的岗位/权限、租户范围、医院/科室/病区/库房数据范围、患者或就诊上下文、允许模拟身份与否、敏感字段可见性、审计级别。默认策略应为拒绝；菜单树从同一策略投影，但不能成为策略本身。

### 已确认的安全风险

1. 参考仓库配置文件中存在疑似非占位凭证或契约配置。本文不记录任何值。目标部署必须轮换现有值，把凭证移出源码并由密钥管理注入；是否清理上游历史应单独评估。
2. 动态接口默认可记录请求体，只对顶层对象中名称类似密码、密钥、令牌或凭证的键做有限脱敏。嵌套对象、数组、患者信息、诊疗内容和支付字段仍可能进入日志。生产环境应默认关闭 body 日志，或使用按接口字段白名单的结构化审计。
3. 医保调用日志有意保存完整请求和响应，并在独立事务中保留失败轨迹。这提高可追溯性，也形成高敏集中面，必须加密、字段脱敏、最小权限、保留/销毁策略和受控导出。
4. 当前 CORS 允许任意 origin、method 和 header，虽然禁用 credentials，生产边界仍应限制可信客户端来源和请求头。
5. CHS 独立代理在 API key 为空时可绕过校验；电子票据转发 host 接受调用方服务标识。部署时必须启用强认证、网络隔离和允许列表，不能仅依赖内网假设。

审计记录至少包含请求标识、操作者与实际被模拟者、租户/医院/科室、操作标识、业务对象、幂等键、预期/实际版本、前后状态、结果码、时间和外部关联号。不得把 access token、证书私钥或完整高敏请求体作为通用审计字段。

## 外部集成模块

外部平台不是核心状态机的分支复制品。核心用例产生本地交易和集成任务，适配器负责协议、签名、加密、本地客户端或远程 host，结果再通过受控命令落回核心状态。所有外部操作都要区分 `NOT_SENT`、`SENDING`、`SUCCEEDED`、`REJECTED`、`RESULT_UNKNOWN`、`RETRY_SCHEDULED` 和 `MANUAL_REVIEW`。

| 模块 | 已确认能力 | 局部或未完成边界 | 可移植端口 |
| --- | --- | --- | --- |
| 吉林医保 CHS | 签到、人员待遇、门诊/住院登记结算、目录、库存、审核、对账清算、调用日志；完整请求/响应审计 | remote host 文件上传未实现；SM2/SM4 服务有 unsupported 路径；未做现场互操作测试 | 签到、业务调用、文件传输、查单/撤销、调用审计 |
| 电子处方 | 预检、签名、文件上传、撤销、处方查询和结算结果查询；信封、响应解密和签名代码存在 | 依赖现场证书和平台契约配置 | 预检、提交、撤销、查询、结算回执 |
| Boss 电子票据 | Base64 payload、nonce、签名；持久任务、after-commit 唤醒、定时重试、原子 claim 和状态迁移 | host 边界需要认证和服务允许列表 | 开票、冲红、作废、对账、补偿任务 |
| 银联 BPC | Windows DLL 路径支持扫码、查单、退款和 HIS 落账编排 | HTTPS 本地实现是 placeholder/unsupported，不能称纯服务端直连完成 | 支付、查单、退款、孤儿退款确认、落账重试 |
| 工伤 | 持久 encounter/session/presettle 锚点和业务编排 | 核心平台调用依赖 Windows/DLL prepare/submit 两阶段 | 登记、预结算、结算、撤销、对账、桌面桥接 |
| Campus | 校区/院系/学生/教工档案和公费资格、申请、审批、分摊 | 属于机构场景扩展，不是医院核心通用模型 | 人员主数据同步、公费资格和审批分摊 |

医保交易号或第三方服务 ID 只属于具体适配器，不应渗入患者、就诊、费用、支付和库存聚合。目标实现可以替换地区平台或支付供应商，只要端口保持业务语义并保存原始外部关联号与版本化报文摘要。

## 技术无关的重建蓝图

### 模块边界

一个可落地但不绑定部署形态的划分如下：

| 模块 | 拥有的数据和规则 | 对外提供 |
| --- | --- | --- |
| Identity & Scope | 用户、角色、权限、租户、组织、岗位和当前作用域 | 认证、选择作用域、授权决策、菜单投影 |
| Master Data | 患者主索引、人员、地点、目录、价表和模板 | 查重/建档、目录查询、版本发布 |
| Scheduling | 排班、号源、预约、候补和队列 | 容量查询、预约/取消、签到/叫号 |
| Encounter | 门诊/住院就诊、参与者、位置和状态 | 挂号交接、接诊、入转出、完诊/出院/召回 |
| Clinical Orders | 诊断、请求、医嘱、执行和临床文书引用 | 草稿、签发、审核、执行、停止、结果接收 |
| Billing | 费用、账户、预交、快照、结算和退款 | 预结算、确认、冲正、对账 |
| Pharmacy & Inventory | 发放、批次、库存流水和供应单据 | 配药/发药/退药、采购、调拨、盘点、追溯 |
| Records | EMR 版本、病案、质控、归档和借阅 | 文书版本、提交/接收/退回、归档、借阅 |
| PEIS | 体检登记、任务、检查、总检、报告 | 个检/团检闭环 |
| Integration | 外部交易、任务、报文摘要和补偿 | 医保、支付、处方、票据、工伤适配端口 |
| Reporting | 只读投影、导出和打印产物 | 岗位报表、监管报表、打印 |

这些可以是一个进程中的模块、多个服务或混合部署。拆分条件是数据所有权和失败隔离，不是前端菜单。跨模块同步调用仍要经过明确端口；跨进程写入通过 outbox/inbox 或等价可靠投递连接。

### 命令和查询契约

每个写命令至少包含：操作标识、调用者作用域、目标业务标识、幂等键、预期版本、输入、发生时间和来源入口。命令处理结果返回业务对象标识、新版本、前后状态、生成的后续任务和稳定错误码。查询使用独立 DTO，可按页面聚合数据，但不得直接暴露持久化实体或允许查询模型写回。

预结算、报价、目录匹配和医保待遇预览是有时效的计算结果。确认命令必须引用快照标识及版本，并检查快照未过期、来源费用未变化、调用者作用域一致。不能让页面把计算出来的金额作为最终权威值传回。

### 事务和交付语义

1. 单一模块命令在本地事务内完成聚合状态、关键审计和 outbox 写入。
2. 外部调用不持有数据库长事务；先持久化尝试，再调用，再用独立命令确认结果。
3. 超时表示结果未知，不等于失败；先查单，再决定重试或补偿。
4. 消费者按事件标识去重，并按业务版本拒绝乱序结果。
5. 逆向操作引用原交易并产生新事实；不删除或回写历史成功记录。
6. 后台作业持久化租户、游标、租约、重试次数、下次执行时间和最后错误，进程重启后可恢复。

### 最小验收场景

| 场景 | 必须验证的结果 |
| --- | --- |
| 登录与作用域 | 切换租户/医院/科室后菜单和数据范围同步变化；伪造请求头不能越权 |
| 重复挂号提交 | 相同幂等键只生成一个有效就诊、账户和支付尝试 |
| 两人抢同一号源 | 只有容量允许的请求成功，失败方得到稳定冲突而非超卖 |
| 两名护士分同一床 | 至多一个有效占用；就诊位置与床位状态始终一致 |
| 医嘱 stale 修改 | 已签发或已执行版本不被旧草稿覆盖，返回当前版本和可恢复信息 |
| 发药并发扣减 | 库存不为负，发放、批次流水和余额可以对账 |
| 收费金额变化 | 确认过期预结算时拒绝，必须重新生成快照 |
| 支付结果未知 | 禁止重复扣款，查单成功后可补落账，查单无结果后才允许受控重试 |
| 部分退费/退药 | 原交易保留，逆向记录金额/数量正确，未退部分仍保持原状态 |
| 出院阻断 | 存在未完成医嘱或待发退药时不能进入结算，并返回可操作阻断清单 |
| 结算冲正与召回 | 逆向财务记录完整，账户、就诊和床位关系恢复到允许的前序状态 |
| 外部回调重放 | 重复和乱序回调不重复改变业务状态，审计保留每次尝试 |
| 软删除与租户隔离 | 被删主数据不出现在默认查询；相同业务键可按规则复用；跨租户引用被拒绝 |
| 权限与菜单不一致 | 即使知道 URL 或操作标识，没有服务端权限也不能执行命令 |
| 进程重启 | 导入、票据、外部补偿和调度任务从持久状态恢复，不丢失也不重复生效 |

这些场景是重建契约的最低线，不是完整测试清单。每个业务域还需要正常、逆向、并发、权限、审计和外部结果未知测试。

### 总体成熟度矩阵

| 等级 | 固定源码支持的范围 | 不能据此推断 |
| --- | --- | --- |
| 完整源码闭环但未执行 | 门诊正向/逆向主链、住院登记/床位/医嘱/出院/结算主链、三层库存主要单据、Booking 主流程、PEIS、MRMS 主干 | 跨岗位端到端、生产性能、外部平台和设备组合行为已通过 |
| 局部实现 | EMR 质控、CHS 部分解析与 remote 模式、电子处方/工伤现场适配、BPC HTTPS、部分设备和报表页面 | 模块整体生产可用 |
| 占位或空实现 | EMR 部分 validate/质量结果、住院并发集成测试 TODO、若干 CHS 分支、所有 NoOp adapter、住院费用占位页 | 菜单、端口或方法名代表已交付能力 |
| 静态无法确认 | 真实外部平台连通、院点 override、具体部署的最终菜单集合、生产数据质量、容量、灾备 | 固定源码之外的现场状态 |

## 研究边界与采用建议

本文的表数、服务数和页面数来自固定提交的静态扫描；它们不代表某个 profile、租户或院点在运行时全部启用。数据库关系语义大量存在于应用代码而非 DDL，本文的逻辑域归组是源码支持的架构解释，不是声明式 ER 全量还原。第三方模块只做实现覆盖审计，没有真实平台、证书、读卡器、支付终端或医院网络环境，因此不构成互操作认证。

ClinMesh 若采用这些研究结果，应优先吸收跨岗位状态、逆向交易、预结算快照、并发门禁、外部结果未知和工作队列模式。ClinMesh 的当前模块边界、FHIR R5 契约、虚拟时间、Agent tools 和合成数据规则仍由[系统架构](../architecture.md)与[领域词汇](../../CONTEXT.md)拥有；本文不覆盖这些权威。

## 固定版本一手来源

- [项目说明与技术栈][source-readme]
- [动态应用服务入口][source-app-service-registrar]
- [动态 OpenAPI 生成][source-openapi-customizer]
- [统一结果信封][source-result]
- [应用服务事务边界][source-app-service-aspect]
- [领域事件发布][source-domain-events]
- [JWT 安全配置][source-security-config]
- [租户上下文拦截][source-tenant-interceptor]
- [审计实体基线][source-audited-entity]
- [模块化数据库迁移][source-modular-flyway]
- [平台和核心健康 DDL][source-platform-ddl]
- [前端访问路由生成][source-access-routes]
- [动态菜单转换][source-menu-conversion]
- [门诊医生站][source-outpatient-doctor]
- [住院护士站配置][source-inpatient-nurse-tabs]
- [门诊药房发药][source-outpatient-dispense]
- [门诊收费结算][source-outpatient-settlement]
- [库存新旧边界][source-inventory-deprecated]

[source-readme]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/README.md
[source-app-service-registrar]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-health-opensource/whale-framework/whale-web/src/main/java/com/openhis/whale/web/api/AppServiceControllerRegistrar.java
[source-openapi-customizer]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-health-opensource/whale-framework/whale-web/src/main/java/com/openhis/whale/web/config/DynamicOpenApiCustomizer.java
[source-result]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-health-opensource/whale-framework/whale-core/src/main/java/com/openhis/whale/core/application/dto/Result.java
[source-app-service-aspect]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-health-opensource/whale-framework/whale-core/src/main/java/com/openhis/whale/core/infrastructure/transaction/AppServiceAspect.java
[source-domain-events]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-health-opensource/whale-framework/whale-core/src/main/java/com/openhis/whale/core/infrastructure/event/DomainEventPublisher.java
[source-security-config]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-health-opensource/whale-framework/whale-identity/src/main/java/com/openhis/whale/identity/infrastructure/config/SecurityConfig.java
[source-tenant-interceptor]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-health-opensource/whale-framework/whale-core/src/main/java/com/openhis/whale/core/infrastructure/multitenancy/TenantInterceptor.java
[source-audited-entity]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-health-opensource/whale-framework/whale-core/src/main/java/com/openhis/whale/core/domain/AuditedEntityBase.java
[source-modular-flyway]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-health-opensource/whale-health/health-infrastructure/src/main/java/com/openhis/health/infrastructure/config/ModularFlywayConfiguration.java
[source-platform-ddl]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-health-opensource/whale-health/health-infrastructure/src/main/resources/db/migration/health/V1__whale_platform.sql
[source-access-routes]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/router/access-init.ts
[source-menu-conversion]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/utils/auth/convert-menu-data.ts
[source-outpatient-doctor]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/views/outpatient/doctor-station/index.vue
[source-inpatient-nurse-tabs]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/views/inpatient/nurse-station/workbench-tab.config.ts
[source-outpatient-dispense]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/views/outpatient/dispense/index.vue
[source-outpatient-settlement]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/views/outpatient/charge/charge/settlement-dialog.vue
[source-inventory-deprecated]: https://github.com/tntlinking-opensource/openhis-itai-pro/blob/af34ab973eb4550e785df2f669481a597516d4eb/openhis-pro-ui/apps/web-ele/src/views/warehouse/DEPRECATED.md
