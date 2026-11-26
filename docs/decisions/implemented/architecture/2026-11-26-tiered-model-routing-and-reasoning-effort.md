# Agent Note: 强弱双档模型路由与思考强度配置

Status: implemented

## Problem

门诊与后台临床 AI 任务共享单一默认模型与默认思考强度时，问诊回复、实时病历整理、患者人设、检验生成及诊疗建议材料／目录筛选等短输出、低复杂度步骤与诊疗建议生成／核验、病历语义质控、住院 DRG 等复杂临床推理步骤被迫使用同一高延迟高推理模型。同时，诊疗建议的断点执行结构（`DoctorRecommendationExecution`）原先仅记录单一 `model`，无法在一次建议生成内安全分离弱档筛选模型与强档生成／核验模型，也无法按实际筛选模型复用跨类别 `#selectionCheckpoint`；OpenAI 直连模式亦缺少按档位区分模型与透传 `reasoning_effort` 并落入用量账本的能力。

## Decision

1. **统一分层映射与桥接协议（`packages/contracts/src/model-bridge.ts`）**：
   - 将全部 17 项模型任务静态划分为 `fast`（11 项：医生代问分类、患者对话、病史整理、建议历史筛选／收敛／目录筛选、患者人设、检验生成与目录补全）与 `strong`（6 项：诊疗建议生成／核验、病历质控生成／核验、住院 DRG／指南建议生成／核验）。
   - `modelBridgeRequestSchema` 的 `operation: 'resolve'` 支持可选 `tier: 'strong' | 'fast'`（缺省 `'strong'` 保持向后兼容）；新增 `dsh:fast` 哨兵模型与 `dsh:default` 并列，并定义只读模型能力查询契约 `POST /clinmesh-model-capabilities`（返回 `efforts` 列表与可选 `defaultEffort`）。
2. **DSH 宿主桥接与通用设置（`apps/dsh-web/`）**：
   - 保留 `generationModel`（默认 `'default'`），新增 volatile 字段 `generationReasoningEffort`（默认 `'default'`）、`fastModel`（默认 `'default'`，表示沿用主模型）与 `fastReasoningEffort`（默认 `'auto-lowest'`，由 `ctx.llm.resolveModelInfo(provider, model)` 自动取 `reasoning.efforts[0]`，非推理模型自动省略）；非 volatile 的 `bridgeSecret` 与 `upstreamOrigin` 禁止写入设置补丁。
   - `/clinmesh-model-capabilities` 仅对同源环回浏览器 `POST` 请求开放，独立于 `bridgeSecret` 挂载于 `llm` 服务；设置页按模型能力渲染主／轻量思考强度下拉并隐藏不支持思考档位的模型选项；同时导出同进程 `resolveFastModelRoute` 供宿主轻量调用复用。
3. **Server 路由绑定、建议断点与 OpenAI 直连（`apps/server/`）**：
   - `DshModelProvider.resolveModel` 解析 `dsh:default` 与 `dsh:fast` 并经 `GenerationModelBinding` 持久化到 `ai_model_binding`，已绑定／在途／自动重试任务不随设置变更漂移，新任务与显式人工重试使用最新设置。
   - `DoctorRecommendationExecution` 在 `binding_json` 中显式分列 `model`、`selectionModel` 以及可选的 `modelReasoningEffort`、`selectionReasoningEffort`；筛选与收敛阶段绑定并校验 `selectionModel`，生成与核验阶段绑定并校验 `model`，跨类别 `#selectionCheckpoint` 按 `selectionModel` 与 `selectionReasoningEffort` 精确匹配复用，重启与人工继续严格保留原绑定。
   - OpenAI 直连模式新增可选 `CLINMESH_AI_STRONG_MODEL`、`CLINMESH_AI_FAST_MODEL`、`CLINMESH_AI_STRONG_REASONING_EFFORT`、`CLINMESH_AI_FAST_REASONING_EFFORT`：未设置时 100% 保留既有 `CLINMESH_AI_*_MODEL` 行为且不发送 `reasoning_effort`；单边配置时强弱两档互不串用；显式配置时按档位发送 `reasoning_effort` 并写入 `ModelUsageService` 账本配置字段。

## Alternatives considered

- **在 `ModelUsageService` 外部用单环境变量为所有任务统一传 `reasoning_effort`**：会同时削弱复杂推理质量或拖慢轻量任务，且单边配置容易在强弱任务间串档，拒绝。
- **在 `DoctorRecommendationExecution` 中对旧单模型 `binding_json` 维持双轨解析兼容层**：当前仍处于开发期，保留隐式回退会掩盖筛选模型漂移与缓存串用风险，改为直接演进为显式 `selectionModel` 字段并在阶段执行与断点复用处强校验。
- **通过无保护 `GET` 端点或扩充 `remote.settings` 返回全部模型能力**：`GET` 请求缺少可靠的浏览器 `Origin` 同源头且易受跨站探测，改用受同源环回与 `application/json` 校验的窄只读 `POST /clinmesh-model-capabilities`。

## Consequences

- 零配置下 DSH 轻量任务自动沿用主模型并降为该模型支持的最低思考档位（非推理模型不传 `reasoningEffort`），配置独立轻量模型后立即按档分流。
- 诊疗建议在同一次生成内混合使用弱档筛选与强档生成／核验，跨类别复用缓存不再受主模型切换影响，且中断后继续或重启恢复不发生模型或思考强度漂移。
- 开发者在 OpenAI 直连模式仅配置单边强档或弱档时，另一档任务会以 `MODEL_UNAVAILABLE` 或不可用状态显式失败关闭而非静默串用。
