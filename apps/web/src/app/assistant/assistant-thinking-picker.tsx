import type {
  LlmProviderCatalogResponse,
  LlmReasoningEffort,
  LlmThinkingMode,
} from '@clinmesh/contracts/agent-sessions'
import { Button } from '@clinmesh/ui/components/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@clinmesh/ui/components/popover'
import { Switch } from '@clinmesh/ui/components/switch'
import {
  BrainCircuitIcon,
  CheckIcon,
  ChevronDownIcon,
  EyeIcon,
} from 'lucide-react'
import { useState } from 'react'
import { updateLlmSettings, useLlmSettings } from '../llm-settings-storage.ts'
import { resolveActiveModelSummary } from './assistant-model-picker.tsx'

const ALL_THINKING_LEVELS: ReadonlyArray<{
  value: LlmReasoningEffort
  shortZh: string
  shortEn: string
  descZh: string
  descEn: string
}> = [
  { value: 'off', shortZh: '关闭', shortEn: 'Off', descZh: '关闭思考，直接快速回复', descEn: 'No extended thinking' },
  { value: 'minimal', shortZh: '极简', shortEn: 'Minimal', descZh: '轻量检查与快速核对', descEn: 'Brief verification' },
  { value: 'low', shortZh: '低', shortEn: 'Low', descZh: '低开销推理，适合常规问答', descEn: 'Light reasoning' },
  { value: 'medium', shortZh: '中', shortEn: 'Medium', descZh: '均衡临床分析与响应速度', descEn: 'Balanced clinical depth' },
  { value: 'high', shortZh: '高', shortEn: 'High', descZh: '深入鉴别诊断与多步推理', descEn: 'Deep clinical reasoning' },
  { value: 'xhigh', shortZh: '极高', shortEn: 'XHigh', descZh: '复杂疑难病例深度推演', descEn: 'Maximum standard effort' },
  { value: 'max', shortZh: '最大', shortEn: 'Max', descZh: '无上限深度思考（支持模型）', descEn: 'Unconstrained max effort' },
]

const THINKING_MODES: ReadonlyArray<{
  value: LlmThinkingMode
  labelZh: string
  labelEn: string
  shortZh: string
  shortEn: string
  descZh: string
  descEn: string
}> = [
  {
    value: 'auto',
    labelZh: '自动 (Auto)',
    labelEn: 'Auto',
    shortZh: '自动',
    shortEn: 'Auto',
    descZh: '按模型特性自动选用自适应或原生推理',
    descEn: 'Follows model default (adaptive on Claude 4.6+)',
  },
  {
    value: 'adaptive',
    labelZh: '自适应 (Adaptive)',
    labelEn: 'Adaptive',
    shortZh: '自适应',
    shortEn: 'Adaptive',
    descZh: '由模型按问题复杂度动态分配思考深度',
    descEn: 'Dynamic thinking allocation (Claude adaptive)',
  },
  {
    value: 'budget',
    labelZh: '预算 (Budget)',
    labelEn: 'Budget',
    shortZh: '预算',
    shortEn: 'Budget',
    descZh: '按固定 Token 预算启用扩展思考',
    descEn: 'Fixed token-budget extended thinking',
  },
]

export function getThinkingEffortLabel(level: LlmReasoningEffort, zh: boolean): string {
  const matched = ALL_THINKING_LEVELS.find(item => item.value === level)
  if (!matched) return level
  return zh ? matched.shortZh : matched.shortEn
}

export function getThinkingModeLabel(mode: LlmThinkingMode, zh: boolean): string {
  const matched = THINKING_MODES.find(item => item.value === mode)
  if (!matched) return mode
  return zh ? matched.shortZh : matched.shortEn
}

export interface AssistantThinkingPickerProps {
  catalog: LlmProviderCatalogResponse | undefined
  zh: boolean
}

/**
 * Click-to-switch Thinking Effort + Thinking Mode (Auto / Adaptive / Budget) +
 * Live Thinking Display Popover directly in the assistant composer.
 */
export function AssistantThinkingPicker({
  catalog,
  zh,
}: AssistantThinkingPickerProps): React.JSX.Element {
  const settings = useLlmSettings()
  const [open, setOpen] = useState(false)

  const active = resolveActiveModelSummary(settings, catalog)
  const supportedLevels: readonly LlmReasoningEffort[] = active.activeCatalogModel
    ? active.activeCatalogModel.supportedThinkingLevels
    : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const modelSupportsReasoning = active.activeCatalogModel ? active.activeCatalogModel.reasoning : true

  const currentEffort = settings.assistant.reasoningEffort
  const currentMode = settings.assistant.thinkingMode
  const effortLabel = getThinkingEffortLabel(currentEffort, zh)
  const modeLabel = getThinkingModeLabel(currentMode, zh)

  const pillText = currentEffort === 'off'
    ? (zh ? '思考:关' : 'Think: Off')
    : currentMode === 'auto'
      ? (zh ? `思考:${effortLabel}` : `Think: ${effortLabel}`)
      : (zh ? `${effortLabel}·${modeLabel}` : `${effortLabel} · ${modeLabel}`)

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={(
          <Button
            aria-label={zh
              ? `切换思考强度与模式（当前：${effortLabel} · ${modeLabel}）`
              : `Switch thinking effort and mode (current: ${effortLabel} · ${modeLabel})`}
            className="h-6 shrink-0 gap-1 px-1.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
            data-active={currentEffort !== 'off' ? 'true' : 'false'}
            data-testid="assistant-thinking-picker-trigger"
            size="xs"
            type="button"
            variant="ghost"
          />
        )}
      >
        <BrainCircuitIcon
          aria-hidden="true"
          className={currentEffort !== 'off' ? 'size-3 shrink-0 text-info' : 'size-3 shrink-0 opacity-65'}
        />
        <span className="whitespace-nowrap">{pillText}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-72 p-0"
        data-testid="assistant-thinking-picker-popover"
        side="top"
        sideOffset={8}
      >
        <div className="border-b border-border px-3 py-2">
          <div className="text-xs font-semibold text-foreground">
            {zh ? '思考强度与思考模式' : 'Thinking effort & mode'}
          </div>
          <div className="text-[0.6875rem] text-muted-foreground">
            {modelSupportsReasoning
              ? (zh ? '点击立即切换，下次发送直接生效' : 'Applies immediately on the next message')
              : (zh ? '当前所选模型未开启扩展思考能力' : 'Selected model does not report reasoning support')}
          </div>
        </div>

        {/* Thinking Effort Level */}
        <div className="border-b border-border p-2">
          <div className="mb-1.5 px-1 text-[0.6875rem] font-medium text-muted-foreground">
            {zh ? '思考强度 (Effort)' : 'Thinking effort'}
          </div>
          <div className="grid grid-cols-4 gap-1">
            {ALL_THINKING_LEVELS.filter(item => supportedLevels.includes(item.value)).map((item) => {
              const selected = currentEffort === item.value
              return (
                <Button
                  aria-label={zh ? `设置思考强度为 ${item.shortZh}` : `Set thinking effort to ${item.shortEn}`}
                  aria-pressed={selected}
                  className="h-7 px-1.5 text-xs"
                  data-testid={`assistant-thinking-level-${item.value}`}
                  key={item.value}
                  onClick={() => {
                    updateLlmSettings(current => ({
                      ...current,
                      assistant: {
                        ...current.assistant,
                        reasoningEffort: item.value,
                      },
                    }))
                  }}
                  size="xs"
                  title={zh ? item.descZh : item.descEn}
                  type="button"
                  variant={selected ? 'secondary' : 'ghost'}
                >
                  {zh ? item.shortZh : item.shortEn}
                </Button>
              )
            })}
          </div>
        </div>

        {/* Thinking Mode */}
        <div className="border-b border-border p-2">
          <div className="mb-1.5 px-1 text-[0.6875rem] font-medium text-muted-foreground">
            {zh ? '思考模式 (Mode)' : 'Thinking mode'}
          </div>
          <div className="space-y-0.5">
            {THINKING_MODES.map((mode) => {
              const selected = currentMode === mode.value
              return (
                <Button
                  aria-label={zh ? `切换思考模式为 ${mode.labelZh}` : `Switch thinking mode to ${mode.labelEn}`}
                  aria-pressed={selected}
                  className="h-auto w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left font-normal"
                  data-testid={`assistant-thinking-mode-${mode.value}`}
                  disabled={currentEffort === 'off'}
                  key={mode.value}
                  onClick={() => {
                    updateLlmSettings(current => ({
                      ...current,
                      assistant: {
                        ...current.assistant,
                        thinkingMode: mode.value,
                      },
                    }))
                  }}
                  size="xs"
                  type="button"
                  variant={selected ? 'secondary' : 'ghost'}
                >
                  <span className="flex w-full items-center justify-between gap-2 text-xs font-medium text-foreground">
                    <span>{zh ? mode.labelZh : mode.labelEn}</span>
                    {selected ? <CheckIcon aria-hidden="true" className="size-3 text-primary" /> : null}
                  </span>
                  <span className="text-[0.6875rem] leading-snug text-muted-foreground">
                    {zh ? mode.descZh : mode.descEn}
                  </span>
                </Button>
              )
            })}
          </div>
        </div>

        {/* Live Thinking Display Toggle */}
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <EyeIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-xs text-foreground">
              {zh ? '生成时展开实时思考' : 'Expand live thinking'}
            </span>
          </div>
          <Switch
            aria-label={zh ? '生成时展开实时思考' : 'Expand live thinking while streaming'}
            checked={settings.showLiveThinking}
            data-testid="assistant-show-live-thinking-switch"
            onCheckedChange={(checked) => {
              updateLlmSettings(current => ({
                ...current,
                showLiveThinking: checked,
              }))
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
