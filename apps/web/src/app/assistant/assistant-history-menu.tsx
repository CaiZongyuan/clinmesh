import type { AgentSessionSummary } from '@clinmesh/contracts/agent-sessions'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Input } from '@clinmesh/ui/components/input'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@clinmesh/ui/components/popover'
import { useQuery } from '@tanstack/react-query'
import {
  CheckIcon,
  CornerDownRightIcon,
  DownloadIcon,
  GitForkIcon,
  HistoryIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { searchAgentSessions } from '../agent-sessions-api.ts'

function formatRelativeTime(iso: string, zh: boolean): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const diffMin = Math.max(0, Math.floor((Date.now() - ms) / 60_000))
  if (diffMin < 1) return zh ? '刚刚' : 'just now'
  if (diffMin < 60) return zh ? `${diffMin} 分钟前` : `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return zh ? `${diffHr} 小时前` : `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return zh ? `${diffDay} 天前` : `${diffDay}d ago`
}

interface SessionTreeNode {
  session: AgentSessionSummary
  depth: number
}

function orderSessionsAsTree(sessions: readonly AgentSessionSummary[]): SessionTreeNode[] {
  const byId = new Map(sessions.map(item => [item.sessionId, item]))
  const childrenByParent = new Map<string, AgentSessionSummary[]>()
  const roots: AgentSessionSummary[] = []

  for (const item of sessions) {
    const parentId = item.forkedFromSessionId
    if (parentId !== null && byId.has(parentId) && parentId !== item.sessionId) {
      const siblings = childrenByParent.get(parentId) ?? []
      siblings.push(item)
      childrenByParent.set(parentId, siblings)
    } else {
      roots.push(item)
    }
  }

  const ordered: SessionTreeNode[] = []
  const visited = new Set<string>()
  const visit = (item: AgentSessionSummary, depth: number) => {
    if (visited.has(item.sessionId)) return
    visited.add(item.sessionId)
    ordered.push({ session: item, depth })
    for (const child of childrenByParent.get(item.sessionId) ?? []) {
      visit(child, Math.min(3, depth + 1))
    }
  }
  for (const root of roots) {
    visit(root, 0)
  }
  for (const item of sessions) {
    if (!visited.has(item.sessionId)) {
      visit(item, 0)
    }
  }
  return ordered
}

export interface AssistantHistoryMenuProps {
  sessions: readonly AgentSessionSummary[]
  selectedSessionId: string | null
  encounterId?: string | null | undefined
  createPending: boolean
  renamePending: boolean
  deletePending: boolean
  forkPending: boolean
  exportPending?: boolean
  onSelectSession: (sessionId: string) => void
  onCreateSession: () => void
  onRenameSession: (sessionId: string, title: string) => void
  onDeleteSession: (sessionId: string) => void
  onForkSession: (sessionId: string) => void
  onExportSession?: (sessionId: string) => void
  zh: boolean
}

/**
 * Claude Desktop-style conversation history popover with:
 * - Cross-session full-text search (title + message content)
 * - Parent/child branch tree hierarchy indentation
 * - Inline rename, fork, Markdown export, and non-blocking inline delete confirmation
 */
export function AssistantHistoryMenu({
  sessions,
  selectedSessionId,
  encounterId,
  createPending,
  renamePending,
  deletePending,
  forkPending,
  exportPending = false,
  onSelectSession,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
  onForkSession,
  onExportSession,
  zh,
}: AssistantHistoryMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  useEffect(() => {
    const trimmed = searchInput.trim()
    if (trimmed.length === 0) {
      setDebouncedQuery('')
      return
    }
    const timer = window.setTimeout(() => setDebouncedQuery(trimmed), 180)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const searchQuery = useQuery({
    queryKey: ['agent-session-search', encounterId ?? '__none__', debouncedQuery],
    queryFn: ({ signal }) => searchAgentSessions(debouncedQuery, encounterId, signal),
    enabled: open && debouncedQuery.length > 0,
    retry: false,
  })

  const treeNodes = useMemo(() => orderSessionsAsTree(sessions), [sessions])

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setEditingSessionId(null)
      setConfirmDeleteId(null)
    }
  }

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger
        render={(
          <Button
            aria-label={zh ? '历史会话列表' : 'Conversation history'}
            data-testid="assistant-history-trigger"
            size="icon-sm"
            title={zh ? '历史会话与搜索' : 'History & search'}
            type="button"
            variant="ghost"
          />
        )}
      >
        <HistoryIcon aria-hidden="true" className="size-4" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-84 p-2"
        data-testid="assistant-history-popover"
      >
        <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-border/80 px-1.5 pb-2">
          <div className="flex items-center gap-1.5">
            <PopoverTitle className="text-xs font-semibold">
              {zh ? '历史对话与分支' : 'Conversations'}
            </PopoverTitle>
            <Badge className="px-1.5 py-0 text-[0.6875rem] tabular-nums" variant="secondary">
              {sessions.length}
            </Badge>
          </div>
          <Button
            aria-label={zh ? '在历史菜单中新建对话' : 'New conversation from history'}
            disabled={createPending}
            onClick={() => {
              onCreateSession()
              setOpen(false)
            }}
            size="xs"
            type="button"
            variant="outline"
          >
            <MessageSquarePlusIcon aria-hidden="true" data-icon="inline-start" />
            {zh ? '新建' : 'New'}
          </Button>
        </div>

        {/* Cross-session full-text search */}
        <div className="relative mb-1.5 flex items-center gap-1 px-0.5">
          <SearchIcon aria-hidden="true" className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
          <Input
            aria-label={zh ? '跨会话全文检索历史对话' : 'Search conversation history'}
            className="h-7 pr-7 pl-7 text-xs"
            data-testid="assistant-history-search"
            onChange={event => setSearchInput(event.currentTarget.value)}
            placeholder={zh ? '搜索标题或对话内容…' : 'Search titles or messages…'}
            value={searchInput}
          />
          {searchInput.length > 0 ? (
            <Button
              aria-label={zh ? '清空搜索关键词' : 'Clear search'}
              className="absolute right-1.5 size-5 p-0"
              onClick={() => {
                setSearchInput('')
                setDebouncedQuery('')
              }}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <XIcon aria-hidden="true" className="size-3" />
            </Button>
          ) : null}
        </div>

        {debouncedQuery.length > 0 ? (
          <div className="cm-assistant-scroll flex max-h-72 flex-col gap-1 overflow-y-auto pr-0.5">
            {searchQuery.isFetching ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                {zh ? '正在检索历史对话…' : 'Searching conversations…'}
              </p>
            ) : (searchQuery.data?.matches.length ?? 0) === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                {zh ? '未找到匹配的历史会话。' : 'No matching conversations found.'}
              </p>
            ) : (
              searchQuery.data!.matches.map(match => (
                <Button
                  aria-label={zh ? `打开搜索匹配会话：${match.session.title}` : `Open matched session: ${match.session.title}`}
                  className="h-auto w-full flex-col items-start gap-0.5 rounded-lg border border-border/70 px-2 py-1.5 text-left font-normal"
                  data-testid="assistant-history-search-hit"
                  key={`${match.session.sessionId}-${match.matchedIn}`}
                  onClick={() => {
                    onSelectSession(match.session.sessionId)
                    setOpen(false)
                  }}
                  type="button"
                  variant="ghost"
                >
                  <span className="flex w-full items-center justify-between gap-1.5">
                    <span className="truncate text-xs font-medium text-foreground">
                      {match.session.title}
                    </span>
                    <Badge className="shrink-0 px-1 py-0 text-[0.625rem]" variant="outline">
                      {match.matchedIn === 'title' ? (zh ? '标题' : 'Title') : (zh ? '内容' : 'Text')}
                    </Badge>
                  </span>
                  <span className="line-clamp-2 w-full text-[0.6875rem] text-muted-foreground">
                    {match.snippet}
                  </span>
                </Button>
              ))
            )}
          </div>
        ) : sessions.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            {zh ? '暂无历史对话，发送消息将自动创建。' : 'No conversations yet. Send a message to start one.'}
          </p>
        ) : (
          <div className="cm-assistant-scroll flex max-h-72 flex-col gap-1 overflow-y-auto pr-0.5">
            {treeNodes.map(({ session: item, depth }) => {
              const isSelected = item.sessionId === selectedSessionId
              const isEditing = editingSessionId === item.sessionId
              const isConfirmingDelete = confirmDeleteId === item.sessionId

              if (isEditing) {
                return (
                  <form
                    className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1.5"
                    key={item.sessionId}
                    onSubmit={(event) => {
                      event.preventDefault()
                      const next = renameDraft.trim()
                      if (next.length === 0) return
                      onRenameSession(item.sessionId, next)
                      setEditingSessionId(null)
                    }}
                  >
                    <Input
                      aria-label={zh ? '输入新的会话名称' : 'Enter new session title'}
                      autoFocus
                      className="h-7 flex-1 text-xs"
                      maxLength={160}
                      onChange={event => setRenameDraft(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.stopPropagation()
                          setEditingSessionId(null)
                        }
                      }}
                      value={renameDraft}
                    />
                    <Button
                      aria-label={zh ? '确认重命名' : 'Confirm rename'}
                      disabled={renamePending || renameDraft.trim().length === 0}
                      size="icon-xs"
                      type="submit"
                      variant="default"
                    >
                      <CheckIcon aria-hidden="true" />
                    </Button>
                    <Button
                      aria-label={zh ? '取消重命名' : 'Cancel rename'}
                      onClick={() => setEditingSessionId(null)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <XIcon aria-hidden="true" />
                    </Button>
                  </form>
                )
              }

              if (isConfirmingDelete) {
                return (
                  <div
                    className="flex items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs"
                    data-testid="assistant-history-delete-confirm"
                    key={item.sessionId}
                  >
                    <span className="truncate font-medium text-destructive">
                      {zh ? `删除「${item.title}」？` : `Delete "${item.title}"?`}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        aria-label={zh ? '确认删除会话' : 'Confirm delete session'}
                        disabled={deletePending}
                        onClick={() => {
                          onDeleteSession(item.sessionId)
                          setConfirmDeleteId(null)
                        }}
                        size="xs"
                        type="button"
                        variant="destructive"
                      >
                        {zh ? '删除' : 'Delete'}
                      </Button>
                      <Button
                        aria-label={zh ? '取消删除会话' : 'Cancel delete session'}
                        onClick={() => setConfirmDeleteId(null)}
                        size="xs"
                        type="button"
                        variant="ghost"
                      >
                        {zh ? '取消' : 'Cancel'}
                      </Button>
                    </div>
                  </div>
                )
              }

              return (
                <div
                  className={isSelected
                    ? 'group flex items-center gap-1 rounded-lg bg-accent/70 px-1.5 py-1 text-accent-foreground'
                    : 'group flex items-center gap-1 rounded-lg px-1.5 py-1 hover:bg-muted/70'}
                  data-depth={depth}
                  data-selected={isSelected ? 'true' : 'false'}
                  data-testid="assistant-history-item"
                  key={item.sessionId}
                  style={depth > 0 ? { paddingInlineStart: `${6 + depth * 12}px` } : undefined}
                >
                  <Button
                    aria-current={isSelected ? 'true' : undefined}
                    aria-label={zh ? `切换到会话：${item.title}` : `Switch to session: ${item.title}`}
                    className="h-auto min-w-0 flex-1 flex-col items-start gap-0.5 px-1.5 py-1 text-left font-normal"
                    onClick={() => {
                      onSelectSession(item.sessionId)
                      setOpen(false)
                    }}
                    type="button"
                    variant="ghost"
                  >
                    <span className="flex w-full min-w-0 items-center gap-1.5">
                      {depth > 0 ? (
                        <CornerDownRightIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                      ) : null}
                      {item.status === 'running' ? (
                        <span aria-hidden="true" className="cm-assistant-running-dot" />
                      ) : null}
                      <span className="truncate text-xs font-medium text-foreground">
                        {item.title}
                      </span>
                      {item.forkedFromSessionId !== null ? (
                        <Badge className="shrink-0 px-1 py-0 text-[0.625rem]" variant="outline">
                          {zh ? '分支' : 'Branch'}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="flex w-full items-center gap-1.5 text-[0.6875rem] text-muted-foreground tabular-nums">
                      <span>{zh ? `${item.messageCount} 条消息` : `${item.messageCount} msgs`}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatRelativeTime(item.updatedAt, zh)}</span>
                    </span>
                  </Button>

                  <div className="flex shrink-0 items-center gap-0.5">
                    {onExportSession !== undefined ? (
                      <Button
                        aria-label={zh ? `导出会话为 Markdown：${item.title}` : `Export session as Markdown: ${item.title}`}
                        data-testid="assistant-history-export"
                        disabled={item.messageCount === 0 || exportPending}
                        onClick={() => {
                          onExportSession(item.sessionId)
                          setOpen(false)
                        }}
                        size="icon-xs"
                        title={zh ? '导出 Markdown' : 'Export Markdown'}
                        type="button"
                        variant="ghost"
                      >
                        <DownloadIcon aria-hidden="true" />
                      </Button>
                    ) : null}
                    <Button
                      aria-label={zh ? `重命名会话：${item.title}` : `Rename session: ${item.title}`}
                      onClick={() => {
                        setConfirmDeleteId(null)
                        setRenameDraft(item.title)
                        setEditingSessionId(item.sessionId)
                      }}
                      size="icon-xs"
                      title={zh ? '重命名' : 'Rename'}
                      type="button"
                      variant="ghost"
                    >
                      <PencilIcon aria-hidden="true" />
                    </Button>
                    <Button
                      aria-label={zh ? `分支会话：${item.title}` : `Fork session: ${item.title}`}
                      disabled={item.status === 'running' || item.messageCount === 0 || forkPending}
                      onClick={() => {
                        onForkSession(item.sessionId)
                        setOpen(false)
                      }}
                      size="icon-xs"
                      title={zh ? '创建分支' : 'Fork'}
                      type="button"
                      variant="ghost"
                    >
                      <GitForkIcon aria-hidden="true" />
                    </Button>
                    <Button
                      aria-label={zh ? `删除会话：${item.title}` : `Delete session: ${item.title}`}
                      disabled={deletePending}
                      onClick={() => {
                        setEditingSessionId(null)
                        setConfirmDeleteId(item.sessionId)
                      }}
                      size="icon-xs"
                      title={zh ? '删除' : 'Delete'}
                      type="button"
                      variant="ghost"
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
