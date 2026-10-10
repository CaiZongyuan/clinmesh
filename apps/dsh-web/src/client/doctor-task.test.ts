import { afterEach, expect, it, vi } from 'vitest'
import { createDoctorInputBridge } from './doctor-task.ts'
import type { ClientSessionInputPort } from './host-ports.ts'

afterEach(() => vi.unstubAllGlobals())
type Accept = Parameters<typeof createDoctorInputBridge>[1]
type Pending = ReturnType<NonNullable<ReturnType<ClientSessionInputPort['binding']>>['session']['getSnapshot']>['pendingSubmissions']
class SessionStore {
  listeners = new Set<() => void>()
  constructor(readonly sessionId: string, public pendingSubmissions: Pending = []) {}
  getSnapshot() { return { sessionId: this.sessionId, pendingSubmissions: this.pendingSubmissions } }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  submit(pending: Pending) {
    this.pendingSubmissions = pending
    for (const listener of this.listeners) listener()
  }
}
const pending = (requestId = 'rpc-1', text = '  替我问清起病时间。\n') => ({ requestId, text, attachments: [] })
const task = (input: { content: string; dshSessionId: string; rpcId: string }) => ({ ...input,
  taskId: 'task-1', permit: 'synthetic-signed-permit-at-least-32-characters' })
function fixture(initial: Pending = []) {
  const stores = new Map([['session-1', new SessionStore('session-1', initial)], ['session-2', new SessionStore('session-2')]])
  let key: string | undefined = 'session-1'
  const currentListeners = new Set<() => void>()
  const current = {
    getSnapshot: () => ({ key }),
    subscribe(listener: () => void) { currentListeners.add(listener); return () => { currentListeners.delete(listener) } },
  }
  const fetch = vi.fn(async () => Response.json({ data: { registered: true } }))
  vi.stubGlobal('fetch', fetch)
  return { stores, current, fetch, currentListeners,
    sessions: { binding: (id: string) => stores.has(id) ? { session: stores.get(id)! } : undefined },
    select(id: string | undefined) { key = id; for (const listener of currentListeners) listener() },
  }
}

it('observes a native submission and only registers its permit, preserving the original text and RPC id', async () => {
  const f = fixture()
  const accept = vi.fn<Accept>(async input => task(input))
  const dispose = createDoctorInputBridge(f, accept)
  try {
    f.stores.get('session-1')!.submit([pending()])
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce())
    expect(accept).toHaveBeenCalledWith({ content: '  替我问清起病时间。\n', dshSessionId: 'session-1', rpcId: 'rpc-1' }, expect.any(AbortSignal))
    expect(f.fetch).toHaveBeenCalledWith('/clinmesh-doctor-task', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: JSON.stringify({ permit: 'synthetic-signed-permit-at-least-32-characters' }),
    }))
  } finally { dispose() }
  expect(f.currentListeners.size).toBe(0)
  expect(f.stores.get('session-1')!.listeners.size).toBe(0)
})

it('ignores submissions already pending on attachment and authorizes each new RPC id only once', async () => {
  const f = fixture([pending('already-pending', '替我问旧病例。')])
  const accept = vi.fn<Accept>(async input => task(input))
  const dispose = createDoctorInputBridge(f, accept)
  try {
    const store = f.stores.get('session-1')!
    store.submit([pending('already-pending', '替我问旧病例。')])
    expect(accept).not.toHaveBeenCalled()
    store.submit([pending('already-pending', '替我问旧病例。'), pending()])
    store.submit([pending()])
    store.submit([pending('rpc-1', '篡改后的范围。')])
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce())
    expect(accept).toHaveBeenCalledOnce()
  } finally { dispose() }
})

it.each(['switch', 'unload'])('cancels in-flight acceptance on %s and never registers its late result', async action => {
  const f = fixture()
  let resolve!: (value: ReturnType<typeof task>) => void
  const result = new Promise<ReturnType<typeof task>>(done => { resolve = done })
  const accept = vi.fn<Accept>(() => result)
  const dispose = createDoctorInputBridge(f, accept)
  try {
    f.stores.get('session-1')!.submit([pending()])
    expect(accept).toHaveBeenCalledOnce()
    const signal = accept.mock.calls[0]![1]
    if (action === 'switch') f.select('session-2')
    else dispose()
    expect(signal.aborted).toBe(true)
    resolve(task({ content: pending().text, dshSessionId: 'session-1', rpcId: 'rpc-1' }))
    await result
    await Promise.resolve()
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.stores.get('session-1')!.listeners.size).toBe(0)
  } finally { dispose() }
})

it('follows new selected sessions without authorizing their pre-existing pending submissions', async () => {
  const f = fixture()
  const accept = vi.fn<Accept>(async input => task(input))
  const dispose = createDoctorInputBridge(f, accept)
  try {
    f.stores.get('session-2')!.submit([pending('old-in-new-session')])
    f.select('session-2')
    f.stores.get('session-2')!.submit([pending('old-in-new-session'), pending('new-in-new-session')])
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce())
    expect(accept).toHaveBeenCalledWith({ content: pending().text, dshSessionId: 'session-2', rpcId: 'new-in-new-session' }, expect.any(AbortSignal))
    f.select(undefined)
    expect(f.stores.get('session-2')!.listeners.size).toBe(0)
  } finally { dispose() }
})

it('does not grant an input credential for attachments, empty or oversized text, or a mismatched snapshot', async () => {
  const f = fixture()
  const accept = vi.fn<Accept>(async input => task(input))
  const dispose = createDoctorInputBridge(f, accept)
  try {
    const store = f.stores.get('session-1')!
    store.submit([
      { ...pending('attachment'), attachments: [{ type: 'image', value: { previewUrl: 'blob:synthetic' } }] },
      pending('empty', ' \n'), pending('oversized', '问'.repeat(2001)), pending(''),
    ])
    expect(accept).not.toHaveBeenCalled()
    vi.spyOn(store, 'getSnapshot').mockReturnValue({ sessionId: 'another-session', pendingSubmissions: [pending('wrong-session')] })
    store.submit([pending('wrong-session')])
    expect(accept).not.toHaveBeenCalled()
  } finally { dispose() }
  expect(f.fetch).not.toHaveBeenCalled()
})

it.each(['content', 'dshSessionId', 'rpcId'] as const)('does not register an acceptance response for another %s', async field => {
  const f = fixture()
  const accept = vi.fn<Accept>(async input => ({ ...task(input), [field]: 'mismatch' }))
  const dispose = createDoctorInputBridge(f, accept)
  try {
    f.stores.get('session-1')!.submit([pending()])
    await accept.mock.results[0]!.value
    await Promise.resolve()
    expect(f.fetch).not.toHaveBeenCalled()
  } finally { dispose() }
})

it('continues source registration when the native submission echo normally retires', async () => {
  const f = fixture()
  let resolve!: (value: ReturnType<typeof task>) => void
  const result = new Promise<ReturnType<typeof task>>(done => { resolve = done })
  const accept = vi.fn<Accept>(() => result)
  const dispose = createDoctorInputBridge(f, accept)
  try {
    const store = f.stores.get('session-1')!
    store.submit([pending()])
    store.submit([])
    expect((accept.mock.calls[0]![1]).aborted).toBe(false)
    resolve(task({ content: pending().text, dshSessionId: 'session-1', rpcId: 'rpc-1' }))
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce())
  } finally { dispose() }
})

it.each(['accept', 'network', 'http'] as const)('keeps %s failures private and never retries the original input', async failure => {
  const f = fixture()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const accept = vi.fn<Accept>(async input => {
    if (failure === 'accept') throw new Error('synthetic-private-prompt-and-provider-credential')
    return task(input)
  })
  if (failure === 'network') f.fetch.mockImplementation(async () => { throw new Error('synthetic-private-provider-credential') })
  if (failure === 'http') f.fetch.mockImplementation(async () => Response.json({ error: 'synthetic-private-response' }, { status: 409 }))
  const dispose = createDoctorInputBridge(f, accept)
  try {
    const store = f.stores.get('session-1')!
    store.submit([pending()])
    store.submit([pending()])
    await Promise.allSettled([accept.mock.results[0]!.value])
    if (failure !== 'accept') await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce())
    expect(accept).toHaveBeenCalledOnce()
    if (failure === 'accept') expect(f.fetch).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  } finally { dispose(); log.mockRestore(); warn.mockRestore() }
})
