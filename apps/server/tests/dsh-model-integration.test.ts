import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { afterEach, expect, it } from 'vitest'
import { encodeModelRoute, dshDefaultModel } from '@clinmesh/contracts/model-bridge'
import { controlConsultationRecordingResponseSchema, doctorCaseDetailSchema, sendConsultationMessageResponseSchema } from '@clinmesh/contracts/his'
import { createModelBridgeHandler } from '../../dsh-web/src/model-bridge.ts'
import { DshModelProvider } from '../src/infrastructure/ai/dsh-model-provider.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'
import type { HistoryTurn } from '../src/application/consultation-history-summary.ts'
import { sourceArtifactHash } from '../src/application/scenario-data/provider.ts'

type HostContext = Parameters<typeof createModelBridgeHandler>[0]
type GenerateOptions = Parameters<HostContext['llm']['stream']>[0]
type StreamChunk = ReturnType<HostContext['llm']['stream']> extends AsyncIterable<infer Chunk> ? Chunk : never

const secret = 'synthetic-model-bridge-secret-at-least-32-characters'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function host() {
  let route = { provider: 'synthetic-provider-a', model: 'same-model' }
  let selection = 'default'
  let answer: unknown = persona
  let responder: ((options: GenerateOptions) => Promise<unknown>) | undefined
  let fail = false
  let hold = false
  let available = true
  let providerFailure: 'AUTH' | 'MISSING_CREDENTIAL' | 'INVALID_CREDENTIAL' | 'TIMEOUT' | undefined
  const calls: GenerateOptions[] = []
  const ctx = {
    agentDefaultModel: { currentSelection: () => route },
    llm: {
      listModels: async (provider: string) => {
        if (!available) throw new Error('Synthetic catalog unavailable')
        return [{ provider, id: 'same-model', name: 'Synthetic model' }]
      },
      async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
        calls.push(options)
        if (hold) await new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('Synthetic cancellation')), { once: true })
        })
        if (fail) throw new Error('private-provider-error-containing-a-secret')
        if (providerFailure !== undefined) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: providerFailure,
            message: 'Provider failure with private-provider-credential and private-prompt' } } }
          return
        }
        const generated = responder === undefined ? answer : await responder(options)
        yield { type: 'text-delta', index: 0, text: typeof generated === 'string' ? generated : JSON.stringify(generated) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const bridge = createModelBridgeHandler(ctx as unknown as HostContext, secret, () => selection)
  const server: Server = createServer(bridge.handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { bridge.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('Host not listening')
  const origin = `http://127.0.0.1:${address.port}`
  return { origin, calls,
    route: (provider: string) => { route = { provider, model: 'same-model' } },
    selection: (value: string) => { selection = value },
    answer: (value: unknown) => { answer = value }, fail: (value: boolean) => { fail = value },
    respond: (callback: NonNullable<typeof responder>) => { responder = callback },
    hold: () => { hold = true }, dispose: bridge.dispose,
    available: (value: boolean) => { available = value },
    providerFailure: (code: NonNullable<typeof providerFailure>) => { providerFailure = code },
  }
}

it('requires a trusted server, validates narrow requests and keeps Provider identity on a pinned auxiliary call', async () => {
  const dsh = await host()
  const endpoint = `${dsh.origin}/clinmesh-model-bridge`
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(endpoint, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
  })
  expect((await post({ operation: 'resolve' })).status).toBe(403)
  expect((await post({ operation: 'resolve' }, { authorization: `Bearer ${secret}`, origin: dsh.origin })).status).toBe(403)
  expect((await post({ operation: 'resolve', url: 'https://untrusted.example' }, { authorization: `Bearer ${secret}` })).status).toBe(503)
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  const pinned = await provider.resolveModel(dshDefaultModel)
  dsh.route('synthetic-provider-b')
  dsh.answer({ reply: '一周了。' })
  const result = await provider.completeJson({ model: pinned, schemaName: 'patient_dialogue_reply',
    jsonSchema: { type: 'object' }, systemPrompt: 'synthetic patient prompt', userPayload: { synthetic: true },
    validate: value => typeof value === 'object' && value !== null && 'reply' in value,
  })
  expect(result.model).toBe(encodeModelRoute({ provider: 'synthetic-provider-a', model: 'same-model' }))
  expect(dsh.calls[0]).toMatchObject({ provider: 'synthetic-provider-a', model: 'same-model', system: expect.stringContaining('synthetic patient prompt') })
  expect(dsh.calls[0]).not.toHaveProperty('tools')
  expect(dsh.calls[0]).not.toHaveProperty('sessionId')
  expect(dsh.calls[0]?.messages).toHaveLength(1)
  dsh.fail(true)
  const failed = await post({ operation: 'complete', model: pinned, schemaName: 'patient_dialogue_reply',
    jsonSchema: {}, systemPrompt: 'private synthetic prompt', userPayload: {} }, { authorization: `Bearer ${secret}` })
  expect(await failed.text()).toBe('{"error":"MODEL_UNAVAILABLE"}')
})

it.each(['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL'] as const)('distinguishes Provider %s failures without relaying credentials or private prompts', async code => {
  const dsh = await host()
  dsh.providerFailure(code)
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  await expect(provider.completeJson({ model: dshDefaultModel, schemaName: 'patient_dialogue_reply',
    jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {},
  })).rejects.toMatchObject({ code: 'AI_AUTH_FAILED',
    message: 'The selected DSH Provider rejected authentication or access; check its credentials and permissions' })
  const response = await fetch(`${dsh.origin}/clinmesh-model-bridge`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify({ operation: 'complete', model: encodeModelRoute({ provider: 'synthetic-provider-a', model: 'same-model' }),
      schemaName: 'patient_dialogue_reply', jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {} }),
  })
  expect(await response.json()).toEqual({ error: 'MODEL_AUTH_FAILED' })
})

it('preserves Provider timeouts without relaying credentials or private prompts', async () => {
  const dsh = await host()
  dsh.providerFailure('TIMEOUT')
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  await expect(provider.completeJson({ model: dshDefaultModel, schemaName: 'patient_dialogue_reply',
    jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {},
  })).rejects.toMatchObject({ code: 'AI_TIMEOUT', message: 'The DSH model request timed out' })
  const response = await fetch(`${dsh.origin}/clinmesh-model-bridge`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify({ operation: 'complete', model: encodeModelRoute({ provider: 'synthetic-provider-a', model: 'same-model' }),
      schemaName: 'patient_dialogue_reply', jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {} }),
  })
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'MODEL_TIMEOUT' })
})

it.each(['', 'private-provider-error', '{"error":"UNKNOWN"}',
  '{"error":"MODEL_AUTH_FAILED","message":"private-provider-credential"}'])('uses a safe fallback for an unrecognized bridge error body (%s)', async body => {
  const provider = new DshModelProvider({ origin: 'http://127.0.0.1:3080', secret, timeoutMs: 2000, maxResponseBytes: 2048,
    fetch: async () => new Response(body, { status: 503 }),
  })
  await expect(provider.resolveModel(dshDefaultModel)).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED',
    message: 'The DSH model bridge is unavailable' })
})

it('bounds and cancels non-success bridge response bodies', async () => {
  let cancelled = false
  const provider = new DshModelProvider({ origin: 'http://127.0.0.1:3080', secret, timeoutMs: 2000, maxResponseBytes: 2048,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2049)) },
      cancel() { cancelled = true },
    }), { status: 503 }),
  })
  await expect(provider.resolveModel(dshDefaultModel)).rejects.toMatchObject({ code: 'AI_RESPONSE_TOO_LARGE' })
  expect(cancelled).toBe(true)
})

it('regenerates invalid JSON on the same route and respects cancellation and response bounds', async () => {
  const dsh = await host()
  dsh.answer('invalid output')
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  const input = { model: dshDefaultModel, schemaName: 'patient_dialogue_reply', jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {} }
  await expect(provider.completeJson(input)).rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' })
  expect(dsh.calls).toHaveLength(2)
  expect(dsh.calls.map(call => call.provider)).toEqual(['synthetic-provider-a', 'synthetic-provider-a'])
  dsh.answer({ reply: 'x'.repeat(3000) })
  await expect(provider.completeJson(input)).rejects.toMatchObject({ code: 'AI_RESPONSE_TOO_LARGE' })
  await expect(provider.completeJson({ ...input, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'AI_TIMEOUT' })
})

it('pins the configured route while its Provider is unavailable and recovers on that route', async () => {
  const dsh = await host()
  dsh.available(false)
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  const model = await provider.resolveModel(dshDefaultModel)
  const input = { model, schemaName: 'patient_dialogue_reply', jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {} }
  await expect(provider.completeJson(input)).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' })
  dsh.route('synthetic-provider-b')
  dsh.available(true)
  dsh.answer({ reply: '一周了。' })
  await provider.completeJson(input)
  expect(dsh.calls[0]?.provider).toBe('synthetic-provider-a')
})

it('repairs a slow invalid response with validation feedback and a fresh attempt budget', async () => {
  const dsh = await host()
  const schema = z.object({ reply: z.string() }).strict()
  dsh.respond(async () => {
    await delay(450)
    return dsh.calls.length === 1 ? { reply: 123 } : { reply: '头晕一周了。' }
  })
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 700, maxResponseBytes: 2048 })
  const result = await provider.completeJson({ model: encodeModelRoute({ provider: 'synthetic-provider-a', model: 'same-model' }),
    schemaName: 'patient_dialogue_reply', jsonSchema: z.toJSONSchema(schema), systemPrompt: 'synthetic',
    userPayload: { synthetic: true }, validate: value => { schema.parse(value); return true },
  })
  expect(JSON.parse(result.content)).toEqual({ reply: '头晕一周了。' })
  expect(dsh.calls).toHaveLength(2)
  expect(dsh.calls[1]?.system).toContain('invalid_type')
  expect(dsh.calls[1]?.system).toContain('reply')
  expect(dsh.calls[1]?.messages).toEqual(dsh.calls[0]?.messages)
})

it('enforces the configured host deadline and cancels its stream before the transport deadline', async () => {
  const dsh = await host()
  dsh.hold()
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 100, maxResponseBytes: 2048 })
  await expect(provider.completeJson({ model: encodeModelRoute({ provider: 'synthetic-provider-a', model: 'same-model' }),
    schemaName: 'patient_dialogue_reply', jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {},
  })).rejects.toMatchObject({ code: 'AI_TIMEOUT', message: 'The DSH model request timed out' })
  expect(dsh.calls[0]?.signal?.aborted).toBe(true)
})

it('rejects unknown business properties even alongside harmless schema metadata', async () => {
  const dsh = await host()
  dsh.answer({ $schema: 'https://json-schema.org/draft/2020-12/schema', reply: '头晕一周了。', diagnosis: '伪造诊断' })
  const schema = z.object({ reply: z.string() }).strict()
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  await expect(provider.completeJson({ model: dshDefaultModel, schemaName: 'patient_dialogue_reply',
    jsonSchema: z.toJSONSchema(schema), systemPrompt: 'synthetic', userPayload: {},
    validate: value => { schema.parse(value); return true },
  })).rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' })
  expect(dsh.calls).toHaveLength(2)
})

it.each(['invalid-json', 'schema-mismatch'])('does not retain an earlier validation cause after a final %s failure', async finalFailure => {
  const dsh = await host()
  const earlierFailure = new z.ZodError([{ code: 'custom', path: ['additions'], message: 'private synthetic validation detail' }])
  let responses = 0
  dsh.respond(async () => ++responses === 2 && finalFailure === 'invalid-json' ? 'invalid JSON' : { additions: [] })
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  let validations = 0
  await expect(provider.completeJson({ model: dshDefaultModel, schemaName: 'consultation_history_summary',
    jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {},
    validate: () => { if (++validations === 1) throw earlierFailure; return false },
  })).rejects.toSatisfy((error: unknown) => error instanceof Error && error.cause !== earlierFailure
    && error.message === 'The DSH model returned invalid structured output')
  expect(dsh.calls).toHaveLength(2)
})

it('cancels an active auxiliary stream on caller disconnect or plugin unload', async () => {
  const dsh = await host()
  dsh.hold()
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  const input = { model: dshDefaultModel, schemaName: 'patient_dialogue_reply', jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {} }
  const caller = new AbortController()
  const completion = expect(provider.completeJson({ ...input, signal: caller.signal })).rejects.toMatchObject({ code: 'AI_TIMEOUT' })
  await expect.poll(() => dsh.calls.length).toBe(1)
  caller.abort()
  await completion
  await expect.poll(() => dsh.calls[0]?.signal?.aborted).toBe(true)
  const unloaded = expect(provider.completeJson(input)).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' })
  await expect.poll(() => dsh.calls.length).toBe(2)
  dsh.dispose()
  await unloaded
  expect(dsh.calls[1]?.signal?.aborted).toBe(true)
})

class KnownDiabetesSyntheaProvider extends StubSyntheaProvider {
  override async generate() {
    const corpus = await super.generate()
    const sources = corpus.sources.map(source => {
      const raw = z.object({ entry: z.array(z.unknown()) }).passthrough().parse(source.raw)
      raw.entry.push({ fullUrl: 'urn:uuid:prior-diabetes', resource: {
        resourceType: 'Condition', id: 'prior-diabetes', subject: { reference: 'urn:uuid:patient' },
        encounter: { reference: 'urn:uuid:prior-encounter' }, recordedDate: '2025-01-10T09:10:00+08:00',
        code: { coding: [{ system: 'http://snomed.info/sct', code: '44054006', display: '2型糖尿病' }] },
      } })
      return { ...source, raw, hash: sourceArtifactHash(raw) }
    })
    return { ...corpus, sources }
  }
}

async function hospital(dsh: Awaited<ReturnType<typeof host>>, outboxRetryDelayMs?: number,
  syntheaProvider = new StubSyntheaProvider()) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-dsh-models-'))
  cleanup.push(() => rm(directory, { recursive: true }))
  const options = {
    dshModelBridge: { origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 1024 * 1024 },
    databasePath: join(directory, 'clinmesh.sqlite'), authBaseUrl: 'http://localhost',
    authSecret: 'synthetic-auth-secret-with-at-least-32-characters', cursorSecret: secret,
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply' as const,
    syntheaProvider, trustedOrigins: ['http://localhost'],
    ...(outboxRetryDelayMs === undefined ? {} : { outboxRetryDelayMs }),
  }
  let runtime = await createClinMeshRuntime(options)
  cleanup.push(async () => runtime.close())
  return { get runtime() { return runtime }, restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) } }
}

async function recordingCase(summarize: (turns: HistoryTurn[]) => unknown, faithful = true,
  verify?: (additions: unknown[]) => unknown) {
  const dsh = await host()
  // Keep the pure diabetes question visible to the history path; hidden-diagnosis
  // leakage protection is covered separately by dialogue regressions.
  const instance = await hospital(dsh, 0, new KnownDiabetesSyntheaProvider())
  const started = await startConsultationCase(instance.runtime)
  const cookie = await signIn(instance.runtime, 'doctor@demo.clinmesh.local')
  let reply = ''
  dsh.respond(async options => {
    const payload: unknown = JSON.parse(z.object({ text: z.string() }).parse(options.messages[0]?.content[0]).text)
    if (options.system?.includes('独立病史核对者')) {
      const { additions } = z.object({ additions: z.array(z.unknown()) }).parse(payload)
      return verify?.(additions) ?? { additions: additions.map((_, index) => ({ index, faithful, complete: true, relationValid: true })) }
    }
    if (options.system?.includes('病史整理助手')) {
      const { turns } = z.object({ turns: z.array(z.object({ id: z.string(), speaker: z.string(), messageText: z.string() })) }).parse(payload)
      return summarize(turns)
    }
    return { reply }
  })
  const read = async () => doctorCaseDetailSchema.parse(await (await instance.runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } },
  )).json())
  const headers = () => ({ cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() })
  const ask = async (answer: string) => {
    reply = answer
    const detail = await read()
    const response = await instance.runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
      method: 'POST', headers: headers(), body: JSON.stringify({
        expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId, [`Task/${detail.taskId}`]: detail.taskVersion },
        input: { expectedConsultationVersion: detail.consultation!.version, message: '请继续说说您的情况。' },
      }),
    })
    expect(response.status).toBe(200)
    const turn = sendConsultationMessageResponseSchema.parse(await response.json()).data.patientTurn
    expect(turn.messageText).toBe(answer)
    return turn
  }
  const control = async (action: 'backfill' | 'retry') => {
    const detail = await read()
    const response = await instance.runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/consultation-recording/actions/control`, {
      method: 'POST', headers: headers(), body: JSON.stringify({
        expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId },
        input: { action, expectedRecordingVersion: detail.consultationRecording!.version },
      }),
    })
    expect(response.status).toBe(200)
    return controlConsultationRecordingResponseSchema.parse(await response.json())
  }
  return { instance, dsh, read, ask, control }
}

const mixedQuestionReply = '医生，那我今天到现在还没吃东西，水也就抿了两口，这样抽血行不行啊？'
const mixedQuestionSummary = '患者自述今日尚未进食，仅饮少量水'
function candidate(turn: HistoryTurn, text: string) {
  return { additions: [{ field: 'historyOfPresentIllness', relation: 'addition',
    facts: [{ text, sources: [{ sourceTurnId: turn.id, quote: turn.messageText }] }] }] }
}

it.each(['citation', 'target', 'field-limit', 'verification-coverage'] as const)(
  'preserves the final DSH %s diagnostic in immutable failure receipts across explicit recovery', async reason => {
    let invalid = true
    const reply = '头晕一周了。'
    const summary = '患者自述头晕一周'
    const fixture = await recordingCase(turns => {
      const output = candidate(turns.at(-1)!, summary)
      if (!invalid) return output
      const addition = output.additions[0]!
      if (reason === 'citation') return { additions: [{ ...addition,
        facts: [{ text: summary, sources: [{ sourceTurnId: turns.at(-1)!.id, quote: '未曾说过的合成引用。' }] }],
      }] }
      if (reason === 'target') return { additions: [{ ...addition, relation: 'update', targetAdditionId: 'synthetic-missing-target' }] }
      if (reason === 'field-limit') return { additions: [{ ...addition, field: 'chiefComplaint',
        facts: Array.from({ length: 2 }, () => ({ ...addition.facts[0]!, text: '合'.repeat(600) })),
      }] }
      return output
    }, true, additions => ({ additions: invalid && reason === 'verification-coverage' ? []
      : additions.map((_, index) => ({ index, faithful: true, complete: true, relationValid: true })) }))
    await fixture.ask(reply)
    await fixture.instance.runtime.dispatchPending()
    const failed = await fixture.read()
    expect(failed.clinicalDocument?.draft).toBeUndefined()
    expect(failed.consultationRecording).toMatchObject({ status: 'failed', additions: [],
      failures: [{ code: 'AI_RESPONSE_INVALID', retrying: false }] })
    const receipts = () => fixture.instance.runtime.database.driver.prepare(
      "SELECT response_json FROM command_receipt WHERE operation = 'consultation.history.fail' ORDER BY rowid",
    ).all().map(row => JSON.parse(z.object({ response_json: z.string() }).parse(row).response_json) as unknown)
    const failures = receipts()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ data: { status: 'failed', code: 'AI_RESPONSE_INVALID', diagnostic: {
      stage: reason === 'verification-coverage' ? 'verification' : 'summary', reason,
    } } })
    expect(JSON.stringify(failures)).not.toMatch(new RegExp(`${reply}|${summary}|未曾说过的合成引用|${secret}|病史整理助手`))
    const repairedStage = reason === 'verification-coverage' ? '独立病史核对者' : '病史整理助手'
    expect(fixture.dsh.calls.filter(call => call.system?.includes(repairedStage))).toHaveLength(2)
    await fixture.instance.restart()
    invalid = false
    await fixture.control('retry')
    await fixture.instance.runtime.dispatchPending()
    const recovered = await fixture.read()
    expect(recovered.consultationRecording).toMatchObject({ status: 'updated', failures: [] })
    expect(recovered.clinicalDocument?.draft?.historyOfPresentIllness).toBe(summary)
    expect(receipts()).toEqual(failures)
  },
)

it.each([
  [mixedQuestionReply, '患者已空腹至少8小时'],
  [mixedQuestionReply, '患者符合空腹采血条件'],
  [mixedQuestionReply, '患者已经完成采血'],
  ['我是不是糖尿病？', '患者确诊糖尿病'],
  ['胸痛已经三天了吗？', '患者胸痛三天'],
  ['如果我三天没吃饭，会不会头晕？', '患者三天未进食'],
  ['我没有胸痛，是不是就不用检查了？', '患者胸痛'],
  ['我可能昨晚发烧了，需要检查吗？', '患者昨晚发热'],
])('rejects unsupported facts from a complete question through independent DSH verification: %s → %s', async (reply, text) => {
  const fixture = await recordingCase(turns => candidate(turns.at(-1)!, text), false)
  await fixture.ask(reply)
  await fixture.instance.runtime.dispatchPending()
  const detail = await fixture.read()
  expect(detail.clinicalDocument?.draft).toBeUndefined()
  expect(detail.consultationRecording).toMatchObject({ status: 'failed', additions: [],
    failures: [{ code: 'CONSULTATION_RECORDING_SOURCE_INVALID' }] })
  expect(detail.consultation!.turns.at(-1)!.messageText).toBe(reply)
  const summaries = fixture.dsh.calls.filter(call => call.system?.includes('病史整理助手'))
  const verifications = fixture.dsh.calls.filter(call => call.system?.includes('独立病史核对者'))
  expect(verifications.length).toBeGreaterThan(0)
  expect(verifications).toHaveLength(summaries.length)
  expect(verifications.every(call => !call.system?.includes('previous response failed validation'))).toBe(true)
})

it.each(['我是不是糖尿病？', '胸痛已经三天了吗？', '如果三天不吃东西，会不会头晕？'])(
  'completes a pure question without history through DSH: %s', async reply => {
    const fixture = await recordingCase(() => ({ additions: [] }))
    await fixture.ask(reply)
    await fixture.instance.runtime.dispatchPending()
    expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'updated', processedCount: 1,
      remainingCount: 0, failedCount: 0, failures: [], additions: [] })
    expect((await fixture.read()).clinicalDocument?.draft).toBeUndefined()
    expect(fixture.dsh.calls.filter(call => call.system?.includes('独立病史核对者'))).toHaveLength(0)
  },
)

it.each([
  ['我没有胸痛，是不是就不用检查了？', '患者否认胸痛'],
  ['我可能昨晚发烧了，需要检查吗？', '患者自述可能于昨晚发热'],
  ['我昨晚开始头晕。今天站起来更明显，是不是要检查？', '患者自述昨晚起头晕，今日站立时加重'],
])('keeps negation, uncertainty and connected sentences in DSH summaries: %s', async (reply, text) => {
  const fixture = await recordingCase(turns => candidate(turns.at(-1)!, text))
  await fixture.ask(reply)
  await fixture.instance.runtime.dispatchPending()
  const pending = await fixture.read()
  expect(pending.clinicalDocument?.draft?.historyOfPresentIllness).toBe(text)
  expect(pending.consultationRecording).toMatchObject({ status: 'updated', additions: [{ status: 'applied' }] })
  expect(pending.consultationRecording!.additions[0]!.facts).toMatchObject([
    { text, sources: [{ quote: reply }] },
  ])
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(text)
})

it('backfills complete mixed questions through DSH without rewriting saved replies', async () => {
  const fixture = await recordingCase(turns => {
    const turn = turns.at(-1)!
    return turn.messageText === mixedQuestionReply ? candidate(turn, mixedQuestionSummary) : { additions: [] }
  })
  // Existing consultations have no automatic eligibility until explicit backfill.
  fixture.instance.runtime.database.driver.prepare('DELETE FROM consultation_recording').run()
  const turn = await fixture.ask(mixedQuestionReply)
  await fixture.instance.restart()
  await fixture.instance.runtime.dispatchPending()
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'backfill', processedCount: 0, remainingCount: 2 })
  expect(fixture.dsh.calls.filter(call => call.system?.includes('病史整理助手'))).toHaveLength(0)
  await fixture.control('backfill')
  await fixture.instance.runtime.dispatchPending()
  const detail = await fixture.read()
  expect(detail.clinicalDocument?.draft?.historyOfPresentIllness).toBe(mixedQuestionSummary)
  expect(detail.consultationRecording).toMatchObject({ status: 'updated', processedCount: 2, remainingCount: 0, failures: [],
    additions: [{ status: 'applied', facts: [{ sources: [{ sourceTurnId: turn.id, quote: mixedQuestionReply }] }] }] })
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(mixedQuestionSummary)
})

it('explicitly recovers five completed, one failed and one queued DSH recording without rerunning successful jobs', async () => {
  const fixture = await recordingCase(turns => {
    const turn = turns.at(-1)!
    return candidate(turn, turn.messageText === mixedQuestionReply ? mixedQuestionSummary : `患者自述：${turn.messageText}`)
  })
  for (const reply of ['头晕一周了。', '昨天咳嗽了。', '今天有点乏力。', '以前吃过氨氯地平。', '没有药物过敏。']) {
    await fixture.ask(reply)
    await fixture.instance.runtime.dispatchPending()
    }
  const completed = await fixture.read()
  const jobs = () => fixture.instance.runtime.database.driver.prepare(
    'SELECT * FROM consultation_recording_job ORDER BY rowid',
  ).all()
  const completedJobs = jobs()
  expect(completedJobs).toHaveLength(5)
  const failedTurn = await fixture.ask(mixedQuestionReply)
  // Seed the persisted pre-fix AI_RESPONSE_INVALID outcome; deployment must not revive it.
  fixture.instance.runtime.database.driver.prepare(
    "UPDATE consultation_recording_job SET status = 'failed', error_code = 'AI_RESPONSE_INVALID' WHERE turn_id = ?",
  ).run(failedTurn.id)
  const queuedTurn = await fixture.ask('我胸口已经痛三天了，这会不会很严重?')
  await fixture.instance.runtime.dispatchPending()
  const callsBeforeRestart = fixture.dsh.calls.length
  await fixture.instance.restart()
  await fixture.instance.runtime.dispatchPending()
  const failed = await fixture.read()
  expect(failed.consultationRecording).toMatchObject({ status: 'failed', processedCount: 5, failedCount: 1, remainingCount: 2,
    failures: [{ sourceTurnId: failedTurn.id, code: 'AI_RESPONSE_INVALID', retrying: false }] })
  expect(failed.clinicalDocument?.draft).toEqual(completed.clinicalDocument?.draft)
  expect(failed.consultation!.turns.slice(-3).map(turn => turn.id)).toContain(queuedTurn.id)
  expect(fixture.dsh.calls).toHaveLength(callsBeforeRestart)
  await fixture.control('retry')
  await fixture.instance.runtime.dispatchPending()
  const recovered = await fixture.read()
  expect(recovered.consultationRecording).toMatchObject({ status: 'updated', processedCount: 7, failedCount: 0,
    remainingCount: 0, failures: [] })
  expect(recovered.clinicalDocument?.draft?.historyOfPresentIllness).toContain(completed.clinicalDocument!.draft!.historyOfPresentIllness)
  expect(recovered.consultationRecording!.additions.slice(0, 5)).toEqual(completed.consultationRecording!.additions)
  const applied = await fixture.read()
  expect(applied.clinicalDocument!.draft!.historyOfPresentIllness).toBe(
    completed.clinicalDocument!.draft!.historyOfPresentIllness + '\n' + mixedQuestionSummary + '\n患者自述：' + queuedTurn.messageText,
  )
  expect(jobs().slice(0, 5)).toEqual(completedJobs)
  expect(fixture.dsh.calls).toHaveLength(callsBeforeRestart + 4)
  const recordingCalls = fixture.dsh.calls.slice(callsBeforeRestart)
  expect(recordingCalls.map(call => JSON.parse(z.object({ text: z.string() }).parse(call.messages[0]!.content[0]).text))
    .map(payload => payload.currentTurnId ?? payload.turns.at(-1).id)).toEqual([failedTurn.id, failedTurn.id, queuedTurn.id, queuedTurn.id])
  await fixture.instance.restart()
  await fixture.instance.runtime.dispatchPending()
  expect((await fixture.read()).clinicalDocument?.draft).toEqual(applied.clinicalDocument?.draft)
  expect(fixture.dsh.calls).toHaveLength(callsBeforeRestart + 4)
})

it.each([false, true].flatMap(metadata => [
  { metadata, reply: '头晕一周了。', summary: '头晕一周' },
  { metadata, reply: '医生，那我今天到现在还没吃东西，水也就抿了两口，这样抽血行不行啊？', summary: '患者自述今日尚未进食，仅饮少量水' },
  { metadata, reply: '我胸口已经痛三天了，这会不会很严重?', summary: '患者自述胸痛三天' },
]))('restores queued DSH recording and writes history directly ($reply, schema metadata: $metadata)', async ({ metadata, reply, summary }) => {
  const dsh = await host()
  const instance = await hospital(dsh)
  const started = await startConsultationCase(instance.runtime)
  const cookie = await signIn(instance.runtime, 'doctor@demo.clinmesh.local')
  dsh.answer({ reply })
  const response = await instance.runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
    method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: started.encounterVersion,
      [`Task/${started.doctorTaskId}`]: '1' }, input: { expectedConsultationVersion: 2, message: '多久了？' } }),
  })
  expect(response.status).toBe(200)
  const answered = await response.json() as { data: { patientTurn: { id: string } } }
  await instance.restart()
  const beforeRecording = dsh.calls.length
  dsh.respond(async options => ({ ...(metadata ? { $schema: 'https://json-schema.org/draft/2020-12/schema' } : {}),
    additions: options.system?.includes('独立病史核对者')
      ? [{ index: 0, faithful: true, complete: true, relationValid: true }]
      : [{ field: 'historyOfPresentIllness', relation: 'addition', facts: [{ text: summary,
        sources: [{ sourceTurnId: answered.data.patientTurn.id, quote: reply }] }] }],
  }))
  await instance.runtime.dispatchPending()
  const detail = doctorCaseDetailSchema.parse(await (await instance.runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } },
  )).json())
  expect(detail.clinicalDocument?.draft?.historyOfPresentIllness).toBe(summary)
  expect(detail.consultationRecording!.additions[0]!.facts).toEqual([
    { text: summary, sources: [{ sourceTurnId: answered.data.patientTurn.id, quote: reply }] },
  ])
  expect(detail.consultationRecording).toMatchObject({ status: 'updated', additions: [{ status: 'applied' }] })
  expect(dsh.calls).toHaveLength(beforeRecording + 2)
  expect(dsh.calls.at(-2)?.system).toContain('跨轮归并')
  expect(dsh.calls.at(-1)?.system).toContain('独立病史核对者')
  const call = dsh.calls.at(-1)!
  expect(call.provider).toBe('synthetic-provider-a')
  expect(JSON.stringify(call)).toContain('sourceTurnId')
  expect(JSON.stringify(call)).not.toMatch(/hiddenResources|Case Truth|private-session-transcript|reasoning/)
  const applied = doctorCaseDetailSchema.parse(await (await instance.runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } },
  )).json())
  expect(applied.clinicalDocument?.draft?.historyOfPresentIllness).toBe(summary)
  expect(applied.consultationRecording!.additions[0]!.status).toBe('applied')
  const count = dsh.calls.length
  await instance.restart()
  await instance.runtime.dispatchPending()
  expect(dsh.calls).toHaveLength(count)
})

it('pins queued personas through settings changes and a Server restart', async () => {
  const dsh = await host()
  const instance = await hospital(dsh)
  const runtime = instance.runtime
  const cookie = await signIn(runtime, 'admin@demo.clinmesh.local')
  const headers = { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }
  const generation = await runtime.app.request('/api/sim/v1/scenario-generation-jobs', {
    method: 'POST', headers, body: JSON.stringify({ name: '模型路由演练',
      population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' }, providerId: 'synthea',
      seeds: { clinical: 7331, population: 4242 }, timeRange: { end: '2026-08-01', start: '2020-01-01' }, timeZone: 'Asia/Shanghai' }),
  })
  expect(generation.status).toBe(200)
  const generated = await runtime.scenarioData.processNextGenerationJob()
  const idempotencyKey = randomUUID()
  const context = await runtime.identity.resolveRequestActor(new Headers({ cookie }), 'GET', '/api/session')
  const queued = await runtime.app.request(`/api/sim/v1/synthetic-cases/${generated?.caseIds[0]}/patient-persona-jobs`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': idempotencyKey }, body: '{}',
  })
  expect(queued.status).toBe(200)
  dsh.route('synthetic-provider-b')
  await instance.restart()
  expect(await instance.runtime.patientPersona.processNext()).toMatchObject({ status: 'succeeded' })
  expect(dsh.calls.at(-1)?.provider).toBe('synthetic-provider-a')
  // Idempotency belongs to the actor: another administrator's new task uses the new selection.
  await instance.runtime.patientPersona.enqueue({ caseId: generated!.caseIds[0]!,
    context: { ...context, actorId: 'synthetic-second-administrator' }, idempotencyKey })
  expect(await instance.runtime.patientPersona.processNext()).toMatchObject({ status: 'succeeded' })
  expect(dsh.calls.at(-1)?.provider).toBe('synthetic-provider-b')
})

it('uses current settings for a new reply retry and pins retransmissions of that retry', async () => {
  const dsh = await host()
  const instance = await hospital(dsh)
  const runtime = instance.runtime
  const started = await startConsultationCase(runtime)
  const headers = (cookie: string) => ({ cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() })
  dsh.route('synthetic-provider-b')
  const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const versions = { [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1' }
  dsh.answer({ reply: '一周了，站起来就晕。' })
  dsh.fail(true)
  const asked = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
    method: 'POST', headers: headers(doctor), body: JSON.stringify({ expectedVersions: versions,
      input: { expectedConsultationVersion: 2, message: '多久了？' } }),
  })
  expect(asked.status).toBe(503)
  dsh.route('synthetic-provider-a')
  const detail = doctorCaseDetailSchema.parse(await (await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie: doctor } })).json())
  const retryPath = `/api/his/v1/encounters/${started.encounterId}/actions/retry-consultation-reply`
  const retryRequest = {
    method: 'POST', headers: headers(doctor), body: JSON.stringify({ expectedVersions: {}, input: { expectedConsultationVersion: detail.consultation?.version } }),
  }
  expect((await runtime.app.request(retryPath, retryRequest)).status).toBe(503)
  expect(dsh.calls.at(-1)?.provider).toBe('synthetic-provider-a')
  dsh.route('synthetic-provider-b')
  expect((await runtime.app.request(retryPath, retryRequest)).status).toBe(503)
  expect(dsh.calls.at(-1)?.provider).toBe('synthetic-provider-a')
  dsh.fail(false)
  const newRetryRequest = { ...retryRequest, headers: headers(doctor) }
  const retry = await runtime.app.request(retryPath, newRetryRequest)
  expect(retry.status).toBe(200)
  expect(dsh.calls.at(-1)?.provider).toBe('synthetic-provider-b')
  const reply: unknown = await retry.json()
  const callCount = dsh.calls.length
  dsh.route('synthetic-provider-a')
  expect(await (await runtime.app.request(retryPath, newRetryRequest)).json()).toEqual(reply)
  expect(dsh.calls).toHaveLength(callCount)
})
