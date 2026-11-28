import type {
  AgentContentBlock,
  AgentRetryState,
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionSummary,
  ClinicalEntityMention,
} from '@clinmesh/contracts/agent-sessions'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@clinmesh/ui/components/message-scroller'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@clinmesh/ui/components/popover'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CopyIcon,
  GitForkIcon,
  LayersIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  MessageSquarePlusIcon,
  MessageSquareQuoteIcon,
  Minimize2Icon,
  PanelRightCloseIcon,
  PencilIcon,
  QuoteIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SettingsIcon,
  SparklesIcon,
  TimerIcon,
  XIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useActiveEncounterStore } from './active-encounter-context.tsx'
import {
  compactAgentSession,
  createAgentSession,
  deleteAgentSession,
  exportAgentSession,
  forkAgentSession,
  getAgentSession,
  getLlmProviderCatalog,
  listAgentSessions,
  listClinicalEntities,
  listScopeClinicalEntities,
  recallQueuedAgentInput,
  renameAgentSession,
  resetAgentSession,
  retryLatestAgentMessage,
  sendAgentMessage,
  stopAgentSession,
  subscribeAgentSessionEvents,
  updateAgentSession,
} from './agent-sessions-api.ts'
import { ApiClientError } from './api-client.ts'
import { AssistantComposer, type ComposerSendMode } from './assistant/assistant-composer.tsx'
import { AssistantHistoryMenu } from './assistant/assistant-history-menu.tsx'
import { AssistantPreferencesMenu } from './assistant/assistant-preferences-menu.tsx'
import { AssistantSideChat } from './assistant/assistant-side-chat.tsx'
import { formatTokenCount } from './assistant/context-composition-bar.tsx'
import { ContextInspectorOverlay } from './assistant/context-inspector-overlay.tsx'
import { WorkProcessBlock } from './assistant/work-process-block.tsx'
import './assistant/assistant-panel.css'
import { useLlmSettings } from './llm-settings-storage.ts'
import { MarkdownRenderer } from './markdown-renderer.tsx'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

const PROVIDER_CONFIG_ERROR_CODES = new Set([
  'LLM_PROVIDER_UNCONFIGURED',
  'LLM_AUTH_FAILED',
  'LLM_RATE_LIMITED',
  'LLM_TIMEOUT',
  'LLM_REQUEST_FAILED',
  'AI_AUTH_FAILED',
])

const WIDTH_STORAGE_KEY = 'clinmesh.assistant.sidebarWidth.v1'
const DEFAULT_SIDEBAR_WIDTH = 396
const MIN_SIDEBAR_WIDTH = 320
const MAX_SIDEBAR_WIDTH = 680

function clampSidebarWidth(width: number): number {
  const maxByViewport = typeof window !== 'undefined'
    ? Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(window.innerWidth * 0.56)))
    : MAX_SIDEBAR_WIDTH
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxByViewport, Math.round(width)))
}

function readStoredSidebarWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY)
    const parsed = raw === null ? Number.NaN : Number(raw)
    if (Number.isFinite(parsed) && parsed >= MIN_SIDEBAR_WIDTH) {
      return clampSidebarWidth(parsed)
    }
  } catch {
    // Ignore storage failures.
  }
  return DEFAULT_SIDEBAR_WIDTH
}

function extractMessagePlainText(message: AgentSessionMessage): string {
  return message.blocks
    .filter((block): block is Extract<AgentContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * Groups consecutive assistant messages from a multi-step tool-calling turn into a single
 * Claude Desktop-style reply turn (one unified WorkProcessBlock + final prose + one footer),
 * preserving the last entryId for accurate message-level branching and streaming telemetry.
 */
function groupConversationMessages(messages: readonly AgentSessionMessage[]): AgentSessionMessage[] {
  const grouped: AgentSessionMessage[] = []
  for (const msg of messages) {
    const prev = grouped[grouped.length - 1]
    if (msg.role === 'assistant' && prev !== undefined && prev.role === 'assistant') {
      const mergedDuration = (prev.durationMs ?? 0) + (msg.durationMs ?? 0)
      grouped[grouped.length - 1] = {
        ...prev,
        id: prev.id,
        entryId: msg.entryId ?? prev.entryId,
        blocks: [...prev.blocks, ...msg.blocks],
        stopReason: msg.stopReason,
        errorMessage: msg.errorMessage ?? prev.errorMessage,
        streaming: prev.streaming || msg.streaming,
        model: msg.model ?? prev.model ?? null,
        provider: msg.provider ?? prev.provider ?? null,
        durationMs: mergedDuration > 0 ? mergedDuration : null,
        ttftMs: prev.ttftMs ?? msg.ttftMs ?? null,
        tokensPerSecond: msg.tokensPerSecond ?? prev.tokensPerSecond ?? null,
        usage: msg.usage ?? prev.usage ?? null,
        modelCallId: msg.modelCallId ?? prev.modelCallId ?? null,
      }
      continue
    }
    grouped.push(msg)
  }
  return grouped
}

const STARTER_PROMPTS = [
  {
    id: 'summary',
    zhLabel: '整理当前病例摘要',
    enLabel: 'Summarize visible case',
    zhPrompt: '请帮我整理当前病例摘要',
    enPrompt: 'Please summarize the current visible case.',
  },
  {
    id: 'differential',
    zhLabel: '列出鉴别诊断思路',
    enLabel: 'Differential diagnosis',
    zhPrompt: '请结合当前可见信息，列出需要优先考虑和排除的鉴别诊断思路。',
    enPrompt: 'List prioritized differential diagnoses based on the currently visible clinical findings.',
  },
  {
    id: 'checklist',
    zhLabel: '核对问诊与检查遗漏',
    enLabel: 'Check history & workup gaps',
    zhPrompt: '请帮我核对当前问诊要点、体征及关键检查是否存在遗漏或用药安全风险。',
    enPrompt: 'Review key history, physical exam, workup gaps, and medication safety checks.',
  },
] as const

function RetryCountdownBanner({
  retryState,
  retryPending,
  onRetryNow,
  zh,
}: {
  retryState: AgentRetryState
  retryPending: boolean
  onRetryNow: () => void
  zh: boolean
}): React.JSX.Element {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [retryState.retryAt])

  const retryAtMs = Date.parse(retryState.retryAt)
  const remainingSec = Number.isFinite(retryAtMs)
    ? Math.max(0, Math.ceil((retryAtMs - nowMs) / 1_000))
    : 0

  return (
    <div className="cm-retry-banner" data-testid="assistant-retry-banner" role="status">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <TimerIcon aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
          <span>
            {retryState.isRateLimited
              ? (zh ? '模型触发速率限制（自动退避中）' : 'Rate limited — auto backoff')
              : (zh ? '请求短暂异常（自动重试中）' : 'Transient error — auto retry')}
          </span>
          <Badge className="px-1 py-0 text-[0.625rem] tabular-nums" variant="outline">
            {zh ? `第 ${retryState.attempt} 次 · ${remainingSec}s` : `#${retryState.attempt} · ${remainingSec}s`}
          </Badge>
        </div>
        <p className="truncate text-[0.6875rem] text-muted-foreground">{retryState.error}</p>
      </div>
      <Button
        aria-label={zh ? '立即跳过倒计时并重试' : 'Retry immediately'}
        className="h-6 shrink-0 px-2 text-xs"
        data-testid="assistant-retry-now-btn"
        disabled={retryPending}
        onClick={onRetryNow}
        size="xs"
        type="button"
        variant="outline"
      >
        <RefreshCwIcon aria-hidden="true" className="size-3" data-icon="inline-start" />
        {zh ? '立即重试' : 'Retry now'}
      </Button>
    </div>
  )
}

function SystemBoundaryView({
  message,
  zh,
}: {
  message: AgentSessionMessage
  zh: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const text = extractMessagePlainText(message)
  const isCompaction = Boolean(message.isCompactionSummary)

  return (
    <div
      className="cm-system-boundary"
      data-role="system"
      data-testid={isCompaction ? 'assistant-compaction-divider' : 'assistant-reset-divider'}
    >
      <div className="cm-system-boundary-line">
        {isCompaction ? (
          <Button
            aria-expanded={expanded}
            aria-label={zh ? '展开或折叠上下文压缩摘要' : 'Toggle compacted context summary'}
            className="h-6 gap-1 rounded-full border border-border bg-muted/60 px-2.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded(prev => !prev)}
            size="xs"
            type="button"
            variant="ghost"
          >
            <Minimize2Icon aria-hidden="true" className="size-3 text-warning" />
            <span>{zh ? '已压缩早期上下文摘要' : 'Earlier context compacted'}</span>
            {expanded ? (
              <ChevronDownIcon aria-hidden="true" className="size-3" />
            ) : (
              <ChevronRightIcon aria-hidden="true" className="size-3" />
            )}
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2.5 py-0.5 text-[0.6875rem]">
            <RotateCcwIcon aria-hidden="true" className="size-3" />
            <span>{zh ? '上下文窗口已重置' : 'Context window reset'}</span>
          </span>
        )}
      </div>

      {expanded && text.length > 0 ? (
        <div className="w-full rounded-lg border border-border bg-muted/40 p-2.5 text-xs text-muted-foreground">
          <MarkdownRenderer content={text} />
        </div>
      ) : null}
    </div>
  )
}

function AssistantTurnView({
  message,
  isLatestAssistant,
  isRunning,
  isEditingBranch,
  canRetry,
  retryPending,
  forkPending,
  showLiveThinking,
  onRetry,
  onInspectCall,
  onQuoteText,
  onSideChatQuote,
  onForkAtEntry,
  onEditAndBranch,
  onTextSelection,
  zh,
}: {
  message: AgentSessionMessage
  isLatestAssistant: boolean
  isRunning: boolean
  isEditingBranch: boolean
  canRetry: boolean
  retryPending: boolean
  forkPending: boolean
  showLiveThinking: boolean
  onRetry: () => void
  onInspectCall: (callId: string | null) => void
  onQuoteText: (text: string) => void
  onSideChatQuote: (text: string) => void
  onForkAtEntry: (entryId: number) => void
  onEditAndBranch: (message: AgentSessionMessage) => void
  onTextSelection: (selectedText: string) => void
  zh: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  if (message.role === 'system') {
    return <SystemBoundaryView message={message} zh={zh} />
  }

  if (message.role === 'user') {
    const text = extractMessagePlainText(message)
    return (
      <div
        className="cm-user-turn-wrap"
        data-editing={isEditingBranch ? 'true' : 'false'}
        data-role="user"
        data-testid="assistant-user-turn"
        data-turn-anchor={message.id}
      >
        <div
          className={isEditingBranch
            ? 'max-w-[88%] rounded-2xl bg-secondary px-3.5 py-2.5 text-sm leading-relaxed text-secondary-foreground ring-2 ring-info/60'
            : 'max-w-[88%] rounded-2xl bg-secondary px-3.5 py-2.5 text-sm leading-relaxed text-secondary-foreground'}
        >
          <p className="whitespace-pre-wrap break-words">{text}</p>
        </div>
        <div className="cm-user-turn-actions">
          {isEditingBranch ? (
            <Badge className="px-1.5 py-0 text-[0.625rem]" variant="secondary">
              {zh ? '正在编辑以分支' : 'Editing for branch'}
            </Badge>
          ) : (
            <Button
              aria-label={zh ? '从这条提问编辑并创建新分支' : 'Edit and branch from this prompt'}
              className="h-5 gap-1 px-1.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
              data-testid="assistant-edit-branch-btn"
              disabled={isRunning || forkPending}
              onClick={() => onEditAndBranch(message)}
              size="xs"
              type="button"
              variant="ghost"
            >
              <PencilIcon aria-hidden="true" className="size-2.5" />
              <span>{zh ? '编辑并分支' : 'Edit & branch'}</span>
            </Button>
          )}
        </div>
      </div>
    )
  }

  const thinkingBlocks = message.blocks.filter(
    (block): block is Extract<AgentContentBlock, { type: 'thinking' }> => block.type === 'thinking',
  )
  const toolBlocks = message.blocks.filter(
    (block): block is Extract<AgentContentBlock, { type: 'tool-call' }> => block.type === 'tool-call',
  )
  const textBlocks = message.blocks.filter(
    (block): block is Extract<AgentContentBlock, { type: 'text' }> => block.type === 'text',
  )
  const plainMarkdown = textBlocks.map(block => block.text).join('\n\n').trim()

  const handleCopy = async () => {
    if (plainMarkdown.length === 0) return
    try {
      await navigator.clipboard?.writeText(plainMarkdown)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Ignore clipboard failures in headless/restricted environments.
    }
  }

  const handleProseMouseUp = () => {
    const selected = window.getSelection?.()?.toString().trim() ?? ''
    if (selected.length >= 4 && selected.length <= 2_000) {
      onTextSelection(selected)
    }
  }

  const telemetryParts: string[] = []
  if (message.ttftMs != null && message.ttftMs > 0) {
    telemetryParts.push(`TTFT ${(message.ttftMs / 1000).toFixed(1)}s`)
  }
  if (message.tokensPerSecond != null && message.tokensPerSecond > 0) {
    telemetryParts.push(`${message.tokensPerSecond.toFixed(1)} tok/s`)
  }

  return (
    <article
      className="cm-assistant-turn"
      data-role="assistant"
      data-testid="assistant-reply-turn"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <BotIcon aria-hidden="true" className="size-3.5 text-foreground/80" />
        <span className="font-medium text-foreground">{zh ? '临床助手' : 'Clinician Assistant'}</span>
        {message.model ? (
          <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
            {message.model}
          </span>
        ) : null}
        {message.streaming ? (
          <span className="inline-flex items-center gap-1 text-info" role="status">
            <LoaderCircleIcon aria-hidden="true" className="size-3 animate-spin" />
            <span>{zh ? '生成中…' : 'Streaming…'}</span>
          </span>
        ) : null}
      </div>

      <WorkProcessBlock
        defaultOpenWhenStreaming={showLiveThinking}
        durationMs={message.durationMs}
        startedAtIso={message.createdAt}
        streaming={message.streaming}
        thinkingBlocks={thinkingBlocks}
        toolBlocks={toolBlocks}
        zh={zh}
      />

      {textBlocks.length > 0 ? (
        <div className="cm-assistant-prose" onMouseUp={handleProseMouseUp}>
          {textBlocks.map((block, index) => (
            <MarkdownRenderer content={block.text} key={`${message.id}-text-${index}`} />
          ))}
        </div>
      ) : message.streaming && thinkingBlocks.length === 0 && toolBlocks.length === 0 ? (
        <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
          <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
          <span>{zh ? '正在连接模型并组织临床回复…' : 'Connecting to model…'}</span>
        </div>
      ) : null}

      {message.errorMessage !== null && message.errorMessage.length > 0 ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          {message.errorMessage}
        </p>
      ) : null}

      {!message.streaming ? (
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="cm-turn-actions">
            {plainMarkdown.length > 0 ? (
              <>
                <Button
                  aria-label={zh ? '复制助手回复' : 'Copy assistant reply'}
                  className="h-6 gap-1 px-1.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
                  data-testid="assistant-copy-reply"
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

                <Button
                  aria-label={zh ? '引用此条助手回复到输入框' : 'Quote this reply into composer'}
                  className="h-6 gap-1 px-1.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
                  data-testid="assistant-quote-reply"
                  onClick={() => onQuoteText(plainMarkdown.slice(0, 400))}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  <QuoteIcon aria-hidden="true" className="size-3" />
                  <span>{zh ? '引用' : 'Quote'}</span>
                </Button>

                <Button
                  aria-label={zh ? '针对此条回复打开侧边追问' : 'Open side chat about this reply'}
                  className="h-6 gap-1 px-1.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
                  data-testid="assistant-side-reply"
                  onClick={() => onSideChatQuote(plainMarkdown.slice(0, 600))}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  <MessageSquareQuoteIcon aria-hidden="true" className="size-3" />
                  <span>{zh ? '侧边追问' : 'Side'}</span>
                </Button>
              </>
            ) : null}

            {message.entryId !== null ? (
              <Button
                aria-label={zh ? '从此条回复创建新分支' : 'Fork conversation from this reply'}
                className="h-6 gap-1 px-1.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
                data-testid="assistant-fork-turn"
                disabled={isRunning || forkPending}
                onClick={() => onForkAtEntry(message.entryId!)}
                size="xs"
                type="button"
                variant="ghost"
              >
                <GitForkIcon aria-hidden="true" className="size-3" />
                <span>{zh ? '分支' : 'Fork'}</span>
              </Button>
            ) : null}

            {message.modelCallId ? (
              <Button
                aria-label={zh ? '查看本次回复的上下文快照' : 'Inspect context for this reply'}
                className="h-6 gap-1 px-1.5 text-[0.6875rem] text-muted-foreground hover:text-foreground tabular-nums"
                data-testid="assistant-inspect-call"
                onClick={() => onInspectCall(message.modelCallId ?? null)}
                size="xs"
                type="button"
                variant="ghost"
              >
                <LayersIcon aria-hidden="true" className="size-3" />
                <span>
                  {message.usage
                    ? `${formatTokenCount(message.usage.promptTokens)} tok`
                    : (zh ? '上下文' : 'Context')}
                </span>
              </Button>
            ) : null}

            {isLatestAssistant && canRetry ? (
              <Button
                aria-label={zh ? '重试最新问题' : 'Retry latest'}
                className="h-6 gap-1 px-1.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
                disabled={retryPending}
                onClick={onRetry}
                size="xs"
                type="button"
                variant="ghost"
              >
                <RefreshCwIcon aria-hidden="true" className="size-3" />
                <span>{zh ? '重试' : 'Retry'}</span>
              </Button>
            ) : null}
          </div>

          {telemetryParts.length > 0 ? (
            <span
              className="text-[0.6875rem] text-muted-foreground tabular-nums"
              data-testid="assistant-turn-telemetry"
            >
              {telemetryParts.join(' · ')}
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

interface PendingBranchEdit {
  sourceSessionId: string
  sourceMessageId: string
  atEntryId: number | null
  turnIndex: number
  previousDraft: string
  customInstructions: string | null
  autoCompact: boolean
}

export interface ClinicianAssistantSidebarProps {
  locale: WorkspaceLocale
  open: boolean
  onCollapse: () => void
  onExpand: () => void
  onRunningChange?: (running: boolean) => void
  session: SessionContext
}

export function ClinicianAssistantSidebar({
  locale,
  open,
  onCollapse,
  onExpand,
  onRunningChange,
  session,
}: ClinicianAssistantSidebarProps): React.JSX.Element | null {
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const activeEncounter = useActiveEncounterStore()
  const llmSettings = useLlmSettings()

  const scopeKey = useMemo(
    () => [
      session.actor.workspaceId,
      session.actor.epoch,
      session.actor.roleCode,
      activeEncounter.encounterId ?? '__none__',
    ].join('::'),
    [
      session.actor.workspaceId,
      session.actor.epoch,
      session.actor.roleCode,
      activeEncounter.encounterId,
    ],
  )

  const sessionsQueryKey = useMemo(
    () => ['agent-sessions', scopeKey] as const,
    [scopeKey],
  )

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [composingNewSession, setComposingNewSession] = useState(false)
  const [draftCustomInstructions, setDraftCustomInstructions] = useState<string | null>(null)
  const [draftAutoCompact, setDraftAutoCompact] = useState(true)
  const [pendingBranchEdit, setPendingBranchEdit] = useState<PendingBranchEdit | null>(null)
  const [liveDetail, setLiveDetail] = useState<AgentSessionDetail | null>(null)
  const [composerText, setComposerText] = useState('')
  const [quotedText, setQuotedText] = useState<string | null>(null)
  const [attachedEntities, setAttachedEntities] = useState<ClinicalEntityMention[]>([])
  const [selectedPassage, setSelectedPassage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<{ code: string; message: string } | null>(null)
  const [statusNotice, setStatusNotice] = useState<string | null>(null)

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readStoredSidebarWidth())
  const [wideMode, setWideMode] = useState(false)
  const [resizing, setResizing] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [inspectCallId, setInspectCallId] = useState<string | null>(null)
  const [sideChatOpen, setSideChatOpen] = useState(false)
  const [sideChatNonce, setSideChatNonce] = useState(0)
  const [sideChatQuote, setSideChatQuote] = useState<string | null>(null)
  const [sideChatQuestion, setSideChatQuestion] = useState<string | null>(null)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [minimapOpen, setMinimapOpen] = useState(false)

  const dragStartRef = useRef<{ x: number; width: number } | null>(null)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const onRunningChangeRef = useRef(onRunningChange)
  onRunningChangeRef.current = onRunningChange

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => composerTextareaRef.current?.focus())
  }, [])

  // Reset active session state cleanly whenever Workspace / Epoch / Role / Encounter changes.
  useEffect(() => {
    setSelectedSessionId(null)
    setComposingNewSession(false)
    setDraftCustomInstructions(null)
    setDraftAutoCompact(true)
    setPendingBranchEdit(null)
    setLiveDetail(null)
    setActionError(null)
    setStatusNotice(null)
    setContextOpen(false)
    setInspectCallId(null)
    setSideChatOpen(false)
    setSideChatQuote(null)
    setSideChatQuestion(null)
    setQuotedText(null)
    setAttachedEntities([])
    setSelectedPassage(null)
  }, [scopeKey])

  // Close overlays automatically if sidebar collapses.
  useEffect(() => {
    if (!open) {
      if (contextOpen) setContextOpen(false)
      if (sideChatOpen) setSideChatOpen(false)
    }
  }, [open, contextOpen, sideChatOpen])

  const sessionsQuery = useQuery({
    queryKey: sessionsQueryKey,
    queryFn: ({ signal }) => listAgentSessions(activeEncounter.encounterId, signal),
    enabled: open || selectedSessionId !== null,
  })

  const catalogQuery = useQuery({
    queryKey: ['llm-provider-catalog'],
    queryFn: ({ signal }) => getLlmProviderCatalog({ signal }),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  })

  const refreshCatalog = useCallback(() => {
    void getLlmProviderCatalog({ refresh: true })
      .then((fresh) => {
        queryClient.setQueryData(['llm-provider-catalog'], fresh)
      })
      .catch(() => {
        // Keep last known catalog snapshot on transient refresh failure.
      })
  }, [queryClient])

  const sessions = sessionsQuery.data?.sessions ?? []

  // Automatically pick the most recent session for the current scope unless user explicitly started a fresh draft.
  useEffect(() => {
    if (sessions.length === 0) {
      if (selectedSessionId !== null && !sessionsQuery.isFetching) {
        setSelectedSessionId(null)
        setLiveDetail(null)
      }
      return
    }
    if (composingNewSession) return
    if (selectedSessionId === null || !sessions.some(item => item.sessionId === selectedSessionId)) {
      setSelectedSessionId(sessions[0]!.sessionId)
    }
  }, [composingNewSession, selectedSessionId, sessions, sessionsQuery.isFetching])

  const detailQuery = useQuery({
    queryKey: ['agent-session-detail', selectedSessionId],
    queryFn: ({ signal }) => getAgentSession(selectedSessionId!, signal),
    enabled: selectedSessionId !== null,
  })

  const clinicalEntitiesQuery = useQuery({
    queryKey: [
      'agent-clinical-entities',
      selectedSessionId ?? '__draft__',
      activeEncounter.encounterId ?? '__none__',
      activeEncounter.caseId ?? '__none__',
    ],
    queryFn: ({ signal }) => selectedSessionId !== null
      ? listClinicalEntities(selectedSessionId, signal)
      : listScopeClinicalEntities({
          encounterId: activeEncounter.encounterId,
          caseId: activeEncounter.caseId,
        }, signal),
    enabled: open && (selectedSessionId !== null || activeEncounter.caseId !== null),
    staleTime: 15_000,
    retry: false,
  })

  const activeDetail = liveDetail?.session.sessionId === selectedSessionId
    ? liveDetail
    : (detailQuery.data ?? null)

  // Keep SSE subscription active for the selected session so refresh/collapse/rejoin stays live.
  useEffect(() => {
    if (selectedSessionId === null) return
    const unsubscribe = subscribeAgentSessionEvents(selectedSessionId, {
      onSnapshot: (snapshot) => {
        setLiveDetail(snapshot)
        queryClient.setQueryData(['agent-session-detail', selectedSessionId], snapshot)
        queryClient.setQueryData(
          sessionsQueryKey,
          (previous: { sessions: AgentSessionSummary[] } | undefined) => {
            if (previous === undefined) return previous
            const exists = previous.sessions.some(item => item.sessionId === snapshot.session.sessionId)
            const nextList = exists
              ? previous.sessions.map(item =>
                  item.sessionId === snapshot.session.sessionId ? snapshot.session : item,
                )
              : [snapshot.session, ...previous.sessions]
            return { sessions: nextList }
          },
        )
      },
    })
    return unsubscribe
  }, [queryClient, selectedSessionId, sessionsQueryKey])

  const isRunning = activeDetail?.session.status === 'running'
  useEffect(() => {
    onRunningChangeRef.current?.(isRunning)
  }, [isRunning])

  const refreshSessions = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: sessionsQueryKey })
  }, [queryClient, sessionsQueryKey])

  const flashNotice = useCallback((text: string) => {
    setStatusNotice(text)
    window.setTimeout(() => {
      setStatusNotice(current => (current === text ? null : current))
    }, 3_200)
  }, [])

  const mapError = useCallback((error: unknown): { code: string; message: string } => {
    if (error instanceof ApiClientError) {
      return {
        code: error.code,
        message: getWorkspaceErrorMessage(error, messages, error.message),
      }
    }
    return {
      code: 'LLM_REQUEST_FAILED',
      message: error instanceof Error ? error.message : messages.serviceErrorDescription,
    }
  }, [messages])

  const upsertSessionSummary = useCallback((summary: AgentSessionSummary) => {
    queryClient.setQueryData(
      sessionsQueryKey,
      (previous: { sessions: AgentSessionSummary[] } | undefined) => {
        const list = previous?.sessions ?? []
        const exists = list.some(item => item.sessionId === summary.sessionId)
        return {
          sessions: exists
            ? list.map(item => (item.sessionId === summary.sessionId ? summary : item))
            : [summary, ...list],
        }
      },
    )
  }, [queryClient, sessionsQueryKey])

  const startNewDraftSession = useCallback(() => {
    setComposingNewSession(true)
    setSelectedSessionId(null)
    setLiveDetail(null)
    setPendingBranchEdit(null)
    setDraftCustomInstructions(null)
    setDraftAutoCompact(true)
    setQuotedText(null)
    setAttachedEntities([])
    setSelectedPassage(null)
    setActionError(null)
    setStatusNotice(null)
    setContextOpen(false)
    focusComposer()
  }, [focusComposer])

  const selectExistingSession = useCallback((sessionId: string) => {
    setComposingNewSession(false)
    setSelectedSessionId(sessionId)
    setPendingBranchEdit(null)
    setQuotedText(null)
    setAttachedEntities([])
    setSelectedPassage(null)
    setActionError(null)
    setStatusNotice(null)
  }, [])

  const sendMutation = useMutation({
    mutationFn: async ({
      content,
      whenBusy,
      branchEdit,
    }: {
      content: string
      whenBusy: ComposerSendMode
      branchEdit: PendingBranchEdit | null
    }) => {
      let targetSessionId = selectedSessionId
      let createdFreshSessionId: string | null = null

      if (branchEdit !== null) {
        if (branchEdit.atEntryId !== null) {
          const forked = await forkAgentSession(branchEdit.sourceSessionId, {
            atEntryId: branchEdit.atEntryId,
          })
          targetSessionId = forked.session.sessionId
          createdFreshSessionId = forked.session.sessionId
        } else {
          const created = await createAgentSession({
            encounterId: activeEncounter.encounterId,
            caseId: activeEncounter.caseId,
            patientId: activeEncounter.patientId,
            ...(branchEdit.customInstructions ? { customInstructions: branchEdit.customInstructions } : {}),
            autoCompact: branchEdit.autoCompact,
          })
          targetSessionId = created.session.sessionId
          createdFreshSessionId = created.session.sessionId
        }
      } else if (targetSessionId === null) {
        const created = await createAgentSession({
          encounterId: activeEncounter.encounterId,
          caseId: activeEncounter.caseId,
          patientId: activeEncounter.patientId,
          ...(draftCustomInstructions ? { customInstructions: draftCustomInstructions } : {}),
          autoCompact: draftAutoCompact,
        })
        targetSessionId = created.session.sessionId
        createdFreshSessionId = created.session.sessionId
      }

      try {
        return await sendAgentMessage(targetSessionId, { content, whenBusy })
      } catch (error) {
        // Avoid leaving behind ghost empty/unused sessions if the first send fails immediately.
        if (createdFreshSessionId !== null) {
          await deleteAgentSession(createdFreshSessionId).catch(() => undefined)
        }
        throw error
      }
    },
    onSuccess: (updated) => {
      setActionError(null)
      setComposingNewSession(false)
      setPendingBranchEdit(null)
      setDraftCustomInstructions(null)
      setDraftAutoCompact(true)
      upsertSessionSummary(updated.session)
      setSelectedSessionId(updated.session.sessionId)
      setLiveDetail(updated)
      queryClient.setQueryData(['agent-session-detail', updated.session.sessionId], updated)
      refreshSessions()
    },
    onError: (error) => setActionError(mapError(error)),
  })

  const recallQueueMutation = useMutation({
    mutationFn: (submissionId: number) => recallQueuedAgentInput(selectedSessionId!, submissionId),
    onSuccess: ({ content, detail }) => {
      setActionError(null)
      setLiveDetail(detail)
      queryClient.setQueryData(['agent-session-detail', detail.session.sessionId], detail)
      if (content.trim().length > 0) {
        setComposerText(prev => (prev.trim().length > 0 ? `${content}\n${prev}` : content))
        focusComposer()
      }
    },
    onError: (error) => setActionError(mapError(error)),
  })

  const stopMutation = useMutation({
    mutationFn: () => stopAgentSession(selectedSessionId!),
    onSuccess: (updated) => {
      setLiveDetail(updated)
      queryClient.setQueryData(['agent-session-detail', updated.session.sessionId], updated)
      refreshSessions()
    },
    onError: (error) => setActionError(mapError(error)),
  })

  const retryMutation = useMutation({
    mutationFn: () => retryLatestAgentMessage(selectedSessionId!),
    onSuccess: (updated) => {
      setActionError(null)
      setLiveDetail(updated)
      queryClient.setQueryData(['agent-session-detail', updated.session.sessionId], updated)
      refreshSessions()
    },
    onError: (error) => setActionError(mapError(error)),
  })

  const updateSettingsMutation = useMutation({
    mutationFn: ({
      sessionId,
      customInstructions,
      autoCompact,
    }: {
      sessionId: string
      customInstructions?: string | null
      autoCompact?: boolean
    }) => updateAgentSession(sessionId, {
      ...(customInstructions === undefined ? {} : { customInstructions }),
      ...(autoCompact === undefined ? {} : { autoCompact }),
    }),
    onSuccess: ({ session: updated }) => {
      setActionError(null)
      upsertSessionSummary(updated)
      setLiveDetail(current =>
        current !== null && current.session.sessionId === updated.sessionId
          ? { ...current, session: updated }
          : current,
      )
      queryClient.setQueryData(
        ['agent-session-detail', updated.sessionId],
        (current: AgentSessionDetail | undefined) =>
          current === undefined ? current : { ...current, session: updated },
      )
      flashNotice(zh ? '已保存会话配置。' : 'Session settings saved.')
    },
    onError: (error) => setActionError(mapError(error)),
  })

  const compactMutation = useMutation({
    mutationFn: () => compactAgentSession(selectedSessionId!, {}),
    onSuccess: (updated) => {
      setActionError(null)
      setLiveDetail(updated)
      queryClient.setQueryData(['agent-session-detail', updated.session.sessionId], updated)
      void queryClient.invalidateQueries({ queryKey: ['agent-session-context', updated.session.sessionId] })
      flashNotice(zh ? '上下文压缩完成。' : 'Context compacted.')
    },
    onError: (error) => setActionError(mapError(error)),
  })

  const resetMutation = useMutation({
    mutationFn: () => resetAgentSession(selectedSessionId!, {}),
    onSuccess: (updated) => {
      setActionError(null)
      setLiveDetail(updated)
      queryClient.setQueryData(['agent-session-detail', updated.session.sessionId], updated)
      void queryClient.invalidateQueries({ queryKey: ['agent-session-context', updated.session.sessionId] })
      flashNotice(zh ? '上下文窗口已重置。' : 'Context window reset.')
    },
    onError: (error) => setActionError(mapError(error)),
  })

  const exportMutation = useMutation({
    mutationFn: (sessionId: string) => exportAgentSession(sessionId),
    onSuccess: async (result) => {
      setActionError(null)
      try {
        await navigator.clipboard?.writeText(result.markdown)
      } catch {
        // Ignore clipboard errors in headless environments.
      }
      try {
        if (typeof Blob !== 'undefined' && typeof URL.createObjectURL === 'function') {
          const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' })
          const objectUrl = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = objectUrl
          link.download = result.filename
          link.style.display = 'none'
          document.body.appendChild(link)
          link.click()
          link.remove()
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000)
        }
      } catch {
        // Ignore file download issues in JSDOM/restricted contexts.
      }
      flashNotice(zh ? `已复制并导出 ${result.filename}` : `Copied & exported ${result.filename}`)
    },
    onError: (error) => setActionError(mapError(error)),
  })

  const renameMutation = useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) =>
      renameAgentSession(sessionId, title),
    onSuccess: ({ session: renamed }) => {
      setActionError(null)
      upsertSessionSummary(renamed)
      setLiveDetail(current =>
        current !== null && current.session.sessionId === renamed.sessionId
          ? { ...current, session: renamed }
          : current,
      )
      refreshSessions()
    },
    onError: (error) => setActionError(mapError(error)),
  })

  const forkMutation = useMutation({
    mutationFn: ({
      sourceSessionId,
      atEntryId,
    }: {
      sourceSessionId: string
      atEntryId?: number
    }) => forkAgentSession(sourceSessionId, atEntryId === undefined ? {} : { atEntryId }),
    onSuccess: (forked) => {
      setActionError(null)
      setComposingNewSession(false)
      setPendingBranchEdit(null)
      upsertSessionSummary(forked.session)
      setSelectedSessionId(forked.session.sessionId)
      setLiveDetail(forked)
      queryClient.setQueryData(['agent-session-detail', forked.session.sessionId], forked)
      refreshSessions()
    },
    onError: (error) => setActionError(mapError(error)),
  })

  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => deleteAgentSession(sessionId),
    onSuccess: (_data, deletedId) => {
      setActionError(null)
      if (selectedSessionId === deletedId) {
        setComposingNewSession(false)
        setSelectedSessionId(null)
        setLiveDetail(null)
        setPendingBranchEdit(null)
        setContextOpen(false)
        setSideChatOpen(false)
      }
      refreshSessions()
    },
    onError: (error) => setActionError(mapError(error)),
  })

  const composeOutgoingMessage = useCallback((rawText: string): string => {
    const sections: string[] = []
    if (attachedEntities.length > 0) {
      sections.push(
        attachedEntities
          .map(entity => `[临床引用: ${entity.label}]\n${entity.detailText}`)
          .join('\n\n'),
      )
    }
    if (quotedText !== null && quotedText.trim().length > 0) {
      const quotedLines = quotedText
        .trim()
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n')
      sections.push(quotedLines)
    }
    const trimmed = rawText.trim()
    if (trimmed.length > 0) {
      sections.push(trimmed)
    }
    return sections.join('\n\n').trim()
  }, [attachedEntities, quotedText])

  const sendPrompt = useCallback((text: string, mode: ComposerSendMode = 'reject') => {
    const trimmed = text.trim()
    if (trimmed.length === 0 || sendMutation.isPending) return
    if (isRunning && mode === 'reject') return
    const activeBranchEdit = pendingBranchEdit
    setComposerText('')
    setQuotedText(null)
    setAttachedEntities([])
    setSelectedPassage(null)
    sendMutation.mutate({ content: trimmed, whenBusy: mode, branchEdit: activeBranchEdit })
  }, [isRunning, pendingBranchEdit, sendMutation])

  const handleSend = useCallback((mode?: ComposerSendMode) => {
    const composed = composeOutgoingMessage(composerText)
    if (composed.length === 0) return
    sendPrompt(composed, mode ?? (isRunning ? 'followUp' : 'reject'))
  }, [composeOutgoingMessage, composerText, isRunning, sendPrompt])

  const handleEditAndBranch = useCallback((userMessage: AgentSessionMessage) => {
    if (selectedSessionId === null) return
    const promptText = extractMessagePlainText(userMessage)
    const rawMessages = activeDetail?.messages ?? []
    const idx = rawMessages.findIndex(item => item.id === userMessage.id)
    let prevEntryId: number | null = null
    let turnIndex = 0
    for (let i = 0; i <= idx; i += 1) {
      if (rawMessages[i]?.role === 'user') turnIndex += 1
    }
    for (let i = idx - 1; i >= 0; i -= 1) {
      const candidate = rawMessages[i]?.entryId
      if (candidate !== null && candidate !== undefined) {
        prevEntryId = candidate
        break
      }
    }
    setPendingBranchEdit({
      sourceSessionId: selectedSessionId,
      sourceMessageId: userMessage.id,
      atEntryId: prevEntryId,
      turnIndex: Math.max(1, turnIndex),
      previousDraft: pendingBranchEdit ? pendingBranchEdit.previousDraft : composerText,
      customInstructions: activeDetail?.session.customInstructions ?? null,
      autoCompact: activeDetail?.session.autoCompact ?? true,
    })
    setComposerText(promptText)
    setActionError(null)
    focusComposer()
  }, [activeDetail?.messages, activeDetail?.session.autoCompact, activeDetail?.session.customInstructions, composerText, focusComposer, pendingBranchEdit, selectedSessionId])

  const handleCancelBranchEdit = useCallback(() => {
    if (pendingBranchEdit === null) return
    setComposerText(pendingBranchEdit.previousDraft)
    setPendingBranchEdit(null)
    focusComposer()
  }, [focusComposer, pendingBranchEdit])

  const openSideChatOverlay = useCallback((options?: { quote?: string | null; question?: string | null }) => {
    setContextOpen(false)
    setSelectedPassage(null)
    if (options?.quote !== undefined) {
      setSideChatQuote(options.quote)
    }
    if (options?.question !== undefined) {
      setSideChatQuestion(options.question)
    }
    setSideChatNonce(prev => prev + 1)
    setSideChatOpen(true)
  }, [])

  const openContextInspectorOverlay = useCallback((callId: string | null = null) => {
    setSideChatOpen(false)
    setInspectCallId(callId)
    setContextOpen(true)
  }, [])

  const commitWidth = useCallback((nextWidth: number) => {
    const clamped = clampSidebarWidth(nextWidth)
    setSidebarWidth(clamped)
    try {
      window.localStorage.setItem(WIDTH_STORAGE_KEY, String(clamped))
    } catch {
      // Ignore storage errors.
    }
  }, [])

  const effectiveWidth = wideMode
    ? clampSidebarWidth(typeof window !== 'undefined' ? Math.max(540, Math.round(window.innerWidth * 0.48)) : 600)
    : sidebarWidth

  const displayedError = actionError ?? activeDetail?.session.lastError ?? null
  const showSettingsLink = displayedError !== null && PROVIDER_CONFIG_ERROR_CODES.has(displayedError.code)
  const groupedMessages = useMemo(
    () => groupConversationMessages(activeDetail?.messages ?? []),
    [activeDetail?.messages],
  )
  const userTurns = useMemo(
    () => groupedMessages
      .filter(msg => msg.role === 'user')
      .map((msg, index) => ({
        id: msg.id,
        index: index + 1,
        preview: extractMessagePlainText(msg).replace(/\s+/g, ' ').slice(0, 64),
      })),
    [groupedMessages],
  )
  const latestAssistantId = useMemo(() => {
    for (let i = groupedMessages.length - 1; i >= 0; i -= 1) {
      if (groupedMessages[i]?.role === 'assistant') return groupedMessages[i]!.id
    }
    return null
  }, [groupedMessages])

  const autoCompactEnabled = selectedSessionId !== null
    ? (activeDetail?.session.autoCompact ?? true)
    : draftAutoCompact
  const effectiveCustomInstructions = selectedSessionId !== null
    ? (activeDetail?.session.customInstructions ?? null)
    : draftCustomInstructions
  const hasMessages = (activeDetail?.messages.length ?? 0) > 0
  const queuedInputs = activeDetail?.queuedInputs ?? []
  const retryState = activeDetail?.retryState ?? null
  const compactionActive = Boolean(activeDetail?.compactionState?.active)
  const clinicalEntities = clinicalEntitiesQuery.data?.entities ?? []

  if (!open) {
    if (!isRunning) return null
    return (
      <div className="fixed right-3 bottom-3 z-20">
        <Button
          aria-label={zh ? '临床助手正在生成，点击展开' : 'Clinician assistant is running, click to expand'}
          className="gap-2 rounded-full shadow-md"
          onClick={onExpand}
          size="sm"
          type="button"
          variant="secondary"
        >
          <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
          <span>{zh ? '助手生成中…' : 'Assistant running…'}</span>
        </Button>
      </div>
    )
  }

  return (
    <>
      <ContextInspectorOverlay
        autoCompact={autoCompactEnabled}
        compactPending={compactMutation.isPending}
        initialSelectedCallId={inspectCallId}
        latestContextCall={activeDetail?.latestContextCall ?? null}
        onClose={() => setContextOpen(false)}
        onCompact={() => {
          if (selectedSessionId !== null && hasMessages && !isRunning) {
            compactMutation.mutate()
          } else {
            flashNotice(zh ? '当前会话尚无对话内容或正在生成，暂不可压缩。' : 'No completed turns to compact yet.')
          }
        }}
        onReset={() => {
          if (selectedSessionId !== null && hasMessages && !isRunning) {
            resetMutation.mutate()
          } else {
            flashNotice(zh ? '当前会话尚无对话内容或正在生成，暂无需重置。' : 'No active turns to reset yet.')
          }
        }}
        onToggleAutoCompact={(enabled) => {
          if (selectedSessionId !== null) {
            updateSettingsMutation.mutate({ sessionId: selectedSessionId, autoCompact: enabled })
          } else {
            setDraftAutoCompact(enabled)
          }
        }}
        open={contextOpen}
        resetPending={resetMutation.isPending}
        sessionId={selectedSessionId}
        sessionTitle={activeDetail?.session.title}
        sidebarWidth={effectiveWidth}
        zh={zh}
      />

      <AssistantSideChat
        caseId={activeEncounter.caseId}
        encounterId={activeEncounter.encounterId}
        initialQuestion={sideChatQuestion}
        initialQuote={sideChatQuote}
        onClose={() => setSideChatOpen(false)}
        onInsertToMain={(text) => {
          setComposerText(prev => (prev.trim().length > 0 ? `${prev.trim()}\n\n${text}` : text))
          setSideChatOpen(false)
          focusComposer()
        }}
        open={sideChatOpen}
        openNonce={sideChatNonce}
        sessionId={selectedSessionId}
        sidebarWidth={effectiveWidth}
        zh={zh}
      />

      <aside
        aria-label={zh ? '临床助手侧栏' : 'Clinician Assistant sidebar'}
        className="cm-assistant-sidebar"
        data-clinmesh-assistant-sidebar=""
        data-wide={wideMode ? 'true' : 'false'}
        ref={sidebarRef}
        style={{ width: `${effectiveWidth}px` }}
      >
        <div
          aria-label={zh ? '调整临床助手侧栏宽度' : 'Resize clinician assistant sidebar'}
          aria-orientation="vertical"
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuenow={effectiveWidth}
          className="cm-assistant-resizer"
          data-resizing={resizing ? 'true' : 'false'}
          onDoubleClick={() => {
            setWideMode(false)
            commitWidth(DEFAULT_SIDEBAR_WIDTH)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              setWideMode(false)
              commitWidth(effectiveWidth + 24)
            } else if (event.key === 'ArrowRight') {
              event.preventDefault()
              setWideMode(false)
              commitWidth(effectiveWidth - 24)
            }
          }}
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture?.(event.pointerId)
            dragStartRef.current = { x: event.clientX, width: effectiveWidth }
            setWideMode(false)
            setResizing(true)
          }}
          onPointerMove={(event) => {
            if (dragStartRef.current === null) return
            const deltaX = dragStartRef.current.x - event.clientX
            setSidebarWidth(clampSidebarWidth(dragStartRef.current.width + deltaX))
          }}
          onPointerUp={(event) => {
            if (dragStartRef.current === null) return
            const deltaX = dragStartRef.current.x - event.clientX
            commitWidth(dragStartRef.current.width + deltaX)
            dragStartRef.current = null
            setResizing(false)
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          }}
          role="separator"
          tabIndex={0}
        />

        {/* Single calm 48px Claude Desktop-style header */}
        <header className="flex h-12 shrink-0 items-center justify-between gap-1.5 border-b border-border px-3">
          <div className="flex min-w-0 items-center gap-2">
            {isRunning ? (
              <span aria-hidden="true" className="cm-assistant-running-dot" />
            ) : (
              <BotIcon aria-hidden="true" className="size-4 shrink-0 text-foreground/80" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span
                  className="truncate text-sm font-semibold text-foreground"
                  data-testid="assistant-session-title"
                >
                  {activeDetail?.session.title ?? (zh ? '临床助手' : 'Clinician Assistant')}
                </span>
                {activeDetail?.session.forkedFromSessionId ? (
                  <Badge className="shrink-0 px-1.5 py-0 text-[0.625rem]" variant="outline">
                    {zh ? '分支' : 'Branch'}
                  </Badge>
                ) : null}
              </div>
            </div>
            {activeEncounter.patientName ? (
              <Badge className="max-w-20 shrink-0 truncate text-[0.6875rem]" variant="secondary">
                {activeEncounter.patientName}
              </Badge>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {userTurns.length >= 2 ? (
              <Popover onOpenChange={setMinimapOpen} open={minimapOpen}>
                <PopoverTrigger
                  render={(
                    <Button
                      aria-label={zh ? '轮次快速跳转目录' : 'Turn navigation minimap'}
                      data-testid="assistant-minimap-trigger"
                      size="icon-sm"
                      title={zh ? '轮次目录' : 'Turn outline'}
                      type="button"
                      variant="ghost"
                    />
                  )}
                >
                  <ListTreeIcon aria-hidden="true" className="size-4" />
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-2" data-testid="assistant-minimap-popover">
                  <PopoverTitle className="mb-1.5 px-1.5 text-xs font-semibold">
                    {zh ? `对话轮次导航（${userTurns.length}）` : `Turns (${userTurns.length})`}
                  </PopoverTitle>
                  <div className="cm-assistant-scroll flex max-h-60 flex-col gap-0.5 overflow-y-auto">
                    {userTurns.map(turn => (
                      <Button
                        aria-label={zh ? `跳转到第 ${turn.index} 轮：${turn.preview}` : `Jump to turn ${turn.index}: ${turn.preview}`}
                        className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left text-xs font-normal"
                        data-testid={`assistant-minimap-turn-${turn.index}`}
                        key={turn.id}
                        onClick={() => {
                          const target = sidebarRef.current?.querySelector(`[data-turn-anchor="${turn.id}"]`)
                          if (target && typeof target.scrollIntoView === 'function') {
                            target.scrollIntoView({ behavior: 'smooth', block: 'start' })
                          }
                          setMinimapOpen(false)
                        }}
                        size="xs"
                        type="button"
                        variant="ghost"
                      >
                        <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
                          {turn.index}.
                        </span>
                        <span className="truncate text-foreground">{turn.preview}</span>
                      </Button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            ) : null}

            <AssistantPreferencesMenu
              autoCompact={autoCompactEnabled}
              customInstructions={effectiveCustomInstructions}
              onOpenOverrideChange={setPreferencesOpen}
              onSaveSessionSettings={(input) => {
                if (selectedSessionId !== null) {
                  updateSettingsMutation.mutate({
                    sessionId: selectedSessionId,
                    ...input,
                  })
                } else {
                  if (input.customInstructions !== undefined) {
                    setDraftCustomInstructions(input.customInstructions)
                  }
                  if (input.autoCompact !== undefined) {
                    setDraftAutoCompact(input.autoCompact)
                  }
                  flashNotice(zh ? '已保存新会话默认配置，将在发送首条消息时生效。' : 'Saved for your next new conversation.')
                }
              }}
              openOverride={preferencesOpen}
              savePending={updateSettingsMutation.isPending}
              sessionId={selectedSessionId}
              zh={zh}
            />

            <AssistantHistoryMenu
              createPending={false}
              deletePending={deleteMutation.isPending}
              encounterId={activeEncounter.encounterId}
              exportPending={exportMutation.isPending}
              forkPending={forkMutation.isPending}
              onCreateSession={startNewDraftSession}
              onDeleteSession={sessionId => deleteMutation.mutate(sessionId)}
              onExportSession={sessionId => exportMutation.mutate(sessionId)}
              onForkSession={sessionId => forkMutation.mutate({ sourceSessionId: sessionId })}
              onRenameSession={(sessionId, title) => renameMutation.mutate({ sessionId, title })}
              onSelectSession={selectExistingSession}
              renamePending={renameMutation.isPending}
              selectedSessionId={selectedSessionId}
              sessions={sessions}
              zh={zh}
            />

            <Button
              aria-label={zh ? '新建助手会话' : 'New assistant session'}
              onClick={startNewDraftSession}
              size="icon-sm"
              title={zh ? '新建对话' : 'New conversation'}
              type="button"
              variant="ghost"
            >
              <MessageSquarePlusIcon aria-hidden="true" className="size-4" />
            </Button>

            <Button
              aria-label={zh ? '从当前会话创建分支' : 'Fork current session'}
              disabled={activeDetail === null || !hasMessages || isRunning || forkMutation.isPending}
              onClick={() => {
                if (activeDetail !== null) {
                  forkMutation.mutate({ sourceSessionId: activeDetail.session.sessionId })
                }
              }}
              size="icon-sm"
              title={zh ? '创建对话分支' : 'Fork conversation'}
              type="button"
              variant="ghost"
            >
              <GitForkIcon aria-hidden="true" className="size-4" />
            </Button>

            <Button
              aria-label={wideMode ? (zh ? '恢复标准宽度' : 'Restore standard width') : (zh ? '宽屏阅读模式' : 'Wide reading mode')}
              aria-pressed={wideMode}
              onClick={() => setWideMode(prev => !prev)}
              size="icon-sm"
              title={wideMode ? (zh ? '标准宽度' : 'Standard width') : (zh ? '宽屏模式' : 'Wide mode')}
              type="button"
              variant="ghost"
            >
              {wideMode ? (
                <Minimize2Icon aria-hidden="true" className="size-3.5" />
              ) : (
                <Maximize2Icon aria-hidden="true" className="size-3.5" />
              )}
            </Button>

            <Button
              aria-label={zh ? '收起临床助手' : 'Collapse clinician assistant'}
              onClick={onCollapse}
              size="icon-sm"
              title={zh ? '收起助手' : 'Collapse assistant'}
              type="button"
              variant="ghost"
            >
              <PanelRightCloseIcon aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </header>

        {/* Continuous Claude Desktop-style conversation stream */}
        <div className="flex min-h-0 flex-1 flex-col">
          <MessageScrollerProvider autoScroll>
            <MessageScroller className="min-h-0 flex-1">
              <MessageScrollerViewport className="cm-assistant-scroll">
                <MessageScrollerContent className="gap-5 px-4 py-4">
                  {groupedMessages.length === 0 ? (
                    <MessageScrollerItem messageId="assistant-empty">
                      <div className="flex flex-col items-start gap-4 py-6">
                        <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted/60 text-foreground">
                          <SparklesIcon aria-hidden="true" className="size-5" />
                        </div>
                        <div className="space-y-1.5">
                          <h2 className="text-base font-semibold text-foreground">
                            {zh ? '临床助手已就绪' : 'Clinician Assistant Ready'}
                          </h2>
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {activeEncounter.patientName
                              ? (zh
                                  ? `已绑定当前接诊（${activeEncounter.patientName}）。仅读取医生可见临床信息，不接触未公开的隐藏病例真值。`
                                  : `Bound to current encounter (${activeEncounter.patientName}). Reads clinician-visible data only.`)
                              : (zh
                                  ? '支持鉴别诊断思路、病历整理、检查与用药安全提醒；打开门诊或住院病例后会自动隔离绑定至当前接诊。'
                                  : 'Ask for differential diagnosis, charting help, or safety checklists. Opening a case isolates sessions per encounter.')}
                          </p>
                        </div>

                        <div className="flex w-full flex-col gap-1.5 pt-1">
                          {STARTER_PROMPTS.map(item => (
                            <Button
                              className="h-auto justify-start rounded-xl border border-border/80 bg-background px-3 py-2 text-left text-xs font-normal text-foreground hover:bg-accent/50"
                              data-testid={`assistant-starter-${item.id}`}
                              disabled={isRunning || sendMutation.isPending}
                              key={item.id}
                              onClick={() => sendPrompt(zh ? item.zhPrompt : item.enPrompt)}
                              type="button"
                              variant="ghost"
                            >
                              <span className="truncate">{zh ? item.zhLabel : item.enLabel}</span>
                            </Button>
                          ))}
                        </div>
                      </div>
                    </MessageScrollerItem>
                  ) : groupedMessages.map(message => (
                    <MessageScrollerItem
                      key={message.id}
                      messageId={message.id}
                      scrollAnchor={message.role === 'user'}
                    >
                      <AssistantTurnView
                        canRetry={Boolean(activeDetail?.canRetryLatest && !isRunning)}
                        forkPending={forkMutation.isPending}
                        isEditingBranch={pendingBranchEdit?.sourceMessageId === message.id}
                        isLatestAssistant={message.id === latestAssistantId}
                        isRunning={isRunning}
                        message={message}
                        onEditAndBranch={handleEditAndBranch}
                        onForkAtEntry={(entryId) => {
                          if (selectedSessionId !== null) {
                            forkMutation.mutate({ sourceSessionId: selectedSessionId, atEntryId: entryId })
                          }
                        }}
                        onInspectCall={callId => openContextInspectorOverlay(callId)}
                        onQuoteText={(text) => {
                          setQuotedText(text)
                          setSelectedPassage(null)
                          focusComposer()
                        }}
                        onRetry={() => retryMutation.mutate()}
                        onSideChatQuote={text => openSideChatOverlay({ quote: text })}
                        onTextSelection={selected => setSelectedPassage(selected)}
                        retryPending={retryMutation.isPending}
                        showLiveThinking={llmSettings.showLiveThinking}
                        zh={zh}
                      />
                    </MessageScrollerItem>
                  ))}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>
        </div>

        {/* Bottom Status Banners + Selected-Text Quote Bar + Error Alert + Composer */}
        <div className="flex shrink-0 flex-col gap-2 border-t border-border/70 bg-card px-3 pt-2.5 pb-3">
          {compactionActive ? (
            <div
              className="flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground"
              data-testid="assistant-compaction-banner"
              role="status"
            >
              <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin text-info" />
              <span>{zh ? '正在自动压缩早期上下文…' : 'Compacting earlier context…'}</span>
            </div>
          ) : null}

          {retryState !== null ? (
            <RetryCountdownBanner
              onRetryNow={() => retryMutation.mutate()}
              retryPending={retryMutation.isPending}
              retryState={retryState}
              zh={zh}
            />
          ) : null}

          {selectedPassage !== null ? (
            <div className="cm-selection-quote-bar" data-testid="assistant-selection-bar">
              <span className="truncate text-muted-foreground">
                {zh ? `已选中：${selectedPassage.slice(0, 40)}` : `Selected: ${selectedPassage.slice(0, 40)}`}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  aria-label={zh ? '引用选中片段到输入框' : 'Quote selection into composer'}
                  className="h-6 px-1.5 text-[0.6875rem]"
                  data-testid="assistant-selection-quote"
                  onClick={() => {
                    setQuotedText(selectedPassage)
                    setSelectedPassage(null)
                    focusComposer()
                  }}
                  size="xs"
                  type="button"
                  variant="secondary"
                >
                  {zh ? '引用' : 'Quote'}
                </Button>
                <Button
                  aria-label={zh ? '针对选中片段侧边追问' : 'Side chat on selection'}
                  className="h-6 px-1.5 text-[0.6875rem]"
                  data-testid="assistant-selection-side"
                  onClick={() => openSideChatOverlay({ quote: selectedPassage })}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  {zh ? '侧边追问' : 'Side chat'}
                </Button>
                <Button
                  aria-label={zh ? '取消文本选中操作条' : 'Dismiss selection bar'}
                  onClick={() => setSelectedPassage(null)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
            </div>
          ) : null}

          {statusNotice !== null ? (
            <div
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1 text-xs text-foreground"
              data-testid="assistant-status-notice"
              role="status"
            >
              <span className="truncate">{statusNotice}</span>
              <Button
                aria-label={zh ? '关闭提示信息' : 'Dismiss status notice'}
                onClick={() => setStatusNotice(null)}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <XIcon aria-hidden="true" />
              </Button>
            </div>
          ) : null}

          {displayedError !== null ? (
            <Alert variant="destructive">
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>{zh ? '模型调用受阻' : 'Model Request Failed'}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{displayedError.message}</p>
                {showSettingsLink ? (
                  <Button render={<Link to="/settings/models" />} size="sm" variant="outline">
                    <SettingsIcon aria-hidden="true" data-icon="inline-start" />
                    {zh ? '前往模型与服务商设置' : 'Open Models & Provider settings'}
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          <AssistantComposer
            attachedEntities={attachedEntities}
            catalog={catalogQuery.data}
            catalogFetching={catalogQuery.isFetching}
            clinicalEntities={clinicalEntities}
            contextInspectorOpen={contextOpen}
            isRunning={isRunning}
            latestContextCall={activeDetail?.latestContextCall ?? null}
            onAttachEntity={(entity) => {
              setAttachedEntities(prev => (prev.some(item => item.id === entity.id) ? prev : [...prev, entity]))
            }}
            onCancelBranchEdit={handleCancelBranchEdit}
            onChange={setComposerText}
            onClearQuote={() => setQuotedText(null)}
            onCompact={() => {
              if (selectedSessionId !== null && hasMessages && !isRunning) {
                compactMutation.mutate()
              } else {
                flashNotice(zh ? '当前会话尚无对话内容或正在生成，暂不可压缩。' : 'No completed turns to compact yet.')
              }
            }}
            onExport={() => {
              if (selectedSessionId !== null && hasMessages) {
                exportMutation.mutate(selectedSessionId)
              } else {
                flashNotice(zh ? '当前会话尚无内容可导出。' : 'No active messages to export.')
              }
            }}
            onOpenContextInspector={() => {
              if (contextOpen) {
                setContextOpen(false)
              } else {
                openContextInspectorOverlay(null)
              }
            }}
            onOpenInstructions={() => setPreferencesOpen(true)}
            onOpenSideChat={(question) => openSideChatOverlay({ question: question ?? null })}
            onRecallQueuedInput={submissionId => recallQueueMutation.mutate(submissionId)}
            onRefreshCatalog={refreshCatalog}
            onRemoveEntity={entityId => setAttachedEntities(prev => prev.filter(item => item.id !== entityId))}
            onReset={() => {
              if (selectedSessionId !== null && hasMessages && !isRunning) {
                resetMutation.mutate()
              } else {
                flashNotice(zh ? '当前会话尚无对话内容或正在生成，暂无需重置。' : 'No active turns to reset yet.')
              }
            }}
            onSend={handleSend}
            onStop={() => stopMutation.mutate()}
            pendingBranchEdit={pendingBranchEdit ? { turnIndex: pendingBranchEdit.turnIndex } : null}
            queuedInputs={queuedInputs}
            quotedText={quotedText}
            recallPending={recallQueueMutation.isPending}
            sendPending={sendMutation.isPending}
            stopPending={stopMutation.isPending}
            textareaRef={composerTextareaRef}
            value={composerText}
            zh={zh}
          />
        </div>
      </aside>
    </>
  )
}
