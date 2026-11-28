import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  type AssistantMessage,
} from '@earendil-works/pi-ai'
import {
  agentSessionDetailSchema,
  agentSessionSseEventSchema,
  clinicalEntitiesResponseSchema,
  exportAgentSessionResponseSchema,
  listAgentSessionsResponseSchema,
  listClinicianMemoryResponseSchema,
  LLM_RUNTIME_HEADERS,
  llmProviderCatalogResponseSchema,
  modelCallDetailResponseSchema,
  searchAgentSessionsResponseSchema,
  sessionContextResponseSchema,
  sideChatResponseSchema,
  testLlmProviderResponseSchema,
} from '@clinmesh/contracts/agent-sessions'
import { doctorCaseDetailSchema, sendConsultationMessageResponseSchema } from '@clinmesh/contracts/his'
import { createClinMeshRuntime } from '../src/runtime.ts'
import type { CustomMockResponder } from '../src/infrastructure/agents/byok-provider-resolver.ts'
import {
  persona,
  signIn,
  startConsultationCase,
  StubSyntheaProvider,
} from './fixtures/consultation.ts'
import type { JsonChatCompletionInput, JsonChatCompletionsProvider } from '../src/infrastructure/ai/openai-chat-completions.ts'

const origin = 'http://localhost'
const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

class PersonaOnlyProvider implements JsonChatCompletionsProvider {
  async completeJson(_input: JsonChatCompletionInput) {
    return { content: JSON.stringify(persona), model: 'fake-persona-model' }
  }
}

async function createTestRuntime(options: {
  databasePath?: string
  mockResponder?: CustomMockResponder
  mockTokensPerSecond?: number
  withPersonaProvider?: boolean
  localProviders?: { enabled: boolean; homeDir?: string; env?: NodeJS.ProcessEnv }
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'clinmesh-pi-durable-'))
  directories.push(dir)
  const dbPath = options.databasePath ?? join(dir, 'clinmesh.sqlite')
  const runtime = await createClinMeshRuntime({
    authBaseUrl: origin,
    authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath: dbPath,
    demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply',
    outboxRetryDelayMs: 0,
    syntheaProvider: new StubSyntheaProvider(),
    trustedOrigins: [origin],
    ...(options.withPersonaProvider ? {
      chatCompletionsProvider: new PersonaOnlyProvider(),
      patientPersonaModel: 'fake-persona-model',
    } : {}),
    ...(options.mockResponder === undefined ? {} : { mockResponder: options.mockResponder }),
    ...(options.mockTokensPerSecond === undefined ? {} : { mockTokensPerSecond: options.mockTokensPerSecond }),
    ...(options.localProviders === undefined ? {} : { localProviders: options.localProviders }),
  })
  runtimes.push(runtime)
  return { runtime, dbPath }
}

async function waitForSessionIdle(
  runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
  cookie: string,
  sessionId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await runtime.app.request(`/api/agents/sessions/${sessionId}`, {
      headers: { cookie },
    })
    const detail = agentSessionDetailSchema.parse(await res.json())
    if (detail.session.status !== 'running') return detail
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`Timed out waiting for session ${sessionId} to become idle`)
}

function assertZeroSecretInDatabase(
  runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
  secret: string,
) {
  const tables = (runtime.database.driver.prepare(
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  ).all() as Array<{ name: string }>).map(row => row.name)

  for (const table of tables) {
    const rows = runtime.database.driver.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all()
    const serialized = JSON.stringify(rows)
    expect(serialized, `Secret leaked into table ${table}`).not.toContain(secret)
  }
}

describe('pi-durable agent runtime, BYOK security, Mock Mode, and Patient Agent isolation', () => {
  it('mounts pi_* tables cleanly inside the workspace SQLite database and enforces explicit unconfigured errors', async () => {
    const { runtime } = await createTestRuntime({ withPersonaProvider: true })
    const tables = (runtime.database.driver.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'pi_%' ORDER BY name`,
    ).all() as Array<{ name: string }>).map(row => row.name)
    expect(tables).toContain('pi_conversations')
    expect(tables).toContain('pi_entries')
    expect(tables).toContain('pi_tasks')
    expect(tables).toContain('pi_documents')
    expect(runtime.database.diagnostics().integrity).toBe('ok')

    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local')

    // 1. Provider test without API key & Mock Mode OFF -> explicit LLM_PROVIDER_UNCONFIGURED
    const testRes = await runtime.app.request('/api/agents/providers/test', {
      method: 'POST',
      headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'live',
        provider: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        modelId: 'gpt-4.1-mini',
      }),
    })
    expect(testRes.status).toBe(200)
    const testPayload = testLlmProviderResponseSchema.parse(await testRes.json())
    expect(testPayload.ok).toBe(false)
    expect(testPayload.errorCode).toBe('LLM_PROVIDER_UNCONFIGURED')

    // 2. Clinician Assistant send without key & Mock Mode OFF -> explicit 503 LLM_PROVIDER_UNCONFIGURED
    const createRes = await runtime.app.request('/api/agents/sessions', {
      method: 'POST',
      headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '未配置测试' }),
    })
    expect(createRes.status).toBe(201)
    const created = agentSessionDetailSchema.parse(await createRes.json())

    const sendRes = await runtime.app.request(`/api/agents/sessions/${created.session.sessionId}/messages`, {
      method: 'POST',
      headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '帮我分析下症状' }),
    })
    expect(sendRes.status).toBe(503)
    const sendError = await sendRes.json() as { error: { code: string } }
    expect(sendError.error.code).toBe('LLM_PROVIDER_UNCONFIGURED')

    // 3. Patient Agent ask without consultationModel / BYOK / Mock Mode -> explicit 503 LLM_PROVIDER_UNCONFIGURED
    const caseData = await startConsultationCase(runtime)
    const detailRes = await runtime.app.request(`/api/his/v1/doctor/cases/${caseData.outpatientCaseId}`, {
      headers: { cookie: doctorCookie },
    })
    const caseDetail = doctorCaseDetailSchema.parse(await detailRes.json())
    const askRes = await runtime.app.request(
      `/api/his/v1/encounters/${caseData.encounterId}/actions/ask-consultation-question`,
      {
        method: 'POST',
        headers: {
          cookie: doctorCookie,
          origin,
          'content-type': 'application/json',
          'idempotency-key': `unconfigured-${randomUUID()}`,
        },
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${caseDetail.encounter.id}`]: caseDetail.encounter.versionId,
            [`Task/${caseData.doctorTaskId}`]: '1',
          },
          input: { expectedConsultationVersion: caseDetail.consultation!.version, message: '哪里不舒服？' },
        }),
      },
    )
    expect(askRes.status).toBe(503)
    const askError = await askRes.json() as { error: { code: string } }
    expect(askError.error.code).toBe('LLM_PROVIDER_UNCONFIGURED')
  })

  it('never persists BYOK API keys into SQLite or leaks them into error responses', async () => {
    const { runtime, dbPath } = await createTestRuntime()
    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
    const sentinelKey = 'sk-clinmesh-byok-sentinel-never-persist-987654321'

    // Start a tiny local HTTP server that echoes back a 401 mentioning the Authorization key.
    const { createServer } = await import('node:http')
    const fakeUpstream = createServer((req, res) => {
      const auth = req.headers.authorization ?? ''
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: { message: `Invalid authentication header: ${auth}`, type: 'invalid_request_error' },
      }))
    })
    await new Promise<void>(resolve => fakeUpstream.listen(0, '127.0.0.1', () => resolve()))
    const address = fakeUpstream.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const baseUrl = `http://127.0.0.1:${port}/v1`

    try {
      // 1. Test connection against upstream echoing key in 401 error
      const probeRes = await runtime.app.request('/api/agents/providers/test', {
        method: 'POST',
        headers: {
          cookie: doctorCookie,
          origin,
          'content-type': 'application/json',
          [LLM_RUNTIME_HEADERS.apiKey]: sentinelKey,
        },
        body: JSON.stringify({
          mode: 'live',
          provider: 'openai-compatible',
          baseUrl,
          modelId: 'test-model',
        }),
      })
      const probeBody = testLlmProviderResponseSchema.parse(await probeRes.json())
      expect(probeBody.ok).toBe(false)
      expect(probeBody.errorCode).toBe('LLM_AUTH_FAILED')
      expect(probeBody.message).not.toContain(sentinelKey)

      // 2. Send assistant message with BYOK header
      const createRes = await runtime.app.request('/api/agents/sessions', {
        method: 'POST',
        headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'BYOK 安全校验' }),
      })
      const created = agentSessionDetailSchema.parse(await createRes.json())

      const sendRes = await runtime.app.request(`/api/agents/sessions/${created.session.sessionId}/messages`, {
        method: 'POST',
        headers: {
          cookie: doctorCookie,
          origin,
          'content-type': 'application/json',
          [LLM_RUNTIME_HEADERS.mode]: 'live',
          [LLM_RUNTIME_HEADERS.provider]: 'openai-compatible',
          [LLM_RUNTIME_HEADERS.baseUrl]: baseUrl,
          [LLM_RUNTIME_HEADERS.modelId]: 'test-model',
          [LLM_RUNTIME_HEADERS.apiKey]: sentinelKey,
        },
        body: JSON.stringify({ content: '测试密钥隔离' }),
      })
      expect(sendRes.status).toBe(202)
      const finalDetail = await waitForSessionIdle(runtime, doctorCookie, created.session.sessionId)
      expect(finalDetail.session.status).toBe('error')
      expect(JSON.stringify(finalDetail)).not.toContain(sentinelKey)

      // 3. Scan every SQLite table AND raw database file bytes for 0 occurrences
      assertZeroSecretInDatabase(runtime, sentinelKey)
      runtime.database.driver.pragma('wal_checkpoint(TRUNCATE)')
      const rawDbBytes = await readFile(dbPath)
      expect(rawDbBytes.includes(Buffer.from(sentinelKey, 'utf8'))).toBe(false)
    } finally {
      await new Promise<void>(resolve => fakeUpstream.close(() => resolve()))
    }
  })

  it('supports Mock Mode streaming, thinking + tool-call blocks, SSE rejoin, stop, retry latest, rename, fork, delete, and scope isolation', async () => {
    const { runtime } = await createTestRuntime({ withPersonaProvider: true })
    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
    const nurseCookie = await signIn(runtime, 'triage@demo.clinmesh.local')
    const caseData = await startConsultationCase(runtime)
    const caseDetailRes = await runtime.app.request(`/api/his/v1/doctor/cases/${caseData.outpatientCaseId}`, {
      headers: { cookie: doctorCookie },
    })
    const caseDetail = doctorCaseDetailSchema.parse(await caseDetailRes.json())

    // Create encounter-scoped Clinician Assistant session
    const createRes = await runtime.app.request('/api/agents/sessions', {
      method: 'POST',
      headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '门诊助手测试',
        encounterId: caseData.encounterId,
        caseId: caseData.outpatientCaseId,
        patientId: caseDetail.patient.id,
      }),
    })
    expect(createRes.status).toBe(201)
    const created = agentSessionDetailSchema.parse(await createRes.json())
    const sessionId = created.session.sessionId

    // Send prompt triggering Mock Mode thinking + read_visible_case_summary durable tool call
    const sendRes = await runtime.app.request(`/api/agents/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        cookie: doctorCookie,
        origin,
        'content-type': 'application/json',
        [LLM_RUNTIME_HEADERS.mode]: 'mock',
        [LLM_RUNTIME_HEADERS.provider]: 'mock',
        [LLM_RUNTIME_HEADERS.modelId]: 'mock-clinmesh-v1',
        [LLM_RUNTIME_HEADERS.reasoningEffort]: 'medium',
      },
      body: JSON.stringify({ content: '请帮我整理当前病例摘要' }),
    })
    expect(sendRes.status).toBe(202)

    // Open SSE stream and collect snapshots until idle
    const sseAbort = new AbortController()
    const sseRes = await runtime.app.request(`/api/agents/sessions/${sessionId}/events`, {
      headers: { cookie: doctorCookie },
      signal: sseAbort.signal,
    })
    expect(sseRes.status).toBe(200)
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream')
    const reader = sseRes.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let latestDetail = created
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const dataLine = frame.split('\n').find(line => line.startsWith('data:'))
        if (!dataLine) continue
        const parsedEvent = agentSessionSseEventSchema.parse(JSON.parse(dataLine.slice(5).trim()))
        if (parsedEvent.type === 'snapshot') {
          latestDetail = parsedEvent.detail
          if (latestDetail.session.status === 'idle' && latestDetail.messages.some(m => m.role === 'assistant' && !m.streaming && m.blocks.some(b => b.type === 'text'))) {
            sseAbort.abort()
            break
          }
        }
      }
      if (sseAbort.signal.aborted) break
    }
    reader.releaseLock()

    const allBlocks = latestDetail.messages.flatMap(m => m.blocks)
    expect(allBlocks.some(b => b.type === 'thinking')).toBe(true)
    expect(allBlocks.some(b => b.type === 'tool-call' && b.name === 'read_visible_case_summary' && b.status === 'done')).toBe(true)
    expect(allBlocks.some(b => b.type === 'text' && b.text.includes('当前病例摘要'))).toBe(true)

    // Verify Context Snapshots captured both tool round and final reply calls with categorized breakdown
    const ctxRes = await runtime.app.request(`/api/agents/sessions/${sessionId}/context`, {
      headers: { cookie: doctorCookie },
    })
    expect(ctxRes.status).toBe(200)
    const ctxPayload = sessionContextResponseSchema.parse(await ctxRes.json())
    expect(ctxPayload.modelCalls.length).toBeGreaterThanOrEqual(2)
    expect(ctxPayload.latestCall).not.toBeNull()
    expect(ctxPayload.latestCall!.usage.source).toBe('SIMULATED')
    expect(ctxPayload.latestCall!.usage.promptTokens).toBeGreaterThan(0)
    expect(ctxPayload.latestCall!.estimate.byKind.INSTRUCTIONS).toBeGreaterThan(0)
    expect(ctxPayload.latestCall!.estimate.byKind.CLINICAL_CONTEXT).toBeGreaterThan(0)
    expect(ctxPayload.latestCall!.estimate.byKind.TOOL_DEFINITION).toBeGreaterThan(0)
    expect(ctxPayload.latestCall!.estimate.byKind.TOOL_RESULT).toBeGreaterThan(0)

    const callDetailRes = await runtime.app.request(
      `/api/agents/sessions/${sessionId}/model-calls/${ctxPayload.latestCall!.id}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(callDetailRes.status).toBe(200)
    const callDetail = modelCallDetailResponseSchema.parse(await callDetailRes.json()).modelCall
    expect(callDetail.included.some(item => item.kind === 'INSTRUCTIONS')).toBe(true)
    expect(callDetail.included.some(item => item.kind === 'CLINICAL_CONTEXT' && item.content.includes(caseData.encounterId))).toBe(true)
    expect(callDetail.included.some(item => item.kind === 'TOOL_DEFINITION' && item.label === 'read_visible_case_summary')).toBe(true)
    expect(callDetail.included.some(item => item.kind === 'TOOL_RESULT' && item.label === 'read_visible_case_summary')).toBe(true)
    expect(callDetail.response.some(item => item.kind === 'ASSISTANT_MESSAGE')).toBe(true)

    // Retry latest user message replaces assistant response without duplicating user turn and logs RETRY_OMIT
    const retryRes = await runtime.app.request(`/api/agents/sessions/${sessionId}/retry`, {
      method: 'POST',
      headers: {
        cookie: doctorCookie,
        origin,
        [LLM_RUNTIME_HEADERS.mode]: 'mock',
        [LLM_RUNTIME_HEADERS.provider]: 'mock',
        [LLM_RUNTIME_HEADERS.modelId]: 'mock-clinmesh-v1',
      },
    })
    expect(retryRes.status).toBe(202)
    const afterRetry = await waitForSessionIdle(runtime, doctorCookie, sessionId)
    expect(afterRetry.messages.filter(m => m.role === 'user')).toHaveLength(1)
    expect(afterRetry.latestContextCall).not.toBeNull()

    const ctxAfterRetryRes = await runtime.app.request(`/api/agents/sessions/${sessionId}/context`, {
      headers: { cookie: doctorCookie },
    })
    const ctxAfterRetry = sessionContextResponseSchema.parse(await ctxAfterRetryRes.json())
    expect(ctxAfterRetry.contextEvents.some(ev => ev.kind === 'RETRY_OMIT' && ev.removedCount > 0)).toBe(true)
    expect(ctxAfterRetry.latestCall!.excludedCount).toBeGreaterThan(0)

    // Rename & Fork
    const renameRes = await runtime.app.request(`/api/agents/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '重命名后的病例助手' }),
    })
    expect(renameRes.status).toBe(200)
    expect(((await renameRes.json()) as { session: { title: string } }).session.title).toBe('重命名后的病例助手')

    const forkRes = await runtime.app.request(`/api/agents/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '分支探索会话' }),
    })
    expect(forkRes.status).toBe(201)
    const forked = agentSessionDetailSchema.parse(await forkRes.json())
    expect(forked.session.forkedFromSessionId).toBe(sessionId)
    expect(forked.messages.length).toBeGreaterThanOrEqual(2)

    // Forked session inherits context snapshot history
    const forkedCtxRes = await runtime.app.request(`/api/agents/sessions/${forked.session.sessionId}/context`, {
      headers: { cookie: doctorCookie },
    })
    expect(forkedCtxRes.status).toBe(200)
    const forkedCtx = sessionContextResponseSchema.parse(await forkedCtxRes.json())
    expect(forkedCtx.modelCalls.length).toBe(ctxAfterRetry.modelCalls.length)

    // Scope isolation: Nurse role forbidden on session AND context routes; different encounterId returns empty list
    const nurseRes = await runtime.app.request(`/api/agents/sessions/${sessionId}`, {
      headers: { cookie: nurseCookie },
    })
    expect(nurseRes.status).toBe(403)
    const nurseCtxRes = await runtime.app.request(`/api/agents/sessions/${sessionId}/context`, {
      headers: { cookie: nurseCookie },
    })
    expect(nurseCtxRes.status).toBe(403)
    const nurseCallRes = await runtime.app.request(
      `/api/agents/sessions/${sessionId}/model-calls/${ctxPayload.latestCall!.id}`,
      { headers: { cookie: nurseCookie } },
    )
    expect(nurseCallRes.status).toBe(403)

    const otherEncounterListRes = await runtime.app.request('/api/agents/sessions?encounterId=enc-unrelated', {
      headers: { cookie: doctorCookie },
    })
    const otherList = listAgentSessionsResponseSchema.parse(await otherEncounterListRes.json())
    expect(otherList.sessions).toHaveLength(0)

    // Delete forked session
    const deleteRes = await runtime.app.request(`/api/agents/sessions/${forked.session.sessionId}`, {
      method: 'DELETE',
      headers: { cookie: doctorCookie, origin },
    })
    expect(deleteRes.status).toBe(200)
    const afterDeleteRes = await runtime.app.request(`/api/agents/sessions/${forked.session.sessionId}`, {
      headers: { cookie: doctorCookie },
    })
    expect(afterDeleteRes.status).toBe(404)
  })

  it('isolates Patient Agent context from Case Truth and enforces hidden-diagnosis leak guard through pi-durable', async () => {
    const capturedPrompts: string[] = []
    let mockTurn = 0
    const { runtime } = await createTestRuntime({
      withPersonaProvider: true,
      mockResponder: (context) => {
        capturedPrompts.push(JSON.stringify(context.messages))
        mockTurn += 1
        // First response deliberately leaks hidden diagnosis "Influenza" / "急性上呼吸道感染"; second also leaks -> fallback
        if (mockTurn <= 2) {
          return fauxAssistantMessage([
            fauxText(JSON.stringify({ reply: '我就是得了社区获得性肺炎和急性支气管炎。' })),
          ])
        }
        return fauxAssistantMessage([
          fauxText(JSON.stringify({ reply: '我这两天就是有点发烧、浑身没劲。' })),
        ])
      },
    })
    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
    const caseData = await startConsultationCase(runtime)

    // Also create a Clinician Assistant session with distinctive text to prove Patient Agent never sees it
    const assistantRes = await runtime.app.request('/api/agents/sessions', {
      method: 'POST',
      headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '医生私密推理', encounterId: caseData.encounterId }),
    })
    const assistantSession = agentSessionDetailSchema.parse(await assistantRes.json())
    await runtime.app.request(`/api/agents/sessions/${assistantSession.session.sessionId}/messages`, {
      method: 'POST',
      headers: {
        cookie: doctorCookie,
        origin,
        'content-type': 'application/json',
        [LLM_RUNTIME_HEADERS.mode]: 'mock',
        [LLM_RUNTIME_HEADERS.provider]: 'mock',
      },
      body: JSON.stringify({ content: 'ASSISTANT_PRIVATE_DIFFERENTIAL_MARKER_7711' }),
    })
    await waitForSessionIdle(runtime, doctorCookie, assistantSession.session.sessionId)

    // Reset counter so patient call hits our two-leak -> safeFallbackReply path
    mockTurn = 0
    const patientCaseDetailRes = await runtime.app.request(`/api/his/v1/doctor/cases/${caseData.outpatientCaseId}`, {
      headers: { cookie: doctorCookie },
    })
    const patientCaseDetail = doctorCaseDetailSchema.parse(await patientCaseDetailRes.json())
    const askRes = await runtime.app.request(
      `/api/his/v1/encounters/${caseData.encounterId}/actions/ask-consultation-question`,
      {
        method: 'POST',
        headers: {
          cookie: doctorCookie,
          origin,
          'content-type': 'application/json',
          'idempotency-key': `patient-pi-durable-${randomUUID()}`,
          [LLM_RUNTIME_HEADERS.mode]: 'mock',
          [LLM_RUNTIME_HEADERS.provider]: 'mock',
          [LLM_RUNTIME_HEADERS.modelId]: 'mock-clinmesh-v1',
        },
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${patientCaseDetail.encounter.id}`]: patientCaseDetail.encounter.versionId,
            [`Task/${caseData.doctorTaskId}`]: '1',
          },
          input: { expectedConsultationVersion: patientCaseDetail.consultation!.version, message: '您觉得自己得了什么病？' },
        }),
      },
    )
    expect(askRes.status).toBe(200)
    const askBody = sendConsultationMessageResponseSchema.parse(await askRes.json())
    expect(askBody.data.patientTurn.source).toBe('patient-agent')

    // Patient Agent prompt MUST NOT include Clinician Assistant reasoning or hidden Case Truth resources
    const patientPrompts = capturedPrompts.filter(p => p.includes('扮演患者本人'))
    expect(patientPrompts.length).toBeGreaterThanOrEqual(1)
    for (const prompt of patientPrompts) {
      expect(prompt).not.toContain('ASSISTANT_PRIVATE_DIFFERENTIAL_MARKER_7711')
      expect(prompt).not.toContain('hiddenResources')
    }

    // Clinician Assistant API must refuse access to the Patient Agent's pi-durable session ID & context
    const forbiddenRes = await runtime.app.request(
      `/api/agents/sessions/patient-agent-${caseData.encounterId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(forbiddenRes.status).toBe(403)
    const forbiddenCtxRes = await runtime.app.request(
      `/api/agents/sessions/patient-agent-${caseData.encounterId}/context`,
      { headers: { cookie: doctorCookie } },
    )
    expect(forbiddenCtxRes.status).toBe(403)
  })

  it('recovers an interrupted mid-stream turn cleanly from SQLite pi-durable checkpoints after process restart without duplicating turns', async () => {
    let releaseFirstStream: (() => void) | undefined
    let firstStreamStarted!: () => void
    const firstStreamStartedPromise = new Promise<void>((resolve) => {
      firstStreamStarted = resolve
    })

    const slowResponder: CustomMockResponder = async (_context, options) => {
      firstStreamStarted()
      await new Promise<void>((resolve) => {
        releaseFirstStream = resolve
        options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return fauxAssistantMessage([
        fauxThinking('中断前的思考过程'),
        fauxText('这是中断前的响应'),
      ])
    }

    const { runtime: runtime1, dbPath } = await createTestRuntime({
      mockResponder: slowResponder,
      mockTokensPerSecond: 100,
    })
    const doctorCookie1 = await signIn(runtime1, 'doctor@demo.clinmesh.local')
    const createRes = await runtime1.app.request('/api/agents/sessions', {
      method: 'POST',
      headers: { cookie: doctorCookie1, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '崩溃恢复测试' }),
    })
    const created = agentSessionDetailSchema.parse(await createRes.json())
    const sessionId = created.session.sessionId

    const sendRes = await runtime1.app.request(`/api/agents/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        cookie: doctorCookie1,
        origin,
        'content-type': 'application/json',
        [LLM_RUNTIME_HEADERS.mode]: 'mock',
        [LLM_RUNTIME_HEADERS.provider]: 'mock',
        [LLM_RUNTIME_HEADERS.modelId]: 'mock-clinmesh-v1',
      },
      body: JSON.stringify({ content: '请持续输出一段临床建议' }),
    })
    expect(sendRes.status).toBe(202)
    await firstStreamStartedPromise

    // Close runtime1 mid-flight to simulate process shutdown / restart
    const idx = runtimes.indexOf(runtime1)
    if (idx !== -1) runtimes.splice(idx, 1)
    await runtime1.close()
    releaseFirstStream?.()

    // Reopen runtime2 on the SAME SQLite database file
    const recoveredResponder: CustomMockResponder = (): AssistantMessage => fauxAssistantMessage([
      fauxThinking('重启后从 SQLite 检查点恢复生成'),
      fauxText('重启恢复完成：已基于原问题继续生成完整临床建议。'),
    ])
    const { runtime: runtime2 } = await createTestRuntime({
      databasePath: dbPath,
      mockResponder: recoveredResponder,
    })
    const doctorCookie2 = await signIn(runtime2, 'doctor@demo.clinmesh.local')

    // Wait for pi-durable to automatically finish the recovered task from checkpoint
    const recoveredDetail = await waitForSessionIdle(runtime2, doctorCookie2, sessionId, 8_000)
    expect(recoveredDetail.messages.filter(m => m.role === 'user')).toHaveLength(1)
    expect(recoveredDetail.messages.some(
      m => m.role === 'assistant' && m.blocks.some(b => b.type === 'text' && b.text.includes('重启恢复完成')),
    )).toBe(true)
  })

  it('discovers local pi / claude / codex providers read-only without exposing secrets and executes adaptive vs budget thinking modes', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'clinmesh-local-cli-home-'))
    directories.push(fakeHome)

    const piSecret = 'sk-pi-local-sentinel-secret-11111'
    const claudeSecret = 'tok-claude-local-sentinel-secret-22222'
    const codexSecret = 'tok-codex-local-sentinel-secret-33333'

    // Start a tiny local fake gateway that handles both Anthropic Messages SSE and OpenAI Chat Completions SSE
    const capturedRequests: Array<{
      path: string
      authHeader: string | undefined
      xApiKey: string | undefined
      body: Record<string, unknown>
    }> = []
    const { createServer } = await import('node:http')
    const fakeGateway = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8')
        const body = rawBody.length > 0 ? JSON.parse(rawBody) as Record<string, unknown> : {}
        capturedRequests.push({
          path: req.url ?? '',
          authHeader: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
          xApiKey: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
          body,
        })

        if ((req.url ?? '').includes('/messages')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const events = [
            { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: String(body.model ?? 'claude-sonnet-4-6'), content: [], stop_reason: null, usage: { input_tokens: 42, output_tokens: 1 } } } },
            { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '本地 Claude 临床回复就绪。' } } },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } } },
            { event: 'message_stop', data: { type: 'message_stop' } },
          ]
          for (const item of events) {
            res.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`)
          }
          res.end()
          return
        }

        if ((req.url ?? '').includes('/chat/completions')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: String(body.model ?? 'deepseek-r1'), choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: String(body.model ?? 'deepseek-r1'), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        res.writeHead(404)
        res.end('Not Found')
      })
    })
    await new Promise<void>(resolve => fakeGateway.listen(0, '127.0.0.1', resolve))
    const addr = fakeGateway.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0
    const gatewayOrigin = `http://127.0.0.1:${port}`

    try {
      // Seed synthetic ~/.pi/agent/models.json + settings.json
      await mkdir(join(fakeHome, '.pi', 'agent'), { recursive: true })
      await writeFile(join(fakeHome, '.pi', 'agent', 'settings.json'), JSON.stringify({
        defaultProvider: 'local-gateway',
        defaultModel: 'deepseek-r1',
        defaultThinkingLevel: 'high',
      }))
      await writeFile(join(fakeHome, '.pi', 'agent', 'models.json'), JSON.stringify({
        providers: {
          'local-gateway': {
            name: 'Local Pi Gateway',
            api: 'openai-completions',
            baseUrl: `${gatewayOrigin}/v1`,
            apiKey: piSecret,
            models: [
              { id: 'deepseek-r1', name: 'DeepSeek R1', reasoning: true, contextWindow: 131_072, maxTokens: 8_192 },
            ],
          },
        },
      }))

      // Seed synthetic ~/.claude/settings.json
      await mkdir(join(fakeHome, '.claude'), { recursive: true })
      await writeFile(join(fakeHome, '.claude', 'settings.json'), JSON.stringify({
        model: 'sonnet[1m]',
        env: {
          ANTHROPIC_BASE_URL: gatewayOrigin,
          ANTHROPIC_AUTH_TOKEN: claudeSecret,
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6',
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000',
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16384',
        },
      }))

      // Seed synthetic ~/.codex/config.toml + custom-models.json
      await mkdir(join(fakeHome, '.codex'), { recursive: true })
      await writeFile(join(fakeHome, '.codex', 'custom-models.json'), JSON.stringify({
        models: [
          {
            slug: 'gpt-5.4',
            display_name: 'GPT-5.4 Codex',
            context_window: 400_000,
            default_reasoning_level: 'xhigh',
            supported_reasoning_levels: [
              { effort: 'low', description: '' },
              { effort: 'high', description: '' },
              { effort: 'xhigh', description: '' },
            ],
            supports_reasoning_summaries: true,
          },
        ],
      }))
      await writeFile(join(fakeHome, '.codex', 'config.toml'), [
        'model_provider = "codex-gw"',
        'model = "gpt-5.4"',
        'model_reasoning_effort = "xhigh"',
        'model_catalog_json = "custom-models.json"',
        '',
        '[model_providers.codex-gw]',
        'name = "Codex Gateway"',
        `base_url = "${gatewayOrigin}/v1"`,
        'wire_api = "responses"',
        `experimental_bearer_token = "${codexSecret}"`,
        'requires_openai_auth = false',
      ].join('\n'))

      const { runtime } = await createTestRuntime({
        localProviders: { enabled: true, homeDir: fakeHome, env: {} },
      })
      const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local')

      // 1. Catalog discovers pi, claude, codex and NEVER leaks secrets
      const catalogRes = await runtime.app.request('/api/agents/providers/catalog', {
        headers: { cookie: doctorCookie },
      })
      expect(catalogRes.status).toBe(200)
      const catalogText = await catalogRes.text()
      expect(catalogText).not.toContain(piSecret)
      expect(catalogText).not.toContain(claudeSecret)
      expect(catalogText).not.toContain(codexSecret)

      const catalog = llmProviderCatalogResponseSchema.parse(JSON.parse(catalogText))
      expect(catalog.discoveryEnabled).toBe(true)
      expect(catalog.localProviders.map(p => p.source)).toEqual(['pi', 'claude', 'codex'])

      const claudeProvider = catalog.localProviders.find(p => p.id === 'claude:local')!
      expect(claudeProvider.authReady).toBe(true)
      expect(claudeProvider.authKind).toBe('bearer-token')
      const sonnetModel = claudeProvider.models.find(m => m.id === 'claude-sonnet-4-6')!
      expect(sonnetModel.contextWindow).toBe(1_000_000)
      expect(sonnetModel.supportsAdaptiveThinking).toBe(true)

      const codexProvider = catalog.localProviders.find(p => p.id === 'codex:codex-gw')!
      expect(codexProvider.api).toBe('openai-responses')
      expect(codexProvider.models[0]?.id).toBe('gpt-5.4')
      expect(codexProvider.models[0]?.supportedThinkingLevels).toEqual(['off', 'low', 'high', 'xhigh'])

      // 2. Test local pi provider live connection via POST /api/agents/providers/test
      const piProbeRes = await runtime.app.request('/api/agents/providers/test', {
        method: 'POST',
        headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'local',
          localProviderId: 'pi:local-gateway',
          modelId: 'deepseek-r1',
        }),
      })
      expect(piProbeRes.status).toBe(200)
      const piProbe = testLlmProviderResponseSchema.parse(await piProbeRes.json())
      expect(piProbe.ok).toBe(true)
      expect(capturedRequests[0]?.authHeader).toBe(`Bearer ${piSecret}`)

      // 3. Execute live Clinician Assistant turns against local Claude provider: adaptive vs budget thinking modes
      const createRes = await runtime.app.request('/api/agents/sessions', {
        method: 'POST',
        headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ title: '本地 Claude 思考模式测试' }),
      })
      const created = agentSessionDetailSchema.parse(await createRes.json())
      const sessionId = created.session.sessionId

      const sendAdaptive = await runtime.app.request(`/api/agents/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          cookie: doctorCookie,
          origin,
          'content-type': 'application/json',
          [LLM_RUNTIME_HEADERS.mode]: 'local',
          [LLM_RUNTIME_HEADERS.localProvider]: 'claude:local',
          [LLM_RUNTIME_HEADERS.modelId]: 'claude-sonnet-4-6',
          [LLM_RUNTIME_HEADERS.reasoningEffort]: 'high',
          [LLM_RUNTIME_HEADERS.thinkingMode]: 'adaptive',
        },
        body: JSON.stringify({ content: '测试自适应思考模式' }),
      })
      expect(sendAdaptive.status).toBe(202)
      await waitForSessionIdle(runtime, doctorCookie, sessionId, 5_000)

      const adaptiveReq = capturedRequests.find(r => r.path.includes('/messages'))!
      expect(adaptiveReq.authHeader).toBe(`Bearer ${claudeSecret}`)
      expect(adaptiveReq.xApiKey).toBeUndefined()
      expect((adaptiveReq.body.thinking as { type?: string })?.type).toBe('adaptive')
      expect((adaptiveReq.body.output_config as { effort?: string })?.effort).toBe('high')

      const sendBudget = await runtime.app.request(`/api/agents/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          cookie: doctorCookie,
          origin,
          'content-type': 'application/json',
          [LLM_RUNTIME_HEADERS.mode]: 'local',
          [LLM_RUNTIME_HEADERS.localProvider]: 'claude:local',
          [LLM_RUNTIME_HEADERS.modelId]: 'claude-sonnet-4-6',
          [LLM_RUNTIME_HEADERS.reasoningEffort]: 'low',
          [LLM_RUNTIME_HEADERS.thinkingMode]: 'budget',
        },
        body: JSON.stringify({ content: '切换为固定预算思考模式' }),
      })
      expect(sendBudget.status).toBe(202)
      await waitForSessionIdle(runtime, doctorCookie, sessionId, 5_000)

      const anthropicRequests = capturedRequests.filter(r => r.path.includes('/messages'))
      expect(anthropicRequests).toHaveLength(2)
      const budgetThinking = anthropicRequests[1]!.body.thinking as { type?: string; budget_tokens?: number }
      expect(budgetThinking.type).toBe('enabled')
      expect(typeof budgetThinking.budget_tokens).toBe('number')

      // Context snapshot should reflect the discovered 1M context window for claude-sonnet-4-6!
      const ctxRes = await runtime.app.request(`/api/agents/sessions/${sessionId}/context`, {
        headers: { cookie: doctorCookie },
      })
      const ctx = sessionContextResponseSchema.parse(await ctxRes.json())
      expect(ctx.latestCall?.contextWindow).toBe(1_000_000)

      // Zero local CLI secrets ever persisted in SQLite
      assertZeroSecretInDatabase(runtime, piSecret)
      assertZeroSecretInDatabase(runtime, claudeSecret)
      assertZeroSecretInDatabase(runtime, codexSecret)
    } finally {
      await new Promise<void>(resolve => fakeGateway.close(() => resolve()))
    }
  })

  it('supports P0/P1/P2 capabilities: default auto-compact, manual /compact & /reset, steer/followUp queue + recall, isolated /side chat, granular clinical tools & @ mentions, entry-level fork, instructions & clinician memory, full-text search, export, and telemetry', async () => {
    const { runtime } = await createTestRuntime({ withPersonaProvider: true })
    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
    const caseData = await startConsultationCase(runtime)
    const caseDetailRes = await runtime.app.request(`/api/his/v1/doctor/cases/${caseData.outpatientCaseId}`, {
      headers: { cookie: doctorCookie },
    })
    const caseDetail = doctorCaseDetailSchema.parse(await caseDetailRes.json())

    const mockHeaders = {
      cookie: doctorCookie,
      origin,
      'content-type': 'application/json',
      [LLM_RUNTIME_HEADERS.mode]: 'mock',
      [LLM_RUNTIME_HEADERS.provider]: 'mock',
      [LLM_RUNTIME_HEADERS.modelId]: 'mock-clinmesh-v1',
    }

    // 1. Auto-Compaction is ON by default on newly created sessions
    const createRes = await runtime.app.request('/api/agents/sessions', {
      method: 'POST',
      headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '全量增强能力验证',
        encounterId: caseData.encounterId,
        caseId: caseData.outpatientCaseId,
        patientId: caseDetail.patient.id,
      }),
    })
    expect(createRes.status).toBe(201)
    const created = agentSessionDetailSchema.parse(await createRes.json())
    const sessionId = created.session.sessionId
    expect(created.session.autoCompact).toBe(true)

    // 2. Session-level custom instructions & autoCompact toggle via PATCH
    const patchRes = await runtime.app.request(`/api/agents/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        customInstructions: '请严格使用 SOAP 结构并突出高风险用药核对。',
        autoCompact: true,
      }),
    })
    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()) as { session: { customInstructions?: string | null; autoCompact?: boolean } }
    expect(patched.session.customInstructions).toContain('SOAP')
    expect(patched.session.autoCompact).toBe(true)

    // 3. Clinician preference memory CRUD (pending -> approved -> delete)
    const addMemRes = await runtime.app.request('/api/agents/memory', {
      method: 'POST',
      headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '鉴别诊断优先按危重度排序', status: 'pending' }),
    })
    expect(addMemRes.status).toBe(201)
    const memAfterAdd = listClinicianMemoryResponseSchema.parse(await addMemRes.json())
    expect(memAfterAdd.items).toHaveLength(1)
    expect(memAfterAdd.items[0]!.status).toBe('pending')

    const approveMemRes = await runtime.app.request(`/api/agents/memory/${memAfterAdd.items[0]!.id}`, {
      method: 'PATCH',
      headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })
    expect(approveMemRes.status).toBe(200)
    const memAfterApprove = listClinicianMemoryResponseSchema.parse(await approveMemRes.json())
    expect(memAfterApprove.items[0]!.status).toBe('approved')

    // 4. Granular clinical entity mentions (@) read strictly clinician-visible data with ZERO hidden Case Truth
    const entitiesRes = await runtime.app.request(`/api/agents/sessions/${sessionId}/clinical-entities`, {
      headers: { cookie: doctorCookie },
    })
    expect(entitiesRes.status).toBe(200)
    const entitiesPayload = clinicalEntitiesResponseSchema.parse(await entitiesRes.json())
    expect(entitiesPayload.entities.some(e => e.kind === 'vitals')).toBe(true)
    expect(entitiesPayload.entities.some(e => e.kind === 'medications')).toBe(true)
    expect(JSON.stringify(entitiesPayload)).not.toContain('hiddenResources')

    // 5. Granular clinical tools in Mock Mode (lab, imaging, medication, vitals) + telemetry
    await runtime.app.request(`/api/agents/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: mockHeaders,
      body: JSON.stringify({ content: '请帮我核对当前检验结果和血常规指标' }),
    })
    const afterLab = await waitForSessionIdle(runtime, doctorCookie, sessionId)
    expect(afterLab.messages.flatMap(m => m.blocks).some(
      b => b.type === 'tool-call' && b.name === 'read_lab_results' && b.status === 'done',
    )).toBe(true)

    await runtime.app.request(`/api/agents/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: mockHeaders,
      body: JSON.stringify({ content: '请核对处方用药安全与过敏史' }),
    })
    const afterMed = await waitForSessionIdle(runtime, doctorCookie, sessionId)
    expect(afterMed.messages.flatMap(m => m.blocks).some(
      b => b.type === 'tool-call' && b.name === 'read_medication_orders' && b.status === 'done',
    )).toBe(true)
    expect(afterMed.latestContextCall?.durationMs).toBeGreaterThanOrEqual(0)

    // Verify approved clinician memory & custom instructions were injected into system instructions context!
    const ctxBeforeCompact = sessionContextResponseSchema.parse(
      await (await runtime.app.request(`/api/agents/sessions/${sessionId}/context`, { headers: { cookie: doctorCookie } })).json(),
    )
    const callDetail = modelCallDetailResponseSchema.parse(
      await (await runtime.app.request(`/api/agents/sessions/${sessionId}/model-calls/${ctxBeforeCompact.latestCall!.id}`, {
        headers: { cookie: doctorCookie },
      })).json(),
    ).modelCall
    const instructionsItem = callDetail.included.find(item => item.kind === 'INSTRUCTIONS')
    expect(instructionsItem?.content).toContain('SOAP')
    expect(instructionsItem?.content).toContain('鉴别诊断优先按危重度排序')

    // 6. Isolated Side Chat (/side) answers WITHOUT polluting main session entries
    const countBeforeSide = afterMed.messages.length
    const sideRes = await runtime.app.request(`/api/agents/sessions/${sessionId}/side-question`, {
      method: 'POST',
      headers: mockHeaders,
      body: JSON.stringify({
        question: '阿莫西林成人常规剂量是多少？',
        quote: '请核对处方用药安全与过敏史',
      }),
    })
    expect(sideRes.status).toBe(200)
    const sidePayload = sideChatResponseSchema.parse(await sideRes.json())
    expect(sidePayload.answer).toContain('侧边追问')
    const detailAfterSide = agentSessionDetailSchema.parse(
      await (await runtime.app.request(`/api/agents/sessions/${sessionId}`, { headers: { cookie: doctorCookie } })).json(),
    )
    expect(detailAfterSide.messages.length).toBe(countBeforeSide)

    // 7. Message-level Fork (atEntryId) branches cleanly at the first assistant reply
    const firstAssistant = afterLab.messages.find(m => m.role === 'assistant' && m.entryId !== null)!
    const branchRes = await runtime.app.request(`/api/agents/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '首轮分支', atEntryId: firstAssistant.entryId! }),
    })
    expect(branchRes.status).toBe(201)
    const branched = agentSessionDetailSchema.parse(await branchRes.json())
    expect(branched.session.forkedFromSessionId).toBe(sessionId)
    expect(branched.session.forkedFromEntryId).toBe(firstAssistant.entryId)
    expect(branched.messages.filter(m => m.role === 'user')).toHaveLength(1)

    // 8. Manual /compact produces a durable CompactionEntry + COMPACT context event
    const compactRes = await runtime.app.request(`/api/agents/sessions/${sessionId}/compact`, {
      method: 'POST',
      headers: mockHeaders,
      body: JSON.stringify({ instructions: '保留检验异常与过敏警示' }),
    })
    expect(compactRes.status).toBe(200)
    const afterCompact = agentSessionDetailSchema.parse(await compactRes.json())
    expect(afterCompact.messages.some(m => m.role === 'system' && m.isCompactionSummary === true)).toBe(true)
    const ctxAfterCompact = sessionContextResponseSchema.parse(
      await (await runtime.app.request(`/api/agents/sessions/${sessionId}/context`, { headers: { cookie: doctorCookie } })).json(),
    )
    expect(ctxAfterCompact.contextEvents.some(ev => ev.kind === 'COMPACT')).toBe(true)

    // 9. Manual /reset creates a durable ResetEntry + RESET context event
    const resetRes = await runtime.app.request(`/api/agents/sessions/${sessionId}/reset`, {
      method: 'POST',
      headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(resetRes.status).toBe(200)
    const afterReset = agentSessionDetailSchema.parse(await resetRes.json())
    expect(afterReset.messages.some(m => m.role === 'system' && m.isResetBoundary === true)).toBe(true)
    const ctxAfterReset = sessionContextResponseSchema.parse(
      await (await runtime.app.request(`/api/agents/sessions/${sessionId}/context`, { headers: { cookie: doctorCookie } })).json(),
    )
    expect(ctxAfterReset.contextEvents.some(ev => ev.kind === 'RESET')).toBe(true)

    // 10. Cross-session full-text search & Markdown export
    const searchRes = await runtime.app.request(
      `/api/agents/sessions/search?q=${encodeURIComponent('血常规')}&encounterId=${encodeURIComponent(caseData.encounterId)}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(searchRes.status).toBe(200)
    const searchPayload = searchAgentSessionsResponseSchema.parse(await searchRes.json())
    expect(searchPayload.matches.some(m => m.session.sessionId === sessionId && m.matchedIn === 'message')).toBe(true)

    const exportRes = await runtime.app.request(`/api/agents/sessions/${sessionId}/export`, {
      headers: { cookie: doctorCookie },
    })
    expect(exportRes.status).toBe(200)
    const exportPayload = exportAgentSessionResponseSchema.parse(await exportRes.json())
    expect(exportPayload.filename.endsWith('.md')).toBe(true)
    expect(exportPayload.markdown).toContain('# 全量增强能力验证')
    expect(exportPayload.markdown).toContain('SOAP')

    // 11. Delete clinician memory cleans up cleanly
    const delMemRes = await runtime.app.request(`/api/agents/memory/${memAfterAdd.items[0]!.id}`, {
      method: 'DELETE',
      headers: { cookie: doctorCookie, origin },
    })
    expect(delMemRes.status).toBe(200)
    expect(listClinicianMemoryResponseSchema.parse(await delMemRes.json()).items).toHaveLength(0)

    // 12. Stateless scope clinical-entities & standalone /side work BEFORE any session is created, and auto-title strips clinical refs
    const scopeEntitiesRes = await runtime.app.request(
      `/api/agents/clinical-entities?encounterId=${encodeURIComponent(caseData.encounterId)}&caseId=${encodeURIComponent(caseData.outpatientCaseId)}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(scopeEntitiesRes.status).toBe(200)
    expect(clinicalEntitiesResponseSchema.parse(await scopeEntitiesRes.json()).entities.length).toBeGreaterThan(0)

    const sessionsBeforeStandalone = listAgentSessionsResponseSchema.parse(
      await (await runtime.app.request(`/api/agents/sessions?encounterId=${encodeURIComponent(caseData.encounterId)}`, {
        headers: { cookie: doctorCookie },
      })).json(),
    ).sessions.length

    const standaloneSideRes = await runtime.app.request('/api/agents/side-question', {
      method: 'POST',
      headers: mockHeaders,
      body: JSON.stringify({
        question: '核对儿童退热剂型',
        encounterId: caseData.encounterId,
        caseId: caseData.outpatientCaseId,
      }),
    })
    expect(standaloneSideRes.status).toBe(200)
    expect(sideChatResponseSchema.parse(await standaloneSideRes.json()).answer).toContain('侧边追问')

    const sessionsAfterStandalone = listAgentSessionsResponseSchema.parse(
      await (await runtime.app.request(`/api/agents/sessions?encounterId=${encodeURIComponent(caseData.encounterId)}`, {
        headers: { cookie: doctorCookie },
      })).json(),
    ).sessions.length
    expect(sessionsAfterStandalone).toBe(sessionsBeforeStandalone)

    // Auto-title strips attached [临床引用: ...] prefix so History shows the clinician's real question
    const autoTitleSession = agentSessionDetailSchema.parse(
      await (await runtime.app.request('/api/agents/sessions', {
        method: 'POST',
        headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ encounterId: caseData.encounterId, caseId: caseData.outpatientCaseId }),
      })).json(),
    )
    await runtime.app.request(`/api/agents/sessions/${autoTitleSession.session.sessionId}/messages`, {
      method: 'POST',
      headers: mockHeaders,
      body: JSON.stringify({
        content: '[临床引用: 主诉与生命体征]\n体温 38.2°C\n\n> 引用片段\n\n请评估是否需要抗生素治疗',
      }),
    })
    const autoTitled = await waitForSessionIdle(runtime, doctorCookie, autoTitleSession.session.sessionId)
    expect(autoTitled.session.title).toBe('请评估是否需要抗生素治疗')
  })

  it('queues steer/followUp inputs while streaming and supports recalling queued messages cleanly', async () => {
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    let callCount = 0
    const { runtime } = await createTestRuntime({
      mockResponder: async (_ctx, options) => {
        callCount += 1
        if (callCount === 1) {
          firstStarted()
          await new Promise<void>((resolve) => {
            releaseFirst = resolve
            options?.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          return fauxAssistantMessage([fauxText('第一轮回答完成。')])
        }
        return fauxAssistantMessage([fauxText('后续排队回答完成。')])
      },
    })

    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
    const mockHeaders = {
      cookie: doctorCookie,
      origin,
      'content-type': 'application/json',
      [LLM_RUNTIME_HEADERS.mode]: 'mock',
      [LLM_RUNTIME_HEADERS.provider]: 'mock',
      [LLM_RUNTIME_HEADERS.modelId]: 'mock-clinmesh-v1',
    }

    const created = agentSessionDetailSchema.parse(
      await (await runtime.app.request('/api/agents/sessions', {
        method: 'POST',
        headers: { cookie: doctorCookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ title: '并发队列验证' }),
      })).json(),
    )
    const sessionId = created.session.sessionId

    // Kick off slow first turn
    const firstSend = await runtime.app.request(`/api/agents/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: mockHeaders,
      body: JSON.stringify({ content: '第一轮慢速分析' }),
    })
    expect(firstSend.status).toBe(202)
    await firstStartedPromise

    // Queue a followUp message & a steer message while busy
    const queuedFollowUp = await runtime.app.request(`/api/agents/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: mockHeaders,
      body: JSON.stringify({ content: '排队追问：补充鉴别要点', whenBusy: 'followUp' }),
    })
    expect(queuedFollowUp.status).toBe(202)

    const queuedSteer = await runtime.app.request(`/api/agents/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: mockHeaders,
      body: JSON.stringify({ content: '立即引导：重点关注心电图', whenBusy: 'steer' }),
    })
    expect(queuedSteer.status).toBe(202)
    const busyDetail = agentSessionDetailSchema.parse(await queuedSteer.json())
    expect((busyDetail.queuedInputs ?? []).length).toBeGreaterThanOrEqual(2)

    // Recall the followUp submission before first turn finishes
    const followUpItem = busyDetail.queuedInputs!.find(item => item.mode === 'followUp')!
    const recallRes = await runtime.app.request(
      `/api/agents/sessions/${sessionId}/queue/${followUpItem.submissionId}`,
      { method: 'DELETE', headers: { cookie: doctorCookie, origin } },
    )
    expect(recallRes.status).toBe(200)
    const recalledBody = (await recallRes.json()) as { recalled: boolean; content: string }
    expect(recalledBody.recalled).toBe(true)
    expect(recalledBody.content).toContain('排队追问')

    // Release first stream -> steered follow-up executes automatically
    releaseFirst()
    const finalDetail = await waitForSessionIdle(runtime, doctorCookie, sessionId, 6_000)
    expect(finalDetail.messages.some(
      m => m.role === 'user' && m.blocks.some(b => b.type === 'text' && b.text.includes('立即引导')),
    )).toBe(true)
    expect(finalDetail.messages.some(
      m => m.role === 'user' && m.blocks.some(b => b.type === 'text' && b.text.includes('排队追问')),
    )).toBe(false)
  })
})
