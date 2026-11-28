import type { ModelCallSummary } from '@clinmesh/contracts/agent-sessions'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Switch } from '@clinmesh/ui/components/switch'
import { useQuery } from '@tanstack/react-query'
import { Minimize2Icon, RefreshCwIcon, RotateCcwIcon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getAgentModelCallDetail, getAgentSessionContext } from '../agent-sessions-api.ts'
import { ContextBrowser } from './context-browser.tsx'
import { ContextCompositionBar } from './context-composition-bar.tsx'
import { ContextEventsList } from './context-events-list.tsx'
import { ModelCallTimeline } from './model-call-timeline.tsx'

export interface ContextInspectorOverlayProps {
  open: boolean
  sessionId: string | null
  sessionTitle?: string | undefined
  sidebarWidth: number
  initialSelectedCallId?: string | null | undefined
  latestContextCall?: ModelCallSummary | null | undefined
  autoCompact?: boolean
  compactPending?: boolean
  resetPending?: boolean
  onToggleAutoCompact?: (enabled: boolean) => void
  onCompact?: () => void
  onReset?: () => void
  onClose: () => void
  zh: boolean
}

/**
 * Wide two-column Context Inspector overlay anchored over ONLY the left clinical workspace
 * beside the right-hand Assistant Sidebar so the conversation remains readable side-by-side.
 */
export function ContextInspectorOverlay({
  open,
  sessionId,
  sessionTitle,
  sidebarWidth,
  initialSelectedCallId,
  latestContextCall,
  autoCompact = true,
  compactPending = false,
  resetPending = false,
  onToggleAutoCompact,
  onCompact,
  onReset,
  onClose,
  zh,
}: ContextInspectorOverlayProps): React.JSX.Element | null {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const [selectedCallId, setSelectedCallId] = useState<string | null>(initialSelectedCallId ?? null)

  useEffect(() => {
    if (initialSelectedCallId) {
      setSelectedCallId(initialSelectedCallId)
    }
  }, [initialSelectedCallId])

  // Reset selected call when switching sessions
  useEffect(() => {
    setSelectedCallId(initialSelectedCallId ?? null)
  }, [sessionId, initialSelectedCallId])

  // Escape dismiss
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open])

  const contextQuery = useQuery({
    queryKey: ['agent-session-context', sessionId, latestContextCall?.id ?? 'none'],
    queryFn: ({ signal }) => getAgentSessionContext(sessionId!, signal),
    enabled: open && sessionId !== null,
  })

  const modelCalls = contextQuery.data?.modelCalls ?? (latestContextCall ? [latestContextCall] : [])
  const contextEvents = contextQuery.data?.contextEvents ?? []
  const defaultContextWindow = contextQuery.data?.defaultContextWindow
    ?? latestContextCall?.contextWindow
    ?? 128_000

  const resolvedSelectedCall = useMemo(() => {
    if (modelCalls.length === 0) return null
    if (selectedCallId !== null) {
      const matched = modelCalls.find(call => call.id === selectedCallId)
      if (matched !== undefined) return matched
    }
    return modelCalls[modelCalls.length - 1] ?? null
  }, [modelCalls, selectedCallId])

  const previousCall = useMemo(() => {
    if (resolvedSelectedCall === null) return null
    const idx = modelCalls.findIndex(call => call.id === resolvedSelectedCall.id)
    return idx > 0 ? modelCalls[idx - 1] ?? null : null
  }, [modelCalls, resolvedSelectedCall])

  const callDetailQuery = useQuery({
    queryKey: ['agent-model-call-detail', sessionId, resolvedSelectedCall?.id ?? 'none'],
    queryFn: ({ signal }) => getAgentModelCallDetail(sessionId!, resolvedSelectedCall!.id, signal),
    enabled: open && sessionId !== null && resolvedSelectedCall !== null && resolvedSelectedCall.hasDetail,
  })

  if (!open) return null

  return (
    <div
      aria-label={zh ? '上下文检查器' : 'Context Inspector'}
      aria-modal="false"
      className="cm-ctx-overlay-root"
      data-testid="context-inspector-overlay"
      role="dialog"
      style={{ right: `${Math.max(0, sidebarWidth)}px` }}
    >
      <div className="cm-ctx-overlay-panel" data-testid="context-inspector-panel">
        <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">
              {zh ? '上下文检查器' : 'Context Inspector'}
            </h2>
            {sessionTitle ? (
              <span className="max-w-52 truncate text-xs text-muted-foreground">
                {sessionTitle}
              </span>
            ) : null}
            {resolvedSelectedCall !== null ? (
              <Badge className="font-mono text-[0.6875rem]" variant="secondary">
                {resolvedSelectedCall.model}
              </Badge>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {sessionId !== null && onToggleAutoCompact !== undefined ? (
              <div className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>{zh ? '自动压缩' : 'Auto-compact'}</span>
                <Switch
                  aria-label={zh ? '自动压缩上下文' : 'Automatic context compaction'}
                  checked={autoCompact}
                  data-testid="context-auto-compact-switch"
                  onCheckedChange={onToggleAutoCompact}
                />
              </div>
            ) : null}
            {sessionId !== null && onCompact !== undefined ? (
              <Button
                aria-label={zh ? '立即压缩上下文' : 'Compact context now'}
                data-testid="context-compact-now-btn"
                disabled={compactPending}
                onClick={onCompact}
                size="xs"
                type="button"
                variant="outline"
              >
                <Minimize2Icon aria-hidden="true" className="size-3" data-icon="inline-start" />
                {compactPending ? (zh ? '压缩中…' : 'Compacting…') : (zh ? '立即压缩' : 'Compact')}
              </Button>
            ) : null}
            {sessionId !== null && onReset !== undefined ? (
              <Button
                aria-label={zh ? '重置上下文窗口' : 'Reset context window'}
                data-testid="context-reset-btn"
                disabled={resetPending}
                onClick={onReset}
                size="xs"
                type="button"
                variant="ghost"
              >
                <RotateCcwIcon aria-hidden="true" className="size-3" data-icon="inline-start" />
                {zh ? '重置' : 'Reset'}
              </Button>
            ) : null}
            {sessionId !== null ? (
              <Button
                aria-label={zh ? '刷新上下文快照' : 'Refresh context snapshots'}
                disabled={contextQuery.isFetching}
                onClick={() => void contextQuery.refetch()}
                size="icon-sm"
                title={zh ? '刷新' : 'Refresh'}
                type="button"
                variant="ghost"
              >
                <RefreshCwIcon
                  aria-hidden="true"
                  className={contextQuery.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'}
                />
              </Button>
            ) : null}
            <Button
              aria-label={zh ? '关闭上下文检查器' : 'Close Context Inspector'}
              data-testid="context-inspector-close"
              onClick={onClose}
              size="icon-sm"
              title={zh ? '关闭 (Esc)' : 'Close (Esc)'}
              type="button"
              variant="ghost"
            >
              <XIcon aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </header>

        <div className="cm-ctx-body">
          <div className="cm-ctx-left-col cm-assistant-scroll" data-testid="context-inspector-left-col">
            <ContextCompositionBar
              call={resolvedSelectedCall}
              defaultContextWindow={defaultContextWindow}
              previousCall={previousCall}
              zh={zh}
            />
            <ModelCallTimeline
              contextEvents={contextEvents}
              modelCalls={modelCalls}
              onSelectCall={callId => setSelectedCallId(callId)}
              selectedCallId={resolvedSelectedCall?.id ?? null}
              zh={zh}
            />
            <ContextEventsList
              contextEvents={contextEvents}
              modelCalls={modelCalls}
              onSelectCall={callId => setSelectedCallId(callId)}
              selectedCallId={resolvedSelectedCall?.id ?? null}
              zh={zh}
            />
          </div>

          <div className="cm-ctx-right-col cm-assistant-scroll" data-testid="context-inspector-right-col">
            <ContextBrowser
              detail={callDetailQuery.data?.modelCall ?? null}
              loading={callDetailQuery.isLoading || contextQuery.isLoading}
              selectedCall={resolvedSelectedCall}
              zh={zh}
            />
          </div>
        </div>
      </div>

      <div
        aria-hidden="true"
        className="cm-ctx-overlay-backdrop"
        data-testid="context-inspector-backdrop"
        onClick={onClose}
      />
    </div>
  )
}
