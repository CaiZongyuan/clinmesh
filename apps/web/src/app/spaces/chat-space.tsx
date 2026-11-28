import type {
  AgentContentBlock,
  AgentSessionDetail,
  ClinicalEntityMention,
} from '@clinmesh/contracts/agent-sessions'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Input } from '@clinmesh/ui/components/input'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@clinmesh/ui/components/message-scroller'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CircleAlertIcon,
  LayersIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  compactAgentSession,
  createAgentSession,
  deleteAgentSession,
  exportAgentSession,
  getAgentSession,
  getLlmProviderCatalog,
  listAgentSessions,
  resetAgentSession,
  sendAgentMessage,
  stopAgentSession,
  subscribeAgentSessionEvents,
} from '../agent-sessions-api.ts'
import { ApiClientError } from '../api-client.ts'
import { AssistantComposer, type ComposerSendMode } from '../assistant/assistant-composer.tsx'
import { AssistantSideChat } from '../assistant/assistant-side-chat.tsx'
import { ContextInspectorOverlay } from '../assistant/context-inspector-overlay.tsx'
import { WorkProcessBlock } from '../assistant/work-process-block.tsx'
import { MarkdownRenderer } from '../markdown-renderer.tsx'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { useChatHandoffStore } from './chat-handoff.ts'

type ThreadFilter = 'all' | 'general' | 'case'

function extractText(blocks: readonly AgentContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<AgentContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

export function ChatSpace({
  locale,
  session,
  onNavigate,
}: {
  locale: WorkspaceLocale
  session: SessionContext
  onNavigate: (path: string) => void
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const consumeHandoff = useChatHandoffStore(s => s.consumeHandoff)

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [creatingFresh, setCreatingFresh] = useState(false)
  const [filter, setFilter] = useState<ThreadFilter>('all')
  const [searchText, setSearchText] = useState('')
  const [draft, setDraft] = useState('')
  const [contextOpen, setContextOpen] = useState(false)
  const [sideChatOpen, setSideChatOpen] = useState(false)
  const [sideChatInitialQ, setSideChatInitialQ] = useState<string | undefined>(undefined)
  const [attachedEntities, setAttachedEntities] = useState<readonly ClinicalEntityMention[]>([])
  const [liveDetail, setLiveDetail] = useState<AgentSessionDetail | null>(null)
  const [statusNotice, setStatusNotice] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const sessionsQueryKey = useMemo(
    () => ['chat-space-sessions', session.actor.workspaceId, session.actor.epoch] as const,
    [session.actor.epoch, session.actor.workspaceId],
  )

  const sessionsQuery = useQuery({
    queryKey: sessionsQueryKey,
    queryFn: ({ signal }) => listAgentSessions(undefined, signal),
  })

  const catalogQuery = useQuery({
    queryKey: ['llm-provider-catalog'],
    queryFn: ({ signal }) => getLlmProviderCatalog({ signal }),
  })

  // Apply any cross-space handoff draft (e.g. from Research Space or Personal Agent Space)
  useEffect(() => {
    const handoff = consumeHandoff()
    if (handoff.sessionId) {
      setSelectedSessionId(handoff.sessionId)
      setCreatingFresh(false)
    } else if (handoff.draft) {
      setCreatingFresh(true)
      setSelectedSessionId(null)
      setDraft(handoff.draft)
      window.setTimeout(() => textareaRef.current?.focus(), 60)
    }
  }, [consumeHandoff])

  const filteredSessions = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    return (sessionsQuery.data?.sessions ?? []).filter(item => {
      if (filter === 'general' && item.scope.encounterId !== null) return false
      if (filter === 'case' && item.scope.encounterId === null) return false
      if (q.length > 0 && !item.title.toLowerCase().includes(q)) return false
      return true
    })
  }, [filter, searchText, sessionsQuery.data?.sessions])

  // Auto-select latest session unless user explicitly started a fresh conversation
  useEffect(() => {
    if (creatingFresh) return
    if (selectedSessionId !== null) return
    const first = filteredSessions[0]
    if (first) setSelectedSessionId(first.sessionId)
  }, [creatingFresh, filteredSessions, selectedSessionId])

  const detailQuery = useQuery({
    queryKey: ['chat-space-detail', selectedSessionId],
    queryFn: ({ signal }) => getAgentSession(selectedSessionId!, signal),
    enabled: selectedSessionId !== null,
  })

  const activeDetail =
    liveDetail !== null && liveDetail.session.sessionId === selectedSessionId
      ? liveDetail
      : (detailQuery.data ?? null)

  // Live SSE updates for active session
  useEffect(() => {
    if (selectedSessionId === null) {
      setLiveDetail(null)
      return
    }
    const unsub = subscribeAgentSessionEvents(selectedSessionId, {
      onSnapshot: snapshot => {
        setLiveDetail(snapshot)
        queryClient.setQueryData(['chat-space-detail', snapshot.session.sessionId], snapshot)
        if (snapshot.session.status !== 'running') {
          void queryClient.invalidateQueries({ queryKey: sessionsQueryKey })
        }
      },
    })
    return unsub
  }, [queryClient, selectedSessionId, sessionsQueryKey])

  const sendMutation = useMutation({
    mutationFn: async ({ text, mode }: { text: string; mode?: ComposerSendMode | undefined }) => {
      let sid = selectedSessionId
      if (sid === null) {
        const created = await createAgentSession({
          title: text.slice(0, 48),
          encounterId: null,
        })
        sid = created.session.sessionId
        setSelectedSessionId(sid)
        setCreatingFresh(false)
        setLiveDetail(created)
      }
      const next = await sendAgentMessage(sid, {
        content: text,
        ...(mode ? { whenBusy: mode } : {}),
      })
      return next
    },
    onSuccess: detail => {
      setDraft('')
      setAttachedEntities([])
      setLiveDetail(detail)
      queryClient.setQueryData(['chat-space-detail', detail.session.sessionId], detail)
      void queryClient.invalidateQueries({ queryKey: sessionsQueryKey })
    },
  })

  const stopMutation = useMutation({
    mutationFn: () => {
      if (!selectedSessionId) throw new Error('No active session')
      return stopAgentSession(selectedSessionId)
    },
    onSuccess: detail => {
      setLiveDetail(detail)
      queryClient.setQueryData(['chat-space-detail', detail.session.sessionId], detail)
    },
  })

  const compactMutation = useMutation({
    mutationFn: () => {
      if (!selectedSessionId) throw new Error('No active session')
      return compactAgentSession(selectedSessionId)
    },
    onSuccess: detail => {
      setLiveDetail(detail)
      setStatusNotice(zh ? '已完成上下文压缩 (/compact)' : 'Context compacted')
    },
  })

  const resetMutation = useMutation({
    mutationFn: () => {
      if (!selectedSessionId) throw new Error('No active session')
      return resetAgentSession(selectedSessionId)
    },
    onSuccess: detail => {
      setLiveDetail(detail)
      setStatusNotice(zh ? '已重置当前上下文窗口 (/reset)' : 'Context window reset')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => deleteAgentSession(sessionId),
    onSuccess: (_data, deletedId) => {
      if (selectedSessionId === deletedId) {
        setSelectedSessionId(null)
        setLiveDetail(null)
      }
      void queryClient.invalidateQueries({ queryKey: sessionsQueryKey })
    },
  })

  const isRunning = activeDetail?.session.status === 'running'
  const visibleMessages = activeDetail?.messages ?? []

  const handleSend = (mode?: ComposerSendMode) => {
    const trimmed = draft.trim()
    if (trimmed.length === 0) return
    sendMutation.mutate({ text: trimmed, mode })
  }

  const handleExport = async () => {
    if (!selectedSessionId) return
    const result = await exportAgentSession(selectedSessionId)
    try {
      await navigator.clipboard.writeText(result.markdown)
      setStatusNotice(zh ? `已复制「${result.title}」Markdown 到剪贴板` : `Copied "${result.title}" markdown`)
    } catch {
      setStatusNotice(zh ? `已导出「${result.filename}」` : `Exported ${result.filename}`)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
      {/* Left Conversation History Sidebar */}
      <aside
        aria-label={zh ? '聊天会话列表' : 'Chat sessions'}
        className="hidden w-64 shrink-0 flex-col gap-2.5 border-r bg-sidebar p-2.5 md:flex"
      >
        <Button
          className="w-full justify-center gap-1.5"
          onClick={() => {
            setCreatingFresh(true)
            setSelectedSessionId(null)
            setLiveDetail(null)
            setContextOpen(false)
            textareaRef.current?.focus()
          }}
          size="sm"
          type="button"
        >
          <MessageSquarePlusIcon aria-hidden="true" className="size-3.5" />
          <span>{zh ? '新建对话' : 'New chat'}</span>
        </Button>

        <div className="relative">
          <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={zh ? '搜索历史会话' : 'Search chat history'}
            className="h-8 pl-8 text-xs"
            onChange={event => setSearchText(event.currentTarget.value)}
            placeholder={zh ? '搜索对话标题…' : 'Search threads…'}
            value={searchText}
          />
        </div>

        <ToggleGroup
          aria-label={zh ? '筛选会话范围' : 'Filter thread scope'}
          className="w-full"
          onValueChange={values => {
            const next = (values as ThreadFilter[])[0]
            if (next) setFilter(next)
          }}
          size="sm"
          spacing={0}
          value={[filter]}
          variant="outline"
        >
          <ToggleGroupItem className="flex-1" value="all">{zh ? '全部' : 'All'}</ToggleGroupItem>
          <ToggleGroupItem className="flex-1" value="general">{zh ? '通用' : 'General'}</ToggleGroupItem>
          <ToggleGroupItem className="flex-1" value="case">{zh ? '病例' : 'Cases'}</ToggleGroupItem>
        </ToggleGroup>

        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-0.5">
          {filteredSessions.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              {zh ? '暂无匹配对话，发消息即可创建持久化会话。' : 'No threads yet. Send a message to start.'}
            </div>
          ) : (
            filteredSessions.map(item => {
              const active = item.sessionId === selectedSessionId
              return (
                <div
                  className={active
                    ? 'group flex items-start gap-1 rounded-md border bg-card px-2.5 py-2 text-xs shadow-2xs'
                    : 'group flex items-start gap-1 rounded-md border border-transparent px-2.5 py-2 text-xs hover:bg-muted'}
                  key={item.sessionId}
                >
                  <Button
                    className="h-auto min-w-0 flex-1 flex-col items-start gap-1 p-0 text-left font-normal hover:bg-transparent"
                    onClick={() => {
                      setCreatingFresh(false)
                      setSelectedSessionId(item.sessionId)
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <span className="w-full truncate font-medium text-foreground">{item.title}</span>
                    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Badge variant="outline">
                        {item.scope.encounterId ? (zh ? '关联病例' : 'Case') : (zh ? '通用对话' : 'General')}
                      </Badge>
                      <span>{item.messageCount} {zh ? '轮' : 'msgs'}</span>
                    </span>
                  </Button>
                  <Button
                    aria-label={zh ? `删除会话 ${item.title}` : `Delete ${item.title}`}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => deleteMutation.mutate(item.sessionId)}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon aria-hidden="true" className="size-3" />
                  </Button>
                </div>
              )
            })
          )}
        </div>
      </aside>

      {/* Main Full-Width Chat Canvas */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Session Sub-Header */}
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b bg-card px-4">
          <div className="flex min-w-0 items-center gap-2">
            <MessageSquareIcon aria-hidden="true" className="size-4 shrink-0 text-info" />
            <span className="truncate text-sm font-medium text-foreground">
              {activeDetail?.session.title ?? (zh ? '新持久化对话（pi-durable）' : 'New pi-durable conversation')}
            </span>
            {activeDetail?.session.scope.encounterId ? (
              <Badge variant="secondary">{zh ? '病例上下文已绑定' : 'Encounter linked'}</Badge>
            ) : (
              <Badge variant="outline">{zh ? '自由临床对话' : 'General clinical chat'}</Badge>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {selectedSessionId ? (
              <Button
                onClick={() => setContextOpen(open => !open)}
                size="xs"
                type="button"
                variant={contextOpen ? 'secondary' : 'outline'}
              >
                <LayersIcon aria-hidden="true" className="size-3.5" />
                <span>/context</span>
              </Button>
            ) : null}
            <Button onClick={() => setSideChatOpen(open => !open)} size="xs" type="button" variant="outline">
              <span>/side</span>
            </Button>
          </div>
        </div>

        {statusNotice ? (
          <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground" role="status">
            <span>{statusNotice}</span>
            <Button onClick={() => setStatusNotice(null)} size="xs" type="button" variant="ghost">
              {zh ? '关闭' : 'Dismiss'}
            </Button>
          </div>
        ) : null}

        {sendMutation.isError ? (
          <div className="px-4 pt-3">
            <Alert variant="destructive">
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>{zh ? '发送失败' : 'Failed to send'}</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {sendMutation.error instanceof ApiClientError
                    ? getWorkspaceErrorMessage(sendMutation.error, messages)
                    : (sendMutation.error instanceof Error ? sendMutation.error.message : 'Error')}
                </span>
                <Button onClick={() => onNavigate('/settings/models')} size="xs" type="button" variant="outline">
                  {zh ? '前往模型与服务商设置' : 'Open Models Settings'}
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        {/* Conversation Stream */}
        <MessageScrollerProvider>
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport className="h-full overflow-y-auto px-4 py-6 sm:px-8">
              <MessageScrollerContent className="mx-auto flex max-w-3xl flex-col gap-4" data-cm="clinical-prose">
                {visibleMessages.length === 0 ? (
                  <div className="mx-auto my-12 flex max-w-lg flex-col items-center gap-3 text-center">
                    <span className="flex size-11 items-center justify-center rounded-xl border bg-card text-info shadow-2xs">
                      <SparklesIcon aria-hidden="true" className="size-5" />
                    </span>
                    <h2 className="text-base font-semibold text-foreground">
                      {zh ? 'ClinMesh 全屏对话空间' : 'ClinMesh Fullscreen Chat'}
                    </h2>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {zh
                        ? '直连 Step 3 pi-durable 持久化会话运行时。支持通用临床问答、指南检索、科研队列分析、/context 上下文检查与断线续传。'
                        : 'Powered by Step 3 pi-durable runtime for general clinical Q&A, guideline analysis, cohort discussion, and /context inspection.'}
                    </p>
                    <div className="flex flex-wrap justify-center gap-2 pt-2">
                      {[
                        zh ? '总结青霉素过敏患者的成人社区获得性肺炎经验用药原则' : 'Summarize empiric CAP regimens for penicillin-allergic adults',
                        zh ? '解读高敏肌钙蛋白轻度升高时的胸痛鉴别思路' : 'Differential diagnosis for mildly elevated hs-cTnI',
                      ].map(sample => (
                        <Button
                          key={sample}
                          onClick={() => {
                            setDraft(sample)
                            textareaRef.current?.focus()
                          }}
                          size="xs"
                          type="button"
                          variant="outline"
                        >
                          {sample}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : (
                  visibleMessages.map(msg => {
                    const text = extractText(msg.blocks)
                    const thinkingBlocks = msg.blocks.filter(
                      (b): b is Extract<AgentContentBlock, { type: 'thinking' }> => b.type === 'thinking',
                    )
                    const toolBlocks = msg.blocks.filter(
                      (b): b is Extract<AgentContentBlock, { type: 'tool-call' }> => b.type === 'tool-call',
                    )
                    const isUser = msg.role === 'user'
                    return (
                      <MessageScrollerItem key={msg.id}>
                        {isUser ? (
                          <div className="ml-auto max-w-[82%] rounded-xl bg-secondary px-3.5 py-2.5 text-sm text-secondary-foreground">
                            {text}
                          </div>
                        ) : (
                          <div className="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3.5 text-sm">
                            <WorkProcessBlock
                              durationMs={msg.durationMs ?? null}
                              startedAtIso={msg.createdAt}
                              streaming={msg.streaming}
                              thinkingBlocks={thinkingBlocks}
                              toolBlocks={toolBlocks}
                              zh={zh}
                            />
                            {text.length > 0 ? (
                              <MarkdownRenderer content={text} />
                            ) : msg.errorMessage ? (
                              <p className="text-xs text-destructive">{msg.errorMessage}</p>
                            ) : null}
                          </div>
                        )}
                      </MessageScrollerItem>
                    )
                  })
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>

        {/* Full-Width Composer */}
        <div className="shrink-0 border-t bg-card/80 px-4 py-3 sm:px-8">
          <div className="mx-auto max-w-3xl">
            <AssistantComposer
              attachedEntities={attachedEntities}
              catalog={catalogQuery.data}
              catalogFetching={catalogQuery.isFetching}
              clinicalEntities={[]}
              contextInspectorOpen={contextOpen}
              isRunning={isRunning}
              latestContextCall={activeDetail?.latestContextCall ?? null}
              onAttachEntity={entity => setAttachedEntities(curr => [...curr.filter(e => e.id !== entity.id), entity])}
              onChange={setDraft}
              onClearQuote={() => {}}
              onCompact={() => { if (selectedSessionId) compactMutation.mutate() }}
              onExport={() => { void handleExport() }}
              onOpenContextInspector={() => setContextOpen(open => !open)}
              onOpenInstructions={() => onNavigate('/agents')}
              onOpenSideChat={q => {
                setSideChatInitialQ(q)
                setSideChatOpen(true)
              }}
              onRecallQueuedInput={() => {}}
              onRefreshCatalog={() => { void catalogQuery.refetch() }}
              onRemoveEntity={id => setAttachedEntities(curr => curr.filter(e => e.id !== id))}
              onReset={() => { if (selectedSessionId) resetMutation.mutate() }}
              onSend={handleSend}
              onStop={() => { if (selectedSessionId) stopMutation.mutate() }}
              queuedInputs={activeDetail?.queuedInputs ?? []}
              quotedText={null}
              recallPending={false}
              sendPending={sendMutation.isPending}
              stopPending={stopMutation.isPending}
              textareaRef={textareaRef}
              value={draft}
              zh={zh}
            />
          </div>
        </div>

        {/* Context Inspector Overlay */}
        <ContextInspectorOverlay
          latestContextCall={activeDetail?.latestContextCall ?? null}
          onClose={() => setContextOpen(false)}
          onCompact={() => compactMutation.mutate()}
          onReset={() => resetMutation.mutate()}
          open={contextOpen && selectedSessionId !== null}
          sessionId={selectedSessionId}
          sessionTitle={activeDetail?.session.title}
          sidebarWidth={0}
          zh={zh}
        />

        {/* Side Chat Overlay */}
        <AssistantSideChat
          caseId={null}
          encounterId={activeDetail?.session.scope.encounterId ?? null}
          initialQuestion={sideChatInitialQ ?? null}
          initialQuote={null}
          onClose={() => setSideChatOpen(false)}
          onInsertToMain={text => {
            setDraft(curr => (curr.trim().length > 0 ? `${curr}\n${text}` : text))
            setSideChatOpen(false)
          }}
          open={sideChatOpen}
          sessionId={selectedSessionId}
          sidebarWidth={0}
          zh={zh}
        />
      </div>
    </div>
  )
}
