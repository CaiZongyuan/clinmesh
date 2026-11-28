import { z } from 'zod'

export const LLM_RUNTIME_HEADERS = {
  mode: 'x-clinmesh-llm-mode',
  provider: 'x-clinmesh-llm-provider',
  localProvider: 'x-clinmesh-llm-local-provider',
  baseUrl: 'x-clinmesh-llm-base-url',
  modelId: 'x-clinmesh-llm-model',
  apiKey: 'x-clinmesh-llm-api-key',
  reasoningEffort: 'x-clinmesh-llm-reasoning',
  thinkingMode: 'x-clinmesh-llm-thinking-mode',
} as const

export const llmProviderKindSchema = z.enum([
  'openai-compatible',
  'anthropic',
  'gemini',
  'mock',
])
export type LlmProviderKind = z.infer<typeof llmProviderKindSchema>

export const llmModeSchema = z.enum(['live', 'mock', 'local'])
export type LlmMode = z.infer<typeof llmModeSchema>

export const llmReasoningEffortSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])
export type LlmReasoningEffort = z.infer<typeof llmReasoningEffortSchema>

export const llmThinkingModeSchema = z.enum(['auto', 'adaptive', 'budget'])
export type LlmThinkingMode = z.infer<typeof llmThinkingModeSchema>

export const llmLocalSourceSchema = z.enum(['pi', 'claude', 'codex'])
export type LlmLocalSource = z.infer<typeof llmLocalSourceSchema>

export const llmCatalogApiSchema = z.enum([
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'google-generative-ai',
  'mock',
])
export type LlmCatalogApi = z.infer<typeof llmCatalogApiSchema>

export const llmAgentRoleSchema = z.enum(['patient', 'assistant'])
export type LlmAgentRole = z.infer<typeof llmAgentRoleSchema>

export const llmAgentModelConfigSchema = z.object({
  provider: llmProviderKindSchema,
  baseUrl: z.string().max(500).optional(),
  modelId: z.string().min(1).max(200),
  reasoningEffort: llmReasoningEffortSchema,
  thinkingMode: llmThinkingModeSchema.optional(),
}).strict()
export type LlmAgentModelConfig = z.infer<typeof llmAgentModelConfigSchema>

export const testLlmProviderRequestSchema = z.object({
  mode: llmModeSchema,
  provider: llmProviderKindSchema.optional(),
  localProviderId: z.string().min(1).max(120).optional(),
  baseUrl: z.string().max(500).optional(),
  modelId: z.string().min(1).max(200),
  reasoningEffort: llmReasoningEffortSchema.optional(),
  thinkingMode: llmThinkingModeSchema.optional(),
}).strict()
export type TestLlmProviderRequest = z.infer<typeof testLlmProviderRequestSchema>

export const testLlmProviderResponseSchema = z.object({
  ok: z.boolean(),
  provider: z.string().min(1),
  modelId: z.string(),
  latencyMs: z.number().int().nonnegative(),
  replyPreview: z.string().optional(),
  errorCode: z.string().optional(),
  message: z.string(),
}).strict()
export type TestLlmProviderResponse = z.infer<typeof testLlmProviderResponseSchema>

export const llmProviderStatusResponseSchema = z.object({
  serverDefaultConfigured: z.boolean(),
  serverDefaultProvider: llmProviderKindSchema.nullable(),
  serverDefaultModel: z.string().nullable(),
}).strict()
export type LlmProviderStatusResponse = z.infer<typeof llmProviderStatusResponseSchema>

export const llmCatalogModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  api: llmCatalogApiSchema,
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  reasoning: z.boolean(),
  supportedThinkingLevels: z.array(llmReasoningEffortSchema),
  supportsAdaptiveThinking: z.boolean(),
  defaultThinkingLevel: llmReasoningEffortSchema.optional(),
  isDefault: z.boolean().optional(),
}).strict()
export type LlmCatalogModel = z.infer<typeof llmCatalogModelSchema>

export const llmLocalProviderSummarySchema = z.object({
  id: z.string().min(1),
  source: llmLocalSourceSchema,
  providerKey: z.string().min(1),
  displayName: z.string().min(1),
  api: llmCatalogApiSchema,
  baseUrlHost: z.string().nullable(),
  originPath: z.string().min(1),
  authReady: z.boolean(),
  authKind: z.enum(['api-key', 'bearer-token', 'oauth', 'env-var', 'none']),
  defaultModelId: z.string().nullable(),
  defaultThinkingLevel: llmReasoningEffortSchema.nullable(),
  models: z.array(llmCatalogModelSchema),
}).strict()
export type LlmLocalProviderSummary = z.infer<typeof llmLocalProviderSummarySchema>

export const llmProviderCatalogResponseSchema = z.object({
  discoveryEnabled: z.boolean(),
  scannedAt: z.string(),
  serverDefault: llmProviderStatusResponseSchema,
  localProviders: z.array(llmLocalProviderSummarySchema),
}).strict()
export type LlmProviderCatalogResponse = z.infer<typeof llmProviderCatalogResponseSchema>

export const agentSessionKindSchema = z.enum([
  'clinician-assistant',
  'patient-agent',
])
export type AgentSessionKind = z.infer<typeof agentSessionKindSchema>

export const agentSessionScopeSchema = z.object({
  workspaceId: z.string().min(1),
  epoch: z.string().min(1),
  roleCode: z.string().min(1),
  encounterId: z.string().min(1).nullable(),
  caseId: z.string().min(1).nullable(),
  patientId: z.string().min(1).nullable(),
}).strict()
export type AgentSessionScope = z.infer<typeof agentSessionScopeSchema>

export const agentContentBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }).strict(),
  z.object({
    type: z.literal('thinking'),
    thinking: z.string(),
    redacted: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal('tool-call'),
    callId: z.string().min(1),
    name: z.string().min(1),
    argumentsJson: z.string(),
    status: z.enum(['pending', 'running', 'done', 'error']),
    output: z.string().optional(),
    isError: z.boolean().optional(),
  }).strict(),
])
export type AgentContentBlock = z.infer<typeof agentContentBlockSchema>

export const contextItemKindSchema = z.enum([
  'INSTRUCTIONS',
  'CLINICAL_CONTEXT',
  'COMPACTED_SUMMARY',
  'TOOL_DEFINITION',
  'USER_MESSAGE',
  'ASSISTANT_MESSAGE',
  'REASONING',
  'TOOL_CALL',
  'TOOL_RESULT',
])
export type ContextItemKind = z.infer<typeof contextItemKindSchema>

export const toolDefinitionSourceSchema = z.enum(['BUILTIN', 'EXTENSION'])
export type ToolDefinitionSource = z.infer<typeof toolDefinitionSourceSchema>

export const modelCallPurposeSchema = z.enum(['TURN', 'COMPACTION'])
export type ModelCallPurpose = z.infer<typeof modelCallPurposeSchema>

export const modelCallStatusSchema = z.enum(['COMPLETED', 'ERROR', 'ABORTED'])
export type ModelCallStatus = z.infer<typeof modelCallStatusSchema>

export const modelCallUsageSourceSchema = z.enum(['PROVIDER', 'ESTIMATED', 'SIMULATED'])
export type ModelCallUsageSource = z.infer<typeof modelCallUsageSourceSchema>

export const contextItemSchema = z.object({
  kind: contextItemKindSchema,
  blobId: z.string().min(1),
  content: z.string(),
  tokens: z.number().int().nonnegative(),
  label: z.string().optional(),
  source: toolDefinitionSourceSchema.optional(),
  entryId: z.number().int().positive().optional(),
}).strict()
export type ContextItem = z.infer<typeof contextItemSchema>

export const modelCallUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  source: modelCallUsageSourceSchema,
}).strict()
export type ModelCallUsage = z.infer<typeof modelCallUsageSchema>

export const contextKindTokenMapSchema = z.object({
  INSTRUCTIONS: z.number().int().nonnegative(),
  CLINICAL_CONTEXT: z.number().int().nonnegative(),
  COMPACTED_SUMMARY: z.number().int().nonnegative(),
  TOOL_DEFINITION: z.number().int().nonnegative(),
  USER_MESSAGE: z.number().int().nonnegative(),
  ASSISTANT_MESSAGE: z.number().int().nonnegative(),
  REASONING: z.number().int().nonnegative(),
  TOOL_CALL: z.number().int().nonnegative(),
  TOOL_RESULT: z.number().int().nonnegative(),
}).strict()
export type ContextKindTokenMap = z.infer<typeof contextKindTokenMapSchema>

export const modelCallEstimateSchema = z.object({
  byKind: contextKindTokenMapSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  excludedTokens: z.number().int().nonnegative(),
}).strict()
export type ModelCallEstimate = z.infer<typeof modelCallEstimateSchema>

export const modelCallSummarySchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().positive(),
  purpose: modelCallPurposeSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  startedAt: z.string(),
  endedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  ttftMs: z.number().int().nonnegative().optional(),
  tokensPerSecond: z.number().nonnegative().optional(),
  status: modelCallStatusSchema,
  errorMessage: z.string().optional(),
  usage: modelCallUsageSchema,
  estimate: modelCallEstimateSchema,
  includedCount: z.number().int().nonnegative(),
  excludedCount: z.number().int().nonnegative(),
  responseToolNames: z.array(z.string()),
  hasDetail: z.boolean(),
  assistantEntryId: z.number().int().positive().nullable().optional(),
}).strict()
export type ModelCallSummary = z.infer<typeof modelCallSummarySchema>

export const modelCallDetailSchema = modelCallSummarySchema.extend({
  included: z.array(contextItemSchema),
  excluded: z.array(contextItemSchema),
  response: z.array(contextItemSchema),
}).strict()
export type ModelCallDetail = z.infer<typeof modelCallDetailSchema>

export const contextEventKindSchema = z.enum(['COMPACT', 'RETRY_OMIT', 'RESET'])
export type ContextEventKind = z.infer<typeof contextEventKindSchema>

export const contextEventSummarySchema = z.object({
  id: z.string().min(1),
  kind: contextEventKindSchema,
  createdAt: z.string(),
  afterCallSeq: z.number().int().nonnegative(),
  removedCount: z.number().int().nonnegative(),
  reclaimedTokens: z.number().int().nonnegative(),
  summaryTokens: z.number().int().nonnegative(),
  summarizedByModel: z.boolean(),
  summaryPreview: z.string().optional(),
}).strict()
export type ContextEventSummary = z.infer<typeof contextEventSummarySchema>

export const sessionContextResponseSchema = z.object({
  sessionId: z.string().min(1),
  defaultContextWindow: z.number().int().positive(),
  modelCalls: z.array(modelCallSummarySchema),
  contextEvents: z.array(contextEventSummarySchema),
  latestCall: modelCallSummarySchema.nullable(),
}).strict()
export type SessionContextResponse = z.infer<typeof sessionContextResponseSchema>

export const modelCallDetailResponseSchema = z.object({
  modelCall: modelCallDetailSchema,
}).strict()
export type ModelCallDetailResponse = z.infer<typeof modelCallDetailResponseSchema>

export const agentSessionMessageSchema = z.object({
  id: z.string().min(1),
  entryId: z.number().int().positive().nullable(),
  role: z.enum(['user', 'assistant', 'system']),
  createdAt: z.string(),
  blocks: z.array(agentContentBlockSchema),
  stopReason: z.string().nullable(),
  errorMessage: z.string().nullable(),
  streaming: z.boolean(),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  ttftMs: z.number().int().nonnegative().nullable().optional(),
  tokensPerSecond: z.number().nonnegative().nullable().optional(),
  usage: modelCallUsageSchema.nullable().optional(),
  modelCallId: z.string().min(1).nullable().optional(),
  isCompactionSummary: z.boolean().optional(),
  isResetBoundary: z.boolean().optional(),
}).strict()
export type AgentSessionMessage = z.infer<typeof agentSessionMessageSchema>

export const agentQueuedInputSchema = z.object({
  submissionId: z.number().int().positive(),
  mode: z.enum(['steer', 'followUp']),
  content: z.string(),
}).strict()
export type AgentQueuedInput = z.infer<typeof agentQueuedInputSchema>

export const agentRetryStateSchema = z.object({
  attempt: z.number().int().positive(),
  retryAt: z.string(),
  error: z.string(),
  isRateLimited: z.boolean(),
}).strict()
export type AgentRetryState = z.infer<typeof agentRetryStateSchema>

export const agentCompactionStateSchema = z.object({
  active: z.boolean(),
  trigger: z.enum(['manual', 'threshold', 'overflow']).optional(),
  lastError: z.string().nullable().optional(),
}).strict()
export type AgentCompactionState = z.infer<typeof agentCompactionStateSchema>

export const agentSessionErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
}).strict()
export type AgentSessionError = z.infer<typeof agentSessionErrorSchema>

export const agentSessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  conversationId: z.number().int().positive(),
  kind: agentSessionKindSchema,
  title: z.string().min(1).max(160),
  scope: agentSessionScopeSchema,
  forkedFromSessionId: z.string().min(1).nullable(),
  forkedFromEntryId: z.number().int().positive().nullable().optional(),
  customInstructions: z.string().max(4_000).nullable().optional(),
  autoCompact: z.boolean().optional(),
  status: z.enum(['idle', 'running', 'error']),
  lastError: agentSessionErrorSchema.nullable(),
  messageCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()
export type AgentSessionSummary = z.infer<typeof agentSessionSummarySchema>

export const agentSessionDetailSchema = z.object({
  session: agentSessionSummarySchema,
  messages: z.array(agentSessionMessageSchema),
  canRetryLatest: z.boolean(),
  latestContextCall: modelCallSummarySchema.nullable().optional(),
  queuedInputs: z.array(agentQueuedInputSchema).optional(),
  retryState: agentRetryStateSchema.nullable().optional(),
  compactionState: agentCompactionStateSchema.optional(),
}).strict()
export type AgentSessionDetail = z.infer<typeof agentSessionDetailSchema>

export const listAgentSessionsResponseSchema = z.object({
  sessions: z.array(agentSessionSummarySchema),
}).strict()
export type ListAgentSessionsResponse = z.infer<typeof listAgentSessionsResponseSchema>

export const createAgentSessionRequestSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  encounterId: z.string().min(1).nullable().optional(),
  caseId: z.string().min(1).nullable().optional(),
  patientId: z.string().min(1).nullable().optional(),
  customInstructions: z.string().trim().max(4_000).nullable().optional(),
  autoCompact: z.boolean().optional(),
}).strict()
export type CreateAgentSessionRequest = z.infer<typeof createAgentSessionRequestSchema>

export const renameAgentSessionRequestSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  customInstructions: z.string().trim().max(4_000).nullable().optional(),
  autoCompact: z.boolean().optional(),
}).strict()
export type RenameAgentSessionRequest = z.infer<typeof renameAgentSessionRequestSchema>

export const sendAgentMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(16_000),
  requestId: z.string().min(1).max(128).optional(),
  whenBusy: z.enum(['reject', 'steer', 'followUp']).optional(),
}).strict()
export type SendAgentMessageRequest = z.infer<typeof sendAgentMessageRequestSchema>

export const compactAgentSessionRequestSchema = z.object({
  instructions: z.string().trim().max(2_000).optional(),
}).strict()
export type CompactAgentSessionRequest = z.infer<typeof compactAgentSessionRequestSchema>

export const resetAgentSessionRequestSchema = z.object({
  handoff: z.string().trim().max(4_000).optional(),
}).strict()
export type ResetAgentSessionRequest = z.infer<typeof resetAgentSessionRequestSchema>

export const sideChatHistoryTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(8_000),
}).strict()

export const sideChatRequestSchema = z.object({
  question: z.string().trim().min(1).max(8_000),
  quote: z.string().trim().max(4_000).optional(),
  history: z.array(sideChatHistoryTurnSchema).max(16).optional(),
  encounterId: z.string().min(1).nullable().optional(),
  caseId: z.string().min(1).nullable().optional(),
}).strict()
export type SideChatRequest = z.infer<typeof sideChatRequestSchema>

export const sideChatResponseSchema = z.object({
  answer: z.string(),
  thinking: z.string().optional(),
  model: z.string(),
  provider: z.string(),
  durationMs: z.number().int().nonnegative(),
  ttftMs: z.number().int().nonnegative().optional(),
}).strict()
export type SideChatResponse = z.infer<typeof sideChatResponseSchema>

export const clinicalEntityKindSchema = z.enum([
  'vitals',
  'consultation',
  'lab',
  'imaging',
  'exam',
  'pathology',
  'medications',
])
export type ClinicalEntityKind = z.infer<typeof clinicalEntityKindSchema>

export const clinicalEntityMentionSchema = z.object({
  id: z.string().min(1),
  kind: clinicalEntityKindSchema,
  label: z.string().min(1),
  summary: z.string(),
  detailText: z.string(),
}).strict()
export type ClinicalEntityMention = z.infer<typeof clinicalEntityMentionSchema>

export const clinicalEntitiesResponseSchema = z.object({
  encounterId: z.string().nullable(),
  caseId: z.string().nullable(),
  entities: z.array(clinicalEntityMentionSchema),
}).strict()
export type ClinicalEntitiesResponse = z.infer<typeof clinicalEntitiesResponseSchema>

export const clinicianMemoryStatusSchema = z.enum(['pending', 'approved', 'discarded'])
export type ClinicianMemoryStatus = z.infer<typeof clinicianMemoryStatusSchema>

export const clinicianMemoryItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1).max(600),
  status: clinicianMemoryStatusSchema,
  source: z.enum(['user', 'assistant']),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()
export type ClinicianMemoryItem = z.infer<typeof clinicianMemoryItemSchema>

export const listClinicianMemoryResponseSchema = z.object({
  items: z.array(clinicianMemoryItemSchema),
}).strict()
export type ListClinicianMemoryResponse = z.infer<typeof listClinicianMemoryResponseSchema>

export const createClinicianMemoryRequestSchema = z.object({
  content: z.string().trim().min(1).max(600),
  status: z.enum(['pending', 'approved']).optional(),
}).strict()
export type CreateClinicianMemoryRequest = z.infer<typeof createClinicianMemoryRequestSchema>

export const updateClinicianMemoryRequestSchema = z.object({
  status: clinicianMemoryStatusSchema.optional(),
  content: z.string().trim().min(1).max(600).optional(),
}).strict()
export type UpdateClinicianMemoryRequest = z.infer<typeof updateClinicianMemoryRequestSchema>

export const sessionSearchMatchSchema = z.object({
  session: agentSessionSummarySchema,
  snippet: z.string(),
  matchedIn: z.enum(['title', 'message']),
}).strict()
export type SessionSearchMatch = z.infer<typeof sessionSearchMatchSchema>

export const searchAgentSessionsResponseSchema = z.object({
  query: z.string(),
  matches: z.array(sessionSearchMatchSchema),
}).strict()
export type SearchAgentSessionsResponse = z.infer<typeof searchAgentSessionsResponseSchema>

export const exportAgentSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string(),
  filename: z.string().min(1),
  markdown: z.string(),
}).strict()
export type ExportAgentSessionResponse = z.infer<typeof exportAgentSessionResponseSchema>

export const forkAgentSessionRequestSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  atEntryId: z.number().int().positive().optional(),
}).strict()
export type ForkAgentSessionRequest = z.infer<typeof forkAgentSessionRequestSchema>

export const agentSessionSseEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    detail: agentSessionDetailSchema,
  }).strict(),
  z.object({
    type: z.literal('heartbeat'),
    timestamp: z.string(),
  }).strict(),
  z.object({
    type: z.literal('error'),
    code: z.string().min(1),
    message: z.string().min(1),
  }).strict(),
])
export type AgentSessionSseEvent = z.infer<typeof agentSessionSseEventSchema>
