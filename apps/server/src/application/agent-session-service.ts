import { randomUUID } from 'node:crypto'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai'
import {
  AgentDoc,
  AssistantEntry,
  CompactionEntry,
  CompactionTask,
  ConversationBusy,
  createRegistry,
  DEFAULT_COMPACTION_POLICY,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  InboxDoc,
  LiveDoc,
  ProviderDoc,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type EntryId,
  type EntryRecord,
  type Extension,
  type InboxState,
  type LiveState,
  type SubmissionId,
  type TaskId,
  type ToolRegistration,
  type ToolSlot,
} from '@earendil-works/pi-durable'
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search'
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode'
import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import {
  type AgentCompactionState,
  type AgentContentBlock,
  type AgentQueuedInput,
  type AgentRetryState,
  type AgentSessionDetail,
  type AgentSessionKind,
  type AgentSessionMessage,
  type AgentSessionScope,
  type AgentSessionSummary,
  type ClinicalEntitiesResponse,
  type ClinicianMemoryItem,
  type CompactAgentSessionRequest,
  type CreateAgentSessionRequest,
  type CreateClinicianMemoryRequest,
  type ExportAgentSessionResponse,
  type ForkAgentSessionRequest,
  type ModelCallDetail,
  type ModelCallSummary,
  type RenameAgentSessionRequest,
  type ResetAgentSessionRequest,
  type ResolveAgentApprovalRequest,
  type ResolveAgentDevReflectionRequest,
  type ResolveAgentDevReflectionResponse,
  type SearchAgentSessionsResponse,
  type SendAgentMessageRequest,
  type SessionContextResponse,
  type SideChatRequest,
  type SideChatResponse,
  type SubmitAgentUiBridgeResultRequest,
  type UpdateClinicianMemoryRequest,
} from '@clinmesh/contracts/agent-sessions'
import {
  ClinMeshDevReflectionsDoc,
  createDevReflectionRuntime,
  persistDevReflectionToDisk,
  type DevReflectionConfig,
  type DevReflectionRuntime,
} from './agent-dev-reflection.ts'
import {
  ClinMeshPendingApprovalsDoc,
  ClinMeshUiBridgeDoc,
  ClinicianApprovalSignal,
  UiBridgeResultSignal,
  createProductionHisToolsBundle,
  type EphemeralHisAuthContext,
  type InProcessHisDispatcher,
  type ProductionHisToolsBundle,
} from './agent-his-tools.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import { BetterSqliteAdapter } from '../infrastructure/agents/better-sqlite-adapter.ts'
import {
  classifyLlmError,
  INTERNAL_PROVIDER_IDS,
  type ClinMeshProviderRegistry,
  type ResolvedTurnConfig,
} from '../infrastructure/agents/byok-provider-resolver.ts'
import type { VisibleCaseReader } from './agent-clinical-reader.ts'
import {
  appendContextEvent,
  appendModelCallSnapshot,
  buildExcludedItemsFromEntries,
  buildIncludedItemsFromRequestMessages,
  CLINICAL_CONTEXT_MARKER,
  createInitialContextSnapshotsDoc,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  estimateTextTokens,
  extractAssistantItems,
  hydrateModelCallDetail,
  summarizeSessionContext,
  toPublicModelCallSummary,
  type ContextItemInput,
  type StoredContextSnapshotsDoc,
} from './agent-context-snapshots.ts'
import type { ActorContext } from './command-executor.ts'

export type AgentSessionErrorCode =
  | 'LLM_PROVIDER_UNCONFIGURED'
  | 'LLM_AUTH_FAILED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_TIMEOUT'
  | 'LLM_REQUEST_FAILED'
  | 'AGENT_SESSION_NOT_FOUND'
  | 'AGENT_SESSION_FORBIDDEN'
  | 'AGENT_SESSION_BUSY'
  | 'AGENT_SESSION_RETRY_UNAVAILABLE'
  | 'AGENT_SESSION_INVALID'
  | 'AGENT_APPROVAL_NOT_FOUND'

export class AgentSessionError extends Error {
  readonly code: AgentSessionErrorCode
  readonly status: 400 | 403 | 404 | 409 | 503

  constructor(code: AgentSessionErrorCode, message: string, status?: 400 | 403 | 404 | 409 | 503) {
    super(message)
    this.name = 'AgentSessionError'
    this.code = code
    this.status = status ?? (
      code === 'LLM_PROVIDER_UNCONFIGURED' || code === 'LLM_TIMEOUT' || code === 'LLM_REQUEST_FAILED' || code === 'LLM_RATE_LIMITED' || code === 'LLM_AUTH_FAILED'
        ? 503
        : code === 'AGENT_SESSION_NOT_FOUND'
          ? 404
          : code === 'AGENT_SESSION_FORBIDDEN'
            ? 403
            : code === 'AGENT_SESSION_BUSY' || code === 'AGENT_SESSION_RETRY_UNAVAILABLE'
              ? 409
              : 400
    )
  }
}

type StoredSessionMeta = {
  sessionId: string
  kind: AgentSessionKind
  title: string
  workspaceId: string
  epoch: string
  roleCode: string
  encounterId: string | null
  caseId: string | null
  patientId: string | null
  forkedFromSessionId: string | null
  forkedFromEntryId?: number | null
  customInstructions?: string | null
  autoCompact?: boolean
  deleted: boolean
  createdAt: string
  updatedAt: string
}

type StoredClinicianMemoryItem = {
  id: string
  content: string
  status: 'pending' | 'approved' | 'discarded'
  source: 'user' | 'assistant'
  createdAt: string
  updatedAt: string
}

type StoredClinicianMemoryDoc = {
  byScope: Record<string, StoredClinicianMemoryItem[]>
}

type StoredSessionIndexEntry = {
  sessionId: string
  conversationId: number
  kind: AgentSessionKind
  workspaceId: string
  epoch: string
  roleCode: string
  encounterId: string | null
  caseId: string | null
  patientId: string | null
  deleted: boolean
}

type StoredSessionIndex = {
  bySessionId: Record<string, StoredSessionIndexEntry>
  patientByEncounterKey: Record<string, string>
}

const ClinMeshSessionMetaDoc = defineDoc<StoredSessionMeta>({
  kind: 'clinmesh.session_meta',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({
    sessionId: '',
    kind: 'clinician-assistant',
    title: '新对话',
    workspaceId: 'workspace-demo',
    epoch: 'epoch-1',
    roleCode: 'doctor',
    encounterId: null,
    caseId: null,
    patientId: null,
    forkedFromSessionId: null,
    forkedFromEntryId: null,
    customInstructions: null,
    autoCompact: true,
    deleted: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }),
  checkpointWhen: () => true,
})

const ClinMeshClinicianMemoryDoc = defineDoc<StoredClinicianMemoryDoc>({
  kind: 'clinmesh.clinician_memory',
  version: 1,
  scope: 'session',
  initial: () => ({ byScope: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 8,
})

const ClinMeshSessionIndexDoc = defineDoc<StoredSessionIndex>({
  kind: 'clinmesh.session_index',
  version: 1,
  scope: 'session',
  initial: () => ({
    bySessionId: {},
    patientByEncounterKey: {},
  }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
})

const ClinMeshContextSnapshotsDoc = defineDoc<StoredContextSnapshotsDoc>({
  kind: 'clinmesh.context_snapshots',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: createInitialContextSnapshotsDoc,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 8,
})

interface PendingModelCallCapture {
  startedAtMs: number
  startedAtIso: string
  provider: string
  modelId: string
  contextWindow: number
  maxOutputTokens: number
  included: ContextItemInput[]
  excluded: ContextItemInput[]
}

function publicProviderLabel(provider: string): string {
  switch (provider) {
    case INTERNAL_PROVIDER_IDS.mock:
      return 'mock'
    case INTERNAL_PROVIDER_IDS.openaiCompatible:
      return 'openai-compatible'
    case INTERNAL_PROVIDER_IDS.anthropic:
      return 'anthropic'
    case INTERNAL_PROVIDER_IDS.gemini:
      return 'gemini'
    case INTERNAL_PROVIDER_IDS.local:
      return 'local-cli'
    case INTERNAL_PROVIDER_IDS.injected:
      return 'injected'
    default:
      return provider
  }
}

export type VisibleCaseSummaryReader = VisibleCaseReader

function memoryScopeKey(workspaceId: string, roleCode: string): string {
  return `${workspaceId}::${roleCode}`
}

function patientEncounterKey(workspaceId: string, epoch: string, encounterId: string): string {
  return `${workspaceId}::${epoch}::${encounterId}`
}

function clinicianAssistantSystemPrompt(
  meta: StoredSessionMeta,
  approvedMemories: readonly StoredClinicianMemoryItem[] = [],
  devReflectionEnabled = false,
): string {
  const scopeLines = [
    CLINICAL_CONTEXT_MARKER,
    `当前角色：${meta.roleCode}`,
    `工作区：${meta.workspaceId}（纪元 ${meta.epoch}）`,
    ...(meta.encounterId ? [`当前接诊 Encounter ID：${meta.encounterId}`] : []),
    ...(meta.caseId ? [`当前病例 ID：${meta.caseId}`] : []),
  ]
  const customInstructions = meta.customInstructions?.trim() ?? ''
  return [
    '你是 ClinMesh 中国公立医院仿真 HIS 的可执行临床助手（Clinician Assistant）。',
    '你不仅能回答临床问题，还可以【直接帮医生完成实际业务操作】（起草病历、诊断草稿、处方草稿、检查检验申请草稿、预填界面表单、核查完诊门禁等），而所有正式签署/确诊/开方/完诊/出院/收退款等高危提交都会自动弹出【医生确认卡片】，由医生一键确认后才真正落库。',
    '',
    '## 权限原则：黑名单与确认红线之外，默认全部放行',
    '- **硬黑名单（仅禁止）**：`auth.*` 身份切换、`agent.*` 密钥与会话管理、`[data-agent-hidden]` 隐藏病例真值、`[data-agent-secret]` 明文口令。',
    '- **医生一键确认红线（高危正式提交）**：正式签署病历（`encounter_clinical_document_sign`）、确认诊断（`encounter_diagnosis_confirm`）、开立处方（`encounter_prescription_issue`）、确认无需用药（`encounter_medication_conclusion_confirm_none`）、完诊（`encounter_complete`）、开立检查检验申请、分诊提交、住院医嘱/出院、收费退款等。此类操作已物理禁止在 `codemode` 中执行，请用 `tool_search` 加载后由模型直接调用，系统会自动弹出【医生确认卡片】待医生一键确认；医生点拒绝后严禁擅自重试。',
    '- **默认全部放行（自主执行）**：除上述黑名单与确认红线外，所有读取、检索、**切换界面栏位/页签**、展开/筛选面板、表单预填草稿、病历/诊断/处方/检验草稿保存、预签预览、安全质控审计均可直接自主执行！不确定当前可执行事件清单时可调 `list_agent_capabilities`。',
    '',
    '## 工具体系与高效工作准则（严禁低效盲猜与反复弹窗）',
    '1. **主动向患者问诊（1 步到位）**：医生让你继续问诊或向患者提问时，**直接调用 `macro_consultation_ask({ message })`**（可把 2–4 个关键追问合并成一条发送），内部自动读取最新 `consultation.version` 并返回患者回复，**严禁在 `codemode` 中循环试探版本号**！',
    '2. **多项检验/检查/签署/确诊一次确认（强烈优先）**：需要开立多项检验、心电图/检查、影像，或同时需要签署病历+确认诊断+开立多项检查时，先用 `macro_search_clinical_catalog({ kind, queries })` 一次查齐有效目录 ID，然后**一次性调用 `batch_confirm_clinical_orders`** 把所有待确认项打包成 **1 张简洁清单卡片**让医生一次点确认；**严禁逐项调用 `*_issue` 反复弹窗打扰医生**！（提示：检验/检查草稿接口每次仅保存单条草稿，多项检验务必直接走 `batch_confirm_clinical_orders`。）',
    '3. **前端工作台导航与实时协同（默认放行）**：切换栏位（如「问诊记录/患者对话栏」↔「病历记录/病历栏」/「诊断」/「检验检查」/「处方」）直接调用 `ui_navigate_workspace({ target })`；读取页面未保存手改内容调 `ui_read_workspace`；预填表单调 `ui_stage_form_draft`（自动跳过医生手改字段）。',
    '4. **高频门诊快捷宏**：读病例全貌用 `macro_clinical_briefing`；安全质控预检用 `macro_safety_completion_audit`；写草稿前准备版本号用 `macro_outpatient_write_preflight`（`doctor_case_get` 已完整包含 `consultation.version` 及各项 `draftVersion`）；不确定流程调 `read_clinical_playbook`。',
    '5. **全量角色授权 HIS 操作（渐进按需）**：可用 `codemode`（QuickJS 沙箱）并行执行只读/草稿/预览接口，或用 `tool_search` 加载单个工具。切记：**禁止在 `codemode` 中用 `for` 循环穷举试探版本号**——版本号直接从 `doctor_case_get` 读取。',
    '6. **兼容快捷只读工具**：也可随时调用 `read_visible_case_summary`、`read_lab_results`、`read_imaging_reports`、`read_medication_orders`、`read_vital_trends` 与 `propose_clinician_preference`。',
    '7. **隐私与真值红线**：严禁臆造未报告的检验/检查结果；严格遵守 Reveal Policy，严禁假设或泄露任何未向医生公开的隐藏病例真值。',
    ...(devReflectionEnabled ? [
      '8. **开发模式自检反思**：若当前处于开发模式且遭遇工具反复失败、字段缺失、参数校验摩擦、被迫多次弹窗或看到 `[DEV-WATCHDOG]` 熔断提示，请立即停止盲试，并在汇报后调用 `dev_reflect_friction` 生成结构化开发反思卡片，由开发者决定是否写入 `.dev-reflections/` 优化清单。',
    ] : []),
    '回答保持清晰、结构化，汇报实际写入的草稿/ID/待确认项。',
    ...(approvedMemories.length > 0 ? [
      '',
      '【已批准的医生工作偏好】',
      ...approvedMemories.map(item => `- ${item.content}`),
    ] : []),
    ...(customInstructions.length > 0 ? [
      '',
      '【当前会话临床指令】',
      customInstructions,
    ] : []),
    '',
    ...scopeLines,
  ].join('\n')
}

function deriveSessionTitle(content: string): string {
  const withoutRefs = content.replace(/\[临床引用:[^\]]*\][\s\S]*?(?=\n\n|$)/g, '')
  const lines = withoutRefs
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('>'))
  const candidate = (lines.join(' ') || content).replace(/\s+/g, ' ').trim()
  return candidate.slice(0, 32) || '临床助手对话'
}

function deriveForkTitle(baseTitle: string): string {
  const stripped = baseTitle.replace(/(?:\s*\(分支\))+$/, '').trim() || baseTitle
  return `${stripped} (分支)`
}

function extractUserText(model: readonly Message[] | undefined): string {
  const userMsg = model?.find(m => m.role === 'user')
  if (userMsg === undefined || userMsg.role !== 'user') return ''
  if (typeof userMsg.content === 'string') return userMsg.content
  return userMsg.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map(part => part.text)
    .join('\n')
}

function extractToolResultText(message: ToolResultMessage): string {
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map(part => part.text)
    .join('\n')
}

function projectAssistantBlocks(
  message: AssistantMessage,
  toolResultsByCallId: ReadonlyMap<string, { output: string; isError: boolean }>,
  liveToolSlotsByCallId: ReadonlyMap<string, ToolSlot>,
): AgentContentBlock[] {
  const blocks: AgentContentBlock[] = []
  for (const part of message.content) {
    if (part.type === 'thinking') {
      if (part.thinking.length > 0 || part.redacted) {
        blocks.push({
          type: 'thinking',
          thinking: part.thinking,
          ...(part.redacted ? { redacted: true } : {}),
        })
      }
      continue
    }
    if (part.type === 'text') {
      if (part.text.length > 0) {
        blocks.push({ type: 'text', text: part.text })
      }
      continue
    }
    if (part.type === 'toolCall') {
      const settled = toolResultsByCallId.get(part.id)
      const liveSlot = liveToolSlotsByCallId.get(part.id)
      const status: 'pending' | 'running' | 'done' | 'error' = settled !== undefined
        ? (settled.isError ? 'error' : 'done')
        : liveSlot !== undefined
          ? (liveSlot.status === 'done' ? 'done' : liveSlot.status === 'pending' ? 'pending' : 'running')
          : 'pending'
      blocks.push({
        type: 'tool-call',
        callId: part.id,
        name: part.name,
        argumentsJson: JSON.stringify(part.arguments ?? {}, null, 2),
        status,
        ...(settled !== undefined
          ? { output: settled.output, isError: settled.isError }
          : liveSlot?.output !== undefined
            ? { output: liveSlot.output }
            : {}),
      })
    }
  }
  return blocks
}

function collectOmittedEntryIds(entries: readonly EntryRecord[]): Set<number> {
  const omitted = new Set<number>()
  for (const entry of entries) {
    if (entry.edits === undefined) continue
    for (const edit of entry.edits) {
      if (edit.action === 'omit') omitted.add(edit.target)
    }
  }
  return omitted
}

function matchCallForAssistantMessage(
  assistantMsg: AssistantMessage,
  calls: readonly ModelCallSummary[],
  usedCallIds: Set<string>,
): ModelCallSummary | undefined {
  let best: ModelCallSummary | undefined
  let bestDiff = Number.POSITIVE_INFINITY
  for (const call of calls) {
    if (call.purpose !== 'TURN' || usedCallIds.has(call.id)) continue
    const endedMs = Date.parse(call.endedAt)
    if (!Number.isFinite(endedMs)) continue
    const diff = Math.abs(endedMs - assistantMsg.timestamp)
    if (diff < bestDiff && diff <= 15_000) {
      bestDiff = diff
      best = call
    }
  }
  if (best !== undefined) {
    usedCallIds.add(best.id)
  }
  return best
}

function projectMessagesFromEntries(
  entries: readonly EntryRecord[],
  live: LiveState | undefined,
  modelCalls: readonly ModelCallSummary[] = [],
): { messages: AgentSessionMessage[]; canRetryLatest: boolean } {
  const omittedIds = collectOmittedEntryIds(entries)
  const toolResultsByCallId = new Map<string, { output: string; isError: boolean }>()
  for (const entry of entries) {
    if (omittedIds.has(entry.id) || !ToolResultEntry.is(entry)) continue
    const msg = entry.model?.[0]
    if (msg?.role === 'toolResult') {
      toolResultsByCallId.set(msg.toolCallId, {
        output: extractToolResultText(msg),
        isError: msg.isError,
      })
    }
  }
  const liveSlotsByCallId = new Map<string, ToolSlot>()
  for (const slot of live?.tools ?? []) {
    liveSlotsByCallId.set(slot.callId, slot)
  }

  const usedCallIds = new Set<string>()
  const messages: AgentSessionMessage[] = []
  let hasUserMessage = false
  for (const entry of entries) {
    if (omittedIds.has(entry.id)) continue
    if (CompactionEntry.is(entry)) {
      const summaryText = extractUserText(entry.model) || '（上下文已自动压缩）'
      messages.push({
        id: `entry-${entry.id}`,
        entryId: entry.id,
        role: 'system',
        createdAt: new Date(entry.model?.[0]?.timestamp ?? Date.now()).toISOString(),
        blocks: [{ type: 'text', text: summaryText }],
        stopReason: null,
        errorMessage: null,
        streaming: false,
        isCompactionSummary: true,
      })
      continue
    }
    if (ResetEntry.is(entry)) {
      const handoff = extractUserText(entry.model)
      messages.push({
        id: `entry-${entry.id}`,
        entryId: entry.id,
        role: 'system',
        createdAt: new Date(entry.model?.[0]?.timestamp ?? Date.now()).toISOString(),
        blocks: [{ type: 'text', text: handoff.length > 0 ? `上下文已重置 · 交接说明：${handoff}` : '上下文已重置（后续对话从全新上下文窗口开始）' }],
        stopReason: null,
        errorMessage: null,
        streaming: false,
        isResetBoundary: true,
      })
      continue
    }
    if (UserEntry.is(entry)) {
      const text = extractUserText(entry.model)
      const ts = entry.model?.[0]?.timestamp ?? Date.now()
      hasUserMessage = true
      messages.push({
        id: `entry-${entry.id}`,
        entryId: entry.id,
        role: 'user',
        createdAt: new Date(ts).toISOString(),
        blocks: [{ type: 'text', text }],
        stopReason: null,
        errorMessage: null,
        streaming: false,
      })
      continue
    }
    if (AssistantEntry.is(entry)) {
      const assistantMsg = entry.model?.[0]
      if (assistantMsg?.role !== 'assistant') continue
      const blocks = projectAssistantBlocks(assistantMsg, toolResultsByCallId, liveSlotsByCallId)
      const matchedCall = matchCallForAssistantMessage(assistantMsg, modelCalls, usedCallIds)
      messages.push({
        id: `entry-${entry.id}`,
        entryId: entry.id,
        role: 'assistant',
        createdAt: new Date(assistantMsg.timestamp).toISOString(),
        blocks,
        stopReason: assistantMsg.stopReason,
        errorMessage: assistantMsg.errorMessage ?? null,
        streaming: false,
        model: matchedCall?.model ?? assistantMsg.model ?? null,
        provider: matchedCall?.provider ?? (assistantMsg.provider ? publicProviderLabel(assistantMsg.provider) : null),
        durationMs: matchedCall?.durationMs ?? null,
        ttftMs: matchedCall?.ttftMs ?? null,
        tokensPerSecond: matchedCall?.tokensPerSecond ?? null,
        usage: matchedCall?.usage ?? null,
        modelCallId: matchedCall?.id ?? null,
      })
    }
  }

  const partial = live?.generation?.message as AssistantMessage | undefined
  if (live?.run !== undefined) {
    const streamingBlocks = partial !== undefined
      ? projectAssistantBlocks(partial, toolResultsByCallId, liveSlotsByCallId)
      : []
    messages.push({
      id: `live-${live.run.taskId}-${live.generation?.attempt ?? 1}`,
      entryId: null,
      role: 'assistant',
      createdAt: new Date(partial?.timestamp ?? Date.now()).toISOString(),
      blocks: streamingBlocks,
      stopReason: 'pending',
      errorMessage: null,
      streaming: true,
      model: partial?.model ?? null,
      provider: partial?.provider ? publicProviderLabel(partial.provider) : null,
      durationMs: null,
      usage: null,
      modelCallId: null,
    })
  }

  return {
    messages,
    canRetryLatest: hasUserMessage && live?.run === undefined,
  }
}

function summarizeMeta(
  conversationId: ConversationId,
  meta: StoredSessionMeta,
  live: LiveState | undefined,
  messageCount: number,
): AgentSessionSummary {
  const isRunning = live?.run !== undefined
  const runFailure = live?.runFailure
  const lastError = !isRunning && runFailure !== undefined && runFailure.reason !== 'aborted'
    ? classifyLlmError(runFailure.detail ?? runFailure.reason)
    : null
  const status: 'idle' | 'running' | 'error' = isRunning
    ? 'running'
    : lastError !== null
      ? 'error'
      : 'idle'

  return {
    sessionId: meta.sessionId,
    conversationId,
    kind: meta.kind,
    title: meta.title,
    scope: {
      workspaceId: meta.workspaceId,
      epoch: meta.epoch,
      roleCode: meta.roleCode,
      encounterId: meta.encounterId,
      caseId: meta.caseId,
      patientId: meta.patientId,
    },
    forkedFromSessionId: meta.forkedFromSessionId,
    forkedFromEntryId: meta.forkedFromEntryId ?? null,
    customInstructions: meta.customInstructions ?? null,
    autoCompact: meta.autoCompact ?? true,
    status,
    lastError,
    messageCount,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}

function extractInboxContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: 'text'; text: string } => (
        typeof part === 'object' && part !== null && 'type' in part && (part as { type?: unknown }).type === 'text'
        && 'text' in part && typeof (part as { text?: unknown }).text === 'string'
      ))
      .map(part => part.text)
      .join('\n')
  }
  return ''
}

function projectQueuedInputs(inbox: InboxState | undefined): AgentQueuedInput[] {
  if (inbox === undefined) return []
  const queued: AgentQueuedInput[] = []
  for (const item of inbox.items) {
    if (item.mode === 'steer' || item.mode === 'followUp') {
      queued.push({
        submissionId: item.id,
        mode: item.mode,
        content: extractInboxContentText(item.content),
      })
    }
  }
  return queued
}

function projectRetryState(
  live: LiveState | undefined,
  redact: (text: string) => string,
): AgentRetryState | null {
  const retry = live?.generation?.retry
  if (retry === undefined) return null
  const safeError = redact(retry.error)
  return {
    attempt: live?.generation?.attempt ?? 1,
    retryAt: new Date(retry.at).toISOString(),
    error: safeError,
    isRateLimited: /429|rate limit|too many requests|quota/i.test(safeError),
  }
}

function projectCompactionState(
  live: LiveState | undefined,
  redact: (text: string) => string,
): AgentCompactionState {
  const activeTask = live?.compactions?.[0]
  return {
    active: activeTask !== undefined,
    ...(activeTask === undefined ? {} : { trigger: activeTask.trigger }),
    ...(live?.compactionFailure === undefined
      ? {}
      : { lastError: redact(live.compactionFailure.error) }),
  }
}

export interface AgentSessionServiceOptions {
  database: ClinMeshDatabase
  providers: ClinMeshProviderRegistry
  visibleCaseReader?: VisibleCaseSummaryReader
  devReflection?: DevReflectionConfig
  onReport?: (message: string, error: unknown) => void
}

/**
 * Unified pi-durable runtime service mounted on ClinMesh's workspace SQLite database
 * using the `pi_` table prefix. Hosts both Clinician Assistant sessions and strictly
 * isolated Patient Agent sessions (one per outpatient Encounter).
 */
export class AgentSessionService {
  readonly #harness: Harness
  readonly #adapter: BetterSqliteAdapter
  readonly #providers: ClinMeshProviderRegistry
  readonly #assistantExtension: Extension
  readonly #allAssistantExtensions: readonly Extension[]
  readonly #baseAssistantTools: readonly ToolRegistration[]
  readonly #toolSearchTools: readonly ToolRegistration[]
  readonly #codemodeTools: readonly ToolRegistration[]
  readonly #hisBundle: ProductionHisToolsBundle
  readonly #devReflection: DevReflectionRuntime
  readonly #httpDispatcherRef: { current?: InProcessHisDispatcher }
  readonly #hisAuthByConversation: Map<number, EphemeralHisAuthContext>
  readonly #visibleCaseReader: VisibleCaseReader | undefined
  readonly #shutdown = new AbortController()
  readonly #activeWatchers = new Set<AbortController>()
  #closed = false

  private constructor(
    harness: Harness,
    adapter: BetterSqliteAdapter,
    providers: ClinMeshProviderRegistry,
    assistantExtension: Extension,
    allAssistantExtensions: readonly Extension[],
    baseAssistantTools: readonly ToolRegistration[],
    toolSearchTools: readonly ToolRegistration[],
    codemodeTools: readonly ToolRegistration[],
    hisBundle: ProductionHisToolsBundle,
    devReflection: DevReflectionRuntime,
    httpDispatcherRef: { current?: InProcessHisDispatcher },
    hisAuthByConversation: Map<number, EphemeralHisAuthContext>,
    visibleCaseReader: VisibleCaseReader | undefined,
  ) {
    this.#harness = harness
    this.#adapter = adapter
    this.#providers = providers
    this.#assistantExtension = assistantExtension
    this.#allAssistantExtensions = allAssistantExtensions
    this.#baseAssistantTools = baseAssistantTools
    this.#toolSearchTools = toolSearchTools
    this.#codemodeTools = codemodeTools
    this.#hisBundle = hisBundle
    this.#devReflection = devReflection
    this.#httpDispatcherRef = httpDispatcherRef
    this.#hisAuthByConversation = hisAuthByConversation
    this.#visibleCaseReader = visibleCaseReader
  }

  static async open(options: AgentSessionServiceOptions): Promise<AgentSessionService> {
    const adapter = new BetterSqliteAdapter(options.database.driver)
    const storage = await SqliteStorage.open(adapter, { prefix: 'pi_' })
    const registry = createRegistry()

    let harnessRef: Harness | undefined
    const httpDispatcherRef: { current?: InProcessHisDispatcher } = {}
    const hisAuthByConversation = new Map<number, EphemeralHisAuthContext>()
    const devReflection = createDevReflectionRuntime(options.devReflection)

    const hisBundle = createProductionHisToolsBundle({
      getDispatcher: () => httpDispatcherRef.current,
      getAuthContext: conversationId => hisAuthByConversation.get(conversationId),
      devReflection,
      onMutationCommitted: async (conversationId) => {
        if (harnessRef === undefined) return
        const conv = await harnessRef.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT)
        if (conv === undefined) return
        await conv.commit(async (tx) => {
          const doc = await tx.doc(ClinMeshPendingApprovalsDoc, conversationId as ConversationId)
          doc.mutationVersion += 1
        }, BACKGROUND_CONTEXT)
      },
    })

    const makeVisibleClinicalTool = (
      name: string,
      description: string,
      reader: (scope: { workspaceId: string; epoch: string; roleCode: string; encounterId: string | null; caseId: string | null }) => string,
    ) => defineTool({
      name,
      description,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      } as const,
      execute: async (_args, api, context) => {
        const meta = await api.snapshot(ClinMeshSessionMetaDoc, api.conversationId, context)
        if (meta === undefined || meta.kind !== 'clinician-assistant') {
          return {
            output: [{ type: 'text', text: '仅临床助手会话可读取医生可见病例信息。' }],
            isError: true,
          }
        }
        const text = reader({
          workspaceId: meta.workspaceId,
          epoch: meta.epoch,
          roleCode: meta.roleCode,
          encounterId: meta.encounterId,
          caseId: meta.caseId,
        })
        return {
          output: [{ type: 'text', text }],
        }
      },
    })

    const readVisibleCaseSummaryTool = makeVisibleClinicalTool(
      'read_visible_case_summary',
      '读取当前接诊的医生可见病例摘要（不含未公开的隐藏真值或诊断答案）。',
      scope => options.visibleCaseReader?.readVisibleCaseSummary(scope) ?? '当前会话未绑定门诊接诊病例。',
    )

    const readLabResultsTool = makeVisibleClinicalTool(
      'read_lab_results',
      '读取当前病例已向医生公开的检验申请状态与检验报告数值（仅可见结果，不含未发布或隐藏真值）。',
      scope => options.visibleCaseReader?.readLabResults?.(scope) ?? '当前会话暂无医生可见检验结果。',
    )

    const readImagingReportsTool = makeVisibleClinicalTool(
      'read_imaging_reports',
      '读取当前病例已向医生公开的放射影像、功能检查（心电图/超声）与病理会诊文本报告。',
      scope => options.visibleCaseReader?.readImagingReports?.(scope) ?? '当前会话暂无医生可见影像或检查报告。',
    )

    const readMedicationOrdersTool = makeVisibleClinicalTool(
      'read_medication_orders',
      '读取当前病例的医生可见处方草稿/医嘱、已记录诊断及过敏史信息。',
      scope => options.visibleCaseReader?.readMedicationOrders?.(scope) ?? '当前会话暂无医生可见处方与用药记录。',
    )

    const readVitalTrendsTool = makeVisibleClinicalTool(
      'read_vital_trends',
      '读取当前病例的分诊生命体征、门诊医患问诊对话与现病史草稿。',
      scope => options.visibleCaseReader?.readVitalTrends?.(scope) ?? '当前会话暂无生命体征与问诊记录。',
    )

    const proposeClinicianPreferenceTool = defineTool({
      name: 'propose_clinician_preference',
      description: '提议一条通用医生工作/输出格式偏好（如“病历整理优先采用 SOAP 结构”）。仅创建待审核提案，必须经医生手动批准后才生效，严禁包含任何患者个人信息。',
      parameters: {
        type: 'object',
        properties: {
          preference: {
            type: 'string',
            description: '简短、通用的输出风格或临床整理偏好（不含具体患者信息）。',
          },
        },
        required: ['preference'],
        additionalProperties: false,
      } as const,
      execute: async (args, api, context) => {
        const meta = await api.snapshot(ClinMeshSessionMetaDoc, api.conversationId, context)
        if (meta === undefined || meta.kind !== 'clinician-assistant' || harnessRef === undefined) {
          return {
            output: [{ type: 'text', text: '仅临床助手会话可提交偏好提案。' }],
            isError: true,
          }
        }
        const rawPreference = typeof args === 'object' && args !== null && 'preference' in args
          ? (args as { preference?: unknown }).preference
          : ''
        const content = typeof rawPreference === 'string' ? rawPreference.trim().slice(0, 600) : ''
        if (content.length === 0) {
          return {
            output: [{ type: 'text', text: '偏好内容不能为空。' }],
            isError: true,
          }
        }
        const scope = memoryScopeKey(meta.workspaceId, meta.roleCode)
        const nowIso = new Date().toISOString()
        await harnessRef.commit(async (tx) => {
          const doc = await tx.doc(ClinMeshClinicianMemoryDoc)
          const existing = doc.byScope[scope] ?? []
          if (!existing.some(item => item.content === content && item.status !== 'discarded')) {
            existing.push({
              id: `mem-${randomUUID()}`,
              content,
              status: 'pending',
              source: 'assistant',
              createdAt: nowIso,
              updatedAt: nowIso,
            })
            doc.byScope[scope] = existing
          }
        }, BACKGROUND_CONTEXT)
        return {
          output: [{ type: 'text', text: `已提交待医生审批的工作偏好提案：「${content}」（需医生手动点击批准后生效）。` }],
        }
      },
    })

    const pendingCalls = new Map<string, PendingModelCallCapture>()

    const assistantExtension = defineExtension({
      name: 'clinmesh-assistant',
      tools: [
        readVisibleCaseSummaryTool,
        readLabResultsTool,
        readImagingReportsTool,
        readMedicationOrdersTool,
        readVitalTrendsTool,
        proposeClinicianPreferenceTool,
      ],
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async (request, api, context) => {
            try {
              const meta = await api.snapshot(ClinMeshSessionMetaDoc, api.conversationId, context)
              if (meta?.kind !== 'clinician-assistant') return undefined
              const agentState = await api.snapshot(AgentDoc, api.conversationId, context)
              const modelRef = agentState?.model
              const resolvedModel = modelRef === undefined
                ? undefined
                : api.models.getModel(modelRef.provider, modelRef.modelId)
              const entriesPage = await api.entries({ order: 'ascending' }, 500, undefined, context)
              const key = `${api.conversationId}:${api.taskId}`
              pendingCalls.set(key, {
                startedAtMs: Date.now(),
                startedAtIso: new Date().toISOString(),
                provider: resolvedModel?.provider ?? modelRef?.provider ?? 'unknown',
                modelId: resolvedModel?.id ?? modelRef?.modelId ?? 'unknown',
                contextWindow: resolvedModel?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
                maxOutputTokens: resolvedModel?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
                included: buildIncludedItemsFromRequestMessages(request.messages),
                excluded: buildExcludedItemsFromEntries(entriesPage.items),
              })
            } catch (error) {
              options.onReport?.('context-snapshot:beforeRequest', error)
            }
            return undefined
          },
          afterResponse: async (message, api, context) => {
            const key = `${api.conversationId}:${api.taskId}`
            const pending = pendingCalls.get(key)
            pendingCalls.delete(key)
            if (harnessRef === undefined) return
            try {
              const meta = await api.snapshot(ClinMeshSessionMetaDoc, api.conversationId, context)
              if (meta?.kind !== 'clinician-assistant') return
              const providerDoc = await api.snapshot(ProviderDoc, api.conversationId, context)
              const ttftMs = providerDoc?.sessionId !== undefined
                ? options.providers.consumeLastTtftMs(providerDoc.sessionId)
                : null
              const endedAtMs = Date.now()
              const startedAtMs = pending?.startedAtMs ?? endedAtMs
              const rawProvider = message.provider || pending?.provider || 'unknown'
              const simulated = rawProvider === INTERNAL_PROVIDER_IDS.mock
              const { items: responseItems, toolNames } = extractAssistantItems(message)
              const status = message.stopReason === 'error'
                ? 'ERROR'
                : message.stopReason === 'aborted'
                  ? 'ABORTED'
                  : 'COMPLETED'
              const safeErrorMessage = message.errorMessage === undefined
                ? undefined
                : options.providers.redact(message.errorMessage)

              await harnessRef.commit(async (tx) => {
                const snapDoc = await tx.doc(ClinMeshContextSnapshotsDoc, api.conversationId)
                appendModelCallSnapshot(snapDoc, {
                  purpose: 'TURN',
                  provider: publicProviderLabel(rawProvider),
                  model: message.model || pending?.modelId || 'unknown',
                  contextWindow: pending?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
                  maxOutputTokens: pending?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
                  startedAt: pending?.startedAtIso ?? new Date(startedAtMs).toISOString(),
                  endedAt: new Date(endedAtMs).toISOString(),
                  durationMs: Math.max(0, endedAtMs - startedAtMs),
                  ttftMs,
                  tokensPerSecond: null,
                  status,
                  ...(safeErrorMessage === undefined ? {} : { errorMessage: safeErrorMessage }),
                  providerUsage: message.usage,
                  simulated,
                  included: pending?.included ?? [],
                  excluded: pending?.excluded ?? [],
                  response: responseItems,
                  responseToolNames: toolNames,
                })
                if (message.stopReason === 'stop') {
                  const fallbackReflection = devReflection.buildFallbackWatchdogReflection(api.conversationId)
                  if (fallbackReflection !== null) {
                    const reflDoc = await tx.doc(ClinMeshDevReflectionsDoc, api.conversationId)
                    reflDoc.items = [...reflDoc.items.slice(-7), fallbackReflection]
                  }
                }
              }, BACKGROUND_CONTEXT)
            } catch (error) {
              options.onReport?.('context-snapshot:afterResponse', error)
            }
          },
        }),
        hook(CompactionTask, {
          beforeCompact: async (compaction, api, context) => {
            if (harnessRef === undefined) return undefined
            try {
              const meta = await api.snapshot(ClinMeshSessionMetaDoc, api.conversationId, context)
              if (meta?.kind !== 'clinician-assistant') return undefined
              const removedItems = buildIncludedItemsFromRequestMessages(compaction.messages)
              const reclaimedTokens = removedItems.reduce((sum, item) => sum + estimateTextTokens(item.content), 0)
              await harnessRef.commit(async (tx) => {
                const snapDoc = await tx.doc(ClinMeshContextSnapshotsDoc, api.conversationId)
                appendContextEvent(snapDoc, {
                  kind: 'COMPACT',
                  removedCount: compaction.entries.length,
                  reclaimedTokens,
                  summaryTokens: Math.max(1, Math.round(reclaimedTokens * 0.25)),
                  summarizedByModel: true,
                  summaryPreview: compaction.instructions ?? (
                    compaction.reason === 'manual' ? '手动触发上下文压缩' : '自动触发上下文压缩'
                  ),
                })
              }, BACKGROUND_CONTEXT)
            } catch (error) {
              options.onReport?.('context-snapshot:beforeCompact', error)
            }
            return undefined
          },
        }),
      ],
    })
    const baseAssistantTools: readonly ToolRegistration[] = [
      readVisibleCaseSummaryTool,
      readLabResultsTool,
      readImagingReportsTool,
      readMedicationOrdersTool,
      readVitalTrendsTool,
      proposeClinicianPreferenceTool,
    ]
    const toolSearchExtension = createToolSearchExtension()
    const codemodeSandbox = new CodemodeSandbox()
    const codemodeExtension = createCodemodeExtension({
      sandbox: codemodeSandbox,
      models: false,
      inlineBudget: 2_400,
    })
    const allAssistantExtensions: readonly Extension[] = [
      assistantExtension,
      toolSearchExtension,
      codemodeExtension,
      hisBundle.macroExtension,
      hisBundle.uiBridgeExtension,
      devReflection.extension,
      ...hisBundle.domainExtensions,
    ]
    for (const ext of allAssistantExtensions) {
      registry.install(ext)
    }

    const harness = await Harness.open(
      storage,
      {
        models: () => options.providers.models,
        registry,
        settings: {
          extensions: [],
          compaction: {
            ...DEFAULT_COMPACTION_POLICY,
            enabled: true,
          },
          steeringMode: 'one-at-a-time',
          followUpMode: 'one-at-a-time',
          progress: {
            partialIntervalMs: 40,
            outputIntervalMs: 40,
            persistWithinMs: 250,
          },
          retry: {
            enabled: true,
            maxRetries: 2,
            baseDelayMs: 500,
            maxAgentDelayMs: 30_000,
          },
        },
        onReport: (report) => {
          options.onReport?.(`pi-durable:${report.kind}`, report.error)
        },
      },
      BACKGROUND_CONTEXT,
    )
    harnessRef = harness
    harness.resume()

    return new AgentSessionService(
      harness,
      adapter,
      options.providers,
      assistantExtension,
      allAssistantExtensions,
      baseAssistantTools,
      toolSearchExtension.tools ?? [],
      codemodeExtension.tools ?? [],
      hisBundle,
      devReflection,
      httpDispatcherRef,
      hisAuthByConversation,
      options.visibleCaseReader,
    )
  }

  attachHttpDispatcher(dispatcher: InProcessHisDispatcher): void {
    this.#httpDispatcherRef.current = dispatcher
  }

  #clinicianAgentConfig(
    meta: StoredSessionMeta,
    approvedMemories: readonly StoredClinicianMemoryItem[],
  ) {
    const isOutpatientDoctor = meta.roleCode === 'outpatient-doctor'
    const roleMacros = isOutpatientDoctor
      ? this.#hisBundle.macroTools
      : this.#hisBundle.macroTools.filter(
          t => t.name === 'read_clinical_playbook' || t.name === 'list_agent_capabilities',
        )
    const roleHisTools = this.#hisBundle.getRoleAllowedHisTools(meta.roleCode)
    const allowedTools: ToolRegistration[] = [
      ...this.#baseAssistantTools,
      ...this.#toolSearchTools,
      ...this.#codemodeTools,
      ...roleMacros,
      ...this.#hisBundle.uiBridgeTools,
      ...this.#devReflection.tools,
      ...roleHisTools,
    ]
    return {
      extensions: this.#allAssistantExtensions,
      tools: allowedTools,
      instructions: clinicianAssistantSystemPrompt(meta, approvedMemories, this.#devReflection.enabled),
      compaction: { enabled: meta.autoCompact ?? true },
    }
  }

  #bindEphemeralHisAuth(conversationId: number, meta: StoredSessionMeta, headers: Headers): void {
    const cookie = headers.get('cookie')?.trim()
    const authorization = headers.get('authorization')?.trim()
    const originHeader = headers.get('origin')?.trim()
    const hostHeader = headers.get('host')?.trim()
    const origin = originHeader && originHeader.startsWith('http')
      ? originHeader
      : hostHeader
        ? `http://${hostHeader}`
        : 'http://localhost'
    this.#hisAuthByConversation.set(conversationId, {
      ...(cookie ? { cookie } : {}),
      ...(authorization ? { authorization } : {}),
      origin,
      roleCode: meta.roleCode,
      workspaceId: meta.workspaceId,
      epoch: meta.epoch,
      caseId: meta.caseId,
      encounterId: meta.encounterId,
    })
  }

  get providers(): ClinMeshProviderRegistry {
    return this.#providers
  }

  get harness(): Harness {
    return this.#harness
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#shutdown.abort()
    for (const controller of this.#activeWatchers) {
      controller.abort()
    }
    this.#activeWatchers.clear()
    this.#hisAuthByConversation.clear()
    await this.#harness.close(BACKGROUND_CONTEXT)
    await this.#adapter.close()
  }

  async listClinicianSessions(
    actor: ActorContext,
    filter: { encounterId?: string | null } = {},
  ): Promise<AgentSessionSummary[]> {
    const index = await this.#harness.snapshot(ClinMeshSessionIndexDoc, BACKGROUND_CONTEXT)
    if (index === undefined) return []
    const matching = Object.values(index.bySessionId).filter((item) => {
      if (item.deleted || item.kind !== 'clinician-assistant') return false
      if (item.workspaceId !== actor.workspaceId || item.epoch !== actor.epoch || item.roleCode !== actor.roleCode) {
        return false
      }
      if (filter.encounterId !== undefined) {
        return item.encounterId === filter.encounterId
      }
      return true
    })

    const summaries: AgentSessionSummary[] = []
    for (const item of matching) {
      const conversationId = item.conversationId as ConversationId
      const meta = await this.#harness.snapshot(ClinMeshSessionMetaDoc, conversationId, BACKGROUND_CONTEXT)
      if (meta === undefined || meta.deleted) continue
      const live = await this.#harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT)
      const conv = await this.#harness.conversation(conversationId, BACKGROUND_CONTEXT)
      if (conv === undefined) continue
      const page = await conv.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT)
      const { messages } = projectMessagesFromEntries(page.items, live)
      summaries.push(summarizeMeta(conversationId, meta, live, messages.length))
    }
    return summaries.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async createClinicianSession(
    actor: ActorContext,
    input: CreateAgentSessionRequest,
  ): Promise<AgentSessionDetail> {
    const sessionId = `asess-${randomUUID()}`
    const nowIso = new Date().toISOString()
    const scope: AgentSessionScope = {
      workspaceId: actor.workspaceId,
      epoch: actor.epoch,
      roleCode: actor.roleCode,
      encounterId: input.encounterId ?? null,
      caseId: input.caseId ?? null,
      patientId: input.patientId ?? null,
    }
    const meta: StoredSessionMeta = {
      sessionId,
      kind: 'clinician-assistant',
      title: input.title ?? '新临床助手对话',
      workspaceId: scope.workspaceId,
      epoch: scope.epoch,
      roleCode: scope.roleCode,
      encounterId: scope.encounterId,
      caseId: scope.caseId,
      patientId: scope.patientId,
      forkedFromSessionId: null,
      forkedFromEntryId: null,
      customInstructions: input.customInstructions?.trim() || null,
      autoCompact: input.autoCompact ?? true,
      deleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    }
    const approvedMemories = await this.#approvedMemoriesFor(actor)
    const conversation = await this.#harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: this.#clinicianAgentConfig(meta, approvedMemories),
      init: async (tx, conversationId) => {
        // Ensure ProviderDoc exists immediately so transient BYOK credentials bind stably.
        await tx.doc(ProviderDoc, conversationId)
        const doc = await tx.doc(ClinMeshSessionMetaDoc, conversationId)
        Object.assign(doc, meta)
        const index = await tx.doc(ClinMeshSessionIndexDoc)
        index.bySessionId[sessionId] = {
          sessionId,
          conversationId,
          kind: 'clinician-assistant',
          workspaceId: scope.workspaceId,
          epoch: scope.epoch,
          roleCode: scope.roleCode,
          encounterId: scope.encounterId,
          caseId: scope.caseId,
          patientId: scope.patientId,
          deleted: false,
        }
      },
    }, BACKGROUND_CONTEXT)
    return this.#buildDetail(conversation)
  }

  async getClinicianSession(actor: ActorContext, sessionId: string): Promise<AgentSessionDetail> {
    const { conversation } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    return this.#buildDetail(conversation)
  }

  async getClinicianSessionContext(actor: ActorContext, sessionId: string): Promise<SessionContextResponse> {
    const { conversation } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const snapDoc = await this.#harness.snapshot(ClinMeshContextSnapshotsDoc, conversation.id, BACKGROUND_CONTEXT)
    return summarizeSessionContext(sessionId, snapDoc)
  }

  async getClinicianModelCallDetail(
    actor: ActorContext,
    sessionId: string,
    callId: string,
  ): Promise<ModelCallDetail> {
    const { conversation } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const snapDoc = await this.#harness.snapshot(ClinMeshContextSnapshotsDoc, conversation.id, BACKGROUND_CONTEXT)
    const detail = hydrateModelCallDetail(snapDoc, callId)
    if (detail === null) {
      throw new AgentSessionError('AGENT_SESSION_NOT_FOUND', '未找到指定的模型调用上下文快照。', 404)
    }
    return detail
  }

  async renameClinicianSession(
    actor: ActorContext,
    sessionId: string,
    title: string,
  ): Promise<AgentSessionSummary> {
    return this.updateClinicianSession(actor, sessionId, { title })
  }

  async updateClinicianSession(
    actor: ActorContext,
    sessionId: string,
    input: RenameAgentSessionRequest,
  ): Promise<AgentSessionSummary> {
    const { conversation } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    if (input.title !== undefined && input.title.trim().length === 0) {
      throw new AgentSessionError('AGENT_SESSION_INVALID', '会话名称不能为空', 400)
    }
    let updatedMeta: StoredSessionMeta | undefined
    await conversation.commit(async (tx) => {
      const meta = await tx.doc(ClinMeshSessionMetaDoc, conversation.id)
      if (input.title !== undefined) {
        meta.title = input.title.trim().slice(0, 160)
      }
      if (input.customInstructions !== undefined) {
        meta.customInstructions = input.customInstructions === null || input.customInstructions.trim().length === 0
          ? null
          : input.customInstructions.trim().slice(0, 4_000)
      }
      if (input.autoCompact !== undefined) {
        meta.autoCompact = input.autoCompact
      }
      meta.updatedAt = new Date().toISOString()
      updatedMeta = { ...meta }
    }, BACKGROUND_CONTEXT)

    if (updatedMeta !== undefined && (input.customInstructions !== undefined || input.autoCompact !== undefined)) {
      const approvedMemories = await this.#approvedMemoriesFor(actor)
      await conversation.configure({
        instructions: clinicianAssistantSystemPrompt(updatedMeta, approvedMemories),
        compaction: { enabled: updatedMeta.autoCompact ?? true },
      }, BACKGROUND_CONTEXT)
    }

    const detail = await this.#buildDetail(conversation)
    return detail.session
  }

  async deleteClinicianSession(actor: ActorContext, sessionId: string): Promise<void> {
    const { conversation } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    await conversation.abort(BACKGROUND_CONTEXT).catch(() => undefined)
    await this.#harness.commit(async (tx) => {
      const meta = await tx.doc(ClinMeshSessionMetaDoc, conversation.id)
      meta.deleted = true
      meta.updatedAt = new Date().toISOString()
      const index = await tx.doc(ClinMeshSessionIndexDoc)
      const entry = index.bySessionId[sessionId]
      if (entry !== undefined) entry.deleted = true
    }, BACKGROUND_CONTEXT)
  }

  async forkClinicianSession(
    actor: ActorContext,
    sessionId: string,
    input: ForkAgentSessionRequest,
  ): Promise<AgentSessionDetail> {
    const { conversation, meta } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const page = await conversation.entries({ order: 'ascending' }, 500, undefined, BACKGROUND_CONTEXT)
    const targetEntryId = (input.atEntryId ?? page.items[page.items.length - 1]?.id) as EntryId | undefined
    if (targetEntryId === undefined) {
      // Empty conversation: create a fresh sibling session inheriting scope & title.
      return this.createClinicianSession(actor, {
        title: input.title ?? deriveForkTitle(meta.title),
        encounterId: meta.encounterId,
        caseId: meta.caseId,
        patientId: meta.patientId,
      })
    }

    const newSessionId = `asess-${randomUUID()}`
    const nowIso = new Date().toISOString()
    const forkedMeta: StoredSessionMeta = {
      ...meta,
      sessionId: newSessionId,
      title: input.title ?? deriveForkTitle(meta.title),
      forkedFromSessionId: meta.sessionId,
      forkedFromEntryId: targetEntryId,
      deleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    }
    const approvedMemories = await this.#approvedMemoriesFor(actor)
    const forked = await conversation.fork(targetEntryId, {
      ownership: { kind: 'ownerless' },
      agent: this.#clinicianAgentConfig(forkedMeta, approvedMemories),
      init: async (tx, newConversationId) => {
        await tx.doc(ProviderDoc, newConversationId)
        const doc = await tx.doc(ClinMeshSessionMetaDoc, newConversationId)
        Object.assign(doc, forkedMeta)
        const index = await tx.doc(ClinMeshSessionIndexDoc)
        index.bySessionId[newSessionId] = {
          sessionId: newSessionId,
          conversationId: newConversationId,
          kind: 'clinician-assistant',
          workspaceId: forkedMeta.workspaceId,
          epoch: forkedMeta.epoch,
          roleCode: forkedMeta.roleCode,
          encounterId: forkedMeta.encounterId,
          caseId: forkedMeta.caseId,
          patientId: forkedMeta.patientId,
          deleted: false,
        }
      },
    }, BACKGROUND_CONTEXT)
    return this.#buildDetail(forked)
  }

  async sendClinicianMessage(
    actor: ActorContext,
    sessionId: string,
    input: SendAgentMessageRequest,
    headers: Headers,
  ): Promise<AgentSessionDetail> {
    const { conversation, meta } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const resolved = this.#providers.resolveTurnConfig('assistant', headers)
    if (resolved === null) {
      throw new AgentSessionError(
        'LLM_PROVIDER_UNCONFIGURED',
        '未配置模型 API Key。请前往“设置 -> 模型与服务商”填写 API Key，或显式开启“演示 / Mock 模式”。',
        503,
      )
    }

    const providerSessionId = await this.#ensureProviderSessionId(conversation)
    const bindingToken = this.#providers.bindTurn(providerSessionId, resolved)
    const approvedMemories = await this.#approvedMemoriesFor(actor)
    this.#bindEphemeralHisAuth(conversation.id, meta, headers)
    this.#devReflection.startTurn(conversation.id)

    try {
      await conversation.configure({
        model: { provider: resolved.internalProviderId, modelId: resolved.modelId },
        thinkingLevel: resolved.thinkingLevel,
        ...this.#clinicianAgentConfig(meta, approvedMemories),
      }, BACKGROUND_CONTEXT)

      await conversation.commit(async (tx) => {
        const doc = await tx.doc(ClinMeshSessionMetaDoc, conversation.id)
        if (doc.title === '新临床助手对话' || doc.title === '新对话') {
          doc.title = deriveSessionTitle(input.content)
        }
        doc.updatedAt = new Date().toISOString()
      }, BACKGROUND_CONTEXT)

      const submission = await conversation.submit({
        type: 'input',
        content: input.content,
        whenBusy: input.whenBusy ?? 'reject',
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      }, BACKGROUND_CONTEXT)

      void submission.wait(BACKGROUND_CONTEXT)
        .then(() => undefined, () => undefined)
        .finally(() => {
          this.#providers.releaseTurn(providerSessionId, bindingToken)
        })
    } catch (error) {
      this.#providers.releaseTurn(providerSessionId, bindingToken)
      if (error instanceof ConversationBusy) {
        throw new AgentSessionError('AGENT_SESSION_BUSY', '助手正在生成回复，请等待完成或先停止生成。', 409)
      }
      throw error
    }

    return this.#buildDetail(conversation)
  }

  async recallQueuedClinicianInput(
    actor: ActorContext,
    sessionId: string,
    submissionId: number,
  ): Promise<{ recalled: boolean; content: string; detail: AgentSessionDetail }> {
    const { conversation } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const inbox = await this.#harness.snapshot(InboxDoc, conversation.id, BACKGROUND_CONTEXT)
    const matched = inbox?.items.find(item => item.id === submissionId && (item.mode === 'steer' || item.mode === 'followUp'))
    const content = matched !== undefined && 'content' in matched ? extractInboxContentText(matched.content) : ''
    const status = await this.#harness.abortSubmission(submissionId as SubmissionId, BACKGROUND_CONTEXT, conversation.id)
    const detail = await this.#buildDetail(conversation)
    return {
      recalled: status === 'aborted',
      content,
      detail,
    }
  }

  async compactClinicianSession(
    actor: ActorContext,
    sessionId: string,
    input: CompactAgentSessionRequest,
    headers: Headers,
  ): Promise<AgentSessionDetail> {
    const { conversation, meta } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const resolved = this.#providers.resolveTurnConfig('assistant', headers)
    if (resolved === null) {
      throw new AgentSessionError(
        'LLM_PROVIDER_UNCONFIGURED',
        '未配置模型 API Key。请前往“设置 -> 模型与服务商”填写 API Key，选择本地 CLI 服务商或开启 Mock 模式。',
        503,
      )
    }

    const providerSessionId = await this.#ensureProviderSessionId(conversation)
    const bindingToken = this.#providers.bindTurn(providerSessionId, resolved)
    const approvedMemories = await this.#approvedMemoriesFor(actor)

    try {
      await conversation.configure({
        model: { provider: resolved.internalProviderId, modelId: resolved.modelId },
        thinkingLevel: 'off',
        extensions: [this.#assistantExtension],
        instructions: clinicianAssistantSystemPrompt(meta, approvedMemories),
        // Manual /compact allows compacting shorter active transcripts too, while preserving
        // the default automatic compaction policy right after completion.
        compaction: {
          ...DEFAULT_COMPACTION_POLICY,
          enabled: meta.autoCompact ?? true,
          keepRecentTokens: 0,
        },
      }, BACKGROUND_CONTEXT)

      const taskId = await conversation.compact(input.instructions, BACKGROUND_CONTEXT)
      await this.#harness.waitForTask(taskId, BACKGROUND_CONTEXT)
    } finally {
      await conversation.configure({
        compaction: {
          ...DEFAULT_COMPACTION_POLICY,
          enabled: meta.autoCompact ?? true,
        },
      }, BACKGROUND_CONTEXT).catch(() => undefined)
      this.#providers.releaseTurn(providerSessionId, bindingToken)
    }

    return this.#buildDetail(conversation)
  }

  async resetClinicianSession(
    actor: ActorContext,
    sessionId: string,
    input: ResetAgentSessionRequest,
  ): Promise<AgentSessionDetail> {
    const { conversation } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const contextView = await conversation.context(BACKGROUND_CONTEXT)
    const removedCount = contextView.entries.length
    const reclaimedTokens = buildIncludedItemsFromRequestMessages(contextView.messages)
      .reduce((sum, item) => sum + estimateTextTokens(item.content), 0)

    await conversation.reset(input.handoff, BACKGROUND_CONTEXT)
    await conversation.commit(async (tx) => {
      const snapDoc = await tx.doc(ClinMeshContextSnapshotsDoc, conversation.id)
      appendContextEvent(snapDoc, {
        kind: 'RESET',
        removedCount,
        reclaimedTokens,
        summaryTokens: input.handoff ? estimateTextTokens(input.handoff) : 0,
        summarizedByModel: false,
        summaryPreview: input.handoff ?? '手动重置上下文窗口',
      })
      const meta = await tx.doc(ClinMeshSessionMetaDoc, conversation.id)
      meta.updatedAt = new Date().toISOString()
    }, BACKGROUND_CONTEXT)

    return this.#buildDetail(conversation)
  }

  async runSideChatQuestion(
    actor: ActorContext,
    sessionId: string,
    input: SideChatRequest,
    headers: Headers,
    signal?: AbortSignal,
  ): Promise<SideChatResponse> {
    const { conversation, meta } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const resolved = this.#providers.resolveTurnConfig('assistant', headers)
    if (resolved === null) {
      throw new AgentSessionError(
        'LLM_PROVIDER_UNCONFIGURED',
        '未配置模型 API Key。请前往“设置 -> 模型与服务商”填写 API Key，选择本地 CLI 服务商或开启 Mock 模式。',
        503,
      )
    }

    const visibleSummary = this.#visibleCaseReader?.readVisibleCaseSummary({
      workspaceId: meta.workspaceId,
      epoch: meta.epoch,
      roleCode: meta.roleCode,
      encounterId: meta.encounterId,
      caseId: meta.caseId,
    })
    const recentPage = await conversation.entries({ order: 'descending' }, 6, undefined, BACKGROUND_CONTEXT)
    const recentExcerpts = recentPage.items
      .toReversed()
      .map((entry) => {
        if (UserEntry.is(entry)) return `医生：${extractUserText(entry.model).slice(0, 240)}`
        if (AssistantEntry.is(entry)) {
          const msg = entry.model?.[0]
          if (msg?.role === 'assistant') {
            const txt = msg.content
              .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
              .map(p => p.text)
              .join(' ')
              .slice(0, 320)
            if (txt.length > 0) return `助手：${txt}`
          }
        }
        return null
      })
      .filter((line): line is string => line !== null)

    const systemPrompt = [
      '你是 ClinMesh 临床助手的轻量级「侧边追问」模式。',
      '此对话完全独立，不写入也不污染主诊会话上下文；请简洁、直接回答医生的局部疑问（如用药剂量核对、鉴别要点、检验指标含义）。',
      '严禁臆造未报告结果或泄露任何未公开病例真值。',
      ...(visibleSummary ? ['', '【当前病例医生可见摘要】', visibleSummary] : []),
      ...(recentExcerpts.length > 0 ? ['', '【主对话最近上下文摘录】', ...recentExcerpts] : []),
    ].join('\n')

    const userContent = input.quote && input.quote.trim().length > 0
      ? `引用主对话片段：\n> ${input.quote.trim()}\n\n追问：${input.question.trim()}`
      : input.question.trim()

    const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [
      ...(input.history ?? []),
      { role: 'user', text: userContent },
    ]

    try {
      return await this.#providers.runEphemeralCompletion(resolved, { systemPrompt, messages }, signal)
    } catch (error) {
      const safe = this.#providers.redact(error instanceof Error ? error.message : String(error))
      const classified = classifyLlmError(safe)
      throw new AgentSessionError(classified.code as AgentSessionErrorCode, classified.message, 503)
    }
  }

  async runStandaloneSideChatQuestion(
    actor: ActorContext,
    input: SideChatRequest,
    headers: Headers,
    signal?: AbortSignal,
  ): Promise<SideChatResponse> {
    const resolved = this.#providers.resolveTurnConfig('assistant', headers)
    if (resolved === null) {
      throw new AgentSessionError(
        'LLM_PROVIDER_UNCONFIGURED',
        '未配置模型 API Key。请前往“设置 -> 模型与服务商”填写 API Key，选择本地 CLI 服务商或开启 Mock 模式。',
        503,
      )
    }

    const visibleSummary = this.#visibleCaseReader?.readVisibleCaseSummary({
      workspaceId: actor.workspaceId,
      epoch: actor.epoch,
      roleCode: actor.roleCode,
      encounterId: input.encounterId ?? null,
      caseId: input.caseId ?? null,
    })

    const systemPrompt = [
      '你是 ClinMesh 临床助手的轻量级「侧边追问」模式。',
      '此对话完全独立，不写入也不污染主诊会话上下文；请简洁、直接回答医生的局部疑问（如用药剂量核对、鉴别要点、检验指标含义）。',
      '严禁臆造未报告结果或泄露任何未公开病例真值。',
      ...(visibleSummary ? ['', '【当前病例医生可见摘要】', visibleSummary] : []),
    ].join('\n')

    const userContent = input.quote && input.quote.trim().length > 0
      ? `引用片段：\n> ${input.quote.trim()}\n\n追问：${input.question.trim()}`
      : input.question.trim()

    const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [
      ...(input.history ?? []),
      { role: 'user', text: userContent },
    ]

    try {
      return await this.#providers.runEphemeralCompletion(resolved, { systemPrompt, messages }, signal)
    } catch (error) {
      const safe = this.#providers.redact(error instanceof Error ? error.message : String(error))
      const classified = classifyLlmError(safe)
      throw new AgentSessionError(classified.code as AgentSessionErrorCode, classified.message, 503)
    }
  }

  listClinicalEntitiesForScope(
    actor: ActorContext,
    scope: { encounterId: string | null; caseId: string | null },
  ): ClinicalEntitiesResponse {
    const entities = this.#visibleCaseReader?.listVisibleMentions?.({
      workspaceId: actor.workspaceId,
      epoch: actor.epoch,
      roleCode: actor.roleCode,
      encounterId: scope.encounterId,
      caseId: scope.caseId,
    }) ?? []
    return {
      encounterId: scope.encounterId,
      caseId: scope.caseId,
      entities,
    }
  }

  async listClinicalEntities(
    actor: ActorContext,
    sessionId: string,
  ): Promise<ClinicalEntitiesResponse> {
    const { meta } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const entities = this.#visibleCaseReader?.listVisibleMentions?.({
      workspaceId: meta.workspaceId,
      epoch: meta.epoch,
      roleCode: meta.roleCode,
      encounterId: meta.encounterId,
      caseId: meta.caseId,
    }) ?? []
    return {
      encounterId: meta.encounterId,
      caseId: meta.caseId,
      entities,
    }
  }

  async searchClinicianSessions(
    actor: ActorContext,
    rawQuery: string,
    filter: { encounterId?: string | null } = {},
  ): Promise<SearchAgentSessionsResponse> {
    const query = rawQuery.trim()
    if (query.length === 0) return { query: '', matches: [] }
    const lowerQuery = query.toLowerCase()
    const index = await this.#harness.snapshot(ClinMeshSessionIndexDoc, BACKGROUND_CONTEXT)
    if (index === undefined) return { query, matches: [] }

    const candidates = Object.values(index.bySessionId).filter((item) => {
      if (item.deleted || item.kind !== 'clinician-assistant') return false
      if (item.workspaceId !== actor.workspaceId || item.epoch !== actor.epoch || item.roleCode !== actor.roleCode) {
        return false
      }
      if (filter.encounterId !== undefined) return item.encounterId === filter.encounterId
      return true
    })

    const matches: SearchAgentSessionsResponse['matches'] = []
    for (const item of candidates) {
      const conversationId = item.conversationId as ConversationId
      const meta = await this.#harness.snapshot(ClinMeshSessionMetaDoc, conversationId, BACKGROUND_CONTEXT)
      if (meta === undefined || meta.deleted) continue
      const live = await this.#harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT)
      const conv = await this.#harness.conversation(conversationId, BACKGROUND_CONTEXT)
      if (conv === undefined) continue
      const page = await conv.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT)
      const { messages } = projectMessagesFromEntries(page.items, live)
      const summary = summarizeMeta(conversationId, meta, live, messages.length)

      if (meta.title.toLowerCase().includes(lowerQuery)) {
        matches.push({ session: summary, snippet: meta.title, matchedIn: 'title' })
        continue
      }

      for (const msg of messages) {
        const text = msg.blocks
          .filter((b): b is Extract<AgentContentBlock, { type: 'text' }> => b.type === 'text')
          .map(b => b.text)
          .join(' ')
        const idx = text.toLowerCase().indexOf(lowerQuery)
        if (idx >= 0) {
          const start = Math.max(0, idx - 28)
          const end = Math.min(text.length, idx + query.length + 56)
          const prefix = start > 0 ? '…' : ''
          const suffix = end < text.length ? '…' : ''
          matches.push({
            session: summary,
            snippet: `${prefix}${text.slice(start, end).replace(/\s+/g, ' ')}${suffix}`,
            matchedIn: 'message',
          })
          break
        }
      }
    }

    matches.sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))
    return { query, matches }
  }

  async exportClinicianSessionMarkdown(
    actor: ActorContext,
    sessionId: string,
  ): Promise<ExportAgentSessionResponse> {
    const { conversation, meta } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const detail = await this.#buildDetail(conversation)
    const lines: string[] = [
      `# ${meta.title}`,
      '',
      `- **导出时间**：${new Date().toISOString()}`,
      `- **会话 ID**：\`${meta.sessionId}\``,
      ...(meta.encounterId ? [`- **接诊 Encounter**：\`${meta.encounterId}\``] : []),
      ...(meta.caseId ? [`- **病例 ID**：\`${meta.caseId}\``] : []),
      ...(meta.customInstructions ? [`- **会话临床指令**：${meta.customInstructions}`] : []),
      '',
      '---',
      '',
    ]

    for (const msg of detail.messages) {
      if (msg.role === 'system') {
        const text = msg.blocks
          .filter((b): b is Extract<AgentContentBlock, { type: 'text' }> => b.type === 'text')
          .map(b => b.text)
          .join('\n')
        lines.push(`> **[系统边界]** ${text}`, '')
        continue
      }
      if (msg.role === 'user') {
        const text = msg.blocks
          .filter((b): b is Extract<AgentContentBlock, { type: 'text' }> => b.type === 'text')
          .map(b => b.text)
          .join('\n')
        lines.push(`## 医生提问`, '', text, '')
        continue
      }
      const text = msg.blocks
        .filter((b): b is Extract<AgentContentBlock, { type: 'text' }> => b.type === 'text')
        .map(b => b.text)
        .join('\n\n')
      const tools = msg.blocks
        .filter((b): b is Extract<AgentContentBlock, { type: 'tool-call' }> => b.type === 'tool-call')
      const metaLabel = [msg.model, msg.durationMs ? `${(msg.durationMs / 1000).toFixed(1)}s` : null]
        .filter(Boolean)
        .join(' · ')
      lines.push(`## 临床助手${metaLabel ? `（${metaLabel}）` : ''}`, '')
      if (tools.length > 0) {
        lines.push(`*调用只读工具：${tools.map(t => `\`${t.name}\``).join('、')}*`, '')
      }
      if (text.length > 0) {
        lines.push(text, '')
      }
    }

    const safeSlug = meta.title.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || meta.sessionId
    return {
      sessionId: meta.sessionId,
      title: meta.title,
      filename: `clinmesh-${safeSlug}.md`,
      markdown: lines.join('\n').trim() + '\n',
    }
  }

  async listClinicianMemories(actor: ActorContext): Promise<ClinicianMemoryItem[]> {
    const doc = await this.#harness.snapshot(ClinMeshClinicianMemoryDoc, BACKGROUND_CONTEXT)
    const items = doc?.byScope[memoryScopeKey(actor.workspaceId, actor.roleCode)] ?? []
    return items.filter(item => item.status !== 'discarded')
  }

  async createClinicianMemory(
    actor: ActorContext,
    input: CreateClinicianMemoryRequest,
  ): Promise<ClinicianMemoryItem[]> {
    const scope = memoryScopeKey(actor.workspaceId, actor.roleCode)
    const nowIso = new Date().toISOString()
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ClinMeshClinicianMemoryDoc)
      const list = doc.byScope[scope] ?? []
      list.unshift({
        id: `mem-${randomUUID()}`,
        content: input.content.trim().slice(0, 600),
        status: input.status ?? 'approved',
        source: 'user',
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      doc.byScope[scope] = list
    }, BACKGROUND_CONTEXT)
    return this.listClinicianMemories(actor)
  }

  async updateClinicianMemory(
    actor: ActorContext,
    memoryId: string,
    input: UpdateClinicianMemoryRequest,
  ): Promise<ClinicianMemoryItem[]> {
    const scope = memoryScopeKey(actor.workspaceId, actor.roleCode)
    const nowIso = new Date().toISOString()
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ClinMeshClinicianMemoryDoc)
      const list = doc.byScope[scope] ?? []
      const target = list.find(item => item.id === memoryId)
      if (target === undefined) {
        throw new AgentSessionError('AGENT_SESSION_NOT_FOUND', '未找到指定的偏好记忆项。', 404)
      }
      if (input.status !== undefined) target.status = input.status
      if (input.content !== undefined && input.content.trim().length > 0) {
        target.content = input.content.trim().slice(0, 600)
      }
      target.updatedAt = nowIso
    }, BACKGROUND_CONTEXT)
    return this.listClinicianMemories(actor)
  }

  async deleteClinicianMemory(
    actor: ActorContext,
    memoryId: string,
  ): Promise<ClinicianMemoryItem[]> {
    const scope = memoryScopeKey(actor.workspaceId, actor.roleCode)
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ClinMeshClinicianMemoryDoc)
      const list = doc.byScope[scope] ?? []
      doc.byScope[scope] = list.filter(item => item.id !== memoryId)
    }, BACKGROUND_CONTEXT)
    return this.listClinicianMemories(actor)
  }

  async stopClinicianSession(actor: ActorContext, sessionId: string): Promise<AgentSessionDetail> {
    const { conversation } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    await conversation.abort(BACKGROUND_CONTEXT)
    return this.#buildDetail(conversation)
  }

  async resolveClinicianApproval(
    actor: ActorContext,
    sessionId: string,
    approvalId: string,
    input: ResolveAgentApprovalRequest,
    headers: Headers,
  ): Promise<AgentSessionDetail> {
    const { conversation, meta } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const approvalsDoc = await this.#harness.snapshot(ClinMeshPendingApprovalsDoc, conversation.id, BACKGROUND_CONTEXT)
    const pending = approvalsDoc?.items.find(item => item.approvalId === approvalId)
    if (pending === undefined) {
      throw new AgentSessionError('AGENT_APPROVAL_NOT_FOUND', '未找到待确认的高危操作，可能已处理或已超时。', 404)
    }

    // Refresh ephemeral clinician cookie/origin from the explicit approval click request
    this.#bindEphemeralHisAuth(conversation.id, meta, headers)

    const delivery = await this.#harness.signal(
      pending.taskId as TaskId,
      ClinicianApprovalSignal,
      approvalId,
      {
        approved: input.approved,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
      BACKGROUND_CONTEXT,
    )
    if (delivery === 'not_found' || delivery === 'closed') {
      await conversation.commit(async (tx) => {
        const doc = await tx.doc(ClinMeshPendingApprovalsDoc, conversation.id)
        doc.items = doc.items.filter(item => item.approvalId !== approvalId)
      }, BACKGROUND_CONTEXT)
    }
    return this.#buildDetail(conversation)
  }

  async submitUiBridgeResult(
    actor: ActorContext,
    sessionId: string,
    requestId: string,
    input: SubmitAgentUiBridgeResultRequest,
  ): Promise<{ delivered: boolean }> {
    const { conversation } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const bridgeDoc = await this.#harness.snapshot(ClinMeshUiBridgeDoc, conversation.id, BACKGROUND_CONTEXT)
    const pending = bridgeDoc?.requests.find(item => item.requestId === requestId)
    if (pending === undefined) {
      return { delivered: false }
    }
    const delivery = await this.#harness.signal(
      pending.taskId as TaskId,
      UiBridgeResultSignal,
      requestId,
      {
        ok: input.ok,
        ...(input.resultJson === undefined ? {} : { resultJson: input.resultJson }),
        ...(input.error === undefined ? {} : { error: input.error }),
      },
      BACKGROUND_CONTEXT,
    )
    if (delivery === 'not_found' || delivery === 'closed') {
      await conversation.commit(async (tx) => {
        const doc = await tx.doc(ClinMeshUiBridgeDoc, conversation.id)
        doc.requests = doc.requests.filter(item => item.requestId !== requestId)
      }, BACKGROUND_CONTEXT)
      return { delivered: false }
    }
    return { delivered: delivery === 'delivered' }
  }

  async resolveDevReflection(
    actor: ActorContext,
    sessionId: string,
    reflectionId: string,
    input: ResolveAgentDevReflectionRequest,
  ): Promise<ResolveAgentDevReflectionResponse> {
    const { conversation, meta } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const docSnap = await this.#harness.snapshot(ClinMeshDevReflectionsDoc, conversation.id, BACKGROUND_CONTEXT)
    const target = docSnap?.items.find(item => item.reflectionId === reflectionId)
    if (target === undefined) {
      throw new AgentSessionError('AGENT_APPROVAL_NOT_FOUND', '未找到对应的开发反思记录。', 404)
    }

    let savedPath: string | null = target.savedPath
    if (input.action === 'save' && target.status !== 'saved') {
      savedPath = await persistDevReflectionToDisk(this.#devReflection.outputDir, target, {
        roleCode: meta.roleCode,
        sessionId: meta.sessionId,
      })
    }

    const nextStatus: 'saved' | 'dismissed' = input.action === 'save' ? 'saved' : 'dismissed'
    await conversation.commit(async (tx) => {
      const doc = await tx.doc(ClinMeshDevReflectionsDoc, conversation.id)
      doc.items = doc.items.map(item =>
        item.reflectionId === reflectionId
          ? { ...item, status: nextStatus, savedPath }
          : item,
      )
    }, BACKGROUND_CONTEXT)

    const detail = await this.#buildDetail(conversation)
    const updatedReflection = { ...target, status: nextStatus, savedPath }
    return {
      reflection: updatedReflection,
      savedPath,
      detail,
    }
  }

  async retryLatestClinicianMessage(
    actor: ActorContext,
    sessionId: string,
    headers: Headers,
  ): Promise<AgentSessionDetail> {
    const { conversation, meta } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const live = await this.#harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT)
    if (live?.run !== undefined) {
      throw new AgentSessionError('AGENT_SESSION_BUSY', '助手正在生成回复，请先停止后再重试。', 409)
    }

    const contextView = await conversation.context(BACKGROUND_CONTEXT)
    const omittedIds = collectOmittedEntryIds(contextView.entries)
    let lastUserIndex = -1
    for (let i = contextView.entries.length - 1; i >= 0; i -= 1) {
      const entry = contextView.entries[i]
      if (entry !== undefined && !omittedIds.has(entry.id) && UserEntry.is(entry)) {
        lastUserIndex = i
        break
      }
    }
    if (lastUserIndex === -1) {
      throw new AgentSessionError('AGENT_SESSION_RETRY_UNAVAILABLE', '当前会话没有可重试的用户消息。', 409)
    }

    const resolved = this.#providers.resolveTurnConfig('assistant', headers)
    if (resolved === null) {
      throw new AgentSessionError(
        'LLM_PROVIDER_UNCONFIGURED',
        '未配置模型 API Key。请前往“设置 -> 模型与服务商”填写 API Key，或显式开启“演示 / Mock 模式”。',
        503,
      )
    }

    const entriesToOmit = contextView.entries
      .slice(lastUserIndex + 1)
      .filter(entry => !omittedIds.has(entry.id) && (AssistantEntry.is(entry) || ToolResultEntry.is(entry)))

    if (entriesToOmit.length > 0) {
      const reclaimedTokens = entriesToOmit.reduce((sum, entry) => {
        const items = buildIncludedItemsFromRequestMessages(entry.model ?? [])
        return sum + items.reduce((inner, item) => inner + estimateTextTokens(item.content), 0)
      }, 0)
      await conversation.submit({
        type: 'write',
        entry: {
          kind: 'clinmesh.retry-omit',
          edits: entriesToOmit.map(entry => ({ target: entry.id, action: 'omit' as const })),
          data: { omittedEntryIds: entriesToOmit.map(entry => entry.id) },
        },
      }, BACKGROUND_CONTEXT)
      await conversation.commit(async (tx) => {
        const snapDoc = await tx.doc(ClinMeshContextSnapshotsDoc, conversation.id)
        appendContextEvent(snapDoc, {
          kind: 'RETRY_OMIT',
          removedCount: entriesToOmit.length,
          reclaimedTokens,
          summaryTokens: 0,
          summarizedByModel: false,
        })
      }, BACKGROUND_CONTEXT)
    }

    const providerSessionId = await this.#ensureProviderSessionId(conversation)
    const bindingToken = this.#providers.bindTurn(providerSessionId, resolved)
    const approvedMemories = await this.#approvedMemoriesFor(actor)
    this.#bindEphemeralHisAuth(conversation.id, meta, headers)
    this.#devReflection.startTurn(conversation.id)

    try {
      await conversation.configure({
        model: { provider: resolved.internalProviderId, modelId: resolved.modelId },
        thinkingLevel: resolved.thinkingLevel,
        ...this.#clinicianAgentConfig(meta, approvedMemories),
      }, BACKGROUND_CONTEXT)

      await conversation.commit(async (tx) => {
        const doc = await tx.doc(ClinMeshSessionMetaDoc, conversation.id)
        doc.updatedAt = new Date().toISOString()
      }, BACKGROUND_CONTEXT)

      const submission = await conversation.submit({
        type: 'continue',
        requestId: `retry-${randomUUID()}`,
      }, BACKGROUND_CONTEXT)

      void submission.wait(BACKGROUND_CONTEXT)
        .then(() => undefined, () => undefined)
        .finally(() => {
          this.#providers.releaseTurn(providerSessionId, bindingToken)
        })
    } catch (error) {
      this.#providers.releaseTurn(providerSessionId, bindingToken)
      if (error instanceof ConversationBusy) {
        throw new AgentSessionError('AGENT_SESSION_BUSY', '助手正在生成回复，请稍后重试。', 409)
      }
      throw error
    }

    return this.#buildDetail(conversation)
  }

  async watchClinicianSession(
    actor: ActorContext,
    sessionId: string,
    signal: AbortSignal,
    onSnapshot: (detail: AgentSessionDetail) => void,
  ): Promise<void> {
    const { conversation } = await this.#resolveOwnedClinicianSession(actor, sessionId)
    const watchController = new AbortController()
    this.#activeWatchers.add(watchController)
    const onExternalAbort = () => watchController.abort()
    signal.addEventListener('abort', onExternalAbort, { once: true })
    if (signal.aborted || this.#shutdown.signal.aborted) {
      watchController.abort()
    }

    const watchContext = withAbortSignal(watchController.signal, BACKGROUND_CONTEXT)
    try {
      const watch = await conversation.watch(watchContext, { min: 200, max: 400 })
      const emitView = async (view: ConversationView) => {
        const meta = await this.#harness.snapshot(ClinMeshSessionMetaDoc, conversation.id, BACKGROUND_CONTEXT)
        if (meta === undefined || meta.deleted) return
        const live = view.docs['pi.live'] as LiveState | undefined
        const inbox = (view.docs['pi.inbox'] as InboxState | undefined)
          ?? await this.#harness.snapshot(InboxDoc, conversation.id, BACKGROUND_CONTEXT)
        const snapDoc = await this.#harness.snapshot(ClinMeshContextSnapshotsDoc, conversation.id, BACKGROUND_CONTEXT)
        const approvalsDoc = await this.#harness.snapshot(ClinMeshPendingApprovalsDoc, conversation.id, BACKGROUND_CONTEXT)
        const uiBridgeDoc = await this.#harness.snapshot(ClinMeshUiBridgeDoc, conversation.id, BACKGROUND_CONTEXT)
        const reflectionsDoc = await this.#harness.snapshot(ClinMeshDevReflectionsDoc, conversation.id, BACKGROUND_CONTEXT)
        const modelCalls = snapDoc?.calls.map(item => toPublicModelCallSummary(item.summary)) ?? []
        const latestContextCall = modelCalls.length > 0 ? modelCalls[modelCalls.length - 1]! : null
        const { messages, canRetryLatest } = projectMessagesFromEntries(view.entries, live, modelCalls)
        onSnapshot({
          session: summarizeMeta(conversation.id, meta, live, messages.length),
          messages,
          canRetryLatest,
          latestContextCall,
          queuedInputs: projectQueuedInputs(inbox),
          retryState: projectRetryState(live, text => this.#providers.redact(text)),
          compactionState: projectCompactionState(live, text => this.#providers.redact(text)),
          pendingApprovals: approvalsDoc?.items ?? [],
          pendingUiRequests: uiBridgeDoc?.requests ?? [],
          devReflections: (reflectionsDoc?.items ?? []).filter(item => item.status !== 'dismissed'),
          mutationVersion: approvalsDoc?.mutationVersion ?? 0,
        })
      }

      await emitView(watch.value)

      await new Promise<void>((resolve) => {
        const cleanup = () => {
          watch.stop()
          resolve()
        }
        watchController.signal.addEventListener('abort', cleanup, { once: true })
        if (watchController.signal.aborted) {
          cleanup()
          return
        }
        watch.start(async (call) => {
          if (watchController.signal.aborted) return
          if ('value' in call && call.value !== undefined) {
            await emitView(call.value)
          }
        })
        void watch.closed.then(() => resolve(), () => resolve())
      })
    } finally {
      signal.removeEventListener('abort', onExternalAbort)
      this.#activeWatchers.delete(watchController)
    }
  }

  /**
   * Ensures exactly one isolated pi-durable conversation exists for an outpatient Encounter's
   * Patient Agent. Never shares history, tools, or documents with Clinician Assistant sessions.
   */
  async ensurePatientAgentConversation(scope: {
    workspaceId: string
    epoch: string
    encounterId: string
    caseId: string
    patientId: string
  }): Promise<{ conversation: Conversation; sessionId: string; providerSessionId: string }> {
    const encounterKey = patientEncounterKey(scope.workspaceId, scope.epoch, scope.encounterId)
    const index = await this.#harness.snapshot(ClinMeshSessionIndexDoc, BACKGROUND_CONTEXT)
    const existingSessionId = index?.patientByEncounterKey[encounterKey]
    if (existingSessionId !== undefined) {
      const entry = index?.bySessionId[existingSessionId]
      if (entry !== undefined) {
        const existingConversation = await this.#harness.conversation(entry.conversationId as ConversationId, BACKGROUND_CONTEXT)
        if (existingConversation !== undefined) {
          const providerSessionId = await this.#ensureProviderSessionId(existingConversation)
          return {
            conversation: existingConversation,
            sessionId: existingSessionId,
            providerSessionId,
          }
        }
      }
    }

    const sessionId = `patient-agent-${scope.encounterId}`
    const nowIso = new Date().toISOString()
    const meta: StoredSessionMeta = {
      sessionId,
      kind: 'patient-agent',
      title: `患者会话 ${scope.encounterId}`,
      workspaceId: scope.workspaceId,
      epoch: scope.epoch,
      roleCode: 'patient-agent',
      encounterId: scope.encounterId,
      caseId: scope.caseId,
      patientId: scope.patientId,
      forkedFromSessionId: null,
      deleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    }
    const conversation = await this.#harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: {
        extensions: [],
        tools: [],
      },
      init: async (tx, conversationId) => {
        await tx.doc(ProviderDoc, conversationId)
        const doc = await tx.doc(ClinMeshSessionMetaDoc, conversationId)
        Object.assign(doc, meta)
        const idx = await tx.doc(ClinMeshSessionIndexDoc)
        idx.bySessionId[sessionId] = {
          sessionId,
          conversationId,
          kind: 'patient-agent',
          workspaceId: scope.workspaceId,
          epoch: scope.epoch,
          roleCode: 'patient-agent',
          encounterId: scope.encounterId,
          caseId: scope.caseId,
          patientId: scope.patientId,
          deleted: false,
        }
        idx.patientByEncounterKey[encounterKey] = sessionId
      },
    }, BACKGROUND_CONTEXT)
    const providerSessionId = await this.#ensureProviderSessionId(conversation)
    return { conversation, sessionId, providerSessionId }
  }

  /**
   * Executes one Patient Agent turn through pi-durable on the encounter's isolated conversation.
   * Deduplicates by requestId so restarts / retries never create duplicate patient turns.
   */
  async executePatientAgentTurn(input: {
    scope: {
      workspaceId: string
      epoch: string
      encounterId: string
      caseId: string
      patientId: string
    }
    systemPrompt: string
    userPayloadJson: string
    requestId: string
    turnConfig: ResolvedTurnConfig
    signal?: AbortSignal
  }): Promise<{
    text: string
    sessionId: string
    conversationId: ConversationId
    stopReason: string
    errorMessage?: string
  }> {
    const { conversation, sessionId, providerSessionId } = await this.ensurePatientAgentConversation(input.scope)
    const bindingToken = this.#providers.bindTurn(providerSessionId, input.turnConfig)
    const waitContext = input.signal === undefined
      ? BACKGROUND_CONTEXT
      : withAbortSignal(input.signal, BACKGROUND_CONTEXT)

    try {
      await conversation.configure({
        model: {
          provider: input.turnConfig.internalProviderId,
          modelId: input.turnConfig.modelId,
        },
        thinkingLevel: input.turnConfig.thinkingLevel,
        extensions: [],
        tools: [],
        instructions: input.systemPrompt,
      }, BACKGROUND_CONTEXT)

      // Reset prior context window only when starting a brand-new turn so each isolated
      // Patient Persona + visible dialogue snapshot is authoritative without leaking prior prompts.
      const existingByRequest = await this.#harness.commit(
        tx => tx.submissionByRequest(conversation.id, input.requestId),
        BACKGROUND_CONTEXT,
      )
      if (existingByRequest === undefined) {
        const latest = await conversation.entries({ order: 'descending' }, 1, undefined, BACKGROUND_CONTEXT)
        if (latest.items.length > 0) {
          await conversation.reset(undefined, BACKGROUND_CONTEXT)
        }
      }

      const submission = await conversation.submit({
        type: 'input',
        content: input.userPayloadJson,
        requestId: input.requestId,
        whenBusy: 'reject',
      }, BACKGROUND_CONTEXT)

      const settled = await (async () => {
        const onAbort = () => {
          void conversation.abort(BACKGROUND_CONTEXT).catch(() => undefined)
        }
        input.signal?.addEventListener('abort', onAbort, { once: true })
        try {
          return await submission.wait(waitContext)
        } catch (error) {
          if (input.signal?.aborted) {
            await conversation.abort(BACKGROUND_CONTEXT).catch(() => undefined)
          }
          throw error
        } finally {
          input.signal?.removeEventListener('abort', onAbort)
        }
      })()
      if (settled.status === 'done' && settled.answer !== undefined) {
        const page = await conversation.entries({ minEntryId: settled.answer, maxEntryId: settled.answer }, 1, undefined, BACKGROUND_CONTEXT)
        const entry = page.items[0]
        const assistant = entry?.model?.[0]
        if (assistant?.role === 'assistant') {
          const text = assistant.content
            .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
            .map(part => part.text)
            .join('\n')
            .trim()
          return {
            text,
            sessionId,
            conversationId: conversation.id,
            stopReason: assistant.stopReason,
            ...(assistant.errorMessage === undefined ? {} : { errorMessage: assistant.errorMessage }),
          }
        }
      }

      const live = await this.#harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT)
      const rawDetail = live?.runFailure?.detail
        ?? (settled.status === 'unanswered' ? settled.detail ?? settled.reason : 'Patient agent turn failed')
      const detail = typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail)
      return {
        text: '',
        sessionId,
        conversationId: conversation.id,
        stopReason: 'error',
        errorMessage: detail,
      }
    } finally {
      this.#providers.releaseTurn(providerSessionId, bindingToken)
    }
  }

  async #ensureProviderSessionId(conversation: Conversation): Promise<string> {
    const existing = await this.#harness.snapshot(ProviderDoc, conversation.id, BACKGROUND_CONTEXT)
    if (existing?.sessionId !== undefined) return existing.sessionId
    return conversation.commit(async (tx) => {
      const doc = await tx.doc(ProviderDoc, conversation.id)
      return doc.sessionId
    }, BACKGROUND_CONTEXT)
  }

  async #resolveOwnedClinicianSession(
    actor: ActorContext,
    sessionId: string,
  ): Promise<{ conversation: Conversation; meta: StoredSessionMeta }> {
    const index = await this.#harness.snapshot(ClinMeshSessionIndexDoc, BACKGROUND_CONTEXT)
    const entry = index?.bySessionId[sessionId]
    if (entry === undefined || entry.deleted) {
      throw new AgentSessionError('AGENT_SESSION_NOT_FOUND', '未找到指定的助手会话。', 404)
    }
    if (entry.kind !== 'clinician-assistant') {
      throw new AgentSessionError('AGENT_SESSION_FORBIDDEN', '无法通过临床助手接口访问患者代理会话。', 403)
    }
    if (entry.workspaceId !== actor.workspaceId || entry.epoch !== actor.epoch || entry.roleCode !== actor.roleCode) {
      throw new AgentSessionError('AGENT_SESSION_FORBIDDEN', '无权访问其他工作区、纪元或角色的助手会话。', 403)
    }
    const conversation = await this.#harness.conversation(entry.conversationId as ConversationId, BACKGROUND_CONTEXT)
    if (conversation === undefined) {
      throw new AgentSessionError('AGENT_SESSION_NOT_FOUND', '助手会话记录不存在。', 404)
    }
    const meta = await this.#harness.snapshot(ClinMeshSessionMetaDoc, conversation.id, BACKGROUND_CONTEXT)
    if (meta === undefined || meta.deleted || meta.kind !== 'clinician-assistant') {
      throw new AgentSessionError('AGENT_SESSION_NOT_FOUND', '助手会话已删除。', 404)
    }
    return { conversation, meta }
  }

  async #approvedMemoriesFor(actor: ActorContext): Promise<StoredClinicianMemoryItem[]> {
    const doc = await this.#harness.snapshot(ClinMeshClinicianMemoryDoc, BACKGROUND_CONTEXT)
    const list = doc?.byScope[memoryScopeKey(actor.workspaceId, actor.roleCode)] ?? []
    return list.filter(item => item.status === 'approved')
  }

  async #buildDetail(conversation: Conversation): Promise<AgentSessionDetail> {
    const meta = await this.#harness.snapshot(ClinMeshSessionMetaDoc, conversation.id, BACKGROUND_CONTEXT)
    if (meta === undefined) {
      throw new AgentSessionError('AGENT_SESSION_NOT_FOUND', '会话元数据不存在。', 404)
    }
    const live = await this.#harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT)
    const inbox = await this.#harness.snapshot(InboxDoc, conversation.id, BACKGROUND_CONTEXT)
    const snapDoc = await this.#harness.snapshot(ClinMeshContextSnapshotsDoc, conversation.id, BACKGROUND_CONTEXT)
    const approvalsDoc = await this.#harness.snapshot(ClinMeshPendingApprovalsDoc, conversation.id, BACKGROUND_CONTEXT)
    const uiBridgeDoc = await this.#harness.snapshot(ClinMeshUiBridgeDoc, conversation.id, BACKGROUND_CONTEXT)
    const reflectionsDoc = await this.#harness.snapshot(ClinMeshDevReflectionsDoc, conversation.id, BACKGROUND_CONTEXT)
    const modelCalls = snapDoc?.calls.map(item => toPublicModelCallSummary(item.summary)) ?? []
    const latestContextCall = modelCalls.length > 0 ? modelCalls[modelCalls.length - 1]! : null
    const page = await conversation.entries({ order: 'ascending' }, 500, undefined, BACKGROUND_CONTEXT)
    const { messages, canRetryLatest } = projectMessagesFromEntries(page.items, live, modelCalls)
    return {
      session: summarizeMeta(conversation.id, meta, live, messages.length),
      messages,
      canRetryLatest,
      latestContextCall,
      queuedInputs: projectQueuedInputs(inbox),
      retryState: projectRetryState(live, text => this.#providers.redact(text)),
      compactionState: projectCompactionState(live, text => this.#providers.redact(text)),
      pendingApprovals: approvalsDoc?.items ?? [],
      pendingUiRequests: uiBridgeDoc?.requests ?? [],
      devReflections: (reflectionsDoc?.items ?? []).filter(item => item.status !== 'dismissed'),
      mutationVersion: approvalsDoc?.mutationVersion ?? 0,
    }
  }
}

export {
  AgentDoc,
  ClinMeshClinicianMemoryDoc,
  ClinMeshContextSnapshotsDoc,
  ClinMeshSessionIndexDoc,
  ClinMeshSessionMetaDoc,
}
