import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installAgentProofBridge } from './agent-proof-bridge.ts'
import { doctorInputPermit } from './doctor-input-fixture.ts'

const disposers: Array<() => void> = []
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose() })

// The host event bus is external; the installed listener and proof issuer are real.
function bridge() {
  const on = vi.fn()
  const secret = 'test-bridge-secret-with-at-least-32-characters'
  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => Promise<void>>()
  const currentTool = vi.fn((_name: string, _agent: unknown): { parameters: unknown } | undefined => ({ parameters: { type: 'object', properties: {
    scopeKey: { type: 'string', const: 'scope' },
    pageRevision: { type: 'string', const: '["view-1",null]' },
  } } }))
  installAgentProofBridge({ on, effect: (register: () => (() => void)) => disposers.push(register()), tools: { get: currentTool },
    webServer: { register: (route: { path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) => {
      routes.set(route.path, route.handler); return () => routes.delete(route.path)
    } },
    llm: { async *stream() {
      yield { type: 'text-delta', text: '{"intent":"discuss","evidence":""}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  } as unknown as Context, secret, { handoffTimeoutMs: 30 })
  const before = on.mock.calls.find(([name]) => name === 'tools/pre-execute')![1] as (
    execution: ToolExecution, next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string; reason?: string }>
  const finish = on.mock.calls.find(([name]) => name === 'tools/result')![1] as (
    execution: ToolExecution,
  ) => void
  const emit = (name: string, ...args: unknown[]) => {
    const handler = on.mock.calls.find(([event]) => event === name)?.[1] as (...values: unknown[]) => void
    handler(...args)
  }
  const originate = async (call: ToolExecution) => {
    const session = call.agent!.session
    Object.assign(session, { header: {}, requestHeader: () => ({ config: { provider: 'scripted', model: 'diagnostics' }, tools: [
      { name: 'clinmesh_select_doctor_section', ...currentTool('clinmesh_select_doctor_section', call.agent) },
      { name: call.name, ...currentTool(call.name, call.agent) },
    ] }) })
    const text = '读取当前病例资料并按医生要求填写草稿。'
    const rpcId = crypto.randomUUID()
    const message = { id: 'human-' + call.callId, source: { kind: 'user', rpcId }, content: [{ type: 'text', text }] }
    emit('agent/inbox/inserted', { agent: call.agent, message })
    emit('agent/inbox/claimed', { agent: call.agent, message, turn: 1 })
    const parameters = currentTool('clinmesh_select_doctor_section', call.agent)!.parameters as {
      properties: { scopeKey: { const: string }; pageRevision: { const: string } }
    }
    const permit = doctorInputPermit({ text, rpcId, dshSessionId: String(session.id), secret,
      scopeKey: parameters.properties.scopeKey.const, pageRevision: parameters.properties.pageRevision.const })
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ permit }))]), {
      method: 'POST', headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    let registered: unknown
    const response = { statusCode: 200, setHeader: vi.fn(), end: (body: string) => { registered = JSON.parse(body) } }
    await routes.get('/clinmesh-doctor-task')!(request as unknown as IncomingMessage, response as unknown as ServerResponse)
    expect(response.statusCode).toBe(200)
    expect(registered).toEqual({ data: { registered: true } })
    emit('session/event', session, { type: 'step/start', data: { turn: 1, step: 1 } })
    emit('session/event', session, { type: 'tool/call', data: {
      turn: 1, step: 1, name: call.name, callId: call.callId, arguments: JSON.stringify(call.arguments),
    } })
  }
  return { before, finish, currentTool, originate, routes, emit, secret }
}

function execution(args: unknown, session = true, name = 'clinmesh_fill_clinical_document_draft') {
  return {
    arguments: args, callId: crypto.randomUUID(), name,
    signal: new AbortController().signal,
    ...(session ? { agent: { session: { id: 'synthetic-session' } } } : {}),
  } as ToolExecution
}

it('proves a saved native doctor input after a normal turn without executing a Tool', async () => {
  const { routes, emit, secret } = bridge()
  const agent = { session: { id: 'doctor-source-session', header: {} } }
  const text = '查体：双肺呼吸音清，无啰音。'
  const message = { id: 'doctor-source-message', source: { kind: 'user', rpcId: 'doctor-source-rpc' },
    content: [{ type: 'text', text }] }
  emit('agent/inbox/inserted', { agent, message })
  emit('agent/inbox/claimed', { agent, message, turn: 1 })
  emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const permit = doctorInputPermit({ text, rpcId: 'doctor-source-rpc', dshSessionId: agent.session.id,
    secret, scopeKey: 'scope', pageRevision: '["view-1",null]' })
  const route = routes.get('/clinmesh-doctor-source')
  expect(route).toBeDefined()
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ permit }))]), {
    method: 'POST', headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  })
  let body: unknown
  const response = Object.assign(new EventEmitter(), { statusCode: 200, setHeader: vi.fn(), end: (value: string) => { body = JSON.parse(value) } })
  await route!(request as unknown as IncomingMessage, response as unknown as ServerResponse)
  expect(response.statusCode).toBe(200)
  expect(body).toMatchObject({ data: { sourceProof: expect.any(String) } })
})

it.each(['text', 'session', 'rpc', 'page', 'signature', 'origin', 'discard', 'dispose', 'abort', 'duplicate'] as const)(
  'rejects a native recording proof with %s mismatch or cancellation', async invalid => {
    const { routes, emit, secret } = bridge()
    const agent = { session: { id: 'doctor-source-session', header: {} } }
    const text = '查体：双肺呼吸音清，无啰音。'
    const message = { id: 'native-record-source', source: { kind: 'user', rpcId: 'doctor-source-rpc' }, content: [{ type: 'text', text }] }
    emit('agent/inbox/inserted', { agent, message })
    if (invalid === 'discard') emit('agent/inbox/discarded', { agent, message })
    if (invalid === 'dispose') emit('agent/disposed', { agent })
    if (invalid === 'abort') {
      emit('agent/inbox/claimed', { agent, message, turn: 1 })
      emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
    }
    if (invalid === 'duplicate') emit('agent/inbox/inserted', { agent, message: { ...message, id: 'duplicated-native-input' } })
    let permit = doctorInputPermit({ text: invalid === 'text' ? '另一份查体结论。' : text,
      rpcId: invalid === 'rpc' ? 'another-rpc' : message.source.rpcId,
      dshSessionId: invalid === 'session' ? 'another-session' : agent.session.id,
      secret, scopeKey: invalid === 'page' ? 'another-case' : 'scope', pageRevision: '["view-1",null]' })
    if (invalid === 'signature') permit += 'x'
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ permit }))]), {
      method: 'POST', headers: { host: 'localhost', origin: invalid === 'origin' ? 'http://another-origin' : 'http://localhost',
        'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' },
    })
    const response = Object.assign(new EventEmitter(), { statusCode: 200, setHeader: vi.fn(), end: vi.fn() })
    await routes.get('/clinmesh-doctor-source')!(request as unknown as IncomingMessage, response as unknown as ServerResponse)
    expect(response.statusCode).toBe(invalid === 'origin' ? 403 : 409)
  },
)

describe('ClinMesh host Tool binding diagnostics', () => {
  it('rejects unobserved, changed, and replayed doctor calls before dispatch', async () => {
    const { before, finish, originate } = bridge()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    const call = execution({ pageRevision: '["view-1",null]', scopeKey: 'scope' })
    expect(await before(call, next)).toMatchObject({
      kind: 'deny', reason: expect.stringContaining('CLINMESH_CALL_SOURCE_REQUIRED'),
    })
    await originate(call)
    expect(await before({ ...call, arguments: { pageRevision: '["view-1",null]', scopeKey: 'scope',
      assessment: 'changed after native recording' } }, next)).toMatchObject({
      kind: 'deny', reason: expect.stringContaining('CLINMESH_CALL_SOURCE_REQUIRED'),
    })
    const observed = execution({ pageRevision: '["view-1",null]', scopeKey: 'scope' })
    await originate(observed)
    expect(await before(observed, next)).toEqual({ kind: 'allow' })
    finish(observed)
    expect(await before(observed, next)).toMatchObject({
      kind: 'deny', reason: expect.stringContaining('CLINMESH_CALL_SOURCE_REQUIRED'),
    })
    expect(next).toHaveBeenCalledOnce()
  })

  it.each(['absent', 'invalid'] as const)('does not invent recovery arguments when the current read definition is %s', async kind => {
    const { before, currentTool } = bridge()
    currentTool.mockImplementation(name => name === 'clinmesh_read_current_context'
      ? kind === 'absent' ? undefined : { parameters: { properties: {
          scopeKey: { const: '' }, pageRevision: { const: 'not-a-valid-binding' },
        } } }
      : { parameters: { properties: {
          scopeKey: { const: 'scope' }, pageRevision: { const: '["view-1",null]' },
        } } })
    const dispatch = vi.fn(async () => ({ kind: 'allow' as const }))
    const denied = await before(execution({ scopeKey: 'previous-patient', pageRevision: '["old",null]' }), dispatch)
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toContain('尚无可用的只读工具目录')
    expect(denied.reason).not.toContain('"arguments"')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects the previous patient write and provides current read-only recovery arguments', async () => {
    const { before, finish, currentTool, originate } = bridge()
    currentTool.mockReturnValue({ parameters: { type: 'object', properties: {
      scopeKey: { type: 'string', const: 'current-patient-scope' },
      pageRevision: { type: 'string', const: '["current-patient",null]' },
      contextId: { type: 'string', const: 'private-context' },
      untrustedExtra: { type: 'string', const: 'must-not-copy' },
    } } })
    const originalInput = { scopeKey: 'previous-patient-scope', pageRevision: '["previous-patient",null]', assessment: '旧意图' }
    const originalCall = execution(originalInput)
    const dispatch = vi.fn(async () => ({ kind: 'allow' as const }))
    const denied = await before(originalCall, dispatch)
    expect(denied.kind).toBe('deny')
    expect(dispatch).not.toHaveBeenCalled()
    expect(originalCall.arguments).toEqual(originalInput)
    const recoveryLine = denied.reason?.split('\n').find(line => line.startsWith('{'))
    expect(recoveryLine).toBeDefined()
    const recovery = JSON.parse(recoveryLine!) as { toolName: string; arguments: unknown }
    expect(recovery).toEqual({ toolName: 'clinmesh_read_current_context', arguments: {
      scopeKey: 'current-patient-scope', pageRevision: '["current-patient",null]',
    } })
    expect(denied.reason).toContain('核对')
    expect(currentTool).toHaveBeenCalledWith('clinmesh_read_current_context', originalCall.agent)
    const agent = originalCall.agent
    if (agent === undefined) throw new Error('Missing synthetic Agent')
    const readCall = { ...execution(recovery.arguments, true, recovery.toolName), agent }
    await originate(readCall)
    expect(await before(readCall, dispatch)).toEqual({ kind: 'allow' })
    expect(dispatch).toHaveBeenCalledOnce()
    finish(readCall)
  })

  it('rejects a call generated for an earlier page before dispatching or creating a proof', async () => {
    const { before } = bridge()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    for (const args of [
      { scopeKey: 'other-patient', pageRevision: '["view-1",null]' },
      { scopeKey: 'scope', pageRevision: '["before-edit",null]' },
    ]) {
      expect(await before(execution(args), next)).toMatchObject({
        kind: 'deny', reason: expect.stringContaining('CLINMESH_BINDING_MISMATCH'),
      })
    }
    expect(next).not.toHaveBeenCalled()
  })

  it.each([
    [{ assessment: 'synthetic' }, ['pageRevision', 'scopeKey']],
    [{ pageRevision: '["view-1",null]' }, ['scopeKey']],
    [{ pageRevision: '', scopeKey: 'scope' }, ['pageRevision']],
    [{ pageRevision: '["view-1",null]', scopeKey: 42 }, ['scopeKey']],
    [null, ['scopeKey', 'pageRevision']],
  ])('identifies invalid binding fields without dispatching: %j', async (args, fields) => {
    const { before } = bridge()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    const result = await before(execution(args), next)
    expect(result.kind).toBe('deny')
    expect(result.reason).toContain('CLINMESH_BINDING_ARGUMENTS_INVALID')
    expect(result.reason).toContain(fields.join(', '))
    expect(result.reason).toContain('const')
    expect(next).not.toHaveBeenCalled()
  })

  it('distinguishes a missing host session from missing arguments', async () => {
    const { before } = bridge()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    const result = await before(execution({ pageRevision: '["view-1",null]', scopeKey: 'scope' }, false), next)
    expect(result.reason).toContain('CLINMESH_HOST_SESSION_REQUIRED')
    expect(next).not.toHaveBeenCalled()
  })

  it('allows a corrected call, then read and repeated writes with the same binding', async () => {
    const { before, finish, originate } = bridge()
    const next = async () => ({ kind: 'allow' as const })
    expect((await before(execution({}), next)).kind).toBe('deny')
    for (const name of ['clinmesh_read_current_context',
      'clinmesh_fill_clinical_document_draft', 'clinmesh_fill_clinical_document_draft']) {
      const call = execution({ pageRevision: '["view-1",null]', scopeKey: 'scope' }, true, name)
      await originate(call)
      expect(await before(call, next)).toEqual({ kind: 'allow' })
      finish(call)
    }
    expect(await before(execution({}, false, 'other_tool'), next)).toEqual({ kind: 'allow' })
  })
})
