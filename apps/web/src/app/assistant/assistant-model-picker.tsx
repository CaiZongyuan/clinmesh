import type {
  LlmCatalogModel,
  LlmLocalProviderSummary,
  LlmProviderCatalogResponse,
  LlmReasoningEffort,
} from '@clinmesh/contracts/agent-sessions'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Input } from '@clinmesh/ui/components/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@clinmesh/ui/components/popover'
import { Link } from '@tanstack/react-router'
import {
  CheckIcon,
  ChevronDownIcon,
  CpuIcon,
  FlaskConicalIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  StarIcon,
  TerminalIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  DEFAULT_PROVIDER_MODELS,
  updateLlmSettings,
  useLlmSettings,
  type StoredLlmSettings,
} from '../llm-settings-storage.ts'

export interface AssistantModelPickerProps {
  catalog: LlmProviderCatalogResponse | undefined
  catalogFetching: boolean
  onRefreshCatalog: () => void
  zh: boolean
}

function formatContextCompact(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

function sourceBadgeLabel(source: LlmLocalProviderSummary['source']): string {
  switch (source) {
    case 'pi':
      return 'pi'
    case 'claude':
      return 'claude'
    case 'codex':
      return 'codex'
  }
}

function clampReasoningForModel(
  current: LlmReasoningEffort,
  model: LlmCatalogModel,
): LlmReasoningEffort {
  if (!model.reasoning) return 'off'
  if (model.supportedThinkingLevels.includes(current)) return current
  if (model.defaultThinkingLevel && model.supportedThinkingLevels.includes(model.defaultThinkingLevel)) {
    return model.defaultThinkingLevel
  }
  if (model.supportedThinkingLevels.includes('medium')) return 'medium'
  return model.supportedThinkingLevels.find(level => level !== 'off') ?? 'off'
}

export function resolveActiveModelSummary(
  settings: StoredLlmSettings,
  catalog: LlmProviderCatalogResponse | undefined,
): {
  sourceKind: 'mock' | 'local' | 'byok'
  providerLabel: string
  modelLabel: string
  activeLocalProvider: LlmLocalProviderSummary | null
  activeCatalogModel: LlmCatalogModel | null
} {
  if (settings.mockMode) {
    return {
      sourceKind: 'mock',
      providerLabel: 'Mock',
      modelLabel: 'mock-clinmesh-v1',
      activeLocalProvider: null,
      activeCatalogModel: null,
    }
  }
  const localId = settings.assistant.localProviderId
  if (localId !== null && localId.trim().length > 0) {
    const matchedProvider = catalog?.localProviders.find(item => item.id === localId) ?? null
    const matchedModel = matchedProvider?.models.find(item => item.id === settings.assistant.modelId) ?? null
    return {
      sourceKind: 'local',
      providerLabel: matchedProvider?.displayName ?? localId,
      modelLabel: matchedModel?.name ?? (settings.assistant.modelId || matchedProvider?.defaultModelId || localId),
      activeLocalProvider: matchedProvider,
      activeCatalogModel: matchedModel,
    }
  }
  return {
    sourceKind: 'byok',
    providerLabel: settings.provider,
    modelLabel: settings.assistant.modelId.trim() || DEFAULT_PROVIDER_MODELS[settings.provider],
    activeLocalProvider: null,
    activeCatalogModel: null,
  }
}

/**
 * Claude Desktop + pi-web style inline Model Selector Popover.
 * Lets clinicians click directly in the composer to switch between discovered local
 * pi / claude / codex providers, BYOK settings, and explicit Mock Mode.
 */
export function AssistantModelPicker({
  catalog,
  catalogFetching,
  onRefreshCatalog,
  zh,
}: AssistantModelPickerProps): React.JSX.Element {
  const settings = useLlmSettings()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const active = resolveActiveModelSummary(settings, catalog)
  const localProviders = catalog?.localProviders ?? []
  const totalLocalModels = localProviders.reduce((sum, p) => sum + p.models.length, 0)
  const trimmedQuery = query.trim().toLowerCase()

  const filteredProviders = useMemo(() => {
    if (trimmedQuery.length === 0) return localProviders
    const next: LlmLocalProviderSummary[] = []
    for (const provider of localProviders) {
      const providerMatches = provider.displayName.toLowerCase().includes(trimmedQuery)
        || provider.source.toLowerCase().includes(trimmedQuery)
        || provider.providerKey.toLowerCase().includes(trimmedQuery)
        || (provider.baseUrlHost?.toLowerCase().includes(trimmedQuery) ?? false)
      const matchingModels = providerMatches
        ? provider.models
        : provider.models.filter(
            model => model.id.toLowerCase().includes(trimmedQuery)
              || model.name.toLowerCase().includes(trimmedQuery),
          )
      if (matchingModels.length > 0) {
        next.push({ ...provider, models: matchingModels })
      }
    }
    return next
  }, [localProviders, trimmedQuery])

  const selectLocalModel = (provider: LlmLocalProviderSummary, model: LlmCatalogModel) => {
    updateLlmSettings(current => ({
      ...current,
      mockMode: false,
      assistant: {
        ...current.assistant,
        localProviderId: provider.id,
        modelId: model.id,
        reasoningEffort: clampReasoningForModel(current.assistant.reasoningEffort, model),
      },
    }))
    setOpen(false)
  }

  const selectMockMode = () => {
    updateLlmSettings(current => ({
      ...current,
      mockMode: true,
    }))
    setOpen(false)
  }

  const selectByokMode = () => {
    updateLlmSettings(current => ({
      ...current,
      mockMode: false,
      assistant: {
        ...current.assistant,
        localProviderId: null,
        modelId: current.assistant.modelId.trim() || DEFAULT_PROVIDER_MODELS[current.provider],
      },
    }))
    setOpen(false)
  }

  const triggerText = active.sourceKind === 'mock'
    ? 'Mock'
    : active.modelLabel

  return (
    <Popover
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setQuery('')
      }}
      open={open}
    >
      <PopoverTrigger
        render={(
          <Button
            aria-label={zh
              ? `切换助手模型（当前：${active.providerLabel} · ${active.modelLabel}）`
              : `Switch assistant model (current: ${active.providerLabel} · ${active.modelLabel})`}
            className="h-6 max-w-44 gap-1 px-1.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
            data-testid="assistant-model-picker-trigger"
            size="xs"
            type="button"
            variant="ghost"
          />
        )}
      >
        {active.sourceKind === 'mock' ? (
          <FlaskConicalIcon aria-hidden="true" className="size-3 shrink-0" />
        ) : active.sourceKind === 'local' ? (
          <TerminalIcon aria-hidden="true" className="size-3 shrink-0 text-info" />
        ) : (
          <CpuIcon aria-hidden="true" className="size-3 shrink-0" />
        )}
        <span className="truncate font-mono">{triggerText}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-80 p-0"
        data-testid="assistant-model-picker-popover"
        side="top"
        sideOffset={8}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground">
              {zh ? '切换模型' : 'Switch model'}
            </div>
            <div className="text-[0.6875rem] text-muted-foreground">
              {localProviders.length > 0
                ? (zh
                    ? `已读取 ${localProviders.length} 个本地 CLI 服务商（${totalLocalModels} 个模型）`
                    : `${localProviders.length} local CLI providers (${totalLocalModels} models)`)
                : (zh ? '支持本地 pi / claude / codex、BYOK 与 Mock' : 'Local pi / claude / codex, BYOK & Mock')}
            </div>
          </div>
          <Button
            aria-label={zh ? '重新扫描本地 CLI 服务商' : 'Rescan local CLI providers'}
            className="size-6 shrink-0"
            disabled={catalogFetching}
            onClick={onRefreshCatalog}
            size="icon-xs"
            title={zh ? '重新读取本地 ~/.pi / ~/.claude / ~/.codex' : 'Rescan local ~/.pi / ~/.claude / ~/.codex'}
            type="button"
            variant="ghost"
          >
            <RefreshCwIcon aria-hidden="true" className={catalogFetching ? 'size-3 animate-spin' : 'size-3'} />
          </Button>
        </div>

        {totalLocalModels > 4 ? (
          <div className="border-b border-border px-2.5 py-2">
            <div className="relative flex items-center">
              <SearchIcon aria-hidden="true" className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
              <Input
                aria-label={zh ? '筛选模型或服务商' : 'Filter models or providers'}
                className="h-7 pl-7 text-xs"
                data-testid="assistant-model-filter-input"
                onChange={event => setQuery(event.currentTarget.value)}
                placeholder={zh ? '筛选模型名称、pi / claude / codex…' : 'Filter model or provider…'}
                type="search"
                value={query}
              />
            </div>
          </div>
        ) : null}

        <div className="cm-assistant-scroll max-h-72 overflow-y-auto p-1.5">
          {/* Discovered local pi / claude / codex providers */}
          {filteredProviders.map(provider => (
            <div className="mb-2 last:mb-0" key={provider.id}>
              <div className="flex items-center justify-between gap-1.5 px-2 py-1 text-[0.6875rem] text-muted-foreground">
                <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                  <Badge className="px-1 py-0 font-mono text-[0.625rem] uppercase" variant="secondary">
                    {sourceBadgeLabel(provider.source)}
                  </Badge>
                  <span className="truncate">{provider.displayName}</span>
                </span>
                <span className="shrink-0 text-[0.625rem]">
                  {provider.authReady
                    ? (provider.baseUrlHost ?? provider.api)
                    : (zh ? '缺凭证' : 'No auth')}
                </span>
              </div>

              <div className="space-y-0.5">
                {provider.models.map((model) => {
                  const isSelected = !settings.mockMode
                    && settings.assistant.localProviderId === provider.id
                    && settings.assistant.modelId === model.id
                  return (
                    <Button
                      aria-label={zh
                        ? `选择本地模型 ${provider.displayName} ${model.name}`
                        : `Select local model ${provider.displayName} ${model.name}`}
                      className="h-auto w-full justify-between gap-2 px-2 py-1.5 text-left font-normal"
                      data-selected={isSelected ? 'true' : 'false'}
                      data-testid={`assistant-model-option-${provider.id}-${model.id}`}
                      disabled={!provider.authReady}
                      key={`${provider.id}::${model.id}`}
                      onClick={() => selectLocalModel(provider, model)}
                      size="xs"
                      type="button"
                      variant={isSelected ? 'secondary' : 'ghost'}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {isSelected ? (
                          <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-primary" />
                        ) : model.isDefault ? (
                          <StarIcon aria-hidden="true" className="size-3 shrink-0 text-warning" />
                        ) : (
                          <span aria-hidden="true" className="inline-block size-3 shrink-0" />
                        )}
                        <span className="truncate text-xs text-foreground">{model.name}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-[0.625rem] text-muted-foreground tabular-nums">
                        {model.reasoning ? (
                          <SparklesIcon aria-hidden="true" className="size-2.5 text-info" />
                        ) : null}
                        <span>{formatContextCompact(model.contextWindow)}</span>
                      </span>
                    </Button>
                  )
                })}
              </div>
            </div>
          ))}

          {trimmedQuery.length > 0 && filteredProviders.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              {zh ? '没有匹配的本地模型' : 'No matching local models'}
            </div>
          ) : null}

          {/* Built-in BYOK & explicit Mock Mode options */}
          {trimmedQuery.length === 0 ? (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <div className="px-2 py-1 text-[0.6875rem] font-medium text-muted-foreground">
                {zh ? '自定义配置与演示模式' : 'Custom BYOK & Demo Mode'}
              </div>
              <div className="space-y-0.5">
                <Button
                  aria-label={zh ? '切换到 BYOK 自定义配置' : 'Switch to BYOK custom configuration'}
                  className="h-auto w-full justify-between gap-2 px-2 py-1.5 text-left font-normal"
                  data-testid="assistant-model-option-byok"
                  onClick={selectByokMode}
                  size="xs"
                  type="button"
                  variant={active.sourceKind === 'byok' ? 'secondary' : 'ghost'}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {active.sourceKind === 'byok' ? (
                      <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-primary" />
                    ) : (
                      <CpuIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate text-xs text-foreground">
                      BYOK · {settings.assistant.localProviderId === null
                        ? (settings.assistant.modelId || DEFAULT_PROVIDER_MODELS[settings.provider])
                        : DEFAULT_PROVIDER_MODELS[settings.provider]}
                    </span>
                  </span>
                  <span className="shrink-0 text-[0.625rem] text-muted-foreground">
                    {settings.apiKey.trim().length > 0
                      ? settings.provider
                      : catalog?.serverDefault.serverDefaultConfigured
                        ? (zh ? '服务端 .env' : 'Server .env')
                        : (zh ? '未填密钥' : 'No key')}
                  </span>
                </Button>

                <Button
                  aria-label={zh ? '切换到演示 Mock 模式' : 'Switch to Demo Mock Mode'}
                  className="h-auto w-full justify-between gap-2 px-2 py-1.5 text-left font-normal"
                  data-testid="assistant-model-option-mock"
                  onClick={selectMockMode}
                  size="xs"
                  type="button"
                  variant={active.sourceKind === 'mock' ? 'secondary' : 'ghost'}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {active.sourceKind === 'mock' ? (
                      <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-primary" />
                    ) : (
                      <FlaskConicalIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate text-xs text-foreground">
                      {zh ? '演示 / Mock 模式' : 'Demo / Mock Mode'}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground">
                    mock-clinmesh-v1
                  </span>
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between border-t border-border px-2 py-1.5">
          <Button
            aria-label={zh ? '打开模型与服务商完整设置' : 'Open full Models & Provider settings'}
            className="h-6 w-full justify-start gap-1.5 px-2 text-[0.6875rem] text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(false)}
            render={<Link to="/settings/models" />}
            size="xs"
            variant="ghost"
          >
            <SettingsIcon aria-hidden="true" className="size-3" />
            <span>{zh ? '模型与服务商设置…' : 'Models & Provider settings…'}</span>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
