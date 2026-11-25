# Agent Note: 内置 dsh-ears 语音输入与患者问诊全时段桥接

Status: implemented

## Problem

ClinMesh 在 DSH Web 入口中需要稳定、开箱可用的语音输入能力，覆盖两个临床交互点：右侧 DSH 助手会话输入框，以及门诊医生“患者问诊”输入框。既有 DSH 隔离沙箱每次执行 `pnpm dsh:setup` 或 `pnpm dev:dsh` 都会用仓库模板覆写 Web Profile 的依赖清单，本地手工安装的社区插件会丢失；同时，`dsh-ears` 原生客户端仅向右侧会话输入框写入草稿，在 ClinMesh 全屏或收起右侧会话列时还会因宿主按钮不可见而屏蔽快捷键，无法在患者问诊场景下全时段使用。

## Decision

1. **在仓库级 DSH Profile 模板固定内置 `dsh-ears@0.4.4`**：
   - 将 `dsh-ears` 锁定在 `deployment/dsh/profile/package.json`、`deployment/dsh/profile/pnpm-lock.yaml`（以官方 npm registry 解析，零镜像地址）与 `deployment/dsh/profile/pnpm-workspace.yaml`（允许 `@fugood/whisper.node` 构建脚本），并排在 `dsh.profile.bundles` 中 `@clinmesh/dsh-web` 之后。
   - 保留 `dsh-ears` 原生的右侧会话麦克风、录音条与 DSH“设置 → `dsh-ears`”配置页，用户配置（Web Speech、本地 Whisper 或云端百炼/OpenAI 兼容/实时 ASR 及润色模型）仅存放在本地 DSH settings 中，不入版本库。
2. **通过可选端口把 `remote.dshEars` 桥接到患者问诊输入框**：
   - `apps/web/src/app/web-runtime.tsx` 新增可选运行时端口 `surfaceVoiceInput`（`WebSurfaceVoiceInput`）。独立 Web 模式不提供该端口，UI 与行为保持不变。
   - `apps/dsh-web/src/client/voice-input.ts` 使用可选 `ctx.inject(['remote.dshEars'], ...)` 订阅宿主 `dsh-ears` 后端（不加入顶层硬依赖 `export const inject`，避免 `dsh-ears` 禁用或延迟加载时阻塞 ClinMesh Surface 挂载），并在边界通过 Zod 校验 `getSettings`、`listAsrBackends`、`getWhisperModelState`、`transcribe`、`startRealtime`/`sendRealtimeAudio`/`finishRealtime` 与 `polish` 返回值。
   - `apps/web/src/app/doctor/consultation-page.tsx` 在 `surfaceVoiceInput` 已安装时于发送按钮旁展示麦克风/停止按钮、内联状态与取消操作；所有转写与润色结果只写入草稿输入框，**永不自动调用 `onAsk` 发送给患者**，发送仍须由医生复核并手动提交。切换只读、发送中、待重试、隐藏 Surface 或卸载组件时自动取消在途语音任务。
3. **分屏 / 全屏 / 收起右侧会话全时段快捷键仲裁**：
   - 由于 `@clinmesh/dsh-web` 在 `dsh.profile.bundles` 中先于 `dsh-ears` 启动，语音桥接在 `apply(ctx)` 阶段提前注册 `window` capture `keydown` 监听。
   - 问诊输入框处于活动状态且获得焦点，或处于全屏／收起右侧会话列模式时，ClinMesh 拦截快捷键并调用 `stopImmediatePropagation()` 防止与 `dsh-ears` 双重录音；分屏且焦点在右侧会话时放行给 `dsh-ears` 原生处理。

## Alternatives considered

- **在本地沙箱持久保留通过 `dshmarket` 自由安装的任意插件**：需要放宽 `scripts/dev-dsh.ts` 模板覆写并引入不可复现的本机漂移状态，无法在全新克隆或 CI 验收中保证语音能力一致，也与“只信任锁定 Profile 插件”的边界冲突，已被用户否决。
- **使用上游内置实验插件市场 `@deepseek-ai/dsh-experimental-plugin-market-bundle`**：不直接提供语音输入且仍需手工在线安装，已被否决。
- **把 `dsh-ears` 扩展到全院所有 HIS 表单与独立 Web**：会引入跨页焦点竞争与独立 Web 后端转写代理，超出当前右侧会话与患者问诊需求范围，故收敛在患者问诊并保持 `surfaceVoiceInput` 端口可扩展。

## Consequences

- `pnpm dsh:setup` 与 `pnpm dev:dsh` 在任意机器和重启后都确定性内置 `dsh-ears@0.4.4`，并与 `scripts/dsh-upstreams-verify.ts` 验收一致。
- 右侧 DSH 会话与门诊患者问诊在左右分屏、全屏及收起右侧会话三种布局下均可点击或用快捷键完成语音输入，且共享同一套 DSH“设置 → `dsh-ears`”配置。
- `@clinmesh/dsh-web` client bundle 仍满足 React 18/19 双版本、ShadowRoot 隔离、`verify-artifact.ts` require 白名单及 5.5 MB 体积预算。
- 本决策不新增服务端 API、数据库表、FHIR 资源或 Agent Tool，不向版本库或日志写入任何 ASR 凭据或音频内容。
