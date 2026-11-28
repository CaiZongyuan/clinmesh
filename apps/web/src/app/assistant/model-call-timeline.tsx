import type {
  ContextEventSummary,
  ModelCallPurpose,
  ModelCallSummary,
} from '@clinmesh/contracts/agent-sessions'
import { Button } from '@clinmesh/ui/components/button'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ContextUsageSourceBadge,
  formatSignedTokenDelta,
  formatTokenCount,
  type ContextCompositionSegmentKey,
} from './context-composition-bar.tsx'

export type ModelCallTimelineMode = 'cumulative' | 'delta'

type TimelineStackKey = Exclude<ContextCompositionSegmentKey, 'remaining'>

const TIMELINE_STACK_KEYS: readonly TimelineStackKey[] = [
  'system_prompt',
  'tool_definitions',
  'clinical_context',
  'messages',
  'tool_results',
  'thinking',
]

export function formatModelCallDuration(durationMs: number): string {
  const safe = Math.max(0, Math.round(durationMs))
  if (safe < 1000) return `${safe}ms`
  return `${(safe / 1000).toFixed(1)}s`
}

export function formatModelCallPurposeLabel(purpose: ModelCallPurpose, zh: boolean): string {
  if (purpose === 'COMPACTION') return zh ? '压缩摘要' : 'Compaction'
  return zh ? '对话调用' : 'Turn'
}

function formatCompactSignedDelta(delta: number): string {
  const rounded = Math.round(delta)
  if (rounded === 0) return '0'
  const abs = Math.abs(rounded)
  const body = abs >= 10_000
    ? `${Math.round(abs / 1000)}k`
    : abs >= 1000
      ? `${(abs / 1000).toFixed(1)}k`
      : String(abs)
  return rounded > 0 ? `+${body}` : `−${body}`
}

function buildStackSlices(call: ModelCallSummary): Array<{ key: TimelineStackKey; weight: number }> {
  const byKind = call.estimate.byKind
  const raw: Record<TimelineStackKey, number> = {
    system_prompt: byKind.INSTRUCTIONS,
    tool_definitions: byKind.TOOL_DEFINITION,
    clinical_context: byKind.CLINICAL_CONTEXT + byKind.COMPACTED_SUMMARY,
    messages: byKind.USER_MESSAGE + byKind.ASSISTANT_MESSAGE,
    tool_results: byKind.TOOL_CALL + byKind.TOOL_RESULT,
    thinking: byKind.REASONING,
  }
  const nonZero = TIMELINE_STACK_KEYS
    .filter(key => raw[key] > 0)
    .map(key => ({ key, weight: raw[key] }))
  if (nonZero.length > 0) return nonZero
  if (call.usage.promptTokens > 0) {
    return [{ key: 'messages', weight: call.usage.promptTokens }]
  }
  return []
}

export interface ModelCallTimelineProps {
  modelCalls: readonly ModelCallSummary[]
  contextEvents: readonly ContextEventSummary[]
  selectedCallId: string | null
  onSelectCall: (callId: string) => void
  zh: boolean
}

export function ModelCallTimeline({
  modelCalls,
  contextEvents,
  selectedCallId,
  onSelectCall,
  zh,
}: ModelCallTimelineProps): React.JSX.Element {
  const [mode, setMode] = useState<ModelCallTimelineMode>('cumulative')
  const selectedBarRef = useRef<HTMLButtonElement | null>(null)

  const viewModel = useMemo(() => {
    const maxPromptTokens = modelCalls.reduce(
      (max, call) => Math.max(max, Math.max(0, call.usage.promptTokens)),
      0,
    )
    const eventSeqSet = new Set(contextEvents.map(event => event.afterCallSeq))
    let prevPrompt = 0
    const metas = modelCalls.map((call, index) => {
      const prompt = Math.max(0, call.usage.promptTokens)
      const deltaTokens = index === 0 ? prompt : prompt - prevPrompt
      const prevCall = index > 0 ? modelCalls[index - 1] : undefined
      const hasEventFlag = prevCall !== undefined && eventSeqSet.has(prevCall.seq)
      prevPrompt = prompt
      return { deltaTokens, hasEventFlag }
    })
    const maxAbsDelta = metas.reduce((max, item) => Math.max(max, Math.abs(item.deltaTokens)), 0)
    const bars = modelCalls.map((call, index) => {
      const meta = metas[index]!
      const prompt = Math.max(0, call.usage.promptTokens)
      const deltaSign: 'positive' | 'negative' | 'zero' = meta.deltaTokens > 0
        ? 'positive'
        : meta.deltaTokens < 0
          ? 'negative'
          : 'zero'
      return {
        call,
        cumulativeRatio: maxPromptTokens > 0 ? Math.min(1, prompt / maxPromptTokens) : 0,
        deltaTokens: meta.deltaTokens,
        deltaRatio: maxAbsDelta > 0 ? Math.min(1, Math.abs(meta.deltaTokens) / maxAbsDelta) : 0,
        deltaSign,
        hasEventFlag: meta.hasEventFlag,
        stackSlices: buildStackSlices(call),
      }
    })
    const selectedBar = (selectedCallId ? bars.find(bar => bar.call.id === selectedCallId) : undefined)
      ?? bars[bars.length - 1]
      ?? null
    return { bars, selectedBar }
  }, [contextEvents, modelCalls, selectedCallId])

  useEffect(() => {
    selectedBarRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [viewModel.selectedBar?.call.id])

  const selectedCall = viewModel.selectedBar?.call ?? null

  return (
    <section
      className="border-b border-border py-3"
      data-testid="context-call-timeline"
      data-timeline-mode={mode}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">
          {zh ? '逐次模型调用' : 'Call timeline'}
        </h3>
        <div
          aria-label={zh ? '时间线视图模式' : 'Timeline mode'}
          className="inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5"
          role="group"
        >
          <Button
            aria-pressed={mode === 'cumulative'}
            className="h-6 px-2 text-xs"
            data-testid="context-timeline-mode-cumulative"
            onClick={() => setMode('cumulative')}
            size="xs"
            type="button"
            variant={mode === 'cumulative' ? 'secondary' : 'ghost'}
          >
            {zh ? '累计' : 'Cumulative'}
          </Button>
          <Button
            aria-pressed={mode === 'delta'}
            className="h-6 px-2 text-xs"
            data-testid="context-timeline-mode-delta"
            onClick={() => setMode('delta')}
            size="xs"
            type="button"
            variant={mode === 'delta' ? 'secondary' : 'ghost'}
          >
            {zh ? '增量' : 'Delta'}
          </Button>
        </div>
      </div>

      {viewModel.bars.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="context-timeline-empty">
          {zh ? '暂无模型调用记录。' : 'No model calls recorded yet.'}
        </p>
      ) : (
        <>
          <div className="cm-ctx-timeline-scroll cm-assistant-scroll">
            <div className="cm-ctx-timeline-track" data-mode={mode}>
              {mode === 'delta' ? <div aria-hidden="true" className="cm-ctx-timeline-zero" /> : null}
              {viewModel.bars.map((bar) => {
                const isSelected = viewModel.selectedBar?.call.id === bar.call.id
                const isNonProvider = bar.call.usage.source !== 'PROVIDER'
                const cumulativeHeightPct = bar.call.usage.promptTokens > 0
                  ? Math.max(10, Math.round(bar.cumulativeRatio * 100))
                  : 0
                const deltaHeightPct = bar.deltaTokens !== 0
                  ? Math.max(12, Math.round(bar.deltaRatio * 46))
                  : 4
                const ariaLabel = zh
                  ? `查看第 ${bar.call.seq} 次调用（输入 ${formatTokenCount(bar.call.usage.promptTokens)} tokens）`
                  : `Inspect call #${bar.call.seq} (${formatTokenCount(bar.call.usage.promptTokens)} prompt tokens)`

                return (
                  <Button
                    aria-label={ariaLabel}
                    aria-pressed={isSelected}
                    className="cm-ctx-bar-btn"
                    data-call-id={bar.call.id}
                    data-call-seq={String(bar.call.seq)}
                    data-non-provider={isNonProvider ? 'true' : 'false'}
                    data-selected={isSelected ? 'true' : 'false'}
                    data-testid="context-timeline-bar"
                    key={bar.call.id}
                    onClick={() => onSelectCall(bar.call.id)}
                    ref={isSelected ? selectedBarRef : undefined}
                    title={`#${bar.call.seq} · ${bar.call.model} · ${formatTokenCount(bar.call.usage.promptTokens)} (${formatSignedTokenDelta(bar.deltaTokens)})`}
                    type="button"
                    variant="ghost"
                  >
                    {bar.hasEventFlag ? (
                      <span aria-hidden="true" className="cm-ctx-event-flag" />
                    ) : null}
                    <span className="cm-ctx-bar-plot">
                      {mode === 'cumulative' ? (
                        <span
                          className="cm-ctx-bar-stack"
                          style={{ height: `${cumulativeHeightPct}%` }}
                        >
                          {bar.stackSlices.map(slice => (
                            <span
                              className={`cm-ctx-seg is-${slice.key}`}
                              key={slice.key}
                              style={{ flex: slice.weight }}
                            />
                          ))}
                        </span>
                      ) : (
                        <span
                          className={`cm-ctx-bar-delta is-${bar.deltaSign}`}
                          style={{ height: `${deltaHeightPct}%` }}
                        />
                      )}
                    </span>
                    <span className="text-[0.6875rem] leading-none text-muted-foreground tabular-nums">
                      {mode === 'delta' ? formatCompactSignedDelta(bar.deltaTokens) : `#${bar.call.seq}`}
                    </span>
                  </Button>
                )
              })}
            </div>
          </div>

          {selectedCall !== null && viewModel.selectedBar !== null ? (
            <div
              className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border/70 pt-2 text-xs text-muted-foreground tabular-nums"
              data-testid="context-timeline-selected-summary"
            >
              <span className="font-semibold text-foreground">
                #{selectedCall.seq} {formatModelCallPurposeLabel(selectedCall.purpose, zh)}
              </span>
              <span className="font-mono text-[0.75rem] text-foreground/85">{selectedCall.model}</span>
              <span>
                {zh ? '输入 ' : 'In '}
                {formatTokenCount(selectedCall.usage.promptTokens)}
              </span>
              {mode === 'delta' ? (
                <span className={viewModel.selectedBar.deltaSign === 'negative' ? 'text-warning' : 'text-info'}>
                  {zh ? '增量 ' : 'Delta '}
                  {formatSignedTokenDelta(viewModel.selectedBar.deltaTokens)}
                </span>
              ) : null}
              <span>
                {zh ? '输出 ' : 'Out '}
                {formatTokenCount(selectedCall.usage.outputTokens)}
              </span>
              <span>{formatModelCallDuration(selectedCall.durationMs)}</span>
              <ContextUsageSourceBadge source={selectedCall.usage.source} zh={zh} />
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
