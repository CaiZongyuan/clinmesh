import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider,
} from '@earendil-works/pi-ai/providers/all'
import {
  llmCatalogApiSchema,
  llmReasoningEffortSchema,
  type LlmCatalogApi,
  type LlmCatalogModel,
  type LlmLocalProviderSummary,
  type LlmReasoningEffort,
} from '@clinmesh/contracts/agent-sessions'

export interface LocalCliProviderDiscoveryOptions {
  enabled: boolean
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

export interface ResolvedLocalModelRuntime {
  providerId: string
  providerDisplayName: string
  source: 'pi' | 'claude' | 'codex'
  api: Exclude<LlmCatalogApi, 'mock'>
  baseUrl: string
  apiKey?: string
  useBearerHeader: boolean
  headers?: Record<string, string>
  compat?: Record<string, unknown>
  thinkingLevelMap?: Record<string, string | null>
  model: LlmCatalogModel
  secrets: string[]
}

interface InternalLocalModelEntry {
  summary: LlmCatalogModel
  compat?: Record<string, unknown>
  thinkingLevelMap?: Record<string, string | null>
  headers?: Record<string, string>
}

interface InternalLocalProviderEntry {
  summary: LlmLocalProviderSummary
  baseUrl: string
  apiKey?: string
  useBearerHeader: boolean
  headers?: Record<string, string>
  compat?: Record<string, unknown>
  modelsById: Map<string, InternalLocalModelEntry>
  secrets: string[]
}

const SUPPORTED_LIVE_APIS = new Set<Exclude<LlmCatalogApi, 'mock'>>([
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'google-generative-ai',
])

const THINKING_ORDER: readonly LlmReasoningEffort[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

function normalizeThinkingLevel(value: unknown): LlmReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined
  const lower = value.trim().toLowerCase()
  if (lower === 'none' || lower === 'disabled') return 'off'
  const parsed = llmReasoningEffortSchema.safeParse(lower)
  return parsed.success ? parsed.data : undefined
}

function normalizeSupportedApi(value: unknown): Exclude<LlmCatalogApi, 'mock'> | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = llmCatalogApiSchema.safeParse(value.trim())
  if (!parsed.success || parsed.data === 'mock') return undefined
  return SUPPORTED_LIVE_APIS.has(parsed.data) ? parsed.data : undefined
}

function sanitizeBaseUrlHost(rawUrl: string | undefined): string | null {
  if (!rawUrl || rawUrl.trim().length === 0) return null
  try {
    const parsed = new URL(rawUrl.trim())
    return parsed.host || null
  } catch {
    return null
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value)
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const num = Number(value.trim())
    if (Number.isFinite(num) && num > 0) return Math.round(num)
  }
  return fallback
}

function looksLikeAdaptiveAnthropicModel(modelId: string, api: Exclude<LlmCatalogApi, 'mock'>): boolean {
  if (api !== 'anthropic-messages') return false
  const lower = modelId.toLowerCase()
  return lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus') || lower.includes('haiku')
}

function deriveSupportedLevels(options: {
  reasoning: boolean
  api: Exclude<LlmCatalogApi, 'mock'>
  thinkingLevelMap?: Record<string, string | null> | undefined
  explicitLevels?: readonly LlmReasoningEffort[] | undefined
}): LlmReasoningEffort[] {
  if (!options.reasoning) return ['off']
  if (options.explicitLevels !== undefined && options.explicitLevels.length > 0) {
    const unique = new Set<LlmReasoningEffort>(['off', ...options.explicitLevels])
    return THINKING_ORDER.filter(level => unique.has(level))
  }
  if (options.thinkingLevelMap !== undefined) {
    const allowed: LlmReasoningEffort[] = []
    for (const level of THINKING_ORDER) {
      const mapped = options.thinkingLevelMap[level]
      if (mapped === null) continue
      if (mapped !== undefined || level === 'off' || level === 'low' || level === 'medium' || level === 'high') {
        allowed.push(level)
      }
    }
    if (allowed.length > 0) return allowed
  }
  if (options.api === 'anthropic-messages') {
    return ['off', 'low', 'medium', 'high', 'max']
  }
  if (options.api === 'openai-responses' || options.api === 'openai-codex-responses') {
    return ['off', 'low', 'medium', 'high', 'xhigh']
  }
  return ['off', 'minimal', 'low', 'medium', 'high']
}

function extractStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && k.trim().length > 0) {
      out[k] = v
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function collectHeaderSecrets(headers: Record<string, string> | undefined): string[] {
  if (!headers) return []
  const secrets: string[] = []
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (
      lower.includes('auth')
      || lower.includes('key')
      || lower.includes('token')
      || lower.includes('secret')
    ) {
      const stripped = v.replace(/^Bearer\s+/i, '').trim()
      if (stripped.length >= 4) secrets.push(stripped)
      if (v.trim().length >= 4) secrets.push(v.trim())
    }
  }
  return secrets
}

function resolvePiAuthJsonSecret(
  authEntry: unknown,
): { apiKey?: string; authKind: LlmLocalProviderSummary['authKind'] } {
  if (!isPlainRecord(authEntry)) return { authKind: 'none' }
  const type = typeof authEntry.type === 'string' ? authEntry.type : ''
  if (type === 'api_key' && typeof authEntry.key === 'string' && authEntry.key.trim().length > 0) {
    return { apiKey: authEntry.key.trim(), authKind: 'api-key' }
  }
  if (type === 'oauth' && typeof authEntry.access === 'string' && authEntry.access.trim().length > 0) {
    return { apiKey: authEntry.access.trim(), authKind: 'oauth' }
  }
  return { authKind: 'none' }
}

function resolvePiConfigKey(
  rawApiKey: unknown,
  authHeader: boolean,
  authJsonEntry: unknown,
  env: NodeJS.ProcessEnv,
): { apiKey?: string; authKind: LlmLocalProviderSummary['authKind']; useBearerHeader: boolean } {
  if (typeof rawApiKey === 'string') {
    const trimmed = rawApiKey.trim()
    // Never execute shell commands from local config files ("!cmd").
    if (trimmed.length > 0 && !trimmed.startsWith('!')) {
      const fromEnv = env[trimmed]?.trim()
      if (fromEnv && fromEnv.length > 0) {
        return {
          apiKey: fromEnv,
          authKind: 'env-var',
          useBearerHeader: authHeader,
        }
      }
      // If it looks like an unresolved ALL_CAPS env variable name with no value, fall through to auth.json
      const looksLikeUnsetEnvVar = /^[A-Z][A-Z0-9_]{2,}$/.test(trimmed)
      if (!looksLikeUnsetEnvVar) {
        return {
          apiKey: trimmed,
          authKind: authHeader ? 'bearer-token' : 'api-key',
          useBearerHeader: authHeader,
        }
      }
    }
  }
  const fromAuth = resolvePiAuthJsonSecret(authJsonEntry)
  if (fromAuth.apiKey !== undefined) {
    return {
      apiKey: fromAuth.apiKey,
      authKind: fromAuth.authKind,
      useBearerHeader: authHeader,
    }
  }
  return { authKind: 'none', useBearerHeader: authHeader }
}

function loadBuiltinModelsForProvider(providerKey: string): InternalLocalModelEntry[] {
  const builtins = new Set<string>(getBuiltinProviders())
  if (!builtins.has(providerKey)) return []
  const models = getBuiltinModels(providerKey as BuiltinProvider)
  const out: InternalLocalModelEntry[] = []
  for (const model of models) {
    const api = normalizeSupportedApi(model.api)
    if (api === undefined) continue
    const thinkingLevelMap = isPlainRecord(model.thinkingLevelMap)
      ? (model.thinkingLevelMap as Record<string, string | null>)
      : undefined
    const compat = isPlainRecord(model.compat) ? (model.compat as Record<string, unknown>) : undefined
    const supportsAdaptiveThinking = api === 'anthropic-messages'
      && (compat?.forceAdaptiveThinking === true || looksLikeAdaptiveAnthropicModel(model.id, api))
    const summary: LlmCatalogModel = {
      id: model.id,
      name: model.name || model.id,
      api,
      contextWindow: asPositiveInt(model.contextWindow, 128_000),
      maxTokens: asPositiveInt(model.maxTokens, 8_192),
      reasoning: Boolean(model.reasoning),
      supportedThinkingLevels: deriveSupportedLevels({
        reasoning: Boolean(model.reasoning),
        api,
        thinkingLevelMap,
      }),
      supportsAdaptiveThinking,
    }
    out.push({
      summary,
      ...(compat === undefined ? {} : { compat }),
      ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    })
  }
  return out
}

function discoverPiProviders(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): InternalLocalProviderEntry[] {
  const agentDir = join(homeDir, '.pi', 'agent')
  if (!existsSync(agentDir)) return []

  const settingsRaw = readJsonFile(join(agentDir, 'settings.json'))
  const authRaw = readJsonFile(join(agentDir, 'auth.json'))
  const modelsRaw = readJsonFile(join(agentDir, 'models.json'))

  const settings = isPlainRecord(settingsRaw) ? settingsRaw : {}
  const authMap = isPlainRecord(authRaw) ? authRaw : {}
  const defaultProviderKey = typeof settings.defaultProvider === 'string' ? settings.defaultProvider.trim() : null
  const defaultModelIdFromSettings = typeof settings.defaultModel === 'string' ? settings.defaultModel.trim() : null
  const defaultThinking = normalizeThinkingLevel(settings.defaultThinkingLevel) ?? null

  const entries: InternalLocalProviderEntry[] = []
  const seenKeys = new Set<string>()

  const customProviders = isPlainRecord(modelsRaw) && isPlainRecord(modelsRaw.providers)
    ? modelsRaw.providers
    : {}

  for (const [providerKey, rawConfig] of Object.entries(customProviders)) {
    if (!isPlainRecord(rawConfig)) continue
    seenKeys.add(providerKey)

    const defaultApi = normalizeSupportedApi(rawConfig.api) ?? 'openai-completions'
    const baseUrl = typeof rawConfig.baseUrl === 'string' && rawConfig.baseUrl.trim().length > 0
      ? rawConfig.baseUrl.trim()
      : ''
    const authHeader = rawConfig.authHeader === true
    const providerHeaders = extractStringRecord(rawConfig.headers)
    const providerCompat = isPlainRecord(rawConfig.compat) ? rawConfig.compat : undefined

    const resolvedAuth = resolvePiConfigKey(rawConfig.apiKey, authHeader, authMap[providerKey], env)
    const hasCustomAuthHeader = providerHeaders !== undefined && Object.keys(providerHeaders).some(k => {
      const lower = k.toLowerCase()
      return lower === 'authorization' || lower === 'x-api-key'
    })
    const authReady = resolvedAuth.apiKey !== undefined || hasCustomAuthHeader
    const authKind = resolvedAuth.authKind !== 'none'
      ? resolvedAuth.authKind
      : (hasCustomAuthHeader ? 'bearer-token' : 'none')

    const modelsById = new Map<string, InternalLocalModelEntry>()
    const rawModels = Array.isArray(rawConfig.models) ? rawConfig.models : []

    for (const rawModel of rawModels) {
      if (!isPlainRecord(rawModel) || typeof rawModel.id !== 'string' || rawModel.id.trim().length === 0) continue
      const modelId = rawModel.id.trim()
      const modelApi = normalizeSupportedApi(rawModel.api) ?? defaultApi
      const modelCompat = isPlainRecord(rawModel.compat)
        ? { ...providerCompat, ...rawModel.compat }
        : providerCompat
      const modelHeaders = extractStringRecord(rawModel.headers)
      const thinkingLevelMap = isPlainRecord(rawModel.thinkingLevelMap)
        ? (rawModel.thinkingLevelMap as Record<string, string | null>)
        : undefined
      const reasoning = rawModel.reasoning === undefined ? true : Boolean(rawModel.reasoning)
      const supportsAdaptiveThinking = modelApi === 'anthropic-messages'
        && (modelCompat?.forceAdaptiveThinking === true || looksLikeAdaptiveAnthropicModel(modelId, modelApi))
      const isDefault = defaultProviderKey === providerKey && defaultModelIdFromSettings === modelId
      const summary: LlmCatalogModel = {
        id: modelId,
        name: typeof rawModel.name === 'string' && rawModel.name.trim().length > 0 ? rawModel.name.trim() : modelId,
        api: modelApi,
        contextWindow: asPositiveInt(rawModel.contextWindow, 128_000),
        maxTokens: asPositiveInt(rawModel.maxTokens, 8_192),
        reasoning,
        supportedThinkingLevels: deriveSupportedLevels({ reasoning, api: modelApi, thinkingLevelMap }),
        supportsAdaptiveThinking,
        ...(isDefault ? { isDefault: true } : {}),
      }
      modelsById.set(modelId, {
        summary,
        ...(modelCompat === undefined ? {} : { compat: modelCompat }),
        ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
        ...(modelHeaders === undefined ? {} : { headers: modelHeaders }),
      })
    }

    if (modelsById.size === 0) {
      for (const builtin of loadBuiltinModelsForProvider(providerKey)) {
        const isDefault = defaultProviderKey === providerKey && defaultModelIdFromSettings === builtin.summary.id
        modelsById.set(builtin.summary.id, {
          ...builtin,
          summary: { ...builtin.summary, ...(isDefault ? { isDefault: true } : {}) },
        })
      }
    }

    const models = [...modelsById.values()].map(m => m.summary)
    if (models.length === 0 || baseUrl.length === 0) continue

    const displayName = typeof rawConfig.name === 'string' && rawConfig.name.trim().length > 0
      ? rawConfig.name.trim()
      : providerKey
    const defaultModelId = defaultProviderKey === providerKey && defaultModelIdFromSettings && modelsById.has(defaultModelIdFromSettings)
      ? defaultModelIdFromSettings
      : (models[0]?.id ?? null)

    const secrets = [
      ...(resolvedAuth.apiKey ? [resolvedAuth.apiKey] : []),
      ...collectHeaderSecrets(providerHeaders),
      ...[...modelsById.values()].flatMap(m => collectHeaderSecrets(m.headers)),
    ]

    entries.push({
      summary: {
        id: `pi:${providerKey}`,
        source: 'pi',
        providerKey,
        displayName,
        api: models[0]?.api ?? defaultApi,
        baseUrlHost: sanitizeBaseUrlHost(baseUrl),
        originPath: '~/.pi/agent/models.json',
        authReady,
        authKind,
        defaultModelId,
        defaultThinkingLevel: defaultProviderKey === providerKey ? defaultThinking : null,
        models,
      },
      baseUrl,
      ...(resolvedAuth.apiKey === undefined ? {} : { apiKey: resolvedAuth.apiKey }),
      useBearerHeader: resolvedAuth.useBearerHeader,
      ...(providerHeaders === undefined ? {} : { headers: providerHeaders }),
      ...(providerCompat === undefined ? {} : { compat: providerCompat }),
      modelsById,
      secrets,
    })
  }

  // Also expose built-in providers that have credentials in ~/.pi/agent/auth.json
  for (const [providerKey, authEntry] of Object.entries(authMap)) {
    if (seenKeys.has(providerKey)) continue
    const resolvedAuth = resolvePiAuthJsonSecret(authEntry)
    if (resolvedAuth.apiKey === undefined) continue
    const builtinModels = loadBuiltinModelsForProvider(providerKey)
    if (builtinModels.length === 0) continue
    const firstModel = getBuiltinModels(providerKey as BuiltinProvider)[0]
    const baseUrl = firstModel?.baseUrl ?? ''
    if (baseUrl.length === 0) continue

    const modelsById = new Map<string, InternalLocalModelEntry>()
    for (const entry of builtinModels) {
      const isDefault = defaultProviderKey === providerKey && defaultModelIdFromSettings === entry.summary.id
      modelsById.set(entry.summary.id, {
        ...entry,
        summary: { ...entry.summary, ...(isDefault ? { isDefault: true } : {}) },
      })
    }
    const models = [...modelsById.values()].map(m => m.summary)
    const defaultModelId = defaultProviderKey === providerKey && defaultModelIdFromSettings && modelsById.has(defaultModelIdFromSettings)
      ? defaultModelIdFromSettings
      : (models[0]?.id ?? null)

    entries.push({
      summary: {
        id: `pi:${providerKey}`,
        source: 'pi',
        providerKey,
        displayName: providerKey,
        api: models[0]!.api,
        baseUrlHost: sanitizeBaseUrlHost(baseUrl),
        originPath: '~/.pi/agent/auth.json',
        authReady: true,
        authKind: resolvedAuth.authKind,
        defaultModelId,
        defaultThinkingLevel: defaultProviderKey === providerKey ? defaultThinking : null,
        models,
      },
      baseUrl,
      apiKey: resolvedAuth.apiKey,
      useBearerHeader: false,
      modelsById,
      secrets: [resolvedAuth.apiKey],
    })
  }

  return entries
}

function parseClaudeModelSpec(
  rawSpec: string,
  aliases: { sonnet?: string; opus?: string; haiku?: string },
  defaultContextWindow: number,
): { modelId: string; contextWindow: number } | null {
  const trimmed = rawSpec.trim()
  if (trimmed.length === 0) return null
  const outerHas1m = /\[1m\]$/i.test(trimmed)
  const stripped = trimmed.replace(/\[1m\]$/i, '').trim()
  if (stripped.length === 0) return null
  const lower = stripped.toLowerCase()
  const aliasResolved = lower === 'sonnet'
    ? (aliases.sonnet ?? 'claude-sonnet-4-6')
    : lower === 'opus'
      ? (aliases.opus ?? 'claude-opus-4-6')
      : lower === 'haiku'
        ? (aliases.haiku ?? 'claude-haiku-4-5')
        : stripped
  const innerHas1m = /\[1m\]$/i.test(aliasResolved)
  const modelId = aliasResolved.replace(/\[1m\]$/i, '').trim()
  if (modelId.length === 0) return null
  return {
    modelId,
    contextWindow: outerHas1m || innerHas1m ? 1_000_000 : defaultContextWindow,
  }
}

function discoverClaudeProviders(homeDir: string): InternalLocalProviderEntry[] {
  const claudeDir = join(homeDir, '.claude')
  if (!existsSync(claudeDir)) return []

  const settingsRaw = readJsonFile(join(claudeDir, 'settings.json'))
  const localSettingsRaw = readJsonFile(join(claudeDir, 'settings.local.json'))
  const credentialsRaw = readJsonFile(join(claudeDir, '.credentials.json'))

  const settings = isPlainRecord(settingsRaw) ? settingsRaw : {}
  const localSettings = isPlainRecord(localSettingsRaw) ? localSettingsRaw : {}
  const mergedEnv: Record<string, string> = {
    ...extractStringRecord(settings.env),
    ...extractStringRecord(localSettings.env),
  }

  const oauthAccessToken = isPlainRecord(credentialsRaw)
    && isPlainRecord(credentialsRaw.claudeAiOauth)
    && typeof credentialsRaw.claudeAiOauth.accessToken === 'string'
    && credentialsRaw.claudeAiOauth.accessToken.trim().length > 0
    ? credentialsRaw.claudeAiOauth.accessToken.trim()
    : undefined

  let apiKey: string | undefined
  let authKind: LlmLocalProviderSummary['authKind'] = 'none'
  let useBearerHeader = false
  let originPath = '~/.claude/settings.json'

  if (mergedEnv.ANTHROPIC_AUTH_TOKEN && mergedEnv.ANTHROPIC_AUTH_TOKEN.trim().length > 0) {
    apiKey = mergedEnv.ANTHROPIC_AUTH_TOKEN.trim()
    if (apiKey.includes('sk-ant-oat')) {
      authKind = 'oauth'
      useBearerHeader = false
    } else {
      authKind = 'bearer-token'
      useBearerHeader = true
    }
  } else if (mergedEnv.ANTHROPIC_API_KEY && mergedEnv.ANTHROPIC_API_KEY.trim().length > 0) {
    apiKey = mergedEnv.ANTHROPIC_API_KEY.trim()
    authKind = 'api-key'
    useBearerHeader = false
  } else if (oauthAccessToken !== undefined) {
    apiKey = oauthAccessToken
    authKind = 'oauth'
    useBearerHeader = false
    originPath = '~/.claude/.credentials.json'
  }

  const baseUrl = mergedEnv.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com'
  const configuredContext = asPositiveInt(mergedEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 200_000)
  const configuredMaxOutput = Math.min(128_000, asPositiveInt(mergedEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS, 16_384))
  const aliases = {
    ...(mergedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL ? { sonnet: mergedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL.trim() } : {}),
    ...(mergedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL ? { opus: mergedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL.trim() } : {}),
    ...(mergedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL ? { haiku: mergedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL.trim() } : {}),
  }

  const rawDefaultModel = typeof localSettings.model === 'string'
    ? localSettings.model
    : typeof settings.model === 'string'
      ? settings.model
      : mergedEnv.ANTHROPIC_MODEL

  const parsedDefault = rawDefaultModel
    ? parseClaudeModelSpec(rawDefaultModel, aliases, configuredContext)
    : null

  const candidateSpecs: Array<{ spec: string; label?: string }> = []
  if (rawDefaultModel) candidateSpecs.push({ spec: rawDefaultModel })
  if (mergedEnv.ANTHROPIC_MODEL) candidateSpecs.push({ spec: mergedEnv.ANTHROPIC_MODEL })
  if (mergedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL) candidateSpecs.push({ spec: mergedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, label: 'Opus' })
  if (mergedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL) candidateSpecs.push({ spec: mergedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, label: 'Sonnet' })
  if (mergedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL) candidateSpecs.push({ spec: mergedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, label: 'Haiku' })
  if (mergedEnv.ANTHROPIC_SMALL_FAST_MODEL) candidateSpecs.push({ spec: mergedEnv.ANTHROPIC_SMALL_FAST_MODEL, label: 'Fast' })

  if (candidateSpecs.length === 0 && apiKey !== undefined) {
    candidateSpecs.push(
      { spec: 'claude-sonnet-4-6', label: 'Sonnet' },
      { spec: 'claude-opus-4-6', label: 'Opus' },
      { spec: 'claude-haiku-4-5', label: 'Haiku' },
    )
  }

  if (candidateSpecs.length === 0 && apiKey === undefined) return []

  const modelsById = new Map<string, InternalLocalModelEntry>()
  for (const item of candidateSpecs) {
    const parsed = parseClaudeModelSpec(item.spec, aliases, configuredContext)
    if (parsed === null) continue
    const existing = modelsById.get(parsed.modelId)
    if (existing !== undefined) {
      if (parsed.contextWindow > existing.summary.contextWindow) {
        existing.summary = { ...existing.summary, contextWindow: parsed.contextWindow }
      }
      continue
    }
    const isDefault = parsedDefault?.modelId === parsed.modelId
    const supportsAdaptiveThinking = looksLikeAdaptiveAnthropicModel(parsed.modelId, 'anthropic-messages')
    const summary: LlmCatalogModel = {
      id: parsed.modelId,
      name: item.label ? `${parsed.modelId} (${item.label})` : parsed.modelId,
      api: 'anthropic-messages',
      contextWindow: parsed.contextWindow,
      maxTokens: configuredMaxOutput,
      reasoning: true,
      supportedThinkingLevels: deriveSupportedLevels({ reasoning: true, api: 'anthropic-messages' }),
      supportsAdaptiveThinking,
      ...(isDefault ? { isDefault: true } : {}),
    }
    modelsById.set(parsed.modelId, { summary })
  }

  const models = [...modelsById.values()].map(m => m.summary)
  if (models.length === 0) return []

  const host = sanitizeBaseUrlHost(baseUrl)
  const displayName = host && host !== 'api.anthropic.com' ? `Claude Code (${host})` : 'Claude Code'
  const alwaysThinking = localSettings.alwaysThinkingEnabled ?? settings.alwaysThinkingEnabled
  const defaultThinkingLevel: LlmReasoningEffort = alwaysThinking === false ? 'off' : 'medium'

  return [{
    summary: {
      id: 'claude:local',
      source: 'claude',
      providerKey: 'claude-code',
      displayName,
      api: 'anthropic-messages',
      baseUrlHost: host,
      originPath,
      authReady: apiKey !== undefined,
      authKind,
      defaultModelId: parsedDefault?.modelId ?? models[0]?.id ?? null,
      defaultThinkingLevel,
      models,
    },
    baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    useBearerHeader,
    modelsById,
    secrets: apiKey ? [apiKey] : [],
  }]
}

function stripTomlComment(line: string): string {
  let inDouble = false
  let inSingle = false
  let escaped = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (inDouble && ch === '\\') {
      escaped = true
      continue
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble
      continue
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle
      continue
    }
    if (!inDouble && !inSingle && ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

function parseTomlScalar(rawValue: string): string | number | boolean | undefined {
  const trimmed = rawValue.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  const numericCandidate = trimmed.replaceAll('_', '')
  if (/^-?\d+(\.\d+)?$/.test(numericCandidate)) {
    const num = Number(numericCandidate)
    if (Number.isFinite(num)) return num
  }
  return undefined
}

interface ParsedCodexToml {
  top: Record<string, string | number | boolean>
  modelProviders: Record<string, Record<string, string | number | boolean>>
}

function parseCodexConfigToml(source: string): ParsedCodexToml {
  const top: Record<string, string | number | boolean> = {}
  const modelProviders: Record<string, Record<string, string | number | boolean>> = {}
  let currentSection: 'top' | 'other' | { kind: 'provider'; id: string } = 'top'

  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim()
    if (line.length === 0) continue

    if (line.startsWith('[') && line.endsWith(']')) {
      const header = line.slice(1, -1).trim()
      const providerMatch = /^model_providers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/.exec(header)
      if (providerMatch !== null) {
        const providerId = providerMatch[1] ?? providerMatch[2] ?? providerMatch[3] ?? ''
        if (providerId.length > 0) {
          modelProviders[providerId] ??= {}
          currentSection = { kind: 'provider', id: providerId }
          continue
        }
      }
      currentSection = 'other'
      continue
    }

    const eqIdx = line.indexOf('=')
    if (eqIdx <= 0) continue
    const rawKey = line.slice(0, eqIdx).trim().replace(/^["']|["']$/g, '')
    const rawVal = line.slice(eqIdx + 1)
    const parsedVal = parseTomlScalar(rawVal)
    if (rawKey.length === 0 || parsedVal === undefined) continue

    if (currentSection === 'top') {
      top[rawKey] = parsedVal
    } else if (typeof currentSection === 'object' && currentSection.kind === 'provider') {
      modelProviders[currentSection.id]![rawKey] = parsedVal
    }
  }

  return { top, modelProviders }
}

function parseCodexCatalogFile(
  codexDir: string,
  catalogRef: string | undefined,
  api: Exclude<LlmCatalogApi, 'mock'>,
  defaultModelId: string | null,
  fallbackContextWindow: number,
): InternalLocalModelEntry[] {
  if (!catalogRef || catalogRef.trim().length === 0) return []
  const resolvedPath = isAbsolute(catalogRef.trim()) ? catalogRef.trim() : join(codexDir, catalogRef.trim())
  const parsed = readJsonFile(resolvedPath)
  const items = Array.isArray(parsed)
    ? parsed
    : isPlainRecord(parsed) && Array.isArray(parsed.models)
      ? parsed.models
      : []

  const out: InternalLocalModelEntry[] = []
  for (const item of items) {
    if (!isPlainRecord(item)) continue
    if (item.supported_in_api === false) continue
    if (item.visibility === 'hide') continue
    const id = typeof item.slug === 'string'
      ? item.slug.trim()
      : typeof item.id === 'string'
        ? item.id.trim()
        : ''
    if (id.length === 0) continue
    const displayName = typeof item.display_name === 'string' && item.display_name.trim().length > 0
      ? item.display_name.trim()
      : typeof item.name === 'string' && item.name.trim().length > 0
        ? item.name.trim()
        : id
    const explicitLevels: LlmReasoningEffort[] = []
    if (Array.isArray(item.supported_reasoning_levels)) {
      for (const entry of item.supported_reasoning_levels) {
        const rawEffort = typeof entry === 'string'
          ? entry
          : isPlainRecord(entry) && typeof entry.effort === 'string'
            ? entry.effort
            : undefined
        const normalized = normalizeThinkingLevel(rawEffort)
        if (normalized !== undefined) explicitLevels.push(normalized)
      }
    }
    const defaultLevel = normalizeThinkingLevel(item.default_reasoning_level)
    const reasoning = explicitLevels.some(l => l !== 'off') || item.supports_reasoning_summaries === true || defaultLevel !== undefined
    const contextWindow = asPositiveInt(item.context_window ?? item.contextWindow, fallbackContextWindow)
    const maxTokens = asPositiveInt(item.max_output_tokens ?? item.maxTokens, 16_384)
    out.push({
      summary: {
        id,
        name: displayName,
        api,
        contextWindow,
        maxTokens,
        reasoning,
        supportedThinkingLevels: deriveSupportedLevels({
          reasoning,
          api,
          explicitLevels: explicitLevels.length > 0 ? explicitLevels : undefined,
        }),
        supportsAdaptiveThinking: false,
        ...(defaultLevel === undefined ? {} : { defaultThinkingLevel: defaultLevel }),
        ...(defaultModelId === id ? { isDefault: true } : {}),
      },
    })
  }
  return out
}

function discoverCodexProviders(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): InternalLocalProviderEntry[] {
  const codexDir = join(homeDir, '.codex')
  if (!existsSync(codexDir)) return []

  const configPath = join(codexDir, 'config.toml')
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
  const parsedToml = configText.length > 0 ? parseCodexConfigToml(configText) : { top: {}, modelProviders: {} }

  const authRaw = readJsonFile(join(codexDir, 'auth.json'))
  const authObj = isPlainRecord(authRaw) ? authRaw : {}
  const authOpenAiKey = typeof authObj.OPENAI_API_KEY === 'string' && authObj.OPENAI_API_KEY.trim().length > 0
    ? authObj.OPENAI_API_KEY.trim()
    : undefined
  const authOAuthToken = isPlainRecord(authObj.tokens)
    && typeof authObj.tokens.access_token === 'string'
    && authObj.tokens.access_token.trim().length > 0
    ? authObj.tokens.access_token.trim()
    : undefined

  const activeProviderKey = typeof parsedToml.top.model_provider === 'string' ? parsedToml.top.model_provider.trim() : null
  const topModel = typeof parsedToml.top.model === 'string' && parsedToml.top.model.trim().length > 0
    ? parsedToml.top.model.trim()
    : null
  const topReasoning = normalizeThinkingLevel(parsedToml.top.model_reasoning_effort) ?? null
  const topContextWindow = asPositiveInt(parsedToml.top.model_context_window, 200_000)
  const topCatalogJson = typeof parsedToml.top.model_catalog_json === 'string' ? parsedToml.top.model_catalog_json : undefined
  const topBaseUrl = typeof parsedToml.top.openai_base_url === 'string' ? parsedToml.top.openai_base_url.trim() : undefined

  const entries: InternalLocalProviderEntry[] = []
  const providerSections = Object.entries(parsedToml.modelProviders)

  for (const [providerKey, section] of providerSections) {
    const wireApi = typeof section.wire_api === 'string' ? section.wire_api.trim().toLowerCase() : 'responses'
    const api: Exclude<LlmCatalogApi, 'mock'> = wireApi === 'chat' ? 'openai-completions' : 'openai-responses'
    const baseUrl = typeof section.base_url === 'string' && section.base_url.trim().length > 0
      ? section.base_url.trim()
      : (topBaseUrl ?? 'https://api.openai.com/v1')
    const requiresOpenAiAuth = section.requires_openai_auth !== false

    let apiKey: string | undefined
    let authKind: LlmLocalProviderSummary['authKind'] = 'none'
    if (typeof section.experimental_bearer_token === 'string' && section.experimental_bearer_token.trim().length > 0) {
      apiKey = section.experimental_bearer_token.trim()
      authKind = 'bearer-token'
    } else if (typeof section.env_key === 'string' && section.env_key.trim().length > 0) {
      const fromEnv = env[section.env_key.trim()]?.trim()
      if (fromEnv && fromEnv.length > 0) {
        apiKey = fromEnv
        authKind = 'env-var'
      }
    }
    if (apiKey === undefined && requiresOpenAiAuth) {
      if (authOpenAiKey !== undefined) {
        apiKey = authOpenAiKey
        authKind = 'api-key'
      } else if (authOAuthToken !== undefined) {
        apiKey = authOAuthToken
        authKind = 'oauth'
      }
    }

    const modelsById = new Map<string, InternalLocalModelEntry>()
    const shouldAttachCatalog = activeProviderKey === providerKey || (activeProviderKey === null && providerSections.length === 1)
    if (shouldAttachCatalog && topCatalogJson) {
      for (const catalogEntry of parseCodexCatalogFile(codexDir, topCatalogJson, api, topModel, topContextWindow)) {
        modelsById.set(catalogEntry.summary.id, catalogEntry)
      }
    }
    if (shouldAttachCatalog && topModel !== null && !modelsById.has(topModel)) {
      modelsById.set(topModel, {
        summary: {
          id: topModel,
          name: topModel,
          api,
          contextWindow: topContextWindow,
          maxTokens: 16_384,
          reasoning: true,
          supportedThinkingLevels: deriveSupportedLevels({ reasoning: true, api }),
          supportsAdaptiveThinking: false,
          ...(topReasoning === null ? {} : { defaultThinkingLevel: topReasoning }),
          isDefault: true,
        },
      })
    }
    if (modelsById.size === 0) {
      modelsById.set(topModel ?? 'gpt-5.4', {
        summary: {
          id: topModel ?? 'gpt-5.4',
          name: topModel ?? 'gpt-5.4',
          api,
          contextWindow: topContextWindow,
          maxTokens: 16_384,
          reasoning: true,
          supportedThinkingLevels: deriveSupportedLevels({ reasoning: true, api }),
          supportsAdaptiveThinking: false,
          ...(topReasoning === null ? {} : { defaultThinkingLevel: topReasoning }),
        },
      })
    }

    const models = [...modelsById.values()].map(m => m.summary)
    const displayName = typeof section.name === 'string' && section.name.trim().length > 0
      ? `Codex · ${section.name.trim()}`
      : `Codex · ${providerKey}`

    entries.push({
      summary: {
        id: `codex:${providerKey}`,
        source: 'codex',
        providerKey,
        displayName,
        api,
        baseUrlHost: sanitizeBaseUrlHost(baseUrl),
        originPath: '~/.codex/config.toml',
        authReady: apiKey !== undefined,
        authKind,
        defaultModelId: shouldAttachCatalog && topModel ? topModel : (models[0]?.id ?? null),
        defaultThinkingLevel: shouldAttachCatalog ? topReasoning : null,
        models,
      },
      baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
      useBearerHeader: false,
      modelsById,
      secrets: apiKey ? [apiKey] : [],
    })
  }

  // Fallback for standard Codex auth.json (OpenAI API key or ChatGPT OAuth) when no custom provider section exists
  if (entries.length === 0 && (authOpenAiKey !== undefined || authOAuthToken !== undefined)) {
    const isOAuth = authOpenAiKey === undefined && authOAuthToken !== undefined
    const api: Exclude<LlmCatalogApi, 'mock'> = isOAuth ? 'openai-codex-responses' : 'openai-responses'
    const baseUrl = isOAuth ? 'https://chatgpt.com/backend-api' : (topBaseUrl ?? 'https://api.openai.com/v1')
    const apiKey = authOpenAiKey ?? authOAuthToken!
    const modelsById = new Map<string, InternalLocalModelEntry>()
    const catalogEntries = topCatalogJson
      ? parseCodexCatalogFile(codexDir, topCatalogJson, api, topModel, topContextWindow)
      : loadBuiltinModelsForProvider(isOAuth ? 'openai-codex' : 'openai')
    for (const entry of catalogEntries) {
      modelsById.set(entry.summary.id, {
        ...entry,
        summary: {
          ...entry.summary,
          api,
          ...(topModel === entry.summary.id ? { isDefault: true } : {}),
        },
      })
    }
    if (topModel !== null && !modelsById.has(topModel)) {
      modelsById.set(topModel, {
        summary: {
          id: topModel,
          name: topModel,
          api,
          contextWindow: topContextWindow,
          maxTokens: 16_384,
          reasoning: true,
          supportedThinkingLevels: deriveSupportedLevels({ reasoning: true, api }),
          supportsAdaptiveThinking: false,
          ...(topReasoning === null ? {} : { defaultThinkingLevel: topReasoning }),
          isDefault: true,
        },
      })
    }
    const models = [...modelsById.values()].map(m => m.summary)
    if (models.length > 0) {
      entries.push({
        summary: {
          id: isOAuth ? 'codex:chatgpt' : 'codex:openai',
          source: 'codex',
          providerKey: isOAuth ? 'openai-codex' : 'openai',
          displayName: isOAuth ? 'Codex (ChatGPT OAuth)' : 'Codex (OpenAI)',
          api,
          baseUrlHost: sanitizeBaseUrlHost(baseUrl),
          originPath: '~/.codex/auth.json',
          authReady: true,
          authKind: isOAuth ? 'oauth' : 'api-key',
          defaultModelId: topModel ?? models[0]?.id ?? null,
          defaultThinkingLevel: topReasoning,
          models,
        },
        baseUrl,
        apiKey,
        useBearerHeader: false,
        modelsById,
        secrets: [apiKey],
      })
    }
  }

  return entries
}

/**
 * Read-only local CLI provider discovery for ~/.pi/agent, ~/.claude, and ~/.codex.
 *
 * Security invariants:
 * - Strictly read-only (never modifies CLI config files).
 * - Public catalog summaries NEVER contain API keys, bearer tokens, OAuth tokens, or auth headers.
 * - Resolved credentials live only in memory for the lifetime of an active turn and are registered
 *   with ClinMeshProviderRegistry's secret redactor.
 */
export class LocalCliProviderStore {
  readonly #enabled: boolean
  readonly #homeDir: string
  readonly #env: NodeJS.ProcessEnv
  #cache: {
    scannedAt: string
    expiresAtMs: number
    entries: InternalLocalProviderEntry[]
    byId: Map<string, InternalLocalProviderEntry>
  } | null = null

  constructor(options: LocalCliProviderDiscoveryOptions) {
    this.#enabled = options.enabled
    this.#homeDir = options.homeDir ?? homedir()
    this.#env = options.env ?? process.env
  }

  get enabled(): boolean {
    return this.#enabled
  }

  scan(options: { force?: boolean } = {}): {
    scannedAt: string
    providers: LlmLocalProviderSummary[]
  } {
    const snapshot = this.#load(options.force === true)
    return {
      scannedAt: snapshot.scannedAt,
      providers: snapshot.entries.map(entry => entry.summary),
    }
  }

  resolveModelRuntime(
    localProviderId: string,
    requestedModelId?: string,
  ): ResolvedLocalModelRuntime | null {
    if (!this.#enabled) return null
    const snapshot = this.#load(false)
    let entry = snapshot.byId.get(localProviderId)
    if (entry === undefined) {
      // Force one fresh scan in case the user just added a provider locally.
      entry = this.#load(true).byId.get(localProviderId)
    }
    if (entry === undefined) return null

    const targetModelId = requestedModelId?.trim() || entry.summary.defaultModelId || entry.summary.models[0]?.id
    if (!targetModelId) return null

    const matched = entry.modelsById.get(targetModelId)
    const modelSummary: LlmCatalogModel = matched?.summary ?? {
      id: targetModelId,
      name: targetModelId,
      api: entry.summary.api,
      contextWindow: 128_000,
      maxTokens: 8_192,
      reasoning: true,
      supportedThinkingLevels: deriveSupportedLevels({
        reasoning: true,
        api: entry.summary.api === 'mock' ? 'openai-completions' : entry.summary.api,
      }),
      supportsAdaptiveThinking: entry.summary.api === 'anthropic-messages'
        && looksLikeAdaptiveAnthropicModel(targetModelId, 'anthropic-messages'),
    }
    const api: Exclude<LlmCatalogApi, 'mock'> = modelSummary.api === 'mock' ? 'openai-completions' : modelSummary.api
    const mergedHeaders = entry.headers || matched?.headers
      ? { ...entry.headers, ...matched?.headers }
      : undefined
    const mergedCompat = entry.compat || matched?.compat
      ? { ...entry.compat, ...matched?.compat }
      : undefined

    return {
      providerId: entry.summary.id,
      providerDisplayName: entry.summary.displayName,
      source: entry.summary.source,
      api,
      baseUrl: entry.baseUrl,
      ...(entry.apiKey === undefined ? {} : { apiKey: entry.apiKey }),
      useBearerHeader: entry.useBearerHeader,
      ...(mergedHeaders === undefined ? {} : { headers: mergedHeaders }),
      ...(mergedCompat === undefined ? {} : { compat: mergedCompat }),
      ...(matched?.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: matched.thinkingLevelMap }),
      model: modelSummary,
      secrets: [...entry.secrets],
    }
  }

  #load(force: boolean) {
    const now = Date.now()
    if (!force && this.#cache !== null && now < this.#cache.expiresAtMs) {
      return this.#cache
    }
    const entries: InternalLocalProviderEntry[] = this.#enabled
      ? [
          ...discoverPiProviders(this.#homeDir, this.#env),
          ...discoverClaudeProviders(this.#homeDir),
          ...discoverCodexProviders(this.#homeDir, this.#env),
        ]
      : []
    const byId = new Map<string, InternalLocalProviderEntry>()
    for (const entry of entries) {
      byId.set(entry.summary.id, entry)
    }
    this.#cache = {
      scannedAt: new Date(now).toISOString(),
      expiresAtMs: now + 2_500,
      entries,
      byId,
    }
    return this.#cache
  }
}
