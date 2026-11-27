# 检验与功能检查

Node 与 Worker 通过 `builtinModules` 安装检验模块和账务端口。Hospital Data Pack 的 `enabledModules` 决定工作台页签、受控操作、虚拟时钟和完诊门禁。独立运行可使用 `createLabModule()`。装配收费端口时，开单事务按来源 Clinical Order 冻结目录项目、版本、数量、单价和币种。受理事务向账务模块重读同一来源的放行决定。预付包须由收费员收齐，支付状态未知时可在收费工作台查明原尝试。免费包直接受理。

## 工作台操作

在综合门诊打开 Jordan Vale，切换到全科医生，在「检验与功能检查」把心电图和高敏肌钙蛋白 I 加入待开清单并确认开立。分别受理、开始检查。管理员推进虚拟时间至预计签发时间即可取得报告，演示时也可点击「立即出报告」。点击「阅读报告」，打开所需版本后集中确认已阅。

Jordan Vale 的首份肌钙蛋白报告为 12 ng/L。管理员可在阅读窗口签发病例预置的更正版本，得到 120 ng/L 的危急值。负责医生重新阅读并确认新版后，检验报告完诊条件通过。心血管包提供经胸超声心动图，开立前须先签署病历并确认主诊断。

同一服务的一次申请首次获得正式已阅确认后，即可开立复查。旧报告更正显示「修订待重阅」，新申请继续执行。每个有效申请的最新报告都须单独确认已阅。

## 接口与并发

`GET /api/his/encounters/:id/lab` 返回公开服务目录、草稿和已签发版本。`PUT …/lab/draft` 以 `serviceIds` 替换最多 20 项待开清单，空数组清空草稿。`POST …/lab/issue` 提交已核对的 `items`，逐项返回 `orderId` 或冲突码。二者的 `expectedVersion` 均针对草稿。

`POST /api/his/lab/orders/:id/{accept,start,report-now,cancel}` 绑定申请版本。`POST /api/his/reports/:id/{acknowledge,amend}` 同时绑定 `expectedVersion`（申请版本）、路径中的报告 ID 和 `reportVersion`。修订使用同一服务、同一阶段预置的下一版及更正原因。报告、既往已阅事实和审计均按原版本保存。

签发阶段依次尝试同一病例完诊后再诊的 `follow-up`、同次就诊同服务已阅后的 `repeat`、住院的 `inpatient`、`initial`。校验每个必需指标的完整编码、值类型与单位。缺少结果、单位不兼容或存在正常基线冲突时，申请进入 `generation-failed`，可在资金状态允许时取消。就诊完结时服务端重验所有有效申请最新版本的已阅事实。
