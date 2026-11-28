import type {
  ContextEventKind,
  ContextEventSummary,
  ModelCallSummary,
} from '@clinmesh/contracts/agent-sessions'
import { Button } from '@clinmesh/ui/components/button'
import { useMemo, useState } from 'react'
import { formatSignedTokenDelta } from './context-composition-bar.tsx'

type FilterKind = 'ALL' | ContextEventKind

const FILTER_KINDS: readonly FilterKind[] = ['ALL', 'COMPACT', 'RETRY_OMIT', 'RESET']

function filterLabel(kind: FilterKind, zh: boolean): string {
  switch (kind) {
    case 'ALL':
      return zh ? '全部' : 'All'
    case 'RETRY_OMIT':
      return zh ? '重试移出' : 'Retry omit'
    case 'COMPACT':
      return zh ? '历史压缩' : 'Compaction'
    case 'RESET':
      return zh ? '上下文重置' : 'Reset'
  }
}

export interface ContextEventsListProps {
  modelCalls: readonly ModelCallSummary[]
  contextEvents: readonly ContextEventSummary[]
  selectedCallId: string | null
  onSelectCall: (callId: string) => void
  zh: boolean
}

export function ContextEventsList({
  modelCalls,
  contextEvents,
  selectedCallId,
  onSelectCall,
  zh,
}: ContextEventsListProps): React.JSX.Element {
  const [filter, setFilter] = useState<FilterKind>('ALL')

  const counts = useMemo(() => {
    const out: Record<FilterKind, number> = {
      ALL: contextEvents.length,
      RETRY_OMIT: 0,
      COMPACT: 0,
      RESET: 0,
    }
    for (const ev of contextEvents) {
      out[ev.kind] += 1
    }
    return out
  }, [contextEvents])

  const visibleEvents = useMemo(
    () => (filter === 'ALL' ? contextEvents : contextEvents.filter(ev => ev.kind === filter)),
    [contextEvents, filter],
  )

  return (
    <section className="py-3" data-testid="context-events-section">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">
          {zh ? '上下文事件' : 'Context events'}
        </h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {zh ? `${contextEvents.length} 条` : `${contextEvents.length} events`}
        </span>
      </div>

      <div
        aria-label={zh ? '按上下文事件类型筛选' : 'Filter context events'}
        className="mb-2.5 flex flex-wrap gap-1"
        role="group"
      >
        {FILTER_KINDS.map((kind) => {
          const active = filter === kind
          return (
            <Button
              aria-pressed={active}
              className="h-6 gap-1 px-2 text-xs"
              key={kind}
              onClick={() => setFilter(kind)}
              size="xs"
              type="button"
              variant={active ? 'secondary' : 'ghost'}
            >
              <span>{filterLabel(kind, zh)}</span>
              <span className="text-muted-foreground tabular-nums">{counts[kind]}</span>
            </Button>
          )
        })}
      </div>

      {visibleEvents.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="context-events-empty">
          {contextEvents.length === 0
            ? (zh
                ? '暂无重试移出或历史压缩事件，全部历史消息均完整保留在上下文中。'
                : 'No retry-omit or compaction events recorded yet — full history is retained.')
            : (zh
                ? '当前筛选条件下暂无匹配的上下文事件。'
                : 'No context events match the selected filter.')}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {visibleEvents.map((ev) => {
            const targetCall = modelCalls.find(call => call.seq > ev.afterCallSeq)
              ?? modelCalls.find(call => call.seq === ev.afterCallSeq)
              ?? modelCalls[modelCalls.length - 1]
              ?? null
            const isSelected = targetCall !== null && targetCall.id === selectedCallId
            const title = ev.kind === 'RETRY_OMIT'
              ? (zh ? `重试移出 · 移出 ${ev.removedCount} 条旧回复` : `Retry omit · Left out ${ev.removedCount} entries`)
              : ev.kind === 'RESET'
                ? (zh ? `上下文重置 · 清空 ${ev.removedCount} 条旧记录` : `Context reset · Cleared ${ev.removedCount} entries`)
                : (zh ? `历史压缩 · 概括 ${ev.removedCount} 条早期消息` : `Compaction · Summarized ${ev.removedCount} entries`)
            return (
              <Button
                aria-label={title}
                aria-pressed={isSelected}
                className="h-auto w-full flex-col items-stretch gap-1 rounded-lg border border-border bg-card px-2.5 py-2 text-left whitespace-normal"
                data-event-kind={ev.kind}
                data-testid="context-event-item"
                disabled={targetCall === null}
                key={ev.id}
                onClick={() => {
                  if (targetCall !== null) onSelectCall(targetCall.id)
                }}
                type="button"
                variant={isSelected ? 'secondary' : 'ghost'}
              >
                <span className="flex items-center justify-between gap-2 text-xs font-medium text-foreground">
                  <span className="truncate">{title}</span>
                  <span className="shrink-0 font-mono text-warning tabular-nums">
                    {formatSignedTokenDelta(-Math.abs(ev.reclaimedTokens))}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                  <span>
                    {ev.kind === 'RETRY_OMIT'
                      ? (zh ? '重试替换历史' : 'Retry omission')
                      : (ev.summarizedByModel ? (zh ? '模型概括' : 'Model summary') : (zh ? '结构化概括' : 'Structured summary'))}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {targetCall !== null
                      ? (zh ? `关联第 #${targetCall.seq} 次调用` : `Linked to call #${targetCall.seq}`)
                      : (zh ? '尚未产生后续调用' : 'Before next call')}
                  </span>
                </span>
              </Button>
            )
          })}
        </div>
      )}
    </section>
  )
}
