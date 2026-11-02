# Agent Note: Surface 患者身份只读代理

Status: implemented

## Problem

住院患者卡从既有 FHIR Patient 读取性别与出生日期。standalone Web 与 ClinMesh 服务同源，DSH Surface 则由宿主提供页面；裸 `/fhir` 会请求宿主，原 `/clinmesh-api` 只转发 `/api`。在 ClinMesh 同源上运行 Surface fixture 会掩盖这个差异。

## Decision

Surface HTTP adapter 将精确的 `GET /fhir/R5/Patient/<id>` 映射为 `/clinmesh-api/_fhir/R5/Patient/<id>`；standalone 沿用原路由。代理只把这一保留路径转到已校验的同一 HTTP loopback origin 的既有 Patient read。

保留路径按原始请求校验：ID 只含 1–64 个 FHIR ID 安全字符并排除 `.`、`..`，不接受编码分隔、查询、历史、其他资源或额外路径。非法保留路径返回 404，非 GET 返回 405。既有 API 的授权头、请求与响应大小、超时限制继续有效；上游服务拥有身份与角色授权。住院药房继续读取原窄 DTO。

## Alternatives considered

- 扩展所有住院 DTO：两个身份字段并不需要改变既有业务读模型，更不应扩大药师可读字段。
- 代理任意 FHIR 路径和方法：引入超出患者身份读取所需的转发范围。
- 保留裸 `/fhir` 并依赖同源验证：不能证明真实宿主上的 Surface 可以读取患者资料。

## Consequences

此路径只解决平台传输，不新增 FHIR 能力、HIS Operation 或 CLI。adapter 与真实 Node HTTP 代理合同覆盖合法 GET、原认证传递及拒绝路径；Surface 产物合同将宿主裸 `/fhir` 固定为 404，并通过真实代理核对患者性别与年龄。当前传输合同见[前端架构](../../../frontend-architecture.md)及[Agent 接入](../../../architecture/agent-integration.md#71-surface-与-host-边界)。
