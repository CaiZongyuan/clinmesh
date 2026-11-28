import type { ModelCallSummary, ModelCallUsageSource } from '@clinmesh/contracts/agent-sessions'
import { Badge } from '@clinmesh/ui/components/badge'

export type ContextCompositionSegmentKey =
  | 'system_prompt'
  | 'tool_definitions'
  | 'clinical_context'
  | 'messages'
  | 'tool_results'
  | 'thinking'
  | 'remaining'

const USED_SEGMENT_KEYS = [
  'system_prompt',
  'tool_definitions',
  'clinical_context',
  'messages',
  'tool_results',
  'thinking',
] as const

type UsedSegmentKey = typeof USED_SEGMENT_KEYS[number]

const ALL_SEGMENT_KEYS: readonly ContextCompositionSegmentKey[] = [
  ...USED_SEGMENT_KEYS,
  'remaining',
]

const SEGMENT_LABELS: Readonly<Record<ContextCompositionSegmentKey, { zh: string; en: string }>> = {
  system_prompt: { zh: 'System Prompt', en: 'System Prompt' },
  tool_definitions: { zh: '工具定义', en: 'Tool definitions' },
  clinical_context: { zh: '临床作用域上下文', en: 'Clinical scope context' },
  messages: { zh: '对话消息', en: 'Messages' },
  tool_results: { zh: '工具调用与结果', en: 'Tool calls & results' },
  thinking: { zh: '历史思考', en: 'Reasoning' },
  remaining: { zh: '剩余窗口', en: 'Remaining window' },
}

export function formatTokenCount(tokens: number): string {
  return Math.max(0, Math.round(tokens)).toLocaleString('en-US')
}

export function formatWindowPercentage(tokens: number, contextWindow: number): string {
  if (tokens <= 0 || contextWindow <= 0) return '0%'
  const rawPct = Math.min(100, (tokens / contextWindow) * 100)
  if (rawPct < 0.1) return '<0.1%'
  const roundedTenths = Math.round(rawPct * 10) / 10
  return Number.isInteger(roundedTenths) ? `${roundedTenths}%` : `${roundedTenths.toFixed(1)}%`
}

export function formatSignedTokenDelta(delta: number): string {
  const rounded = Math.round(delta)
  if (rounded === 0) return '0'
  const abs = formatTokenCount(Math.abs(rounded))
  return rounded > 0 ? `+${abs}` : `−${abs}`
}

function scaleBucketsProportionally(
  rawBuckets: Readonly<Record<UsedSegmentKey, number>>,
  targetTotal: number,
): Record<UsedSegmentKey, number> {
  const zero: Record<UsedSegmentKey, number> = {
    system_prompt: 0,
    tool_definitions: 0,
    clinical_context: 0,
    messages: 0,
    tool_results: 0,
    thinking: 0,
  }
  if (targetTotal <= 0) return zero

  const nonZeroKeys = USED_SEGMENT_KEYS.filter(key => rawBuckets[key] > 0)
  const rawSum = nonZeroKeys.reduce((sum, key) => sum + rawBuckets[key], 0)
  if (rawSum <= 0) {
    return { ...zero, messages: targetTotal }
  }

  const allocations = nonZeroKeys.map((key, orderIndex) => {
    const exact = (rawBuckets[key] * targetTotal) / rawSum
    const floored = Math.floor(exact)
    return { key, floored, remainder: exact - floored, orderIndex }
  })
  let remaining = targetTotal - allocations.reduce((sum, item) => sum + item.floored, 0)
  allocations.sort((a, b) => b.remainder - a.remainder || a.orderIndex - b.orderIndex)
  for (let index = 0; index < allocations.length && remaining > 0; index += 1) {
    allocations[index]!.floored += 1
    remaining -= 1
  }

  const result = { ...zero }
  for (const item of allocations) {
    result[item.key] = item.floored
  }
  return result
}

export function ContextUsageSourceBadge({
  source,
  zh,
}: {
  source: ModelCallUsageSource
  zh: boolean
}): React.JSX.Element {
  const label = source === 'PROVIDER'
    ? (zh ? '服务商返回' : 'Provider')
    : source === 'ESTIMATED'
      ? (zh ? '估算' : 'Estimated')
      : (zh ? '模拟' : 'Simulated')
  return (
    <span
      className={`cm-ctx-source-badge is-${source.toLowerCase()}`}
      data-source={source}
      data-testid="context-usage-source"
    >
      {label}
    </span>
  )
}

export interface ContextCompositionBarProps {
  call?: ModelCallSummary | null | undefined
  previousCall?: ModelCallSummary | null | undefined
  defaultContextWindow?: number
  zh: boolean
}

export function ContextCompositionBar({
  call,
  previousCall,
  defaultContextWindow = 128_000,
  zh,
}: ContextCompositionBarProps): React.JSX.Element {
  const contextWindow = call && call.contextWindow > 0
    ? call.contextWindow
    : Math.max(1, defaultContextWindow)
  const usedTokens = call ? Math.max(0, call.usage.promptTokens) : 0
  const pct = usedTokens > 0
    ? Math.min(100, Math.max(0, Math.round((usedTokens / contextWindow) * 100)))
    : 0

  const byKind = call?.estimate.byKind
  const rawBuckets: Record<UsedSegmentKey, number> = {
    system_prompt: byKind?.INSTRUCTIONS ?? 0,
    tool_definitions: byKind?.TOOL_DEFINITION ?? 0,
    clinical_context: (byKind?.CLINICAL_CONTEXT ?? 0) + (byKind?.COMPACTED_SUMMARY ?? 0),
    messages: (byKind?.USER_MESSAGE ?? 0) + (byKind?.ASSISTANT_MESSAGE ?? 0),
    tool_results: (byKind?.TOOL_CALL ?? 0) + (byKind?.TOOL_RESULT ?? 0),
    thinking: byKind?.REASONING ?? 0,
  }
  const scaled = scaleBucketsProportionally(rawBuckets, usedTokens)
  const remainingTokens = Math.max(0, contextWindow - usedTokens)

  const segments = ALL_SEGMENT_KEYS.map((key) => {
    const tokens = key === 'remaining' ? remainingTokens : scaled[key]
    const ratio = contextWindow > 0 ? Math.min(1, Math.max(0, tokens / contextWindow)) : 0
    const label = SEGMENT_LABELS[key]
    return {
      key,
      label: zh ? label.zh : label.en,
      tokens,
      ratio,
      pctLabel: formatWindowPercentage(tokens, contextWindow),
    }
  })

  const deltaFromPrevious = call && previousCall
    ? call.usage.promptTokens - previousCall.usage.promptTokens
    : null
  const cacheReadTokens = call ? Math.max(0, call.usage.cacheReadTokens) : 0
  const cacheHitPct = usedTokens > 0 && cacheReadTokens > 0
    ? formatWindowPercentage(cacheReadTokens, usedTokens)
    : null

  return (
    <section
      className="border-b border-border py-3"
      data-testid="context-composition-bar"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            {zh ? '当前上下文构成' : 'Context composition'}
          </h3>
          {deltaFromPrevious !== null ? (
            <Badge className="px-1.5 py-0 text-[0.6875rem] tabular-nums" variant="outline">
              {zh ? '较上次 ' : 'vs prev '}
              {formatSignedTokenDelta(deltaFromPrevious)}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
          <span>
            {formatTokenCount(usedTokens)} / {formatTokenCount(contextWindow)} · {usedTokens > 0 && pct === 0 ? '<1%' : `${pct}%`}
          </span>
          {call !== undefined && call !== null ? (
            <ContextUsageSourceBadge source={call.usage.source} zh={zh} />
          ) : null}
        </div>
      </div>

      <div
        aria-label={zh ? `上下文窗口已用 ${pct}%` : `Context window ${pct}% used`}
        className="cm-ctx-stackbar"
        role="img"
      >
        {segments.map((seg) => {
          if (seg.key === 'remaining') {
            return (
              <span
                className="cm-ctx-seg is-remaining"
                key={seg.key}
                style={{ flex: 1 }}
                title={`${seg.label}: ${formatTokenCount(seg.tokens)} (${seg.pctLabel})`}
              />
            )
          }
          if (seg.tokens <= 0) return null
          return (
            <span
              className={`cm-ctx-seg is-${seg.key}`}
              key={seg.key}
              style={{ width: `${Math.min(100, seg.ratio * 100)}%` }}
              title={`${seg.label}: ${formatTokenCount(seg.tokens)} (${seg.pctLabel})`}
            />
          )
        })}
      </div>

      <ul className="mt-2.5 grid grid-cols-1 gap-1 text-xs">
        {segments.map(seg => (
          <li
            className="flex items-center gap-2 py-0.5 text-foreground/85"
            data-pct={seg.pctLabel}
            data-segment-key={seg.key}
            data-testid="context-composition-segment"
            data-tokens={String(seg.tokens)}
            key={seg.key}
          >
            <span aria-hidden="true" className={`cm-ctx-swatch is-${seg.key}`} />
            <span className="truncate">{seg.label}</span>
            <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
              {formatTokenCount(seg.tokens)} · {seg.pctLabel}
            </span>
          </li>
        ))}
      </ul>

      {!call ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="context-composition-empty-note">
          {zh
            ? '尚未发起模型调用。发送第一条消息后将自动记录每次调用的真实上下文构成。'
            : 'No model calls yet. Send a message to record the actual context breakdown.'}
        </p>
      ) : cacheReadTokens > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="context-cache-read-note">
          {zh
            ? `分类数值按内容长度比例分配到总输入；本次提示词缓存命中 ${formatTokenCount(cacheReadTokens)} tokens（${cacheHitPct}）。`
            : `Categories scaled proportionally to prompt tokens; prompt cache hit ${formatTokenCount(cacheReadTokens)} tokens (${cacheHitPct}).`}
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {zh
            ? '分类数值按各部分长度比例分配到本次实际读取的总输入 tokens。'
            : 'Category figures are scaled proportionally to total prompt tokens read on this call.'}
        </p>
      )}
    </section>
  )
}
