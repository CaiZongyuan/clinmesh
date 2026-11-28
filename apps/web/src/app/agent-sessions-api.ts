import {
  agentCapabilitiesManifestSchema,
} from '@clinmesh/contracts/agent-capabilities'
import {
  agentSessionDetailSchema,
  agentSessionSseEventSchema,
  agentSessionSummarySchema,
  clinicalEntitiesResponseSchema,
  exportAgentSessionResponseSchema,
  listAgentSessionsResponseSchema,
  listClinicianMemoryResponseSchema,
  LLM_RUNTIME_HEADERS,
  llmProviderCatalogResponseSchema,
  llmProviderStatusResponseSchema,
  modelCallDetailResponseSchema,
  resolveAgentDevReflectionResponseSchema,
  searchAgentSessionsResponseSchema,
  sessionContextResponseSchema,
  sideChatResponseSchema,
  testLlmProviderResponseSchema,
  type AgentSessionDetail,
  type CompactAgentSessionRequest,
  type CreateAgentSessionRequest,
  type CreateClinicianMemoryRequest,
  type ForkAgentSessionRequest,
  type RenameAgentSessionRequest,
  type ResetAgentSessionRequest,
  type ResolveAgentApprovalRequest,
  type ResolveAgentDevReflectionRequest,
  type SendAgentMessageRequest,
  type SideChatRequest,
  type SubmitAgentUiBridgeResultRequest,
  type TestLlmProviderRequest,
  type UpdateClinicianMemoryRequest,
} from '@clinmesh/contracts/agent-sessions'
import { z } from 'zod'
import { apiGet, apiMutation, resolveApiPath } from './api-client.ts'
import { buildLlmRequestHeaders } from './llm-settings-storage.ts'

const renameResponseSchema = z.object({ session: agentSessionSummarySchema }).strict()
const deleteResponseSchema = z.object({ deleted: z.literal(true) }).strict()
const recallQueueResponseSchema = z.object({
  recalled: z.boolean(),
  content: z.string(),
  detail: agentSessionDetailSchema,
}).strict()

export function getAgentCapabilities(signal?: AbortSignal) {
  return apiGet('/api/agents/capabilities', agentCapabilitiesManifestSchema, signal)
}

export function getLlmProviderStatus(signal?: AbortSignal) {
  return apiGet('/api/agents/providers/status', llmProviderStatusResponseSchema, signal)
}

export function getLlmProviderCatalog(
  options: { refresh?: boolean; signal?: AbortSignal } = {},
) {
  const suffix = options.refresh ? '?refresh=1' : ''
  return apiGet(`/api/agents/providers/catalog${suffix}`, llmProviderCatalogResponseSchema, options.signal)
}

export function testLlmProvider(
  request: TestLlmProviderRequest,
  apiKey: string,
  signal?: AbortSignal,
) {
  const trimmedKey = apiKey.trim()
  return apiMutation(
    '/api/agents/providers/test',
    testLlmProviderResponseSchema,
    request,
    {
      extraHeaders: trimmedKey.length > 0 ? { [LLM_RUNTIME_HEADERS.apiKey]: trimmedKey } : {},
      ...(signal === undefined ? {} : { signal }),
    },
  )
}

export function listAgentSessions(encounterId?: string | null, signal?: AbortSignal) {
  const query = encounterId === undefined
    ? ''
    : `?encounterId=${encodeURIComponent(encounterId ?? '__none__')}`
  return apiGet(`/api/agents/sessions${query}`, listAgentSessionsResponseSchema, signal)
}

export function searchAgentSessions(
  q: string,
  encounterId?: string | null,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ q })
  if (encounterId !== undefined) {
    params.set('encounterId', encounterId ?? '__none__')
  }
  return apiGet(`/api/agents/sessions/search?${params.toString()}`, searchAgentSessionsResponseSchema, signal)
}

export function createAgentSession(input: CreateAgentSessionRequest) {
  return apiMutation('/api/agents/sessions', agentSessionDetailSchema, input)
}

export function getAgentSession(sessionId: string, signal?: AbortSignal) {
  return apiGet(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}`,
    agentSessionDetailSchema,
    signal,
  )
}

export function getAgentSessionContext(sessionId: string, signal?: AbortSignal) {
  return apiGet(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/context`,
    sessionContextResponseSchema,
    signal,
  )
}

export function getAgentModelCallDetail(
  sessionId: string,
  callId: string,
  signal?: AbortSignal,
) {
  return apiGet(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/model-calls/${encodeURIComponent(callId)}`,
    modelCallDetailResponseSchema,
    signal,
  )
}

export function updateAgentSession(sessionId: string, input: RenameAgentSessionRequest) {
  return apiMutation(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}`,
    renameResponseSchema,
    input,
    { method: 'PATCH' },
  )
}

export function renameAgentSession(sessionId: string, title: string) {
  return updateAgentSession(sessionId, { title })
}

export function deleteAgentSession(sessionId: string) {
  return apiMutation(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}`,
    deleteResponseSchema,
    undefined,
    { method: 'DELETE' },
  )
}

export function forkAgentSession(sessionId: string, input: ForkAgentSessionRequest = {}) {
  return apiMutation(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/fork`,
    agentSessionDetailSchema,
    input,
  )
}

export function sendAgentMessage(sessionId: string, input: SendAgentMessageRequest) {
  return apiMutation(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/messages`,
    agentSessionDetailSchema,
    input,
    {
      extraHeaders: buildLlmRequestHeaders('assistant'),
    },
  )
}

export function recallQueuedAgentInput(sessionId: string, submissionId: number) {
  return apiMutation(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/queue/${submissionId}`,
    recallQueueResponseSchema,
    undefined,
    { method: 'DELETE' },
  )
}

export function compactAgentSession(sessionId: string, input: CompactAgentSessionRequest = {}) {
  return apiMutation(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/compact`,
    agentSessionDetailSchema,
    input,
    {
      extraHeaders: buildLlmRequestHeaders('assistant'),
    },
  )
}

export function resetAgentSession(sessionId: string, input: ResetAgentSessionRequest = {}) {
  return apiMutation(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/reset`,
    agentSessionDetailSchema,
    input,
  )
}

export function askSideChatQuestion(sessionId: string, input: SideChatRequest) {
  return apiMutation(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/side-question`,
    sideChatResponseSchema,
    input,
    {
      extraHeaders: buildLlmRequestHeaders('assistant'),
    },
  )
}

export function askStandaloneSideChatQuestion(input: SideChatRequest) {
  return apiMutation(
    '/api/agents/side-question',
    sideChatResponseSchema,
    input,
    {
      extraHeaders: buildLlmRequestHeaders('assistant'),
    },
  )
}

export function listClinicalEntities(sessionId: string, signal?: AbortSignal) {
  return apiGet(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/clinical-entities`,
    clinicalEntitiesResponseSchema,
    signal,
  )
}

export function listScopeClinicalEntities(
  scope: { encounterId: string | null; caseId: string | null },
  signal?: AbortSignal,
) {
  const params = new URLSearchParams()
  if (scope.encounterId !== null) params.set('encounterId', scope.encounterId)
  if (scope.caseId !== null) params.set('caseId', scope.caseId)
  const suffix = params.toString()
  return apiGet(
    `/api/agents/clinical-entities${suffix.length > 0 ? `?${suffix}` : ''}`,
    clinicalEntitiesResponseSchema,
    signal,
  )
}

export function exportAgentSession(sessionId: string, signal?: AbortSignal) {
  return apiGet(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/export`,
    exportAgentSessionResponseSchema,
    signal,
  )
}

export function listClinicianMemories(signal?: AbortSignal) {
  return apiGet('/api/agents/memory', listClinicianMemoryResponseSchema, signal)
}

export function createClinicianMemory(input: CreateClinicianMemoryRequest) {
  return apiMutation('/api/agents/memory', listClinicianMemoryResponseSchema, input)
}

export function updateClinicianMemory(memoryId: string, input: UpdateClinicianMemoryRequest) {
  return apiMutation(
    `/api/agents/memory/${encodeURIComponent(memoryId)}`,
    listClinicianMemoryResponseSchema,
    input,
    { method: 'PATCH' },
  )
}

export function deleteClinicianMemory(memoryId: string) {
  return apiMutation(
    `/api/agents/memory/${encodeURIComponent(memoryId)}`,
    listClinicianMemoryResponseSchema,
    undefined,
    { method: 'DELETE' },
  )
}

const uiBridgeResultResponseSchema = z.object({ delivered: z.boolean() }).strict()

export function resolveAgentApproval(
  sessionId: string,
  approvalId: string,
  input: ResolveAgentApprovalRequest,
) {
  return apiMutation(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
    agentSessionDetailSchema,
    input,
  )
}

export function submitAgentUiBridgeResult(
  sessionId: string,
  requestId: string,
  input: SubmitAgentUiBridgeResultRequest,
) {
  return apiMutation(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/ui-bridge/${encodeURIComponent(requestId)}`,
    uiBridgeResultResponseSchema,
    input,
  )
}

export function resolveAgentDevReflection(
  sessionId: string,
  reflectionId: string,
  input: ResolveAgentDevReflectionRequest,
) {
  return apiMutation(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/dev-reflections/${encodeURIComponent(reflectionId)}`,
    resolveAgentDevReflectionResponseSchema,
    input,
  )
}

export function stopAgentSession(sessionId: string) {
  return apiMutation(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/stop`,
    agentSessionDetailSchema,
    {},
  )
}

export function retryLatestAgentMessage(sessionId: string) {
  return apiMutation(
    `/api/agents/sessions/${encodeURIComponent(sessionId)}/retry`,
    agentSessionDetailSchema,
    {},
    {
      extraHeaders: buildLlmRequestHeaders('assistant'),
    },
  )
}

export function subscribeAgentSessionEvents(
  sessionId: string,
  handlers: {
    onSnapshot: (detail: AgentSessionDetail) => void
    onError?: () => void
    onOpen?: () => void
  },
): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  const url = resolveApiPath(`/api/agents/sessions/${encodeURIComponent(sessionId)}/events`, 'GET')
  const source = new EventSource(url, { withCredentials: true })

  const handlePayload = (event: MessageEvent<string>) => {
    try {
      const parsed = agentSessionSseEventSchema.safeParse(JSON.parse(event.data))
      if (parsed.success && parsed.data.type === 'snapshot') {
        handlers.onSnapshot(parsed.data.detail)
      }
    } catch {
      // Ignore malformed SSE frames.
    }
  }

  source.addEventListener('snapshot', handlePayload as EventListener)
  source.addEventListener('open', () => handlers.onOpen?.())
  source.addEventListener('error', () => handlers.onError?.())

  return () => {
    source.removeEventListener('snapshot', handlePayload as EventListener)
    source.close()
  }
}
