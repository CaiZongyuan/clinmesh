import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAgentExecutionProof, signAgentExecutionProof } from './execution-proof.ts'
import { installAgentProofBridge } from './agent-proof-bridge.ts'

const secret = 'test-bridge-secret-with-at-least-32-characters'
const original = { scopeKey: 'scope', pageRevision: '["record",null]' }
const target = { scopeKey: 'consultation-scope', pageRevision: '["consultation",null]',
  toolNames: ['clinmesh_read_current_context', 'clinmesh_ask_virtual_patient'] }
const result: ToolExecutionResult = { isError: false, value: 'saved', content: [{ type: 'text', text: 'saved' }] }

afterEach(() => { vi.useRealTimers() })

type HostRoute = (request: IncomingMessage, response: ServerResponse) => Promise<void>
type HttpResult = { status: number; body: { data?: { proof?: string; permitted?: boolean }; error?: { code: string; message: string } } }

function fixture(timeoutMs = 30_000, initial = original) {
  const listeners = new Map<string, unknown>()
  const invoke = <T>(name: string, ...args: unknown[]): T | undefined => {
    const listener = listeners.get(name) as ((...values: unknown[]) => T) | undefined
    return listener?.(...args)
  }
  const routes = new Map<string, HostRoute>()
  const disposers: Array<() => void> = []
  let schemas = descriptors(initial, ['clinmesh_read_current_context', 'clinmesh_select_doctor_section'])
  const agent = { session: { id: 'synthetic-session', header: {}, requestHeader: () => ({ tools: schemas }) }, cancel: vi.fn() }
  const ctx = {
    on: (name: string, handler: unknown) => {
      listeners.set(name, handler)
      return () => { if (listeners.get(name) === handler) listeners.delete(name) }
    },
    effect: (factory: () => (() => void)) => { disposers.push(factory()) },
    tools: { get: (name: string) => schemas.find(tool => tool.name === name), schemas: () => schemas },
    webServer: { register: (route: { path: string; handler: HostRoute }) => {
      routes.set(route.path, route.handler); return () => { routes.delete(route.path) }
    } },
  }
  installAgentProofBridge(ctx as unknown as Context, secret, { handoffTimeoutMs: timeoutMs })
  const message = { id: 'human-message', source: { kind: 'user', rpcId: 'human-rpc' }, content: [] }
  invoke('agent/inbox/inserted', { agent, message })
  invoke('agent/inbox/claimed', { agent, message, turn: 1 })
  invoke('session/event', agent.session, { type: 'step/start', data: { turn: 1, step: 1 } })
  function startRequest(path: string, body: unknown) {
    const route = routes.get(path)
    expect(route, `registered ${path}`).toBeDefined()
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: 'POST', headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    const response = Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: false,
      setHeader: vi.fn(), end: (text: string) => {
        response.writableEnded = true; resolve({ status: response.statusCode, body: JSON.parse(text) })
      },
    })
    let resolve: (value: HttpResult) => void = () => undefined
    const returned = new Promise<HttpResult>(done => { resolve = done })
    void route!(request as unknown as IncomingMessage, response as unknown as ServerResponse)
    return { returned, response }
  }
  const request = (path: string, body: unknown) => startRequest(path, body).returned
  async function begin(name = 'clinmesh_select_doctor_section') {
    const controller = new AbortController()
    const call = { arguments: initial, callId: crypto.randomUUID(), name, agent,
      signal: controller.signal } as unknown as ToolExecution
    invoke('session/event', agent.session, { type: 'tool/call', data: {
      turn: 1, step: 1, callId: call.callId, name, arguments: JSON.stringify(call.arguments),
    } })
    expect(await invoke('tools/pre-execute', call, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
    const proof = await request('/clinmesh-agent-proof', { ...initial, contextId: 'current-context', toolName: name })
    expect(proof.status).toBe(200)
    const token = proof.body.data?.proof
    if (token === undefined) throw new Error('Missing proof response')
    return { call, proof: token, controller }
  }
  return { begin, request, startRequest, agent, invoke,
    body: (call: ToolExecution, body = async () => result) => (invoke('tools/execute', call, body) ?? body()) as Promise<ToolExecutionResult>,
    post: (call: ToolExecution, value = result) => (invoke('tools/post-execute', call, value,
      async () => ({ kind: 'accept' })) ?? Promise.resolve({ kind: 'accept' })) as Promise<PostToolDecision>,
    update: (binding: typeof original, names: string[]) => {
      schemas = descriptors(binding, names); invoke('tools/change')
    },
    dispose: () => { for (const dispose of disposers.reverse()) dispose() },
  }
}

function descriptors(binding: typeof original, names: string[]) {
  return names.map(name => ({ name, parameters: { type: 'object', properties: {
    scopeKey: { type: 'string', const: binding.scopeKey }, pageRevision: { type: 'string', const: binding.pageRevision },
  } } }))
}

describe('ClinMesh Host result handoff', () => {
  it('pauses only the pending native task matched by its issued proof', async () => {
    const f = fixture()
    try {
      const { call, proof } = await f.begin()
      expect((await f.request('/clinmesh-agent-handoff', { phase: 'pause', proof })).status).toBe(409)
      await f.body(call)
      const forged = signAgentExecutionProof({ ...parseAgentExecutionProof(proof, { secret }), contextId: 'another-context' }, secret)
      expect((await f.request('/clinmesh-agent-handoff', { phase: 'pause', proof: forged })).status).toBe(409)
      expect(f.agent.cancel).not.toHaveBeenCalled()
      expect(await f.request('/clinmesh-agent-handoff', { phase: 'pause', proof })).toEqual({
        status: 200, body: { data: { paused: true } },
      })
      expect(f.agent.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: expect.stringContaining('CLINMESH_EXECUTION_UNCONFIRMED:') }, { keepInbox: true })
      expect((await f.request('/clinmesh-agent-handoff', { phase: 'pause', proof })).status).toBe(409)
      f.invoke('tools/result', call)
      expect((await f.request('/clinmesh-agent-handoff', { phase: 'pause', proof })).status).toBe(409)
    } finally { f.dispose() }
  })

  it('does not let an old proof pause a newly claimed doctor task', async () => {
    const f = fixture()
    try {
      const { call, proof } = await f.begin()
      await f.body(call)
      const message = { id: 'new-doctor-message', source: { kind: 'user', rpcId: 'new-doctor-rpc' }, content: [] }
      f.invoke('agent/inbox/inserted', { agent: f.agent, message })
      f.invoke('agent/inbox/claimed', { agent: f.agent, message, turn: 1 })
      expect((await f.request('/clinmesh-agent-handoff', { phase: 'pause', proof })).status).toBe(409)
      const unknown: ToolExecutionResult = { isError: true, error: { message: 'CLINMESH_EXECUTION_UNCONFIRMED: late old result' },
        content: [{ type: 'text', text: 'Error: CLINMESH_EXECUTION_UNCONFIRMED: late old result' }] }
      expect(await f.post(call, unknown)).toEqual({ kind: 'accept' })
      expect(f.agent.cancel).not.toHaveBeenCalled()
      f.invoke('tools/result', call, unknown)
      expect(f.agent.cancel).not.toHaveBeenCalled()
      await f.begin('clinmesh_read_current_context')
    } finally { f.dispose() }
  })

  it('re-signs a current doctor read once for the original native call and leaves writes unreplayed', async () => {
    const f = fixture()
    try {
      const { call, proof } = await f.begin('clinmesh_read_current_context')
      const updated = { ...original, pageRevision: '["updated",null]' }
      f.update(updated, ['clinmesh_read_current_context', 'clinmesh_select_doctor_section'])
      const recovered = await f.request('/clinmesh-agent-proof', {
        ...updated, contextId: 'renewed-context', toolName: call.name, previousProof: proof,
      })
      expect(recovered.status).toBe(200)
      const token = recovered.body.data!.proof!
      expect(parseAgentExecutionProof(token, { secret })).toMatchObject({
        ...updated, contextId: 'renewed-context', callId: call.callId,
        origin: { request: original, task: { ...original, rpcId: 'human-rpc', turn: 1 } },
      })
      for (const previousProof of [proof, token]) {
        expect((await f.request('/clinmesh-agent-proof', {
          ...updated, contextId: 'another-context', toolName: call.name, previousProof,
        })).status).toBe(409)
      }
      f.invoke('tools/result', call)
      expect((await f.request('/clinmesh-agent-proof', {
        ...updated, contextId: 'after-result', toolName: call.name, previousProof: token,
      })).status).toBe(409)
    } finally { f.dispose() }
  })

  it.each(['write', 'cancel', 'completed-body', 'turn-ended'] as const)(
    'does not recover a proof after %s', async reason => {
      const f = fixture()
      try {
        const { call, proof, controller } = await f.begin(reason === 'write'
          ? 'clinmesh_select_doctor_section' : 'clinmesh_read_current_context')
        if (reason === 'cancel') controller.abort(new Error('doctor stopped the task'))
        if (reason === 'completed-body') await f.body(call)
        if (reason === 'turn-ended') f.invoke('session/event', f.agent.session, {
          type: 'turn/end', data: { turn: 1 },
        })
        const updated = { ...original, pageRevision: '["updated",null]' }
        f.update(updated, ['clinmesh_read_current_context', 'clinmesh_select_doctor_section'])
        expect((await f.request('/clinmesh-agent-proof', {
          ...updated, contextId: 'renewed-context', toolName: call.name, previousProof: proof,
        })).status).toBe(409)
      } finally { f.dispose() }
    },
  )

  it('cancels an interrupted settlement request without waiting for its directory deadline', async () => {
    const f = fixture()
    try {
      const { call, proof } = await f.begin()
      await f.body(call)
      const final = f.post(call)
      const pending = f.startRequest('/clinmesh-agent-handoff', { proof, phase: 'settle', target })
      pending.response.emit('close')
      expect((await pending.returned).status).toBe(409)
      expect(await final).toMatchObject({ kind: 'block', feedback: [
        { type: 'text', text: 'saved' }, { type: 'text', text: expect.stringContaining('CLINMESH_HANDOFF_CANCELLED') },
      ] })
    } finally { f.dispose() }
  })

  it('passes an unchanged read directory immediately without requiring tools/change', async () => {
    const f = fixture()
    try {
      const { call, proof } = await f.begin('clinmesh_read_current_context')
      await f.body(call)
      const final = f.post(call)
      expect((await f.request('/clinmesh-agent-handoff', { proof, phase: 'settle',
        target: { ...original, toolNames: ['clinmesh_read_current_context', 'clinmesh_select_doctor_section'] },
      })).status).toBe(200)
      expect(await final).toEqual({ kind: 'accept' })
      expect(f.agent.cancel).not.toHaveBeenCalled()
    } finally { f.dispose() }
  })

  it('rejects a validly signed proof that was never issued for this pending call and rejects duplicate settlement', async () => {
    const f = fixture()
    try {
      const { call, proof } = await f.begin()
      await f.body(call)
      const final = f.post(call)
      const forged = signAgentExecutionProof({ ...parseAgentExecutionProof(proof, { secret }), contextId: 'forged-context' }, secret)
      expect((await f.request('/clinmesh-agent-handoff', { proof: forged, phase: 'settle', target })).status).toBe(409)
      expect((await f.request('/clinmesh-agent-handoff', { proof, phase: 'settle', target })).status).toBe(200)
      expect((await f.request('/clinmesh-agent-handoff', { proof, phase: 'settle', target })).status).toBe(409)
      f.update(target, target.toolNames)
      await final
      f.invoke('tools/result', call)
      expect((await f.request('/clinmesh-agent-handoff', { proof, phase: 'settle', target })).status).toBe(409)
    } finally { f.dispose() }
  })

  it('accepts a bounded large directory while rejecting bodies beyond the handoff byte limit', async () => {
    const f = fixture(30_000, { ...original, pageRevision: 'x'.repeat(1024) })
    try {
      const { call, proof } = await f.begin()
      await f.body(call)
      const final = f.post(call)
      const largeTarget = { ...target, pageRevision: 'y'.repeat(1024),
        toolNames: Array.from({ length: 32 }, (_, index) => `clinmesh_${String(index).padStart(55, 'x')}`),
      }
      const body = { proof, phase: 'settle', target: largeTarget }
      expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(4096)
      expect((await f.request('/clinmesh-agent-handoff', { ...body, proof: 'x'.repeat(16_384) })).status).toBe(413)
      expect((await f.request('/clinmesh-agent-handoff', body)).status).toBe(200)
      f.update(largeTarget, largeTarget.toolNames)
      expect(await final).toEqual({ kind: 'accept' })
    } finally { f.dispose() }
  })

  it.each(['abort', 'unload'] as const)('releases the result fence when the execution is cancelled by %s', async cause => {
    const f = fixture()
    try {
      const { call, controller } = await f.begin()
      await f.body(call)
      const final = f.post(call)
      if (cause === 'abort') {
        // Cancellation is the external execution signal; the bridge does not replace it.
        controller.abort(new Error('external cancellation'))
      } else f.dispose()
      const blocked = await final
      expect(blocked).toMatchObject({ kind: 'block', feedback: [{ type: 'text', text: 'saved' }, expect.anything()] })
      expect(f.agent.cancel).toHaveBeenCalledOnce()
    } finally { f.dispose() }
  })

  it('cancels the current turn on a bounded handoff timeout while preserving the body result', async () => {
    vi.useFakeTimers()
    const f = fixture(100)
    try {
      const { call } = await f.begin()
      await f.body(call)
      const final = f.post(call)
      await vi.advanceTimersByTimeAsync(100)
      expect(await final).toMatchObject({ kind: 'block', feedback: [
        { type: 'text', text: 'saved' }, { type: 'text', text: expect.stringContaining('CLINMESH_HANDOFF_TIMEOUT') },
      ] })
      expect(f.agent.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'CLINMESH_HANDOFF_TIMEOUT' }, { keepInbox: true })
    } finally { f.dispose() }
  })

  it('permits publication after all bodies arrive without waiting for sequential post-execute finalization', async () => {
    const f = fixture()
    try {
      const first = await f.begin()
      const second = await f.begin('clinmesh_read_current_context')
      let receiveSecond: () => void = () => undefined
      const secondBody = f.body(second.call, () => new Promise(resolve => {
        receiveSecond = () => resolve(result)
      }))
      await f.body(first.call)
      const firstFinal = f.post(first.call)
      const permitted = vi.fn()
      const permit = f.request('/clinmesh-agent-handoff', { proof: first.proof, phase: 'settle', target })
        .then(response => { permitted(); return response })
      // Drain the request stream and handler, without advancing a publication timer.
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(permitted).not.toHaveBeenCalled()
      receiveSecond()
      await secondBody
      expect((await permit).status).toBe(200)
      const secondFinal = f.post(second.call)
      expect((await f.request('/clinmesh-agent-handoff', { proof: second.proof, phase: 'settle', target })).status).toBe(200)
      f.update(target, target.toolNames)
      expect(await firstFinal).toEqual({ kind: 'accept' })
      expect(await secondFinal).toEqual({ kind: 'accept' })
    } finally { f.dispose() }
  })

  it('holds final native result until the complete current Tool directory is installed', async () => {
    const f = fixture()
    try {
      const { call, proof } = await f.begin()
      await f.body(call)
      const settled = vi.fn()
      const final = f.post(call).then(decision => { settled(); return decision })
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled()
      expect(await f.request('/clinmesh-agent-handoff', { proof, phase: 'settle', target }))
        .toEqual({ status: 200, body: { data: { permitted: true } } })
      expect(settled).not.toHaveBeenCalled()
      f.update(target, ['clinmesh_read_current_context'])
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled()
      f.update(target, target.toolNames)
      expect(await final).toEqual({ kind: 'accept' })
      expect(f.agent.cancel).not.toHaveBeenCalled()
    } finally { f.dispose() }
  })
})
