import type {
  LlmLocalProviderSummary,
  LlmReasoningEffort,
  LlmThinkingMode,
  TestLlmProviderResponse,
} from '@clinmesh/contracts/agent-sessions'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Switch } from '@clinmesh/ui/components/switch'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  EyeIcon,
  EyeOffIcon,
  FlaskConicalIcon,
  PlugZapIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TerminalIcon,
} from 'lucide-react'
import { useState } from 'react'
import {
  getLlmProviderCatalog,
  getLlmProviderStatus,
  testLlmProvider,
} from './agent-sessions-api.ts'
import {
  DEFAULT_PROVIDER_BASE_URLS,
  DEFAULT_PROVIDER_MODELS,
  updateLlmSettings,
  useLlmSettings,
  type LiveLlmProviderKind,
} from './llm-settings-storage.ts'
import { WorkspaceCard, WorkspaceCardLayout } from './workspace-card-layout.tsx'
import { VoiceSettingsCard } from './voice/voice-settings-card.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceSelect } from './workspace-select.tsx'

const PROVIDER_ITEMS: Array<{ value: LiveLlmProviderKind; labelZh: string; labelEn: string }> = [
  { value: 'openai-compatible', labelZh: 'OpenAI 兼容接口（自定义 Base URL）', labelEn: 'OpenAI-compatible (custom Base URL)' },
  { value: 'anthropic', labelZh: 'Anthropic (Claude)', labelEn: 'Anthropic (Claude)' },
  { value: 'gemini', labelZh: 'Google Gemini', labelEn: 'Google Gemini' },
]

const REASONING_ITEMS: Array<{ value: LlmReasoningEffort; labelZh: string; labelEn: string }> = [
  { value: 'off', labelZh: '关闭 (off)', labelEn: 'Off' },
  { value: 'minimal', labelZh: '极简 (minimal)', labelEn: 'Minimal' },
  { value: 'low', labelZh: '低 (low)', labelEn: 'Low' },
  { value: 'medium', labelZh: '中 (medium)', labelEn: 'Medium' },
  { value: 'high', labelZh: '高 (high)', labelEn: 'High' },
  { value: 'xhigh', labelZh: '极高 (xhigh)', labelEn: 'Extra High' },
  { value: 'max', labelZh: '最大 (max)', labelEn: 'Max' },
]

const THINKING_MODE_ITEMS: Array<{ value: LlmThinkingMode; labelZh: string; labelEn: string }> = [
  { value: 'auto', labelZh: '自动 (auto)', labelEn: 'Auto' },
  { value: 'adaptive', labelZh: '自适应思考 (adaptive)', labelEn: 'Adaptive thinking' },
  { value: 'budget', labelZh: '固定预算 (budget)', labelEn: 'Token budget' },
]

export function ModelsSettingsPage({ locale }: { locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const queryClient = useQueryClient()
  const settings = useLlmSettings()
  const [showApiKey, setShowApiKey] = useState(false)
  const [testResult, setTestResult] = useState<TestLlmProviderResponse | null>(null)
  const [savedNotice, setSavedNotice] = useState(false)

  const serverStatus = useQuery({
    queryKey: ['llm-provider-status'],
    queryFn: ({ signal }) => getLlmProviderStatus(signal),
  })

  const providerCatalog = useQuery({
    queryKey: ['llm-provider-catalog'],
    queryFn: ({ signal }) => getLlmProviderCatalog({ signal }),
    staleTime: 30_000,
    retry: false,
  })

  const refreshCatalog = useMutation({
    mutationFn: () => getLlmProviderCatalog({ refresh: true }),
    onSuccess: (fresh) => {
      queryClient.setQueryData(['llm-provider-catalog'], fresh)
    },
  })

  const localProviders = providerCatalog.data?.localProviders ?? []
  const activeAssistantLocal = settings.assistant.localProviderId
    ? localProviders.find(item => item.id === settings.assistant.localProviderId) ?? null
    : null
  const activePatientLocal = settings.patient.localProviderId
    ? localProviders.find(item => item.id === settings.patient.localProviderId) ?? null
    : null

  const connectionTest = useMutation({
    mutationFn: () => {
      if (settings.mockMode) {
        return testLlmProvider(
          {
            mode: 'mock',
            provider: 'mock',
            modelId: 'mock-clinmesh-v1',
            reasoningEffort: settings.assistant.reasoningEffort,
            thinkingMode: settings.assistant.thinkingMode,
          },
          '',
        )
      }
      if (settings.assistant.localProviderId !== null && settings.assistant.localProviderId.trim().length > 0) {
        return testLlmProvider(
          {
            mode: 'local',
            localProviderId: settings.assistant.localProviderId,
            modelId: settings.assistant.modelId.trim()
              || activeAssistantLocal?.defaultModelId
              || activeAssistantLocal?.models[0]?.id
              || 'default',
            reasoningEffort: settings.assistant.reasoningEffort,
            thinkingMode: settings.assistant.thinkingMode,
          },
          '',
        )
      }
      return testLlmProvider(
        {
          mode: 'live',
          provider: settings.provider,
          ...(settings.baseUrl.trim().length === 0 ? {} : { baseUrl: settings.baseUrl.trim() }),
          modelId: settings.assistant.modelId.trim() || DEFAULT_PROVIDER_MODELS[settings.provider],
          reasoningEffort: settings.assistant.reasoningEffort,
          thinkingMode: settings.assistant.thinkingMode,
        },
        settings.apiKey,
      )
    },
    onSuccess: (result) => {
      setTestResult(result)
    },
    onError: (error) => {
      setTestResult({
        ok: false,
        provider: settings.mockMode
          ? 'mock'
          : (settings.assistant.localProviderId ?? settings.provider),
        modelId: settings.assistant.modelId || DEFAULT_PROVIDER_MODELS[settings.provider],
        latencyMs: 0,
        errorCode: 'LLM_REQUEST_FAILED',
        message: error instanceof Error ? error.message : (zh ? '连接测试请求失败。' : 'Connection test failed.'),
      })
    },
  })

  const handleProviderChange = (nextProvider: LiveLlmProviderKind) => {
    setTestResult(null)
    setSavedNotice(false)
    updateLlmSettings((current) => {
      const prevDefaultBase = DEFAULT_PROVIDER_BASE_URLS[current.provider]
      const prevDefaultModel = DEFAULT_PROVIDER_MODELS[current.provider]
      const nextDefaultModel = DEFAULT_PROVIDER_MODELS[nextProvider]
      return {
        ...current,
        provider: nextProvider,
        baseUrl: current.baseUrl.trim() === '' || current.baseUrl === prevDefaultBase
          ? DEFAULT_PROVIDER_BASE_URLS[nextProvider]
          : current.baseUrl,
        patient: {
          ...current.patient,
          localProviderId: null,
          modelId: current.patient.modelId.trim() === '' || current.patient.modelId === prevDefaultModel
            ? nextDefaultModel
            : current.patient.modelId,
        },
        assistant: {
          ...current.assistant,
          localProviderId: null,
          modelId: current.assistant.modelId.trim() === '' || current.assistant.modelId === prevDefaultModel
            ? nextDefaultModel
            : current.assistant.modelId,
        },
      }
    })
  }

  const applyLocalProvider = (
    provider: LlmLocalProviderSummary,
    target: 'assistant' | 'patient',
  ) => {
    setTestResult(null)
    setSavedNotice(false)
    const defaultModel = provider.defaultModelId ?? provider.models[0]?.id ?? ''
    updateLlmSettings(current => ({
      ...current,
      mockMode: false,
      [target]: {
        ...current[target],
        localProviderId: provider.id,
        modelId: defaultModel || current[target].modelId,
        ...(provider.defaultThinkingLevel !== null && target === 'assistant'
          ? { reasoningEffort: provider.defaultThinkingLevel }
          : {}),
      },
    }))
  }

  return (
    <WorkspaceCardLayout id="settings-models-provider" locale={locale}>
      <section aria-labelledby="settings-models-heading" className="max-w-3xl space-y-4">
        <WorkspaceCard
          title={(
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="settings-models-heading">
                {zh ? '模型与服务商（BYOK 与 Mock 模式）' : 'Models & Provider (BYOK & Mock Mode)'}
              </h2>
              {settings.mockMode ? (
                <Badge variant="secondary">
                  <FlaskConicalIcon aria-hidden="true" className="size-3" />
                  {zh ? '演示 / Mock 模式已开启' : 'Mock Mode Active'}
                </Badge>
              ) : settings.assistant.localProviderId !== null ? (
                <Badge variant="secondary">
                  <TerminalIcon aria-hidden="true" className="size-3" />
                  {zh
                    ? `本地 CLI · ${activeAssistantLocal?.displayName ?? settings.assistant.localProviderId}`
                    : `Local CLI · ${activeAssistantLocal?.displayName ?? settings.assistant.localProviderId}`}
                </Badge>
              ) : serverStatus.data?.serverDefaultConfigured ? (
                <Badge variant="outline">
                  <ShieldCheckIcon aria-hidden="true" className="size-3" />
                  {zh ? '服务端 .env 默认密钥可用' : 'Server .env default available'}
                </Badge>
              ) : null}
            </div>
          )}
        >
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault()
              setSavedNotice(true)
            }}
          >
            <FieldSet className="rounded-md border bg-muted/20 p-3">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <FieldLabel htmlFor="llm-mock-mode-switch">
                    {zh ? '演示 / Mock 模式' : 'Demo / Mock Mode'}
                  </FieldLabel>
                  <FieldDescription>
                    {zh
                      ? '显式开启后，患者代理与临床助手均使用本地确定性模拟响应（pi-ai fauxProvider），工作台顶栏将持续显示 Mock Mode 徽标；关闭且未配置密钥时将明确报错，绝不静默降级。'
                      : 'When explicitly enabled, both Patient Agent and Clinician Assistant use deterministic local simulated responses (pi-ai fauxProvider) and the header displays a persistent Mock Mode badge. When off with no API key, requests fail explicitly without silent fallback.'}
                  </FieldDescription>
                </div>
                <Switch
                  aria-label={zh ? '演示 / Mock 模式' : 'Demo / Mock Mode'}
                  checked={settings.mockMode}
                  id="llm-mock-mode-switch"
                  onCheckedChange={(checked) => {
                    setTestResult(null)
                    setSavedNotice(false)
                    updateLlmSettings(current => ({ ...current, mockMode: checked }))
                  }}
                />
              </div>
            </FieldSet>

            {/* Read-only Local CLI Providers (~/.pi, ~/.claude, ~/.codex) */}
            <FieldSet className="rounded-md border bg-muted/10 p-3" data-testid="local-cli-providers-section">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-0.5">
                  <FieldLegend className="mb-0 text-sm">
                    {zh ? '本地 CLI 服务商（pi / claude / codex）' : 'Local CLI Providers (pi / claude / codex)'}
                  </FieldLegend>
                  <FieldDescription>
                    {zh
                      ? '仅由服务端只读发现本机 ~/.pi/agent、~/.claude、~/.codex 配置；密钥仅在服务端请求期间内存读取，绝不回传浏览器或写入 SQLite。'
                      : 'Read-only discovery on the server host from ~/.pi/agent, ~/.claude, and ~/.codex. Credentials stay strictly in server memory per turn and are never returned to the browser or saved to SQLite.'}
                  </FieldDescription>
                </div>
                <Button
                  aria-label={zh ? '重新扫描本地 CLI 服务商' : 'Rescan local CLI providers'}
                  disabled={refreshCatalog.isPending || providerCatalog.isFetching}
                  onClick={() => refreshCatalog.mutate()}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  <RefreshCwIcon
                    aria-hidden="true"
                    className={refreshCatalog.isPending || providerCatalog.isFetching ? 'size-3 animate-spin' : 'size-3'}
                    data-icon="inline-start"
                  />
                  {zh ? '重新扫描' : 'Rescan'}
                </Button>
              </div>

              {localProviders.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  {providerCatalog.data?.discoveryEnabled === false
                    ? (zh
                        ? '当前服务实例未开启本地 CLI 配置发现。'
                        : 'Local CLI provider discovery is disabled on this server instance.')
                    : (zh
                        ? '未检测到本机 ~/.pi/agent、~/.claude 或 ~/.codex 的可用服务商配置，可继续使用下方 BYOK 或 Mock 模式。'
                        : 'No local ~/.pi/agent, ~/.claude, or ~/.codex provider configs detected. Use BYOK or Mock Mode below.')}
                </p>
              ) : (
                <div className="space-y-2">
                  {localProviders.map((provider) => {
                    const usedByAssistant = !settings.mockMode && settings.assistant.localProviderId === provider.id
                    const usedByPatient = !settings.mockMode && settings.patient.localProviderId === provider.id
                    return (
                      <div
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-3 py-2"
                        data-testid={`local-provider-card-${provider.id}`}
                        key={provider.id}
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge className="font-mono text-[0.625rem] uppercase" variant="secondary">
                              {provider.source}
                            </Badge>
                            <span className="text-sm font-medium text-foreground">
                              {provider.displayName}
                            </span>
                            <Badge variant={provider.authReady ? 'outline' : 'destructive'}>
                              {provider.authReady
                                ? (zh ? '凭证就绪' : 'Ready')
                                : (zh ? '缺凭证' : 'Missing auth')}
                            </Badge>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 font-mono text-[0.6875rem] text-muted-foreground">
                            <span>{provider.originPath}</span>
                            {provider.baseUrlHost ? <span>· {provider.baseUrlHost}</span> : null}
                            <span>· {zh ? `${provider.models.length} 个模型` : `${provider.models.length} models`}</span>
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          <Button
                            aria-label={zh
                              ? `将本地服务商 ${provider.displayName} 用于临床助手`
                              : `Use local provider ${provider.displayName} for Clinician Assistant`}
                            disabled={!provider.authReady}
                            onClick={() => applyLocalProvider(provider, 'assistant')}
                            size="xs"
                            type="button"
                            variant={usedByAssistant ? 'default' : 'outline'}
                          >
                            {usedByAssistant
                              ? (zh ? '临床助手已选用' : 'Assistant active')
                              : (zh ? '用于临床助手' : 'Use for Assistant')}
                          </Button>
                          <Button
                            aria-label={zh
                              ? `将本地服务商 ${provider.displayName} 用于患者代理`
                              : `Use local provider ${provider.displayName} for Patient Agent`}
                            disabled={!provider.authReady}
                            onClick={() => applyLocalProvider(provider, 'patient')}
                            size="xs"
                            type="button"
                            variant={usedByPatient ? 'default' : 'outline'}
                          >
                            {usedByPatient
                              ? (zh ? '患者代理已选用' : 'Patient active')
                              : (zh ? '用于患者代理' : 'Use for Patient')}
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </FieldSet>

            <FieldSet disabled={settings.mockMode}>
              <FieldLegend>{zh ? '服务商接入（BYOK）' : 'Provider Connection (BYOK)'}</FieldLegend>
              <FieldGroup className="gap-3">
                <Field>
                  <FieldLabel htmlFor="llm-provider-select">
                    {zh ? '服务商类型' : 'Provider'}
                  </FieldLabel>
                  <WorkspaceSelect
                    id="llm-provider-select"
                    items={PROVIDER_ITEMS.map(item => ({
                      value: item.value,
                      label: zh ? item.labelZh : item.labelEn,
                    }))}
                    onValueChange={(value) => {
                      if (value === 'openai-compatible' || value === 'anthropic' || value === 'gemini') {
                        handleProviderChange(value)
                      }
                    }}
                    value={settings.provider}
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="llm-base-url-input">
                    {zh ? '接口地址 (Base URL)' : 'Base URL'}
                  </FieldLabel>
                  <Input
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect="off"
                    id="llm-base-url-input"
                    onChange={(event) => {
                      const nextValue = event.currentTarget.value
                      setSavedNotice(false)
                      updateLlmSettings(current => ({ ...current, baseUrl: nextValue }))
                    }}
                    placeholder={DEFAULT_PROVIDER_BASE_URLS[settings.provider]}
                    spellCheck={false}
                    type="url"
                    value={settings.baseUrl}
                  />
                  <FieldDescription>
                    {zh
                      ? '支持 OpenAI 兼容端点（如 DeepSeek、通义千问、vLLM、LiteLLM 等）或官方默认地址。'
                      : 'Supports any OpenAI-compatible endpoint or official Anthropic / Gemini base URL.'}
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="llm-api-key-input">
                    {zh ? 'API Key（仅存本机浏览器）' : 'API Key (Browser Local Only)'}
                  </FieldLabel>
                  <div className="flex items-center gap-2">
                    <Input
                      autoCapitalize="none"
                      autoComplete="off"
                      autoCorrect="off"
                      className="flex-1"
                      data-agent-secret=""
                      id="llm-api-key-input"
                      onChange={(event) => {
                        const nextValue = event.currentTarget.value
                        setSavedNotice(false)
                        updateLlmSettings(current => ({ ...current, apiKey: nextValue }))
                      }}
                      placeholder={zh ? '输入 API Key（留空则仅在使用本地 CLI 或服务端 .env 时可用）' : 'Enter API key (leave empty when using local CLI or server .env)'}
                      spellCheck={false}
                      type={showApiKey ? 'text' : 'password'}
                      value={settings.apiKey}
                    />
                    <Button
                      aria-label={showApiKey
                        ? (zh ? '隐藏 API Key' : 'Hide API key')
                        : (zh ? '显示 API Key' : 'Show API key')}
                      aria-pressed={showApiKey}
                      onClick={() => setShowApiKey(prev => !prev)}
                      size="icon"
                      type="button"
                      variant="outline"
                    >
                      {showApiKey ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
                    </Button>
                  </div>
                  <FieldDescription>
                    {zh
                      ? '密钥仅保存在当前浏览器 localStorage，请求时通过请求头临时透传执行，绝不写入后端 SQLite 或日志。'
                      : 'Stored exclusively in this browser localStorage and forwarded transiently via request headers. Never written to SQLite or server logs.'}
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </FieldSet>

            <div className="grid gap-4 md:grid-cols-2">
              <FieldSet className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <FieldLegend className="mb-0">{zh ? '患者代理（Agent 1）' : 'Patient Agent (Agent 1)'}</FieldLegend>
                  {settings.patient.localProviderId !== null ? (
                    <Button
                      aria-label={zh ? '患者代理切回 BYOK 配置' : 'Switch Patient Agent back to BYOK'}
                      onClick={() => {
                        updateLlmSettings(current => ({
                          ...current,
                          patient: { ...current.patient, localProviderId: null },
                        }))
                      }}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      {zh ? '切回 BYOK' : 'Use BYOK'}
                    </Button>
                  ) : null}
                </div>
                <FieldGroup className="gap-3">
                  <Field>
                    <FieldLabel htmlFor="llm-patient-model-input">
                      {zh ? '患者模型 ID' : 'Patient Model ID'}
                    </FieldLabel>
                    {activePatientLocal !== null && !settings.mockMode ? (
                      <WorkspaceSelect
                        id="llm-patient-model-input"
                        items={activePatientLocal.models.map(item => ({
                          value: item.id,
                          label: item.name,
                        }))}
                        onValueChange={(value) => {
                          if (value !== null) {
                            updateLlmSettings(current => ({
                              ...current,
                              patient: { ...current.patient, modelId: value },
                            }))
                          }
                        }}
                        value={settings.patient.modelId}
                      />
                    ) : (
                      <Input
                        autoCapitalize="none"
                        autoComplete="off"
                        autoCorrect="off"
                        disabled={settings.mockMode}
                        id="llm-patient-model-input"
                        onChange={(event) => {
                          const nextValue = event.currentTarget.value
                          setSavedNotice(false)
                          updateLlmSettings(current => ({
                            ...current,
                            patient: { ...current.patient, modelId: nextValue },
                          }))
                        }}
                        placeholder={DEFAULT_PROVIDER_MODELS[settings.provider]}
                        spellCheck={false}
                        value={settings.mockMode ? 'mock-clinmesh-v1' : settings.patient.modelId}
                      />
                    )}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="llm-patient-reasoning-select">
                      {zh ? '患者推理强度' : 'Patient Reasoning Effort'}
                    </FieldLabel>
                    <WorkspaceSelect
                      id="llm-patient-reasoning-select"
                      items={REASONING_ITEMS.map(item => ({
                        value: item.value,
                        label: zh ? item.labelZh : item.labelEn,
                      }))}
                      onValueChange={(value) => {
                        if (value !== null) {
                          updateLlmSettings(current => ({
                            ...current,
                            patient: { ...current.patient, reasoningEffort: value as LlmReasoningEffort },
                          }))
                        }
                      }}
                      value={settings.patient.reasoningEffort}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="llm-patient-thinking-mode-select">
                      {zh ? '患者思考模式' : 'Patient Thinking Mode'}
                    </FieldLabel>
                    <WorkspaceSelect
                      id="llm-patient-thinking-mode-select"
                      items={THINKING_MODE_ITEMS.map(item => ({
                        value: item.value,
                        label: zh ? item.labelZh : item.labelEn,
                      }))}
                      onValueChange={(value) => {
                        if (value !== null) {
                          updateLlmSettings(current => ({
                            ...current,
                            patient: { ...current.patient, thinkingMode: value as LlmThinkingMode },
                          }))
                        }
                      }}
                      value={settings.patient.thinkingMode}
                    />
                  </Field>
                </FieldGroup>
              </FieldSet>

              <FieldSet className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <FieldLegend className="mb-0">{zh ? '临床助手（Agent 2）' : 'Clinician Assistant (Agent 2)'}</FieldLegend>
                  {settings.assistant.localProviderId !== null ? (
                    <Button
                      aria-label={zh ? '临床助手切回 BYOK 配置' : 'Switch Clinician Assistant back to BYOK'}
                      onClick={() => {
                        updateLlmSettings(current => ({
                          ...current,
                          assistant: { ...current.assistant, localProviderId: null },
                        }))
                      }}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      {zh ? '切回 BYOK' : 'Use BYOK'}
                    </Button>
                  ) : null}
                </div>
                <FieldGroup className="gap-3">
                  <Field>
                    <FieldLabel htmlFor="llm-assistant-model-input">
                      {zh ? '助手模型 ID' : 'Assistant Model ID'}
                    </FieldLabel>
                    {activeAssistantLocal !== null && !settings.mockMode ? (
                      <WorkspaceSelect
                        id="llm-assistant-model-input"
                        items={activeAssistantLocal.models.map(item => ({
                          value: item.id,
                          label: item.name,
                        }))}
                        onValueChange={(value) => {
                          if (value !== null) {
                            updateLlmSettings(current => ({
                              ...current,
                              assistant: { ...current.assistant, modelId: value },
                            }))
                          }
                        }}
                        value={settings.assistant.modelId}
                      />
                    ) : (
                      <Input
                        autoCapitalize="none"
                        autoComplete="off"
                        autoCorrect="off"
                        disabled={settings.mockMode}
                        id="llm-assistant-model-input"
                        onChange={(event) => {
                          const nextValue = event.currentTarget.value
                          setSavedNotice(false)
                          updateLlmSettings(current => ({
                            ...current,
                            assistant: { ...current.assistant, modelId: nextValue },
                          }))
                        }}
                        placeholder={DEFAULT_PROVIDER_MODELS[settings.provider]}
                        spellCheck={false}
                        value={settings.mockMode ? 'mock-clinmesh-v1' : settings.assistant.modelId}
                      />
                    )}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="llm-assistant-reasoning-select">
                      {zh ? '助手推理强度' : 'Assistant Reasoning Effort'}
                    </FieldLabel>
                    <WorkspaceSelect
                      id="llm-assistant-reasoning-select"
                      items={REASONING_ITEMS.map(item => ({
                        value: item.value,
                        label: zh ? item.labelZh : item.labelEn,
                      }))}
                      onValueChange={(value) => {
                        if (value !== null) {
                          updateLlmSettings(current => ({
                            ...current,
                            assistant: { ...current.assistant, reasoningEffort: value as LlmReasoningEffort },
                          }))
                        }
                      }}
                      value={settings.assistant.reasoningEffort}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="llm-assistant-thinking-mode-select">
                      {zh ? '助手思考模式' : 'Assistant Thinking Mode'}
                    </FieldLabel>
                    <WorkspaceSelect
                      id="llm-assistant-thinking-mode-select"
                      items={THINKING_MODE_ITEMS.map(item => ({
                        value: item.value,
                        label: zh ? item.labelZh : item.labelEn,
                      }))}
                      onValueChange={(value) => {
                        if (value !== null) {
                          updateLlmSettings(current => ({
                            ...current,
                            assistant: { ...current.assistant, thinkingMode: value as LlmThinkingMode },
                          }))
                        }
                      }}
                      value={settings.assistant.thinkingMode}
                    />
                  </Field>
                </FieldGroup>
              </FieldSet>
            </div>

            <FieldSet className="rounded-md border p-3">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <FieldLabel htmlFor="llm-show-live-thinking-switch">
                    {zh ? '生成时默认展开实时思考' : 'Expand live thinking while streaming'}
                  </FieldLabel>
                  <FieldDescription>
                    {zh
                      ? '开启后，临床助手流式生成回复时将自动展开思考过程；关闭则保持 Claude 桌面端风格的默认折叠状态。'
                      : 'When enabled, the Work Process disclosure expands automatically while streaming; when off, it remains calmly collapsed by default.'}
                  </FieldDescription>
                </div>
                <Switch
                  aria-label={zh ? '生成时默认展开实时思考' : 'Expand live thinking while streaming'}
                  checked={settings.showLiveThinking}
                  id="llm-show-live-thinking-switch"
                  onCheckedChange={(checked) => {
                    updateLlmSettings(current => ({ ...current, showLiveThinking: checked }))
                  }}
                />
              </div>
            </FieldSet>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={connectionTest.isPending}
                onClick={() => connectionTest.mutate()}
                type="button"
                variant="outline"
              >
                {connectionTest.isPending
                  ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
                  : <PlugZapIcon aria-hidden="true" data-icon="inline-start" />}
                {connectionTest.isPending
                  ? (zh ? '正在测试连接…' : 'Testing connection…')
                  : (zh ? '测试连接' : 'Test connection')}
              </Button>
              <Button type="submit" variant="default">
                {zh ? '保存配置' : 'Save settings'}
              </Button>
              {savedNotice ? (
                <span className="text-xs text-muted-foreground" role="status">
                  {zh ? '已保存至本机浏览器配置。' : 'Saved to browser local settings.'}
                </span>
              ) : null}
            </div>

            {testResult !== null ? (
              <div aria-live="polite" role="status">
                <Alert variant={testResult.ok ? 'default' : 'destructive'}>
                  {testResult.ok
                    ? <CheckCircle2Icon aria-hidden="true" />
                    : <CircleAlertIcon aria-hidden="true" />}
                  <AlertTitle>
                    {testResult.ok
                      ? (zh ? `连接成功（${testResult.latencyMs} ms）` : `Connected (${testResult.latencyMs} ms)`)
                      : (zh
                          ? `连接失败${testResult.errorCode ? ` (${testResult.errorCode})` : ''}`
                          : `Connection failed${testResult.errorCode ? ` (${testResult.errorCode})` : ''}`)}
                  </AlertTitle>
                  <AlertDescription>
                    {testResult.message}
                    {testResult.replyPreview ? ` · ${testResult.replyPreview}` : ''}
                  </AlertDescription>
                </Alert>
              </div>
            ) : null}
          </form>
        </WorkspaceCard>

        <VoiceSettingsCard locale={locale} />
      </section>
    </WorkspaceCardLayout>
  )
}
