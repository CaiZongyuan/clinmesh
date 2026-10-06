// @vitest-environment jsdom
import { act, useEffect, useRef, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerWorkspaceHistory } from './workspace-history.tsx'
import type { DirectoryFlowOwner } from './directory-flow.tsx'

const emptyCurrentSession = { key: undefined }
const uiSession = { adapter: { current: { getSnapshot: () => emptyCurrentSession, subscribe: () => () => {} } } }
const locale = { getLocale: () => ({ active: 'zh-CN' }), subscribe: () => () => {} }

function NativeDirectoryFlow({ open, pick, ...owner }: DirectoryFlowOwner & { pick(): Promise<string | null> }) {
  const outcome = useRef(owner)
  outcome.current = owner
  useEffect(() => {
    if (!open) return
    let live = true
    void pick().then((path) => {
      if (live) { if (path === null) outcome.current.onCancel(); else outcome.current.onPicked(path) }
    }, (error: unknown) => { if (live) outcome.current.onError(String(error)) })
    return () => { live = false }
  }, [open, pick])
  return null
}

async function mountHistory(services: Record<string, unknown>) {
  type HeaderProps = { renderSlot(name: string, owner: DirectoryFlowOwner): ReactNode }
  let Header: ComponentType<HeaderProps> = () => null
  let flow: { component: ComponentType<DirectoryFlowOwner>; inject: (() => object) | undefined } | undefined
  const source = { component: NativeDirectoryFlow, inject: () => ({ pick: (services.uiWorkspace as { pickDirectory(): Promise<string | null> }).pickDirectory }) }
  const renderSlot = (_name: string, owner: DirectoryFlowOwner) => {
    if (!flow) return null
    const Flow = flow.component
    return <Flow {...owner} {...flow.inject?.()} />
  }
  const ctx = {
    get: (name: string) => ({ uiSession, locale, ...services })[name],
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register: (entry: { name: string; inject?: () => object }, component: unknown) => {
        if (entry.name === 'conversation.header.leading') Header = component as ComponentType<HeaderProps>
        else flow = { component: component as ComponentType<DirectoryFlowOwner>, inject: entry.inject }
        return () => { if (entry.name !== 'conversation.header.leading') flow = undefined }
      },
      entries: () => flow ? [flow] : [],
      entriesOfSlot: () => [source],
      subscribe: () => () => {},
    },
  }
  const dispose = registerWorkspaceHistory(ctx as unknown as Context)
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  await act(() => root.render(<Header renderSlot={renderSlot} />))
  return {
    element,
    click: async (label: string) => act(() => {
      const button = element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
      button.focus()
      button.click()
    }),
    search: async (value: string) => act(() => {
      const input = element.querySelector<HTMLInputElement>('[aria-label="搜索会话"]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }),
    dispose: async () => {
      await act(() => root.unmount())
      element.remove()
      dispose()
      vi.unstubAllGlobals()
    },
  }
}

function historyLists() {
  const sessions = { ids: ['session-1', 'session-2'], byId: {
    'session-1': { id: 'session-1', displayTitle: '合成门诊讨论', updatedAt: 12, blank: false },
    'session-2': { id: 'session-2', displayTitle: '合成住院讨论', updatedAt: 8, blank: false },
  }, phase: 'ready' }
  const workspaces = { items: [{ workspaceId: 'workspace-1', title: 'clinmesh', sessionIds: ['session-1', 'session-2'] }], archivedSessionIds: [] as string[], pinnedSessionIds: [], phase: 'ready', state: 'idle' }
  return { sessions, workspaces }
}

function snapshot<T>(value: T) {
  return { getSnapshot: () => value, subscribe: () => () => {} }
}

it('defaults to the current session workspace and keeps its blank session reachable', async () => {
  const { sessions, workspaces } = historyLists()
  sessions.byId['session-2'].blank = true
  workspaces.items = [
    { workspaceId: 'workspace-1', title: '门诊', sessionIds: ['session-1'] },
    { workspaceId: 'workspace-2', title: '住院', sessionIds: ['session-2'] },
  ]
  const openSession = vi.fn()
  const sessionStore = {
    value: sessions,
    listeners: new Set<() => void>(),
    getSnapshot() { return this.value },
    subscribe(listener: () => void) {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }
  const history = await mountHistory({
    uiSession: { adapter: { current: snapshot({ key: 'session-2' }) } },
    uiWorkspace: { startSession() {}, openSession },
    sessions: { searchResultLimit: 20, list: sessionStore },
    workspaces: { list: snapshot(workspaces) },
  })
  try {
    await history.click('会话历史')
    expect(history.element.querySelector<HTMLSelectElement>('[aria-label="选择工作区"]')!.value).toBe('workspace-2')
    expect(history.element.textContent).toContain('合成住院讨论')
    expect(history.element.textContent).not.toContain('合成门诊讨论')
    await act(() => [...history.element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '合成住院讨论')!.click())
    expect(openSession).toHaveBeenCalledWith('session-2')
  } finally {
    await history.dispose()
  }
})

it('defaults to a newer empty workspace and starts a session in that selected workspace', async () => {
  const startSession = vi.fn()
  const sessions = { ids: ['old-session'], byId: {
    'old-session': { id: 'old-session', displayTitle: '旧工作区合成讨论', updatedAt: Date.parse('2026-09-01T00:00:00Z'), blank: false },
  }, phase: 'ready' }
  const workspaces = {
    items: [
      { workspaceId: 'workspace-old', title: '旧工作区', createdAt: '2026-08-01T00:00:00Z', sessionIds: ['old-session'] },
      { workspaceId: 'workspace-new', title: '新空工作区', createdAt: '2026-10-01T00:00:00Z', sessionIds: [] },
    ],
    archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready', state: 'idle',
  }
  const history = await mountHistory({
    uiWorkspace: { startSession },
    sessions: { searchResultLimit: 20, list: snapshot(sessions) },
    workspaces: { list: snapshot(workspaces) },
  })
  try {
    await history.click('会话历史')
    expect(history.element.querySelector<HTMLSelectElement>('[aria-label="选择工作区"]')!.value).toBe('workspace-new')
    await history.click('新会话')
    expect(startSession).toHaveBeenCalledWith('workspace-new')
  } finally {
    await history.dispose()
  }
})

it('cancels obsolete content searches and ignores their late results', async () => {
  const { sessions, workspaces } = historyLists()
  type Reply = { ok: true; value: { items: { sessionId: string; snippet: string }[]; hasMore: boolean } }
  const requests: { signal: AbortSignal; resolve(reply: Reply): void }[] = []
  const search = vi.fn((_query: string, signal: AbortSignal) => new Promise<Reply>((resolve) => requests.push({ signal, resolve })))
  const history = await mountHistory({
    uiWorkspace: { startSession() {} },
    sessions: { searchResultLimit: 20, list: snapshot(sessions), search },
    workspaces: { list: snapshot(workspaces) },
  })
  vi.useFakeTimers()
  try {
    await history.click('会话历史')
    await history.search('过期内容')
    await act(() => vi.advanceTimersByTimeAsync(250))
    expect(requests).toHaveLength(1)
    await history.search('最新内容')
    expect(requests[0]!.signal.aborted).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(250))
    await act(() => requests[1]!.resolve({ ok: true, value: { items: [{ sessionId: 'session-2', snippet: '最新搜索片段' }], hasMore: false } }))
    expect(history.element.textContent).toContain('合成住院讨论')
    await act(() => requests[0]!.resolve({ ok: true, value: { items: [{ sessionId: 'session-1', snippet: '过期搜索片段' }], hasMore: false } }))
    expect(history.element.textContent).toContain('最新搜索片段')
    expect(history.element.textContent).not.toContain('合成门诊讨论')
    expect(history.element.textContent).not.toContain('过期搜索片段')
    await history.search('关闭后内容')
    await act(() => vi.advanceTimersByTimeAsync(250))
    await history.click('会话历史')
    expect(requests[2]!.signal.aborted).toBe(true)
    expect(history.element.querySelector('[role="dialog"]')).toBeNull()
  } finally {
    vi.useRealTimers()
    await history.dispose()
  }
})

it('keeps the archived session visible and reports a failed restore', async () => {
  const { sessions, workspaces } = historyLists()
  sessions.byId['session-2'].blank = true
  workspaces.archivedSessionIds = ['session-2']
  const unarchiveSession = vi.fn(async () => { throw new Error('恢复失败，请重试') })
  const history = await mountHistory({
    uiWorkspace: { startSession() {}, unarchiveSession },
    sessions: { searchResultLimit: 20, list: snapshot(sessions) },
    workspaces: { list: snapshot(workspaces) },
  })
  try {
    await history.click('会话历史')
    await act(() => [...history.element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('已归档会话'))!.click())
    expect(history.element.textContent).toContain('合成住院讨论')
    await history.click('恢复合成住院讨论')
    expect(unarchiveSession).toHaveBeenCalledWith('session-2')
    expect(history.element.querySelector('[role="alert"]')?.textContent).toContain('恢复失败，请重试')
    expect(history.element.textContent).toContain('合成住院讨论')
    expect(history.element.querySelector<HTMLButtonElement>('[aria-label="恢复合成住院讨论"]')!.disabled).toBe(false)
  } finally {
    await history.dispose()
  }
})

it('closes history on Escape or an outside pointer and returns focus to its trigger', async () => {
  const { sessions, workspaces } = historyLists()
  const history = await mountHistory({
    uiWorkspace: { startSession() {} },
    sessions: { searchResultLimit: 20, list: snapshot(sessions) },
    workspaces: { list: snapshot(workspaces) },
  })
  try {
    const trigger = history.element.querySelector<HTMLButtonElement>('[aria-label="会话历史"]')!
    await history.click('会话历史')
    history.element.querySelector<HTMLInputElement>('[aria-label="搜索会话"]')!.focus()
    await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(history.element.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    await history.click('会话历史')
    history.element.querySelector<HTMLInputElement>('[aria-label="搜索会话"]')!.focus()
    await act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(history.element.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  } finally {
    await history.dispose()
  }
})

it('ignores a late fork after history has been closed and reopened', async () => {
  const { sessions, workspaces } = historyLists()
  let finishFork: (sessionId: string) => void = () => {}
  const forkSession = vi.fn(() => new Promise<string>((resolve) => { finishFork = resolve }))
  const openSession = vi.fn()
  const history = await mountHistory({
    uiWorkspace: { startSession() {}, openSession, forkSession },
    sessions: { searchResultLimit: 20, list: snapshot(sessions) },
    workspaces: { list: snapshot(workspaces) },
  })
  try {
    await history.click('会话历史')
    await history.click('合成门诊讨论的操作')
    await act(() => [...history.element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Fork')!.click())
    expect(forkSession).toHaveBeenCalledWith('session-1')
    await history.click('会话历史')
    await history.click('会话历史')
    await act(() => finishFork('session-child'))
    expect(openSession).not.toHaveBeenCalled()
    expect(history.element.querySelector('[role="dialog"]')).not.toBeNull()
    await act(() => [...history.element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '合成住院讨论')!.click())
    expect(openSession).toHaveBeenCalledWith('session-2')
  } finally {
    await history.dispose()
  }
})

it('opens recent DSH sessions and starts a session from the conversation header', async () => {
  const openSession = vi.fn()
  const startSession = vi.fn()
  const unarchiveSession = vi.fn(async () => {})
  const searchSessions = vi.fn(async () => ({ ok: true, value: { items: [{ sessionId: 'session-1', snippet: '血压 118/78' }], hasMore: false } }))
  const sessions = { ids: ['session-1', 'session-2'], byId: {
    'session-1': { id: 'session-1', displayTitle: '合成门诊讨论', updatedAt: 12, blank: false },
    'session-2': { id: 'session-2', displayTitle: '已归档病例讨论', updatedAt: 8, blank: false },
  }, phase: 'ready' }
  const workspaces = { items: [{ workspaceId: 'workspace-1', title: 'clinmesh', sessionIds: ['session-1', 'session-2'] }], archivedSessionIds: ['session-2'], pinnedSessionIds: [], phase: 'ready', state: 'idle' }
  const { element, dispose } = await mountHistory({
    uiWorkspace: { openSession, startSession, unarchiveSession },
    sessions: { searchResultLimit: 20, list: snapshot(sessions), search: searchSessions },
    workspaces: { list: snapshot(workspaces) },
  })
  try {
    await act(() => element.querySelector<HTMLButtonElement>('[aria-label="会话历史"]')!.click())
    expect(element.textContent).toContain('合成门诊讨论')
    await act(() => [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '合成门诊讨论')!.click())
    expect(openSession).toHaveBeenCalledWith('session-1')
    await act(() => element.querySelector<HTMLButtonElement>('[aria-label="新会话"]')!.click())
    expect(startSession).toHaveBeenCalledOnce()
    await act(() => element.querySelector<HTMLButtonElement>('[aria-label="会话历史"]')!.click())
    expect(element.textContent).not.toContain('已归档病例讨论')
    await act(() => [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('已归档会话'))!.click())
    expect(element.textContent).toContain('已归档病例讨论')
    await act(() => element.querySelector<HTMLButtonElement>('[aria-label="恢复已归档病例讨论"]')!.click())
    expect(unarchiveSession).toHaveBeenCalledWith('session-2')
    const search = element.querySelector<HTMLInputElement>('[aria-label="搜索会话"]')
    expect(search).not.toBeNull()
    const setSearch = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value)
      search!.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await act(() => setSearch('归档'))
    expect(element.textContent).not.toContain('合成门诊讨论')
    expect(element.textContent).toContain('已归档病例讨论')
    await act(() => setSearch('血压'))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
    expect(searchSessions).toHaveBeenCalledWith('血压', expect.any(AbortSignal))
    expect(element.textContent).toContain('合成门诊讨论')
  } finally {
    await dispose()
  }
})

it('adds a DSH workspace through the host directory picker', async () => {
  let finishPicking: (path: string | null) => void = () => {}
  const pickDirectory = vi.fn(() => new Promise<string | null>((resolve) => { finishPicking = resolve }))
  const create = vi.fn(async () => ({ workspaceId: 'workspace-2', title: 'project', sessionIds: [] }))
  const openWorkspace = vi.fn(async () => {})
  const sessions = { ids: [], byId: {}, phase: 'ready' }
  const workspaces = { items: [{ workspaceId: 'workspace-1', title: 'clinmesh', sessionIds: [] }], archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready', state: 'idle' }
  const { element, dispose } = await mountHistory({
    uiWorkspace: { startSession() {}, pickDirectory, openWorkspace },
    sessions: { searchResultLimit: 20, list: snapshot(sessions) },
    workspaces: { list: snapshot(workspaces), create },
  })
  try {
    await act(() => element.querySelector<HTMLButtonElement>('[aria-label="会话历史"]')!.click())
    await act(() => element.querySelector<HTMLButtonElement>('[aria-label="更多选项"]')!.click())
    await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="新增工作区"]')!.click())
    expect(pickDirectory).toHaveBeenCalledOnce()
    await act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(element.querySelector('[role="dialog"]')).not.toBeNull()
    await act(() => finishPicking('/synthetic/project'))
    expect(create).toHaveBeenCalledWith({ path: '/synthetic/project' })
    expect(openWorkspace).toHaveBeenCalledWith('workspace-2')
    await act(() => element.querySelector<HTMLButtonElement>('[aria-label="会话历史"]')!.click())
    await act(() => element.querySelector<HTMLButtonElement>('[aria-label="更多选项"]')!.click())
    await act(() => element.querySelector<HTMLButtonElement>('[aria-label="新增工作区"]')!.click())
    await act(() => finishPicking(null))
    expect(pickDirectory).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledOnce()
    expect(openWorkspace).toHaveBeenCalledOnce()
  } finally {
    await dispose()
  }
})

it('renames and deletes a Workspace registration through DSH', async () => {
  const rename = vi.fn(async () => ({}))
  const remove = vi.fn(async () => {})
  const sessions = { ids: [], byId: {}, phase: 'ready' }
  const workspaces = { items: [{ workspaceId: 'workspace-1', title: 'clinmesh', sessionIds: [] }], archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready', state: 'idle' }
  const { element, dispose } = await mountHistory({
    uiWorkspace: { startSession() {} },
    sessions: { searchResultLimit: 20, list: snapshot(sessions) },
    workspaces: { list: snapshot(workspaces), rename, delete: remove },
  })
  const click = async (label: string) => act(() => element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click())
  try {
    await click('会话历史')
    await click('更多选项')
    await click('管理工作区')
    await click('重命名工作区')
    const name = element.querySelector<HTMLInputElement>('[aria-label="工作区名称"]')!
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '教学工作区')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => click('保存工作区名称'))
    expect(rename).toHaveBeenCalledWith('workspace-1', '教学工作区')
    await click('管理工作区')
    await click('删除工作区')
    await act(async () => click('确认删除工作区'))
    expect(remove).toHaveBeenCalledWith('workspace-1')
  } finally {
    await dispose()
  }
})

it('runs session row actions through DSH instead of changing the list locally', async () => {
  const pinSession = vi.fn(async () => {})
  const rename = vi.fn(async () => ({ ok: true, value: {} }))
  const using = vi.fn(async (_id: string, _options: unknown, operation: (reference: unknown) => Promise<unknown>) =>
    operation({ binding: { session: { rename } } }),
  )
  const forkSession = vi.fn(async () => 'session-child')
  const activeError = Object.assign(new Error('会话仍在运行'), { rpcError: { code: 'workspace/session-active' } })
  const archiveSession = vi.fn()
    .mockRejectedValueOnce(activeError)
    .mockResolvedValueOnce(undefined)
  const openSession = vi.fn()
  const sessions = { ids: ['session-1'], byId: {
    'session-1': { id: 'session-1', displayTitle: '合成门诊讨论', updatedAt: 12, blank: false },
  }, phase: 'ready' }
  const workspaces = { items: [{ workspaceId: 'workspace-1', title: 'clinmesh', sessionIds: ['session-1'] }], archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready', state: 'idle' }
  const { element, dispose } = await mountHistory({
    uiWorkspace: { startSession() {}, openSession, pinSession, forkSession, archiveSession },
    sessions: { searchResultLimit: 20, list: snapshot(sessions), using },
    workspaces: { list: snapshot(workspaces) },
  })
  try {
    await act(() => element.querySelector<HTMLButtonElement>('[aria-label="会话历史"]')!.click())
    const action = () => element.querySelector<HTMLButtonElement>('[aria-label="合成门诊讨论的操作"]')!
    await act(() => action().click())
    await act(async () => [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '置顶')!.click())
    expect(pinSession).toHaveBeenCalledWith('session-1')
    await act(() => action().click())
    await act(() => [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '重命名')!.click())
    const name = element.querySelector<HTMLInputElement>('[aria-label="会话名称"]')!
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '门诊记录')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '保存')!.click())
    expect(using).toHaveBeenCalledWith('session-1', { source: 'workspaceOperation' }, expect.any(Function))
    expect(rename).toHaveBeenCalledWith('门诊记录')
    await act(() => action().click())
    await act(async () => [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Fork')!.click())
    expect(forkSession).toHaveBeenCalledWith('session-1')
    expect(openSession).toHaveBeenCalledWith('session-child')
    await act(() => element.querySelector<HTMLButtonElement>('[aria-label="会话历史"]')!.click())
    await act(() => action().click())
    await act(async () => [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '归档')!.click())
    expect(archiveSession).toHaveBeenCalledWith('session-1')
    expect(element.textContent).toContain('会话仍在运行')
    await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="停止并归档"]')!.click())
    expect(archiveSession).toHaveBeenCalledWith('session-1', { stopActivity: true })
    expect(element.textContent).toContain('合成门诊讨论')
  } finally {
    await dispose()
  }
})
