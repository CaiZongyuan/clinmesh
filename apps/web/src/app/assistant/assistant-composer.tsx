import type {
  AgentQueuedInput,
  ClinicalEntityMention,
  LlmProviderCatalogResponse,
  ModelCallSummary,
} from '@clinmesh/contracts/agent-sessions'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Textarea } from '@clinmesh/ui/components/textarea'
import {
  ArrowUpIcon,
  AtSignIcon,
  BookMarkedIcon,
  CornerDownRightIcon,
  DownloadIcon,
  GitForkIcon,
  LayersIcon,
  MessageSquareQuoteIcon,
  Minimize2Icon,
  RotateCcwIcon,
  SendHorizontalIcon,
  SquareIcon,
  Undo2Icon,
  XIcon,
} from 'lucide-react'
import { type RefObject, useMemo, useState } from 'react'
import { AssistantModelPicker } from './assistant-model-picker.tsx'
import { AssistantThinkingPicker } from './assistant-thinking-picker.tsx'
import { ContextOccupancyRing } from './context-occupancy-ring.tsx'

export type ComposerSendMode = 'reject' | 'steer' | 'followUp'

interface SlashCommandDef {
  command: '/context' | '/compact' | '/reset' | '/side' | '/instructions' | '/export'
  zhDesc: string
  enDesc: string
}

const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    command: '/context',
    zhDesc: '打开上下文检查器（窗口占比与逐次调用明细）',
    enDesc: 'Open Context Inspector (window usage & call snapshots)',
  },
  {
    command: '/compact',
    zhDesc: '立即手动压缩早期对话上下文（默认已开启自动压缩）',
    enDesc: 'Manually compact earlier turns (auto-compact is on by default)',
  },
  {
    command: '/reset',
    zhDesc: '重置当前上下文窗口并保留历史分隔线',
    enDesc: 'Reset active context window with a fresh boundary',
  },
  {
    command: '/side',
    zhDesc: '打开侧边轻追问（不污染主对话上下文，可后接问题）',
    enDesc: 'Open ephemeral Side Chat without polluting main context',
  },
  {
    command: '/instructions',
    zhDesc: '编辑当前会话临床指令与医生长期偏好记忆',
    enDesc: 'Edit session clinical instructions & clinician memory',
  },
  {
    command: '/export',
    zhDesc: '导出当前会话为 Markdown 临床交接草稿并复制',
    enDesc: 'Export session as Markdown clinical handoff & copy',
  },
] as const

function renderSlashIcon(command: SlashCommandDef['command']) {
  switch (command) {
    case '/context':
      return <LayersIcon aria-hidden="true" className="size-3.5 text-info" />
    case '/compact':
      return <Minimize2Icon aria-hidden="true" className="size-3.5 text-warning" />
    case '/reset':
      return <RotateCcwIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
    case '/side':
      return <MessageSquareQuoteIcon aria-hidden="true" className="size-3.5 text-info" />
    case '/instructions':
      return <BookMarkedIcon aria-hidden="true" className="size-3.5 text-foreground" />
    case '/export':
      return <DownloadIcon aria-hidden="true" className="size-3.5 text-success" />
  }
}

export interface AssistantComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: (mode?: ComposerSendMode) => void
  onStop: () => void
  onOpenContextInspector: () => void
  onCompact: () => void
  onReset: () => void
  onOpenSideChat: (initialQuestion?: string) => void
  onOpenInstructions: () => void
  onExport: () => void
  contextInspectorOpen: boolean
  latestContextCall?: ModelCallSummary | null | undefined
  catalog: LlmProviderCatalogResponse | undefined
  catalogFetching: boolean
  onRefreshCatalog: () => void
  queuedInputs: readonly AgentQueuedInput[]
  onRecallQueuedInput: (submissionId: number) => void
  recallPending: boolean
  quotedText: string | null
  onClearQuote: () => void
  pendingBranchEdit?: { turnIndex: number } | null
  onCancelBranchEdit?: () => void
  textareaRef?: RefObject<HTMLTextAreaElement | null>
  clinicalEntities: readonly ClinicalEntityMention[]
  attachedEntities: readonly ClinicalEntityMention[]
  onAttachEntity: (entity: ClinicalEntityMention) => void
  onRemoveEntity: (entityId: string) => void
  isRunning: boolean
  sendPending: boolean
  stopPending: boolean
  zh: boolean
}

/**
 * Claude Desktop-style cohesive rounded composer with:
 * - Inline click-to-switch Model Picker & Thinking Effort/Mode Picker
 * - Slash commands (/context, /compact, /reset, /side, /instructions, /export)
 * - `@` clinician-visible clinical entity mention autocomplete & removable chips
 * - Selected-text quote chip
 * - Always-enabled textarea while streaming with Steer & Follow-Up Queue bar
 * - Circular ContextOccupancyRing and IME-safe Enter submission
 */
export function AssistantComposer({
  value,
  onChange,
  onSend,
  onStop,
  onOpenContextInspector,
  onCompact,
  onReset,
  onOpenSideChat,
  onOpenInstructions,
  onExport,
  contextInspectorOpen,
  latestContextCall,
  catalog,
  catalogFetching,
  onRefreshCatalog,
  queuedInputs,
  onRecallQueuedInput,
  recallPending,
  quotedText,
  onClearQuote,
  pendingBranchEdit = null,
  onCancelBranchEdit,
  textareaRef,
  clinicalEntities,
  attachedEntities,
  onAttachEntity,
  onRemoveEntity,
  isRunning,
  sendPending,
  stopPending,
  zh,
}: AssistantComposerProps): React.JSX.Element {
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false)
  const trimmed = value.trim()

  const matchedSlashCommands = useMemo(() => {
    if (!trimmed.startsWith('/') || trimmed.includes('\n')) return []
    const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase() ?? ''
    if (firstToken.length === 0) return []
    return SLASH_COMMANDS.filter(item => item.command.startsWith(firstToken))
  }, [trimmed])

  const trailingMentionMatch = useMemo(() => {
    if (clinicalEntities.length === 0) return null
    const match = /(?:^|\s)@([^\s@]*)$/.exec(value)
    return match ? (match[1] ?? '') : null
  }, [clinicalEntities.length, value])

  const availableMentionEntities = useMemo(() => {
    if (clinicalEntities.length === 0) return []
    const attachedIds = new Set(attachedEntities.map(item => item.id))
    const query = (trailingMentionMatch ?? '').trim().toLowerCase()
    return clinicalEntities.filter((entity) => {
      if (attachedIds.has(entity.id)) return false
      if (query.length === 0) return true
      return entity.label.toLowerCase().includes(query)
        || entity.summary.toLowerCase().includes(query)
        || entity.kind.toLowerCase().includes(query)
    })
  }, [attachedEntities, clinicalEntities, trailingMentionMatch])

  const showMentionMenu = (trailingMentionMatch !== null || mentionPickerOpen) && availableMentionEntities.length > 0

  const canSend = trimmed.length > 0
    || attachedEntities.length > 0
    || (quotedText !== null && quotedText.trim().length > 0)

  const runSlashCommand = (command: SlashCommandDef['command'], rawInput?: string) => {
    onChange('')
    setMentionPickerOpen(false)
    switch (command) {
      case '/context':
        onOpenContextInspector()
        return
      case '/compact':
        onCompact()
        return
      case '/reset':
        onReset()
        return
      case '/side': {
        const rest = rawInput ? rawInput.replace(/^\/side\s*/i, '').trim() : ''
        onOpenSideChat(rest.length > 0 ? rest : undefined)
        return
      }
      case '/instructions':
        onOpenInstructions()
        return
      case '/export':
        onExport()
    }
  }

  const handleSubmitIntent = (explicitMode?: ComposerSendMode) => {
    if (trimmed.startsWith('/') && !trimmed.includes('\n')) {
      const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase() ?? ''
      const exact = SLASH_COMMANDS.find(item => item.command === firstToken)
      if (exact !== undefined) {
        runSlashCommand(exact.command, trimmed)
        return
      }
      if (matchedSlashCommands.length === 1 && trimmed === firstToken) {
        runSlashCommand(matchedSlashCommands[0]!.command, trimmed)
        return
      }
    }
    if (!canSend || sendPending) return
    setMentionPickerOpen(false)
    const mode: ComposerSendMode = explicitMode ?? (isRunning ? 'followUp' : 'reject')
    onSend(mode)
  }

  const handleSelectMention = (entity: ClinicalEntityMention) => {
    if (trailingMentionMatch !== null) {
      const stripped = value.replace(/(^|\s)@[^\s@]*$/, '$1')
      onChange(stripped)
    }
    onAttachEntity(entity)
    setMentionPickerOpen(false)
  }

  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        handleSubmitIntent()
      }}
    >
      {/* Deferred Edit & Branch indicator (never persists a fork until the user sends) */}
      {pendingBranchEdit !== null ? (
        <div
          className="flex items-center justify-between gap-2 rounded-lg border border-info/40 bg-info/10 px-2.5 py-1.5 text-xs"
          data-testid="assistant-branch-edit-banner"
          role="status"
        >
          <div className="flex min-w-0 items-center gap-1.5 text-foreground">
            <GitForkIcon aria-hidden="true" className="size-3.5 shrink-0 text-info" />
            <span className="truncate">
              {zh
                ? `正在编辑第 ${pendingBranchEdit.turnIndex} 轮提问，发送后将从此处创建新分支`
                : `Editing turn #${pendingBranchEdit.turnIndex} — sending will create a new branch`}
            </span>
          </div>
          {onCancelBranchEdit !== undefined ? (
            <Button
              aria-label={zh ? '取消编辑并分支' : 'Cancel edit and branch'}
              className="h-5 shrink-0 px-1.5 text-[0.6875rem]"
              data-testid="assistant-branch-edit-cancel"
              onClick={onCancelBranchEdit}
              size="xs"
              type="button"
              variant="ghost"
            >
              {zh ? '取消' : 'Cancel'}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Queued Steer / Follow-Up inputs while streaming */}
      {queuedInputs.length > 0 ? (
        <div
          className="space-y-1 rounded-lg border border-border bg-muted/40 p-2"
          data-testid="assistant-queued-bar"
        >
          <div className="flex items-center justify-between text-[0.6875rem] text-muted-foreground">
            <span>{zh ? `待发送队列（${queuedInputs.length}）` : `Queued messages (${queuedInputs.length})`}</span>
          </div>
          {queuedInputs.map(item => (
            <div
              className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-background px-2 py-1 text-xs"
              data-testid={`assistant-queued-item-${item.submissionId}`}
              key={item.submissionId}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <Badge className="shrink-0 px-1.5 py-0 text-[0.625rem]" variant={item.mode === 'steer' ? 'default' : 'secondary'}>
                  {item.mode === 'steer'
                    ? (zh ? '引导' : 'Steer')
                    : (zh ? '排队' : 'Queue')}
                </Badge>
                <span className="truncate text-foreground">{item.content}</span>
              </div>
              <Button
                aria-label={zh ? `撤回并编辑排队消息：${item.content.slice(0, 24)}` : 'Recall and edit queued message'}
                className="h-5 shrink-0 gap-1 px-1.5 text-[0.6875rem]"
                data-testid="assistant-queued-recall"
                disabled={recallPending}
                onClick={() => onRecallQueuedInput(item.submissionId)}
                size="xs"
                type="button"
                variant="ghost"
              >
                <Undo2Icon aria-hidden="true" className="size-3" />
                <span>{zh ? '撤回' : 'Recall'}</span>
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {/* Slash Command Picker */}
      {matchedSlashCommands.length > 0 ? (
        <div
          className="flex flex-col gap-0.5 rounded-lg border border-border bg-popover p-1.5 text-xs shadow-xs"
          data-testid="assistant-slash-hint"
        >
          {matchedSlashCommands.map(item => (
            <Button
              aria-label={zh ? `执行 ${item.command}：${item.zhDesc}` : `Run ${item.command}: ${item.enDesc}`}
              className="h-7 w-full justify-start gap-2 px-2 text-xs"
              data-testid={`assistant-slash-${item.command.slice(1)}`}
              key={item.command}
              onClick={() => runSlashCommand(item.command, trimmed)}
              size="xs"
              type="button"
              variant="ghost"
            >
              {renderSlashIcon(item.command)}
              <code className="shrink-0 font-mono font-semibold text-foreground">{item.command}</code>
              <span className="truncate text-muted-foreground">
                {zh ? item.zhDesc : item.enDesc}
              </span>
            </Button>
          ))}
        </div>
      ) : null}

      {/* @ Clinical Entity Mention Menu */}
      {showMentionMenu ? (
        <div
          className="cm-assistant-scroll max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-border bg-popover p-1.5 text-xs shadow-xs"
          data-testid="assistant-mention-menu"
        >
          <div className="flex items-center justify-between px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
            <span>{zh ? '引用当前接诊的医生可见临床数据 (@)' : 'Attach clinician-visible data (@)'}</span>
            <Button
              aria-label={zh ? '关闭临床引用列表' : 'Close clinical mention menu'}
              onClick={() => setMentionPickerOpen(false)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <XIcon aria-hidden="true" />
            </Button>
          </div>
          {availableMentionEntities.map(entity => (
            <Button
              aria-label={zh ? `引用临床数据：${entity.label}` : `Attach clinical entity: ${entity.label}`}
              className="h-auto w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left"
              data-testid={`assistant-mention-option-${entity.id}`}
              key={entity.id}
              onClick={() => handleSelectMention(entity)}
              size="xs"
              type="button"
              variant="ghost"
            >
              <span className="flex w-full items-center gap-1.5">
                <AtSignIcon aria-hidden="true" className="size-3 shrink-0 text-info" />
                <span className="truncate font-medium text-foreground">{entity.label}</span>
              </span>
              {entity.summary.length > 0 ? (
                <span className="w-full truncate pl-4 text-[0.6875rem] text-muted-foreground">
                  {entity.summary}
                </span>
              ) : null}
            </Button>
          ))}
        </div>
      ) : null}

      {/* Main Composer Frame (explicitly outside InputGroup so Popover portals keep focus cleanly) */}
      <div className="flex flex-col rounded-xl border border-border bg-background shadow-xs transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
        {/* Quoted Passage Chip & Attached Clinical Entity Chips */}
        {(quotedText !== null && quotedText.trim().length > 0) || attachedEntities.length > 0 ? (
          <div className="flex flex-col gap-1.5 border-b border-border/60 px-2.5 pt-2 pb-1.5">
            {quotedText !== null && quotedText.trim().length > 0 ? (
              <div
                className="flex items-start justify-between gap-2 rounded-lg border border-border/80 bg-muted/40 px-2 py-1 text-xs"
                data-testid="assistant-quote-chip"
              >
                <div className="flex min-w-0 items-start gap-1.5">
                  <CornerDownRightIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-info" />
                  <span className="line-clamp-2 text-muted-foreground">{quotedText}</span>
                </div>
                <Button
                  aria-label={zh ? '清除引用片段' : 'Clear quoted passage'}
                  onClick={onClearQuote}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
            ) : null}

            {attachedEntities.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1">
                {attachedEntities.map(entity => (
                  <span
                    className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-secondary/70 py-0.5 pr-1 pl-2 text-[0.6875rem] text-secondary-foreground"
                    data-testid={`assistant-entity-chip-${entity.id}`}
                    key={entity.id}
                  >
                    <AtSignIcon aria-hidden="true" className="size-3 shrink-0 text-info" />
                    <span className="truncate">{entity.label}</span>
                    <Button
                      aria-label={zh ? `移除已引用的 ${entity.label}` : `Remove attached ${entity.label}`}
                      className="size-4 p-0"
                      onClick={() => onRemoveEntity(entity.id)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <XIcon aria-hidden="true" className="size-2.5" />
                    </Button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <Field className="gap-0">
          <FieldLabel className="sr-only" htmlFor="clinician-assistant-composer">
            {zh ? '向临床助手提问' : 'Ask clinician assistant'}
          </FieldLabel>
          <Textarea
            className="cm-assistant-scroll max-h-36 min-h-14 resize-none overflow-y-auto border-0 bg-transparent px-3 pt-2.5 pb-1 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
            disabled={sendPending}
            id="clinician-assistant-composer"
            maxLength={16_000}
            onChange={event => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                if (mentionPickerOpen) {
                  event.preventDefault()
                  setMentionPickerOpen(false)
                  return
                }
                if (pendingBranchEdit !== null && onCancelBranchEdit !== undefined) {
                  event.preventDefault()
                  onCancelBranchEdit()
                  return
                }
              }
              // IME-safe Enter submission (guards WebKit keyCode 229).
              if (event.key !== 'Enter' || event.shiftKey) return
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              event.preventDefault()
              if (isRunning) {
                handleSubmitIntent(event.ctrlKey || event.metaKey ? 'steer' : 'followUp')
              } else {
                handleSubmitIntent('reject')
              }
            }}
            placeholder={pendingBranchEdit !== null
              ? (zh
                  ? '修改提问内容后按 Enter 发送并创建新分支（Esc 取消）…'
                  : 'Edit prompt and press Enter to branch (Esc to cancel)…')
              : isRunning
                ? (zh
                    ? '生成中…可输入引导或排队消息（Enter 排队，Ctrl+Enter 引导）…'
                    : 'Streaming… type to queue (Enter) or steer (Ctrl+Enter)…')
                : (zh
                    ? '输入临床问题，@ 引用检验/影像，或 / 查看指令（Enter 发送）…'
                    : 'Ask a clinical question, @ attach clinical data, or / for commands…')}
            ref={textareaRef}
            value={value}
          />
        </Field>

        <div className="flex w-full min-w-0 items-center justify-between gap-1.5 px-2 pt-1 pb-2">
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            <AssistantModelPicker
              catalog={catalog}
              catalogFetching={catalogFetching}
              onRefreshCatalog={onRefreshCatalog}
              zh={zh}
            />
            <AssistantThinkingPicker
              catalog={catalog}
              zh={zh}
            />
            {clinicalEntities.length > 0 ? (
              <Button
                aria-label={zh ? '引用当前病例临床数据 (@)' : 'Attach clinical entity (@)'}
                aria-pressed={mentionPickerOpen}
                className="h-7 gap-0.5 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                data-testid="assistant-mention-trigger"
                onClick={() => setMentionPickerOpen(prev => !prev)}
                size="xs"
                title={zh ? '引用检验/影像/体征 (@)' : 'Attach clinical data (@)'}
                type="button"
                variant="ghost"
              >
                <AtSignIcon aria-hidden="true" className="size-3.5" />
              </Button>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <ContextOccupancyRing
              latestCall={latestContextCall}
              onToggle={onOpenContextInspector}
              open={contextInspectorOpen}
              zh={zh}
            />

            {isRunning ? (
              <>
                {canSend ? (
                  <>
                    <Button
                      aria-label={zh ? '立即引导当前生成' : 'Steer current run'}
                      className="h-7 gap-1 rounded-lg px-2 text-xs"
                      data-testid="assistant-steer-btn"
                      disabled={sendPending}
                      onClick={() => handleSubmitIntent('steer')}
                      size="xs"
                      title={zh ? '在当前步骤后立即注入引导 (Ctrl+Enter)' : 'Steer after current step (Ctrl+Enter)'}
                      type="button"
                      variant="outline"
                    >
                      <SendHorizontalIcon aria-hidden="true" className="size-3" />
                      <span>{zh ? '引导' : 'Steer'}</span>
                    </Button>
                    <Button
                      aria-label={zh ? '加入后续排队' : 'Queue follow-up message'}
                      className="h-7 gap-1 rounded-lg px-2 text-xs"
                      data-testid="assistant-queue-btn"
                      disabled={sendPending}
                      onClick={() => handleSubmitIntent('followUp')}
                      size="xs"
                      title={zh ? '当前回复完成后自动继续发送 (Enter)' : 'Send automatically after current turn (Enter)'}
                      type="button"
                      variant="secondary"
                    >
                      <span>{zh ? '排队' : 'Queue'}</span>
                    </Button>
                  </>
                ) : null}
                <Button
                  aria-label={zh ? '停止生成' : 'Stop generation'}
                  className="h-7 gap-1 rounded-lg px-2.5"
                  disabled={stopPending}
                  onClick={onStop}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  <SquareIcon aria-hidden="true" className="size-3 fill-current" />
                  <span>{zh ? '停止' : 'Stop'}</span>
                </Button>
              </>
            ) : (
              <Button
                aria-label={zh ? '发送临床助手消息' : 'Send assistant message'}
                className="size-7 rounded-lg p-0"
                disabled={!canSend || sendPending}
                size="icon-sm"
                title={zh ? '发送 (Enter)' : 'Send (Enter)'}
                type="submit"
                variant="default"
              >
                <ArrowUpIcon aria-hidden="true" className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </form>
  )
}
