import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { normalizeHostLocale, type ClientLocalePort } from './host-locale.ts'
import { registerDirectoryFlow } from './directory-flow.tsx'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ChevronRightIcon, HistoryIcon, MoreHorizontalIcon, PlusIcon, SearchIcon } from 'lucide-react'

const historyStyles = `
  [data-clinmesh-history]{position:absolute;top:8px;left:16px;right:54px;z-index:30;display:flex;justify-content:flex-end;align-items:center;gap:6px;pointer-events:none;color:var(--dsw-alias-label-primary)}
  [data-clinmesh-history]>button,[data-clinmesh-history]>div{pointer-events:auto}
  [data-slot="conversation.session.header"] div:has(>[data-slot="conversation.session.header.utilities"]){padding-inline-end:84px}
  [data-clinmesh-history] button,[data-clinmesh-history] input,[data-clinmesh-history] select{font:inherit}
  [data-clinmesh-history] button{cursor:pointer;color:inherit}
  [data-clinmesh-history] button:disabled{cursor:not-allowed;opacity:.5}
  [data-clinmesh-history] button:focus-visible,[data-clinmesh-history] input:focus-visible,[data-clinmesh-history] select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2183dd);outline-offset:1px}
  .cm-history-icon{width:32px;height:32px;flex:none;display:grid;place-items:center;border:0;border-radius:6px;background:transparent}
  .cm-history-icon:hover,.cm-history-icon[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,#edf1f4)}
  .cm-history-panel{position:absolute;top:40px;right:0;box-sizing:border-box;width:350px;max-width:100%;max-height:min(650px,calc(100vh - 78px));overflow:auto;border:1px solid var(--dsw-alias-border-l3,#dce0e4);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 14px 36px #0002;padding:10px;font-size:13px;line-height:1.4}
  .cm-history-top,.cm-history-search,.cm-history-row{display:flex;align-items:center;gap:6px}
  .cm-history-top{position:relative;margin-bottom:8px}
  .cm-history-top select{flex:1;min-width:0;height:32px;border:0;border-radius:5px;background:transparent;color:inherit;font-weight:600;padding:0 6px}
  .cm-history-advanced,.cm-history-menu{position:absolute;z-index:2;right:0;min-width:145px;border:1px solid var(--dsw-alias-border-l3,#dce0e4);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 8px 20px #0002;padding:4px}
  .cm-history-advanced{top:34px}.cm-history-menu{position:static;width:100%;margin:4px 0}
  .cm-history-advanced button,.cm-history-menu button{width:100%;min-height:30px;text-align:left;border:0;border-radius:4px;background:transparent;padding:5px 8px}
  .cm-history-advanced button:hover,.cm-history-menu button:hover,.cm-history-row:hover{background:var(--dsw-alias-interactive-bg-hover,#edf1f4)}
  .cm-history-search{height:36px;border:1px solid var(--dsw-alias-border-l3,#dce0e4);border-radius:5px;padding:0 10px}
  .cm-history-search input{flex:1;min-width:0;border:0;outline:none;background:transparent;color:inherit}
  .cm-history-heading{margin:12px 7px 4px;color:var(--dsw-alias-label-tertiary,#7b858e);font-size:12px}
  .cm-history-list{max-height:260px;overflow:auto}
  .cm-history-row{flex-wrap:wrap;position:relative;min-height:34px;border-radius:5px;padding:0 6px}
  .cm-history-row.active{background:var(--dsw-alias-interactive-bg-active,#dcecf8)}
  .cm-history-row>span,.cm-history-row>button:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;border:0;background:transparent;padding:5px 3px}
  .cm-history-row small{flex:none;color:var(--dsw-alias-label-tertiary,#7b858e)}
  .cm-history-row .cm-history-icon{opacity:0;width:27px;height:27px}
  .cm-history-row:hover .cm-history-icon,.cm-history-row:focus-within .cm-history-icon{opacity:1}
  .cm-history-archive{border-top:1px solid var(--dsw-alias-border-l3,#dce0e4);margin-top:8px;padding-top:7px}
  .cm-history-archive>button{width:100%;min-height:33px;display:flex;align-items:center;gap:7px;border:0;border-radius:5px;background:transparent;padding:5px 8px;text-align:left}
  .cm-history-archive>button:hover{background:var(--dsw-alias-interactive-bg-hover,#edf1f4)}
  .cm-history-archive>button span{flex:1}
  .cm-history-status{margin:7px 5px;color:var(--dsw-alias-label-secondary,#65717b)}
  .cm-history-dialog{position:relative;z-index:3;margin:8px 0;display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l3,#dce0e4);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);padding:15px;box-shadow:0 8px 22px #0002}
  .cm-history-dialog input{height:35px;border:1px solid var(--dsw-alias-border-l3,#dce0e4);border-radius:5px;background:transparent;color:inherit;padding:0 9px}
  .cm-history-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:auto}
  .cm-history-dialog-actions button{border:1px solid var(--dsw-alias-border-l3,#dce0e4);border-radius:5px;background:transparent;padding:6px 10px}
`

type Snapshot<T> = { getSnapshot(): T; subscribe(listener: () => void): () => void }
type Session = { id: string; title?: string; displayTitle: string; updatedAt: number; blank: boolean; origin?: string }
type SessionList = { ids: readonly string[]; byId: Readonly<Record<string, Session>>; phase: 'pending' | 'ready' }
type SearchItem = { sessionId: string; snippet: string }
type SearchReply = { ok: true; value: { items: readonly SearchItem[]; hasMore: boolean } } | { ok: false; error: { message: string } }
type WorkspaceList = {
  items: readonly { workspaceId: string; title: string; createdAt: string; sessionIds: readonly string[] }[]
  archivedSessionIds: readonly string[]
  pinnedSessionIds: readonly string[]
  phase: 'pending' | 'ready'
  state: 'idle' | 'loading' | 'error'
}

export function registerWorkspaceHistory(ctx: ClientContext): () => void {
  const style = document.createElement('style')
  style.dataset.clinmeshHistoryStyles = ''
  style.textContent = historyStyles
  document.head.append(style)
  const workspace = ctx.get('uiWorkspace') as unknown as {
    startSession(workspaceId?: string): void
    openSession(sessionId: string): void
    unarchiveSession(sessionId: string): Promise<void>
    openWorkspace(workspaceId: string): Promise<void>
    pinSession(sessionId: string): Promise<void>
    unpinSession(sessionId: string): Promise<void>
    forkSession(sessionId: string): Promise<string>
    archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
  }
  const sessions = ctx.get('sessions') as unknown as {
    list: Snapshot<SessionList>
    searchResultLimit: number
    using(
      sessionId: string,
      options: { source: 'workspaceOperation' },
      operation: (reference: { binding: { session: { rename(title: string): Promise<{ ok: boolean; error?: { message: string } }> } } }) => Promise<{ ok: boolean; error?: { message: string } }>,
    ): Promise<{ ok: boolean; error?: { message: string } }>
    search(query: string, signal: AbortSignal): Promise<SearchReply>
  }
  const workspaces = ctx.get('workspaces') as unknown as {
    list: Snapshot<WorkspaceList>
    create(input: { path: string }): Promise<{ workspaceId: string }>
    rename(workspaceId: string, title: string): Promise<unknown>
    delete(workspaceId: string): Promise<void>
  }
  const current = (ctx.get('uiSession') as unknown as {
    adapter: { current: Snapshot<{ key: string | undefined }> }
  }).adapter.current
  const locale = ctx.get('locale') as unknown as ClientLocalePort
  const subscribeLocale = (listener: () => void) => locale.subscribe(listener)
  const getLocale = () => normalizeHostLocale(locale.getLocale().active)
  const subscribeSessions = (listener: () => void) => sessions.list.subscribe(listener)
  const getSessions = () => sessions.list.getSnapshot()
  const subscribeWorkspaces = (listener: () => void) => workspaces.list.subscribe(listener)
  const getWorkspaces = () => workspaces.list.getSnapshot()
  const subscribeCurrent = (listener: () => void) => current.subscribe(listener)
  const getCurrent = () => current.getSnapshot()

  const subscribeDirectoryFlow = (listener: () => void) => ctx.slots.subscribe('clinmesh.history.directoryFlow', listener)
  const hasDirectoryFlow = () => ctx.slots.entriesOfSlot('clinmesh.history.directoryFlow').length > 0

  function HistoryControls({ renderSlot }: PropsRenderSlots<'clinmesh.history.directoryFlow'>) {
    const language = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
    const text = (zh: string, en: string) => language === 'zh-CN' ? zh : en
    const host = useRef<HTMLDivElement>(null)
    const trigger = useRef<HTMLButtonElement>(null)
    const generation = useRef(0)
    const pickingDirectory = useRef(false)
    const pickerGeneration = useRef(0)
    const [pickerOpen, setPickerOpen] = useState(false)
    const directoryAvailable = useSyncExternalStore(subscribeDirectoryFlow, hasDirectoryFlow, hasDirectoryFlow)
    const [open, setOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [advancedOpen, setAdvancedOpen] = useState(false)
    const [manageOpen, setManageOpen] = useState(false)
    const [workspaceAction, setWorkspaceAction] = useState<{ kind: 'rename' | 'delete'; id: WorkspaceList['items'][number]['workspaceId'] } | null>(null)
    const [workspaceDraft, setWorkspaceDraft] = useState('')
    const [menuSession, setMenuSession] = useState<string | null>(null)
    const [pendingArchive, setPendingArchive] = useState<Session['id'] | null>(null)
    const [renameTarget, setRenameTarget] = useState<Session | null>(null)
    const [renameDraft, setRenameDraft] = useState('')
    const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [query, setQuery] = useState('')
    const [contentSearch, setContentSearch] = useState<{
      query: string
      items: readonly SearchItem[]
      hasMore: boolean
      status: 'loading' | 'ready' | 'error'
    }>({ query: '', items: [], hasMore: false, status: 'ready' })
    const sessionList = useSyncExternalStore(subscribeSessions, getSessions, getSessions)
    const workspaceList = useSyncExternalStore(subscribeWorkspaces, getWorkspaces, getWorkspaces)
    const currentId = useSyncExternalStore(subscribeCurrent, getCurrent, getCurrent).key
    const previousSession = useRef(currentId)
    const archived = new Set(workspaceList.archivedSessionIds)
    const pinned = new Set(workspaceList.pinnedSessionIds)
    const search = query.trim().toLocaleLowerCase()
    const currentWorkspace = workspaceList.items.find((item) => item.sessionIds.some((id) => id === currentId))
    let latestWorkspace: WorkspaceList['items'][number] | undefined
    let latestTime = Number.NEGATIVE_INFINITY
    for (const item of workspaceList.items) {
      const activity = item.sessionIds.reduce((latest, id) =>
        Math.max(latest, sessionList.byId[id]?.updatedAt ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY)
      const time = activity === Number.NEGATIVE_INFINITY ? Date.parse(item.createdAt) : activity
      if (!latestWorkspace || time > latestTime) { latestWorkspace = item; latestTime = time }
    }
    const selected = workspaceList.items.find((item) => item.workspaceId === selectedWorkspace)
    const workspaceId = selectedWorkspace === 'all'
      ? 'all' : selected?.workspaceId ?? currentWorkspace?.workspaceId ?? latestWorkspace?.workspaceId ?? 'all'
    const workspaceInfo = workspaceList.items.find((item) => item.workspaceId === workspaceId)
    const close = () => {
      generation.current += 1
      setOpen(false)
      setPickerOpen(false)
      pickingDirectory.current = false
      setBusy(false)
      setAdvancedOpen(false)
      setManageOpen(false)
      setMenuSession(null)
      setWorkspaceAction(null)
      setRenameTarget(null)
      setPendingArchive(null)
      setError('')
    }
    useEffect(() => () => { generation.current += 1 }, [])
    useEffect(() => {
      if (!directoryAvailable && pickerOpen) {
        setPickerOpen(false)
        pickingDirectory.current = false
        setError(text('目录选择器不可用，请稍后重试。', 'Directory picker unavailable. Try again later.'))
      }
    }, [directoryAvailable, pickerOpen])
    useEffect(() => {
      if (previousSession.current !== currentId) {
        previousSession.current = currentId
        close()
      }
    }, [currentId])
    useEffect(() => {
      if (!open) return
      host.current?.querySelector<HTMLElement>('[data-history-panel] select')?.focus()
      return () => { trigger.current?.focus() }
    }, [open])
    useEffect(() => {
      if (!open) return
      const region = host.current?.querySelector<HTMLElement>('[data-history-form], [data-history-menu]')
      if (!region) return
      const active = document.activeElement
      const previous = active instanceof HTMLElement && active !== document.body ? active : trigger.current
      region.querySelector<HTMLElement>('input,select,button:not(:disabled)')?.focus()
      return () => {
        if (previous?.isConnected) previous.focus()
        else trigger.current?.focus()
      }
    }, [open, workspaceAction, renameTarget, pendingArchive, menuSession, advancedOpen])
    useEffect(() => {
      if (!open) return
      const dialog = host.current?.querySelector<HTMLElement>('[data-history-form]')
      const outside = (event: PointerEvent) => {
        if (pickingDirectory.current) return
        if (event.target instanceof Node && !host.current?.contains(event.target)) close()
      }
      const keyboard = (event: KeyboardEvent) => {
        if (pickingDirectory.current) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (dialog) {
            setWorkspaceAction(null); setRenameTarget(null); setPendingArchive(null); setError('')
          } else if (menuSession !== null) setMenuSession(null)
          else if (advancedOpen) { setAdvancedOpen(false); setManageOpen(false) }
          else close()
        }
        if (event.key === 'Tab' && dialog) {
          const controls = Array.from(dialog.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)'))
          if (controls.length === 0) { event.preventDefault(); dialog.focus(); return }
          const next = event.shiftKey ? controls.at(-1) : controls[0]
          if ((event.shiftKey && document.activeElement === controls[0]) || (!event.shiftKey && document.activeElement === controls.at(-1))) {
            event.preventDefault(); next?.focus()
          }
        }
      }
      document.addEventListener('pointerdown', outside)
      document.addEventListener('keydown', keyboard, true)
      return () => {
        document.removeEventListener('pointerdown', outside)
        document.removeEventListener('keydown', keyboard, true)
      }
    }, [open, workspaceAction, renameTarget, pendingArchive, menuSession, advancedOpen])
    useEffect(() => {
      if (!open || search === '') return
      const controller = new AbortController()
      setContentSearch({ query: search, items: [], hasMore: false, status: 'loading' })
      const timer = window.setTimeout(() => {
        void sessions.search(query.trim(), controller.signal).then((result) => {
          if (controller.signal.aborted) return
          setContentSearch(result.ok
            ? { query: search, items: result.value.items, hasMore: result.value.hasMore, status: 'ready' }
            : { query: search, items: [], hasMore: false, status: 'error' })
        }).catch(() => {
          if (!controller.signal.aborted) setContentSearch({ query: search, items: [], hasMore: false, status: 'error' })
        })
      }, 250)
      return () => { window.clearTimeout(timer); controller.abort() }
    }, [open, query, search])
    const contentHits = new Map(contentSearch.query === search ? contentSearch.items.map((item) => [item.sessionId, item.snippet]) : [])
    const localMatch = (session: Session) => session.displayTitle.toLocaleLowerCase().includes(search) ||
      workspaceList.items.some((item) => item.sessionIds.includes(session.id) && item.title.toLocaleLowerCase().includes(search))
    const memberIds = workspaceId === 'all' ? null : new Set(workspaceList.items.find((item) => item.workspaceId === workspaceId)?.sessionIds)
    const visible = sessionList.ids.map((id) => sessionList.byId[id]).filter((session): session is Session =>
      session !== undefined && (!session.blank || session.id === currentId || archived.has(session.id)) && session.origin !== 'subagent' &&
      (memberIds === null || memberIds.has(session.id)) && (search === '' || localMatch(session) || contentHits.has(session.id)))
    const sorted = visible.sort((a, b) => search === ''
      ? Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || b.updatedAt - a.updatedAt
      : Number(localMatch(b)) - Number(localMatch(a)) || (localMatch(a) ? b.updatedAt - a.updatedAt :
        contentSearch.items.findIndex((item) => item.sessionId === a.id) - contentSearch.items.findIndex((item) => item.sessionId === b.id)))
    const limit = sessions.searchResultLimit
    const shown = search === '' ? sorted : sorted.slice(0, limit)
    const recent = shown.filter((session) => !archived.has(session.id))
    const archivedSessions = shown.filter((session) => archived.has(session.id))
    const archiveExpanded = archiveOpen || (search !== '' && archivedSessions.length > 0)
    const run = async (operation: (isCurrent: () => boolean) => Promise<void>) => {
      if (busy) return
      const version = generation.current
      const selection = current.getSnapshot().key
      const isCurrent = () => version === generation.current && selection === current.getSnapshot().key
      setBusy(true)
      setError('')
      try { await operation(isCurrent) }
      catch (cause) {
        if (version === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (version === generation.current) setBusy(false)
      }
    }
    const addWorkspace = (path: string) => {
      if (pickerGeneration.current !== generation.current) return
      setPickerOpen(false)
      pickingDirectory.current = false
      void run(async (isCurrent) => {
        const created = await workspaces.create({ path })
        if (!isCurrent()) return
        setSelectedWorkspace(created.workspaceId)
        await workspace.openWorkspace(created.workspaceId)
        if (isCurrent()) close()
      })
    }
    const runWorkspaceAction = () => run(async (isCurrent) => {
      if (!workspaceAction) return
      const target = workspaceAction
      if (target.kind === 'rename') await workspaces.rename(target.id, workspaceDraft.trim())
      else await workspaces.delete(target.id)
      if (!isCurrent()) return
      if (target.kind === 'delete') setSelectedWorkspace('all')
      setWorkspaceAction(null)
    })
    const beginWorkspaceAction = (kind: 'rename' | 'delete') => {
      if (!workspaceInfo) return
      setWorkspaceDraft(workspaceInfo.title)
      setWorkspaceAction({ kind, id: workspaceInfo.workspaceId })
      setManageOpen(false)
    }
    const runSessionAction = (action: 'pin' | 'fork' | 'archive' | 'restore', sessionId: Session['id']) => run(async (isCurrent) => {
      if (action === 'pin') await (pinned.has(sessionId) ? workspace.unpinSession(sessionId) : workspace.pinSession(sessionId))
      else if (action === 'fork') {
        const child = await workspace.forkSession(sessionId)
        if (isCurrent()) { workspace.openSession(child); close() }
      } else if (action === 'restore') await workspace.unarchiveSession(sessionId)
      else {
        try { await workspace.archiveSession(sessionId) }
        catch (cause) {
          if (isCurrent() && (cause as { rpcError?: { code?: string } } | null)?.rpcError?.code === 'workspace/session-active') {
            setPendingArchive(sessionId)
            return
          }
          throw cause
        }
      }
      if (isCurrent()) setMenuSession(null)
    })
    const renameSession = () => run(async (isCurrent) => {
      if (!renameTarget) return
      const result = await sessions.using(renameTarget.id, { source: 'workspaceOperation' },
        (reference) => reference.binding.session.rename(renameDraft.trim()))
      if (!result.ok) throw new Error(result.error?.message ?? text('重命名失败', 'Rename failed'))
      if (isCurrent()) setRenameTarget(null)
    })
    const stopAndArchive = () => run(async (isCurrent) => {
      if (!pendingArchive) return
      await workspace.archiveSession(pendingArchive, { stopActivity: true })
      if (isCurrent()) { setPendingArchive(null); setMenuSession(null) }
    })
    const formOpen = workspaceAction !== null || renameTarget !== null || pendingArchive !== null
    return <div data-clinmesh-history="" ref={host}>
      <button ref={trigger} className="cm-history-icon" type="button" title={text('会话历史', 'Session history')} aria-label={text('会话历史', 'Session history')} aria-expanded={open} onClick={() => { if (open) close(); else { setSelectedWorkspace(null); setOpen(true) } }}><HistoryIcon size={18} aria-hidden="true" /></button>
      <button className="cm-history-icon" type="button" title={text('新会话', 'New session')} aria-label={text('新会话', 'New session')} onClick={() => { workspace.startSession(open && workspaceId !== 'all' ? workspaceId : undefined); close() }}><PlusIcon size={20} aria-hidden="true" /></button>
      {renderSlot('clinmesh.history.directoryFlow', {
        open: pickerOpen, busy,
        onPicked: addWorkspace,
        onCancel: () => { setPickerOpen(false); pickingDirectory.current = false },
        onError: (message) => { setPickerOpen(false); pickingDirectory.current = false; setError(message) },
      })}
      {open && <div className="cm-history-panel" data-history-panel="" role="dialog" aria-label={text('工作区与会话', 'Workspaces and sessions')}>
        <div hidden={formOpen}>
          <div className="cm-history-top">
            <select aria-label={text('选择工作区', 'Select workspace')} value={workspaceId} disabled={busy} onChange={(event) => { setSelectedWorkspace(event.target.value); setMenuSession(null) }}>
              <option value="all">{text('全部工作区', 'All workspaces')}</option>
              {workspaceList.items.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.title}</option>)}
            </select>
            <button className="cm-history-icon" type="button" aria-label={text('更多选项', 'More options')} aria-expanded={advancedOpen} onClick={() => { setMenuSession(null); setAdvancedOpen(!advancedOpen) }}><MoreHorizontalIcon size={18} aria-hidden="true" /></button>
            {advancedOpen && <div className="cm-history-advanced" data-history-menu="">
              <button type="button" aria-label={text('新增工作区', 'Add workspace')} disabled={busy || !directoryAvailable} title={directoryAvailable ? undefined : text('目录选择器不可用', 'Directory picker unavailable')} onClick={() => { pickerGeneration.current = generation.current; pickingDirectory.current = true; setPickerOpen(true) }}>{text('新增工作区', 'Add workspace')}</button>
              <button type="button" aria-label={text('管理工作区', 'Manage workspace')} disabled={busy || workspaceId === 'all'} onClick={() => setManageOpen(!manageOpen)}>{text('管理工作区', 'Manage workspace')}</button>
              {manageOpen && <div>
                <button type="button" aria-label={text('重命名工作区', 'Rename workspace')} onClick={() => beginWorkspaceAction('rename')}>{text('重命名', 'Rename')}</button>
                <button type="button" aria-label={text('删除工作区', 'Delete workspace')} onClick={() => beginWorkspaceAction('delete')}>{text('删除', 'Delete')}</button>
              </div>}
            </div>}
          </div>
          <label className="cm-history-search"><SearchIcon size={15} aria-hidden="true" /><input aria-label={text('搜索会话', 'Search sessions')} placeholder={text('搜索会话', 'Search sessions')} type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <p className="cm-history-heading">{text('最近会话', 'Recent sessions')}</p>
          <div className="cm-history-list">
            {sessionList.phase === 'pending' || workspaceList.phase === 'pending'
              ? <p className="cm-history-status" role="status">{text('正在加载会话', 'Loading sessions')}</p>
              : recent.length === 0 ? <p className="cm-history-status">{text('暂无会话', 'No sessions')}</p> : recent.map((session) =>
                <div className={`cm-history-row${session.id === currentId ? ' active' : ''}`} key={session.id}>
                  <button type="button" title={session.displayTitle} aria-current={session.id === currentId ? 'true' : undefined} disabled={busy} onClick={() => { workspace.openSession(session.id); close() }}>{session.displayTitle || text('新会话', 'New session')}</button>
                  {pinned.has(session.id) && <small aria-label={text('已置顶', 'Pinned')}>↑</small>}
                  <button className="cm-history-icon" type="button" aria-label={text(`${session.displayTitle}的操作`, `Actions for ${session.displayTitle}`)} aria-expanded={menuSession === session.id} onClick={() => { setAdvancedOpen(false); setMenuSession(menuSession === session.id ? null : session.id) }}><MoreHorizontalIcon size={16} aria-hidden="true" /></button>
                  {contentHits.has(session.id) && <p className="cm-history-status" style={{ width: '100%', margin: '0 3px 6px' }}>{contentHits.get(session.id)}</p>}
                  {menuSession === session.id && <div className="cm-history-menu" data-history-menu="">
                    <button type="button" disabled={busy} onClick={() => { setRenameTarget(session); setRenameDraft(session.title ?? ''); setMenuSession(null) }}>{text('重命名', 'Rename')}</button>
                    <button type="button" disabled={busy} onClick={() => { void runSessionAction('pin', session.id) }}>{pinned.has(session.id) ? text('取消置顶', 'Unpin') : text('置顶', 'Pin')}</button>
                    <button type="button" disabled={busy} onClick={() => { void runSessionAction('fork', session.id) }}>Fork</button>
                    <button type="button" disabled={busy} onClick={() => { void runSessionAction('archive', session.id) }}>{text('归档', 'Archive')}</button>
                  </div>}
                </div>,
              )}
          </div>
          {workspaceList.state === 'error' && <p role="alert" className="cm-history-status">{text('工作区暂不可用，请稍后重试。', 'Workspaces unavailable. Try again later.')}</p>}
          {search !== '' && contentSearch.query === search && <>
            {contentSearch.status === 'loading' && <p role="status" className="cm-history-status">{text('正在搜索内容…', 'Searching content…')}</p>}
            {contentSearch.status === 'error' && <p role="status" className="cm-history-status">{text('内容搜索暂不可用，仍显示标题与工作区匹配项。', 'Content search unavailable. Showing title and workspace matches.')}</p>}
            {(contentSearch.hasMore || sorted.length > limit) && <p role="status" className="cm-history-status">{text('还有更多结果，请缩小搜索范围。', 'More results available. Refine your search.')}</p>}
          </>}
          <div className="cm-history-archive">
            <button type="button" aria-expanded={archiveExpanded} onClick={() => setArchiveOpen(!archiveOpen)}><ChevronRightIcon size={15} aria-hidden="true" style={{ transform: archiveExpanded ? 'rotate(90deg)' : undefined }} /><span>{text('已归档会话', 'Archived sessions')}</span><small>{search !== '' ? archivedSessions.length : visible.filter((session) => archived.has(session.id)).length}</small></button>
            {archiveExpanded && <div className="cm-history-list">{archivedSessions.length === 0 ? <p className="cm-history-status">{text('暂无归档会话', 'No archived sessions')}</p> : archivedSessions.map((session) =>
              <div className="cm-history-row" key={session.id}>
                <span title={session.displayTitle}>{session.displayTitle}</span>
                <button type="button" aria-label={text(`恢复${session.displayTitle}`, `Restore ${session.displayTitle}`)} disabled={busy} onClick={() => { void runSessionAction('restore', session.id) }}>{text('恢复', 'Restore')}</button>
                {contentHits.has(session.id) && <p className="cm-history-status">{contentHits.get(session.id)}</p>}
              </div>,
            )}</div>}
          </div>
        </div>
        {workspaceAction && <form className="cm-history-dialog" data-history-form="" tabIndex={-1} role="dialog" aria-label={workspaceAction.kind === 'rename' ? text('重命名工作区', 'Rename workspace') : text('删除工作区', 'Delete workspace')} onSubmit={(event) => { event.preventDefault(); void runWorkspaceAction() }}>
          <strong>{workspaceAction.kind === 'rename' ? text('重命名工作区', 'Rename workspace') : text('删除工作区', 'Delete workspace')}</strong>
          {workspaceAction.kind === 'rename'
            ? <input aria-label={text('工作区名称', 'Workspace name')} disabled={busy} value={workspaceDraft} onChange={(event) => setWorkspaceDraft(event.target.value)} />
            : <p>{text('只移除工作区注册，不删除会话或文件。', 'Remove the workspace registration only. Sessions and files are preserved.')}</p>}
          <div className="cm-history-dialog-actions">
            <button type="button" disabled={busy} onClick={() => setWorkspaceAction(null)}>{text('取消', 'Cancel')}</button>
            <button type="submit" aria-label={workspaceAction.kind === 'rename' ? text('保存工作区名称', 'Save workspace name') : text('确认删除工作区', 'Confirm workspace deletion')} disabled={busy || (workspaceAction.kind === 'rename' && workspaceDraft.trim() === '')}>{workspaceAction.kind === 'rename' ? text('保存', 'Save') : text('确认删除', 'Delete')}</button>
          </div>
        </form>}
        {renameTarget && <form className="cm-history-dialog" data-history-form="" tabIndex={-1} role="dialog" aria-label={text('重命名会话', 'Rename session')} onSubmit={(event) => { event.preventDefault(); void renameSession() }}>
          <strong>{text('重命名会话', 'Rename session')}</strong>
          <input aria-label={text('会话名称', 'Session name')} disabled={busy} value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} />
          <div className="cm-history-dialog-actions">
            <button type="button" disabled={busy} onClick={() => setRenameTarget(null)}>{text('取消', 'Cancel')}</button>
            <button type="submit" disabled={busy || renameDraft.trim() === ''}>{text('保存', 'Save')}</button>
          </div>
        </form>}
        {pendingArchive && <div className="cm-history-dialog" data-history-form="" tabIndex={-1} role="alertdialog" aria-label={text('归档运行中的会话', 'Archive active session')}>
          <p>{text('会话仍在运行。停止其任务后归档？', 'This session is active. Stop its tasks and archive it?')}</p>
          <div className="cm-history-dialog-actions">
            <button type="button" disabled={busy} onClick={() => { setPendingArchive(null); setError('') }}>{text('取消', 'Cancel')}</button>
            <button type="button" aria-label={text('停止并归档', 'Stop and archive')} disabled={busy} onClick={() => { void stopAndArchive() }}>{text('停止并归档', 'Stop and archive')}</button>
          </div>
        </div>}
        {error && <p role="alert" className="cm-history-status">{error}</p>}
      </div>}
    </div>
  }

  const dispose = ctx.slots.inject('conversation.header.leading', () => {
    const disposeHeader = ctx.slots.register({
      name: 'conversation.header.leading', priority: -100,
      children: { 'clinmesh.history.directoryFlow': { kind: 'single', scope: 'root' } },
    }, HistoryControls)
    const disposeFlow = registerDirectoryFlow(ctx)
    return () => { disposeFlow(); disposeHeader() }
  })
  return () => { dispose(); style.remove() }
}
