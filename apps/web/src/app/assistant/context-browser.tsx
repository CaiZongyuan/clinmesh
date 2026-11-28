import type {
  ContextItem,
  ContextItemKind,
  ModelCallDetail,
  ModelCallSummary,
} from '@clinmesh/contracts/agent-sessions'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from '@clinmesh/ui/components/collapsible'
import { Input } from '@clinmesh/ui/components/input'
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  SearchIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  ContextUsageSourceBadge,
  formatTokenCount,
  type ContextCompositionSegmentKey,
} from './context-composition-bar.tsx'
import {
  formatModelCallDuration,
  formatModelCallPurposeLabel,
} from './model-call-timeline.tsx'

type BrowserCategoryKind = ContextItemKind | 'RESPONSE'

const INCLUDED_ORDER: readonly ContextItemKind[] = [
  'INSTRUCTIONS',
  'CLINICAL_CONTEXT',
  'TOOL_DEFINITION',
  'COMPACTED_SUMMARY',
  'USER_MESSAGE',
  'ASSISTANT_MESSAGE',
  'REASONING',
  'TOOL_CALL',
  'TOOL_RESULT',
]

function categoryLabel(kind: BrowserCategoryKind, zh: boolean): string {
  switch (kind) {
    case 'INSTRUCTIONS':
      return 'System Prompt'
    case 'CLINICAL_CONTEXT':
      return zh ? '临床作用域上下文' : 'Clinical scope context'
    case 'TOOL_DEFINITION':
      return zh ? '工具定义' : 'Tool definitions'
    case 'COMPACTED_SUMMARY':
      return zh ? '历史摘要' : 'Compacted summary'
    case 'USER_MESSAGE':
      return zh ? '用户消息' : 'User messages'
    case 'ASSISTANT_MESSAGE':
      return zh ? '助手回复' : 'Assistant replies'
    case 'REASONING':
      return zh ? '思考过程' : 'Reasoning'
    case 'TOOL_CALL':
      return zh ? '工具调用' : 'Tool calls'
    case 'TOOL_RESULT':
      return zh ? '工具结果' : 'Tool results'
    case 'RESPONSE':
      return zh ? '本次模型输出' : 'Model response'
  }
}

function singleItemKindLabel(kind: ContextItemKind, zh: boolean): string {
  switch (kind) {
    case 'INSTRUCTIONS':
      return 'System'
    case 'CLINICAL_CONTEXT':
      return zh ? '临床上下文' : 'Clinical'
    case 'TOOL_DEFINITION':
      return zh ? '工具定义' : 'Tool def'
    case 'COMPACTED_SUMMARY':
      return zh ? '历史摘要' : 'Summary'
    case 'USER_MESSAGE':
      return zh ? '用户' : 'User'
    case 'ASSISTANT_MESSAGE':
      return zh ? '助手' : 'Assistant'
    case 'REASONING':
      return zh ? '思考' : 'Thinking'
    case 'TOOL_CALL':
      return zh ? '工具调用' : 'Tool call'
    case 'TOOL_RESULT':
      return zh ? '工具结果' : 'Tool result'
  }
}

function categorySwatchKey(kind: BrowserCategoryKind): Exclude<ContextCompositionSegmentKey, 'remaining'> {
  switch (kind) {
    case 'INSTRUCTIONS':
      return 'system_prompt'
    case 'TOOL_DEFINITION':
      return 'tool_definitions'
    case 'CLINICAL_CONTEXT':
    case 'COMPACTED_SUMMARY':
      return 'clinical_context'
    case 'USER_MESSAGE':
    case 'ASSISTANT_MESSAGE':
    case 'RESPONSE':
      return 'messages'
    case 'REASONING':
      return 'thinking'
    case 'TOOL_CALL':
    case 'TOOL_RESULT':
      return 'tool_results'
  }
}

function summarizeItemPreview(item: ContextItem, zh: boolean): string {
  if (item.label) return item.label
  const firstLine = item.content.split(/\r?\n/).find(line => line.trim().length > 0)?.trim()
  if (!firstLine) return zh ? '（空内容）' : '(empty)'
  return firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine
}

function formatStartedClock(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function BrowserItemRow({
  item,
  inResponseGroup,
  zh,
}: {
  item: ContextItem
  inResponseGroup: boolean
  zh: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const preview = summarizeItemPreview(item, zh)

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(item.content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable in restricted environments.
    }
  }

  return (
    <Collapsible
      className="overflow-hidden rounded-md border border-border/80 bg-card"
      data-item-kind={item.kind}
      data-testid="context-browser-item"
    >
      <CollapsibleTrigger
        aria-label={`${singleItemKindLabel(item.kind, zh)}: ${preview}`}
        className="group/item-trigger flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-foreground hover:bg-accent/50"
        data-testid="context-browser-item-toggle"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-aria-expanded/item-trigger:rotate-90"
        />
        {inResponseGroup ? (
          <Badge className="shrink-0 px-1.5 py-0 text-[0.6875rem]" variant="secondary">
            {singleItemKindLabel(item.kind, zh)}
          </Badge>
        ) : null}
        <span className={item.label ? 'min-w-0 flex-1 truncate font-mono text-[0.75rem]' : 'min-w-0 flex-1 truncate'}>
          {preview}
        </span>
        {item.source !== undefined ? (
          <Badge className="shrink-0 px-1.5 py-0 text-[0.6875rem]" variant="outline">
            {item.source === 'BUILTIN' ? (zh ? '内置' : 'Built-in') : (zh ? '扩展' : 'Ext')}
          </Badge>
        ) : null}
        <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
          ≈{formatTokenCount(item.tokens)}
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="relative">
          <div className="flex items-center justify-end border-t border-border/70 bg-muted/60 px-2 py-1">
            <Button
              aria-label={zh ? '复制该上下文条目' : 'Copy context item'}
              className="h-6 gap-1 px-1.5 text-[0.6875rem]"
              onClick={() => void handleCopy()}
              size="xs"
              type="button"
              variant="ghost"
            >
              {copied ? (
                <>
                  <CheckIcon aria-hidden="true" className="size-3 text-success" />
                  <span>{zh ? '已复制' : 'Copied'}</span>
                </>
              ) : (
                <>
                  <CopyIcon aria-hidden="true" className="size-3" />
                  <span>{zh ? '复制' : 'Copy'}</span>
                </>
              )}
            </Button>
          </div>
          <pre
            className="cm-ctx-item-pre cm-assistant-scroll border-t-0"
            data-testid="context-browser-item-content"
          >
            {item.content}
          </pre>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  )
}

export interface ContextBrowserProps {
  selectedCall: ModelCallSummary | null
  detail: ModelCallDetail | null
  loading: boolean
  zh: boolean
}

export function ContextBrowser({
  selectedCall,
  detail,
  loading,
  zh,
}: ContextBrowserProps): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState('')
  const normalizedQuery = searchQuery.trim().toLowerCase()

  const categoryGroups = useMemo(() => {
    if (detail === null) return []
    const matches = (item: ContextItem) => {
      if (normalizedQuery.length === 0) return true
      return (
        item.content.toLowerCase().includes(normalizedQuery)
        || (item.label?.toLowerCase().includes(normalizedQuery) ?? false)
        || item.kind.toLowerCase().includes(normalizedQuery)
      )
    }

    const byKind = new Map<ContextItemKind, ContextItem[]>()
    for (const item of detail.included) {
      if (!matches(item)) continue
      const bucket = byKind.get(item.kind)
      if (bucket !== undefined) bucket.push(item)
      else byKind.set(item.kind, [item])
    }

    const groups: Array<{ kind: BrowserCategoryKind; items: ContextItem[]; totalTokens: number }> = []
    for (const kind of INCLUDED_ORDER) {
      const items = byKind.get(kind)
      if (items === undefined || items.length === 0) continue
      groups.push({
        kind,
        items,
        totalTokens: items.reduce((sum, item) => sum + item.tokens, 0),
      })
    }

    const responseItems = detail.response.filter(matches)
    if (responseItems.length > 0) {
      groups.push({
        kind: 'RESPONSE',
        items: responseItems,
        totalTokens: responseItems.reduce((sum, item) => sum + item.tokens, 0),
      })
    }
    return groups
  }, [detail, normalizedQuery])

  const excludedItems = useMemo(() => {
    if (detail === null) return []
    if (normalizedQuery.length === 0) return detail.excluded
    return detail.excluded.filter(
      item => item.content.toLowerCase().includes(normalizedQuery)
        || (item.label?.toLowerCase().includes(normalizedQuery) ?? false),
    )
  }, [detail, normalizedQuery])

  const startedClock = selectedCall ? formatStartedClock(selectedCall.startedAt) : ''

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-selected-call-id={selectedCall?.id ?? ''}
      data-testid="context-browser"
    >
      <section className="border-b border-border pb-3">
        {selectedCall === null ? (
          <>
            <h3 className="mb-1.5 text-sm font-semibold text-foreground">
              {zh ? '调用上下文明细' : 'Call context items'}
            </h3>
            <p className="text-xs text-muted-foreground" data-testid="context-browser-empty">
              {zh
                ? '尚未记录模型调用；发送消息后可在此逐项检查实际发送给模型的 system prompt、工具定义与对话历史。'
                : 'No model calls recorded yet. Send a message to inspect every item sent to the model.'}
            </p>
          </>
        ) : (
          <>
            <div className="mb-2.5 space-y-1.5" data-testid="context-browser-head">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  {zh
                    ? `第 #${selectedCall.seq} 次调用发送的内容`
                    : `Call #${selectedCall.seq} context snapshot`}
                </h3>
                <ContextUsageSourceBadge source={selectedCall.usage.source} zh={zh} />
              </div>

              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground tabular-nums">
                <span>#{selectedCall.seq} {formatModelCallPurposeLabel(selectedCall.purpose, zh)}</span>
                <span className="font-mono text-foreground/85">{selectedCall.model}</span>
                <span>
                  {zh ? '输入 ' : 'In '}
                  {formatTokenCount(selectedCall.usage.promptTokens)}
                </span>
                <span>
                  {zh ? '输出 ' : 'Out '}
                  {formatTokenCount(selectedCall.usage.outputTokens)}
                </span>
                <span>{formatModelCallDuration(selectedCall.durationMs)}</span>
                {startedClock.length > 0 ? <span>{startedClock}</span> : null}
              </div>

              {selectedCall.hasDetail ? (
                <div className="relative pt-1">
                  <SearchIcon
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    aria-label={zh ? '筛选上下文条目' : 'Filter context items'}
                    className="h-7 pl-8 text-xs"
                    onChange={event => setSearchQuery(event.currentTarget.value)}
                    placeholder={zh ? '按关键词筛选上下文内容…' : 'Filter context items…'}
                    value={searchQuery}
                  />
                </div>
              ) : null}
            </div>

            {!selectedCall.hasDetail ? (
              <div className="rounded-md border border-border bg-muted/50 p-3 text-xs">
                <div className="font-semibold text-foreground">
                  {zh ? '历史快照详情已归档清理' : 'Detailed snapshot pruned'}
                </div>
                <p className="mt-1 text-muted-foreground">
                  {zh
                    ? '完整正文仅保留最近 100 次模型调用，该次调用的用量数值、模型名称与耗时仍完整保留。'
                    : 'Full item content is retained for the most recent 100 calls; token usage and timing remain preserved.'}
                </p>
              </div>
            ) : loading && detail === null ? (
              <p className="text-xs text-muted-foreground" data-testid="context-browser-loading">
                {zh ? '正在加载本次调用上下文…' : 'Loading context snapshot…'}
              </p>
            ) : categoryGroups.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {normalizedQuery.length > 0
                  ? (zh ? '没有匹配该关键词的上下文条目。' : 'No context items match your filter.')
                  : (zh ? '本次调用暂无可展开的上下文条目。' : 'No context items recorded for this call.')}
              </p>
            ) : (
              <div className="divide-y divide-border/70 border-t border-border/70">
                {categoryGroups.map(group => (
                  <Collapsible
                    className="py-1"
                    data-category-kind={group.kind}
                    data-testid="context-browser-category"
                    defaultOpen
                    key={group.kind}
                  >
                    <CollapsibleTrigger
                      aria-label={`${categoryLabel(group.kind, zh)} (${group.items.length})`}
                      className="group/cat-trigger flex w-full items-center gap-1.5 rounded-md px-1 py-1.5 text-xs text-foreground hover:bg-accent/50"
                      data-testid="context-browser-category-toggle"
                    >
                      <ChevronRightIcon
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-muted-foreground transition-transform group-aria-expanded/cat-trigger:rotate-90"
                      />
                      <span
                        aria-hidden="true"
                        className={`cm-ctx-swatch is-${categorySwatchKey(group.kind)}`}
                      />
                      <span className="min-w-0 flex-1 truncate font-semibold">
                        {categoryLabel(group.kind, zh)}
                      </span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {zh ? `${group.items.length} 项` : `${group.items.length}`}
                      </span>
                      <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                        ≈{formatTokenCount(group.totalTokens)}
                      </span>
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      <div className="flex flex-col gap-1 pt-1 pb-2 pl-4">
                        {group.items.map((item, idx) => (
                          <BrowserItemRow
                            inResponseGroup={group.kind === 'RESPONSE'}
                            item={item}
                            key={`${group.kind}-${item.blobId}-${idx}`}
                            zh={zh}
                          />
                        ))}
                      </div>
                    </CollapsiblePanel>
                  </Collapsible>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <section data-testid="context-inspector-removed-section">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            {zh ? '已移出（未原样发送）' : 'Removed (not sent verbatim)'}
          </h3>
          <span className="text-xs text-muted-foreground tabular-nums">
            {zh ? `${excludedItems.length} 条` : `${excludedItems.length} items`}
          </span>
        </div>

        {excludedItems.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {zh
              ? '当前调用没有被移出或跳过的历史消息，全部有效消息均已原样带入上下文。'
              : 'No messages were left out of this call — full active history is included.'}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {excludedItems.map((item, idx) => (
              <BrowserItemRow
                inResponseGroup
                item={item}
                key={`excluded-${item.blobId}-${idx}`}
                zh={zh}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
