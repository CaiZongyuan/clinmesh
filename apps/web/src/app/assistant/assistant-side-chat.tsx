import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation } from '@tanstack/react-query'
import {
  ArrowRightToLineIcon,
  ArrowUpIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  MessageSquareQuoteIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { askSideChatQuestion, askStandaloneSideChatQuestion } from '../agent-sessions-api.ts'
import { MarkdownRenderer } from '../markdown-renderer.tsx'

export interface SideChatTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  model?: string
  durationMs?: number
  ttftMs?: number
}

export interface AssistantSideChatProps {
  open: boolean
  openNonce?: number
  sessionId: string | null
  encounterId?: string | null
  caseId?: string | null
  initialQuote: string | null
  initialQuestion?: string | null
  sidebarWidth: number
  onClose: () => void
  onInsertToMain: (text: string) => void
  zh: boolean
}

/**
 * Lightweight, ephemeral Side Chat (/side) anchored beside the main assistant sidebar.
 * Lets clinicians verify dosage, guidelines, or ask follow-up questions on a quoted
 * passage without polluting the main durable conversation context (and works even before
 * a main session exists).
 */
export function AssistantSideChat({
  open,
  openNonce = 0,
  sessionId,
  encounterId = null,
  caseId = null,
  initialQuote,
  initialQuestion,
  sidebarWidth,
  onClose,
  onInsertToMain,
  zh,
}: AssistantSideChatProps): React.JSX.Element | null {
  const [quote, setQuote] = useState<string | null>(initialQuote)
  const [draft, setDraft] = useState('')
  const [turns, setTurns] = useState<SideChatTurn[]>([])
  const [errorText, setErrorText] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    setQuote(initialQuote)
  }, [initialQuote, openNonce])

  useEffect(() => {
    if (!open) return
    if (initialQuestion && initialQuestion.trim().length > 0) {
      setDraft(initialQuestion.trim())
    }
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [initialQuestion, open, openNonce])

  useEffect(() => {
    setTurns([])
    setErrorText(null)
  }, [sessionId, encounterId])

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

  const sideMutation = useMutation({
    mutationFn: async (question: string) => {
      const history = turns.map(t => ({ role: t.role, text: t.text }))
      const payload = {
        question,
        ...(quote && quote.trim().length > 0 ? { quote: quote.trim() } : {}),
        ...(history.length > 0 ? { history } : {}),
      }
      if (sessionId === null) {
        return askStandaloneSideChatQuestion({
          ...payload,
          encounterId,
          caseId,
        })
      }
      return askSideChatQuestion(sessionId, payload)
    },
    onSuccess: (response, question) => {
      setErrorText(null)
      setTurns(prev => [
        ...prev,
        { id: `side-u-${Date.now()}`, role: 'user', text: question },
        {
          id: `side-a-${Date.now() + 1}`,
          role: 'assistant',
          text: response.answer,
          model: response.model,
          durationMs: response.durationMs,
          ...(response.ttftMs === undefined ? {} : { ttftMs: response.ttftMs }),
        },
      ])
    },
    onError: (error) => {
      setErrorText(error instanceof Error ? error.message : (zh ? '侧边追问请求失败。' : 'Side chat failed.'))
    },
  })

  const submitQuestion = () => {
    const trimmed = draft.trim()
    if (trimmed.length === 0 || sideMutation.isPending) return
    setDraft('')
    sideMutation.mutate(trimmed)
  }

  if (!open) return null

  return (
    <section
      aria-label={zh ? '侧边轻追问面板' : 'Side chat panel'}
      className="cm-side-chat-panel"
      data-testid="assistant-side-chat-panel"
      style={{ right: `${Math.max(0, sidebarWidth)}px` }}
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <MessageSquareQuoteIcon aria-hidden="true" className="size-4 shrink-0 text-info" />
          <h2 className="truncate text-sm font-semibold text-foreground">
            {zh ? '侧边追问' : 'Side chat'}
          </h2>
          <Badge className="px-1.5 py-0 text-[0.625rem]" variant="secondary">
            {zh ? '不污染主上下文' : 'Ephemeral'}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {turns.length > 0 ? (
            <Button
              aria-label={zh ? '清空侧边追问记录' : 'Clear side chat'}
              onClick={() => {
                setTurns([])
                setErrorText(null)
              }}
              size="icon-xs"
              title={zh ? '清空' : 'Clear'}
              type="button"
              variant="ghost"
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            aria-label={zh ? '关闭侧边追问' : 'Close side chat'}
            data-testid="assistant-side-chat-close"
            onClick={onClose}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
      </header>

      {quote !== null && quote.trim().length > 0 ? (
        <div className="flex items-start justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs">
          <blockquote className="line-clamp-3 border-l-2 border-info pl-2 text-muted-foreground">
            {quote}
          </blockquote>
          <Button
            aria-label={zh ? '移除引用片段' : 'Remove quote'}
            onClick={() => setQuote(null)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      <div className="cm-assistant-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {turns.length === 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {zh
              ? '适合快速核对药物剂量、检验指标参考或指南细节；回答仅留在侧栏，不会写入主对话上下文。'
              : 'Ask quick side questions on dosages, lab ranges, or guidelines without adding tokens to the main thread.'}
          </p>
        ) : turns.map(turn => (
          <div className="space-y-1.5" key={turn.id}>
            {turn.role === 'user' ? (
              <div className="flex justify-end">
                <div className="max-w-[90%] rounded-xl bg-secondary px-2.5 py-1.5 text-xs text-secondary-foreground">
                  {turn.text}
                </div>
              </div>
            ) : (
              <div className="space-y-1.5 rounded-xl border border-border bg-background p-2.5 text-xs">
                <MarkdownRenderer content={turn.text} />
                <div className="flex items-center justify-between gap-2 pt-1 text-[0.6875rem] text-muted-foreground">
                  <span className="truncate font-mono">
                    {turn.model ?? ''}
                    {turn.durationMs ? ` · ${(turn.durationMs / 1000).toFixed(1)}s` : ''}
                  </span>
                  <Button
                    aria-label={zh ? '将侧边回答插入主对话输入框' : 'Insert side answer into main composer'}
                    className="h-6 gap-1 px-1.5 text-[0.6875rem]"
                    data-testid="assistant-side-chat-insert"
                    onClick={() => onInsertToMain(turn.text)}
                    size="xs"
                    type="button"
                    variant="ghost"
                  >
                    <ArrowRightToLineIcon aria-hidden="true" className="size-3" />
                    <span>{zh ? '插入主对话' : 'Insert'}</span>
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}

        {sideMutation.isPending ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin text-info" />
            <span>{zh ? '正在回答侧边追问…' : 'Answering side question…'}</span>
          </div>
        ) : null}

        {errorText !== null ? (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertDescription>{errorText}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      <form
        className="flex items-end gap-1.5 border-t border-border bg-card p-2.5"
        onSubmit={(event) => {
          event.preventDefault()
          submitQuestion()
        }}
      >
        <Textarea
          aria-label={zh ? '输入侧边追问内容' : 'Ask a side question'}
          className="cm-assistant-scroll max-h-24 min-h-10 flex-1 resize-none text-xs"
          data-testid="assistant-side-chat-input"
          disabled={sideMutation.isPending}
          onChange={event => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            event.preventDefault()
            submitQuestion()
          }}
          placeholder={zh ? '输入局部追问（Enter 发送）…' : 'Ask a side question…'}
          ref={inputRef}
          value={draft}
        />
        <Button
          aria-label={zh ? '发送侧边追问' : 'Send side question'}
          data-testid="assistant-side-chat-send"
          disabled={draft.trim().length === 0 || sideMutation.isPending}
          size="icon-sm"
          type="submit"
          variant="default"
        >
          <ArrowUpIcon aria-hidden="true" className="size-4" />
        </Button>
      </form>
    </section>
  )
}
