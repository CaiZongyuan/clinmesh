import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage, LlmAdapter, ToolCallId,
  type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Tools from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { installAgentProofBridge } from './agent-proof-bridge.ts'

const record = { scopeKey: 'record-scope', pageRevision: '["record",null]' }
const consultation = { scopeKey: 'consultation-scope', pageRevision: '["consultation-1",null]' }
const answered = { ...consultation, pageRevision: '["consultation-2",null]' }
const firstVisit = { ...record, pageRevision: '["record-before-draft",null]' }
const drafted = { ...record, pageRevision: '["record-after-draft",null]' }
const select = 'clinmesh_select_doctor_section'
const read = 'clinmesh_read_current_context'
const ask = 'clinmesh_ask_virtual_patient'
const draft = 'clinmesh_fill_first_visit_draft'

function call(id: string, name: string, args: object): StreamChunk[] {
  const encoded = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: encoded },
    { type: 'block-end', index: 0, block: {
      type: 'tool-call', id: ToolCallId(id), name, arguments: encoded,
    } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class OneTurnModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model }
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    const step = this.requests.push(request) - 1
    if (step === 0) {
      yield* call('select-section', select, { ...record, section: 'consultation' })
      return
    }
    const expected = [record, consultation, consultation, answered, firstVisit, drafted, drafted][step]!
    expect(request.tools?.map(tool => tool.name)).toContain(step < 4 ? ask : draft)
    expect(request.tools?.find(tool => tool.name === read)?.parameters).toMatchObject({
      properties: { scopeKey: { const: expected.scopeKey }, pageRevision: { const: expected.pageRevision } },
    })
    if (step === 1) yield* call('read-consultation', read, consultation)
    else if (step === 2) yield* call('ask-patient', ask, {
      ...consultation, message: '合成患者：头晕什么时候开始？',
    })
    else if (step === 3) yield* call('return-to-record', select, { ...answered, section: 'record' })
    else if (step === 4) yield* call('fill-draft', draft, {
      ...firstVisit, assessment: '合成 QA 待进一步评估', historyOfPresentIllness: '合成 QA 头晕一周。',
    })
    else if (step === 5) yield* call('read-draft', read, drafted)
    else yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

// Only the browser HTTP channel and Page Context/HIS responses are substitutes.
// Cordis dispatch, Tool execution, prompt assembly, and AgentLoop are real.
function browserChannel(ctx: Context) {
  type Route = (request: IncomingMessage, response: ServerResponse) => Promise<void>
  const routes = new Map<string, Route>()
  ctx.provide('webServer', { register: (route: { path: string; handler: Route }) => {
    routes.set(route.path, route.handler)
    return () => { routes.delete(route.path) }
  } })
  const deliveries: Promise<void>[] = []
  let registrations: Array<() => void> = []
  let questions = 0
  let draftWrites = 0
  const executed: string[] = []

  async function post(path: string, body: unknown) {
    const route = routes.get(path)
    if (!route) return { status: 404, body: {} }
    const returned = Promise.withResolvers<{ status: number; body: { data?: { proof?: string } } }>()
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: 'POST', headers: { host: 'localhost', origin: 'http://localhost',
        'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' },
    })
    const response = Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: false,
      setHeader() {}, end(text: string) {
        response.writableEnded = true
        returned.resolve({ status: response.statusCode, body: JSON.parse(text) })
      },
    })
    void route(request as unknown as IncomingMessage, response as unknown as ServerResponse)
      .catch(returned.reject)
    return returned.promise
  }

  function publish(binding: typeof record) {
    for (const dispose of registrations) dispose()
    registrations = []
    const names = directory(binding)
    for (const name of names) registrations.push(ctx.tools.register({
      name, description: 'Use the authorized synthetic consultation page.',
      parameters: { type: 'object', properties: {
        scopeKey: { type: 'string', const: binding.scopeKey },
        pageRevision: { type: 'string', const: binding.pageRevision },
        ...(name === select ? { section: { type: 'string' } } : {}),
        ...(name === ask ? { message: { type: 'string' } } : {}),
        ...(name === draft ? { assessment: { type: 'string' }, historyOfPresentIllness: { type: 'string' } } : {}),
      }, required: ['scopeKey', 'pageRevision',
        ...(name === select ? ['section'] : []), ...(name === ask ? ['message'] : []),
        ...(name === draft ? ['assessment', 'historyOfPresentIllness'] : [])],
      additionalProperties: false },
      output: { schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async args => {
        executed.push(name)
        const proof = await post('/clinmesh-agent-proof', {
          ...binding, contextId: 'synthetic-context', toolName: name,
        })
        expect(proof.status).toBe(200)
        const next = name === select
          ? (args as { section: string }).section === 'record' ? firstVisit : consultation
          : name === ask ? answered : name === draft ? drafted : binding
        if (name === ask) questions++
        if (name === draft) draftWrites++
        const delivery = post('/clinmesh-agent-handoff', {
          proof: proof.body.data?.proof, phase: 'settle', target: { ...next, toolNames: directory(next) },
        }).then(response => {
          // The browser catalog arrives in a later I/O turn, as in a lease POST.
          // Without a Host result fence, AgentLoop can assemble the old directory first.
          expect([200, 404]).toContain(response.status)
          if (next === binding) return
          return new Promise<void>(resolve => setImmediate(() => { publish(next); resolve() }))
        })
        deliveries.push(delivery)
        return { ok: true, data: { section: next.scopeKey === record.scopeKey ? 'record' : 'consultation',
          questions, draftWrites } }
      },
    }))
  }
  return { publish, executed, drain: () => Promise.all(deliveries), questions: () => questions,
    draftWrites: () => draftWrites }
}

function directory(binding: typeof record): string[] {
  return binding === record ? [select, read]
    : binding.scopeKey === record.scopeKey ? [select, read, draft] : [select, read, ask]
}

it('uses settled section and draft catalogs for every next native request in one user turn', async () => {
  const ctx = new Context()
  let browser: ReturnType<typeof browserChannel> | undefined
  try {
    await ctx.plugin(Sessions)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(Llm)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(Tools)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Agents)
    await ctx.plugin(AgentLoop, { agents: [] })
    browser = browserChannel(ctx)
    installAgentProofBridge(ctx, 'synthetic-host-secret-with-at-least-32-characters')
    browser.publish(record)
    const model = new OneTurnModel()
    ctx.llm.registerAdapter(['scripted'], model)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('native-handoff-regression'),
      agentOptions: { provider: 'scripted', model: 'single-turn' } })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '切换到问诊，读取可见状态，再向合成患者提问一次。' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    // The first request after selection must already expose the consultation tool.
    expect(model.requests[1]?.tools?.map(tool => tool.name)).toContain(ask)
    expect(model.requests).toHaveLength(7)
    expect(browser.executed).toEqual([select, read, ask, select, draft, read])
    expect(browser.questions()).toBe(1)
    expect(browser.draftWrites()).toBe(1)
  } finally {
    await browser?.drain()
    await ctx.fiber.dispose()
  }
})
