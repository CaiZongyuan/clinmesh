import {
  LLM_RUNTIME_HEADERS,
  llmProviderKindSchema,
  llmReasoningEffortSchema,
  llmThinkingModeSchema,
  type LlmAgentRole,
  type LlmProviderKind,
  type LlmReasoningEffort,
  type LlmThinkingMode,
} from '@clinmesh/contracts/agent-sessions'
import { useSyncExternalStore } from 'react'
import { z } from 'zod'

const LLM_SETTINGS_STORAGE_KEY = 'clinmesh.llm-settings:v1'
const LLM_SETTINGS_CHANGE_EVENT = 'clinmesh:llm-settings-change'

export type LiveLlmProviderKind = Exclude<LlmProviderKind, 'mock'>

const storedAgentConfigSchema = z.object({
  modelId: z.string().max(200),
  reasoningEffort: llmReasoningEffortSchema,
  thinkingMode: llmThinkingModeSchema.default('auto'),
  localProviderId: z.string().max(120).nullable().default(null),
})

const storedLlmSettingsSchema = z.object({
  mockMode: z.boolean(),
  provider: llmProviderKindSchema.exclude(['mock']),
  baseUrl: z.string().max(500),
  apiKey: z.string().max(500),
  showLiveThinking: z.boolean().default(false),
  patient: storedAgentConfigSchema,
  assistant: storedAgentConfigSchema,
})

export type StoredAgentRoleConfig = z.infer<typeof storedAgentConfigSchema>
export type StoredLlmSettings = z.infer<typeof storedLlmSettingsSchema>

export const DEFAULT_PROVIDER_BASE_URLS: Record<LiveLlmProviderKind, string> = {
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
}

export const DEFAULT_PROVIDER_MODELS: Record<LiveLlmProviderKind, string> = {
  'openai-compatible': 'gpt-4.1-mini',
  anthropic: 'claude-sonnet-4-5',
  gemini: 'gemini-2.5-flash',
}

export const DEFAULT_LLM_SETTINGS: StoredLlmSettings = {
  mockMode: false,
  provider: 'openai-compatible',
  baseUrl: DEFAULT_PROVIDER_BASE_URLS['openai-compatible'],
  apiKey: '',
  showLiveThinking: false,
  patient: {
    modelId: DEFAULT_PROVIDER_MODELS['openai-compatible'],
    reasoningEffort: 'off',
    thinkingMode: 'auto',
    localProviderId: null,
  },
  assistant: {
    modelId: DEFAULT_PROVIDER_MODELS['openai-compatible'],
    reasoningEffort: 'medium',
    thinkingMode: 'auto',
    localProviderId: null,
  },
}

let cachedRaw: string | null | undefined
let cachedSnapshot: StoredLlmSettings = DEFAULT_LLM_SETTINGS

export function readLlmSettings(): StoredLlmSettings {
  if (typeof window === 'undefined') return DEFAULT_LLM_SETTINGS
  try {
    const raw = window.localStorage.getItem(LLM_SETTINGS_STORAGE_KEY)
    if (raw === cachedRaw) return cachedSnapshot
    cachedRaw = raw
    if (raw === null) {
      cachedSnapshot = DEFAULT_LLM_SETTINGS
      return cachedSnapshot
    }
    const parsed = storedLlmSettingsSchema.safeParse(JSON.parse(raw))
    cachedSnapshot = parsed.success ? parsed.data : DEFAULT_LLM_SETTINGS
    return cachedSnapshot
  } catch {
    return DEFAULT_LLM_SETTINGS
  }
}

export function writeLlmSettings(next: StoredLlmSettings): void {
  if (typeof window === 'undefined') return
  try {
    const serialized = JSON.stringify(next)
    window.localStorage.setItem(LLM_SETTINGS_STORAGE_KEY, serialized)
    cachedRaw = serialized
    cachedSnapshot = next
    window.dispatchEvent(new CustomEvent(LLM_SETTINGS_CHANGE_EVENT))
  } catch {
    // Ignore storage quota or private browsing write restrictions.
  }
}

export function updateLlmSettings(
  updater: (current: StoredLlmSettings) => StoredLlmSettings,
): StoredLlmSettings {
  const next = updater(readLlmSettings())
  writeLlmSettings(next)
  return next
}

function subscribeLlmSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === LLM_SETTINGS_STORAGE_KEY) {
      cachedRaw = undefined
      listener()
    }
  }
  window.addEventListener(LLM_SETTINGS_CHANGE_EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(LLM_SETTINGS_CHANGE_EVENT, listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useLlmSettings(): StoredLlmSettings {
  return useSyncExternalStore(
    subscribeLlmSettings,
    readLlmSettings,
    () => DEFAULT_LLM_SETTINGS,
  )
}

export function buildLlmRequestHeaders(
  role: LlmAgentRole,
  settings: StoredLlmSettings = readLlmSettings(),
): Record<string, string> {
  const roleConfig = settings[role]
  if (settings.mockMode) {
    return {
      [LLM_RUNTIME_HEADERS.mode]: 'mock',
      [LLM_RUNTIME_HEADERS.provider]: 'mock',
      [LLM_RUNTIME_HEADERS.modelId]: 'mock-clinmesh-v1',
      [LLM_RUNTIME_HEADERS.reasoningEffort]: roleConfig.reasoningEffort,
      [LLM_RUNTIME_HEADERS.thinkingMode]: roleConfig.thinkingMode,
    }
  }
  const localProviderId = roleConfig.localProviderId?.trim() ?? ''
  if (localProviderId.length > 0) {
    return {
      [LLM_RUNTIME_HEADERS.mode]: 'local',
      [LLM_RUNTIME_HEADERS.localProvider]: localProviderId,
      ...(roleConfig.modelId.trim().length > 0 ? { [LLM_RUNTIME_HEADERS.modelId]: roleConfig.modelId.trim() } : {}),
      [LLM_RUNTIME_HEADERS.reasoningEffort]: roleConfig.reasoningEffort,
      [LLM_RUNTIME_HEADERS.thinkingMode]: roleConfig.thinkingMode,
    }
  }
  const trimmedKey = settings.apiKey.trim()
  if (trimmedKey.length === 0) {
    return {}
  }
  const trimmedBaseUrl = settings.baseUrl.trim()
  const trimmedModel = roleConfig.modelId.trim() || DEFAULT_PROVIDER_MODELS[settings.provider]
  return {
    [LLM_RUNTIME_HEADERS.mode]: 'live',
    [LLM_RUNTIME_HEADERS.provider]: settings.provider,
    ...(trimmedBaseUrl.length > 0 ? { [LLM_RUNTIME_HEADERS.baseUrl]: trimmedBaseUrl } : {}),
    [LLM_RUNTIME_HEADERS.modelId]: trimmedModel,
    [LLM_RUNTIME_HEADERS.apiKey]: trimmedKey,
    [LLM_RUNTIME_HEADERS.reasoningEffort]: roleConfig.reasoningEffort,
    [LLM_RUNTIME_HEADERS.thinkingMode]: roleConfig.thinkingMode,
  }
}

export type { LlmReasoningEffort, LlmThinkingMode }
