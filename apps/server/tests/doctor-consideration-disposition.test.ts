import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { doctorRecommendationStateSchema, setDoctorConsiderationDispositionResponseSchema } from '@clinmesh/contracts/doctor-recommendations'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { unknownModelTokenUsage } from '@clinmesh/contracts/model-usage'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'
import { DshModelProvider } from '../src/infrastructure/ai/dsh-model-provider.ts'
import { encodeModelRoute, modelBridgeRequestSchema } from '@clinmesh/contracts/model-bridge'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-consideration-'))
  disposals.push(() => rm(directory, { recursive: true, force: true }))
  const bridge = { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 1000, maxResponseBytes: 256 * 1024 }
  const route = encodeModelRoute({ provider: 'synthetic', model: 'synthetic' })
  const runtimeOptions: Parameters<typeof createClinMeshRuntime>[0] = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters',
    databasePath: join(directory, 'clinmesh.sqlite'), demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply', outboxRetryDelayMs: 0,
    dshModelBridge: bridge,
    chatCompletionsProvider: new DshModelProvider({ ...bridge, fetch: async (_url, init) => {
      const input = modelBridgeRequestSchema.parse(JSON.parse(String(init?.body)))
      if (input.operation === 'resolve') return Response.json({ model: route })
      // 带 attemptId 的请求要求回执 accounting，否则视为结果不可信。
      const completed = (result: { content: string }) => Response.json({ ...result, model: input.model,
        ...(input.attemptId === undefined ? {} : { accounting: { attemptId: input.attemptId,
          status: 'succeeded', dispatch: 'dispatched', usage: unknownModelTokenUsage } }) })
      if (input.schemaName === 'patient_persona') return completed({ content: JSON.stringify(persona) })
      if (input.schemaName === 'clinical_document_quality' || input.schemaName === 'clinical_document_quality_verification') {
        const payload = z.object({ agentFacts: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
        return completed({ content: JSON.stringify({ issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })) }) })
      }
      throw new Error('This read must not generate suggestions')
    } }),
    syntheaProvider: new StubSyntheaProvider(), trustedOrigins: ['http://localhost'],
  }
  let runtime = await createClinMeshRuntime(runtimeOptions)
  disposals.push(() => runtime.close())
  const started = await startConsultationCase(runtime)
  const cookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const claimed = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
    method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: {
      [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1',
    }, input: {} }),
  })
  expect(claimed.status).toBe(200)
  const casePath = `/api/his/v1/doctor/cases/${started.outpatientCaseId}`
  const dispositionPath = (kind = 'diagnosis') => `${casePath}/recommendations/${kind}/considerations/disposition`
  const setDisposition = async (label: string, status: 'verified' | 'dismissed' | 'clear', kind = 'diagnosis', headers: Record<string, string> = { cookie, origin: 'http://localhost' }) => {
    const response = await runtime.app.request(dispositionPath(kind), {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { label, status } }),
    })
    const raw = await response.text()
    let body: unknown
    try { body = JSON.parse(raw) } catch { body = raw }
    expect(response.status, String(body)).toBe(200)
    return body
  }
  const readState = async (kind = 'diagnosis') => {
    const response = await runtime.app.request(`${casePath}/recommendations/${kind}`, { headers: { cookie } })
    const body: unknown = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    return doctorRecommendationStateSchema.parse(body)
  }
  const encounterVersion = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(casePath, { headers: { cookie } })).json()).encounter.versionId
  return {
    get runtime() { return runtime }, started, cookie,
    setDisposition, readState, encounterVersion, dispositionPath,
    restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(runtimeOptions) },
  }
}

it('stores, merges, upserts and clears consideration dispositions without touching the encounter', async () => {
  const { setDisposition, readState, encounterVersion } = await setup()
  const before = await encounterVersion()
  const first = setDoctorConsiderationDispositionResponseSchema.parse(await setDisposition('复发性牙龈炎（牙龈炎）待核实', 'verified'))
  expect(first.dispositions).toEqual([{ labelKey: '复发性牙龈炎（牙龈炎）待核实', status: 'verified', label: '复发性牙龈炎（牙龈炎）待核实' }])
  expect(await encounterVersion()).toBe(before)
  expect((await readState()).considerationDispositions).toEqual(first.dispositions)
  // 归一化标题命中同一条处置并覆盖状态；其他 kind 互不影响。
  const upserted = setDoctorConsiderationDispositionResponseSchema.parse(await setDisposition('  复发性牙龈炎（牙龈炎）待核实  ', 'dismissed'))
  expect(upserted.dispositions).toHaveLength(1)
  expect(upserted.dispositions[0]).toMatchObject({ status: 'dismissed', label: '复发性牙龈炎（牙龈炎）待核实' })
  expect((await readState('laboratory')).considerationDispositions).toBeUndefined()
  // clear 撤销处置，状态回到无处置字段。
  await setDisposition('复发性牙龈炎（牙龈炎）待核实', 'clear')
  expect((await readState()).considerationDispositions).toBeUndefined()
})

it('keeps dispositions across restarts and rejects unauthenticated and prescription-kind calls', async () => {
  const { runtime, cookie, setDisposition, readState, restart, dispositionPath } = await setup()
  await setDisposition('右下后牙充填术后牙本质敏感待核实', 'dismissed')
  // 处方类没有思路通道，处置入口直接拒绝。
  const prescription = await runtime.app.request(dispositionPath('prescription'), {
    method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ input: { label: '任意', status: 'verified' } }),
  })
  expect(prescription.status).toBe(400)
  await restart()
  expect((await readState()).considerationDispositions)
    .toEqual([{ labelKey: '右下后牙充填术后牙本质敏感待核实', status: 'dismissed', label: '右下后牙充填术后牙本质敏感待核实' }])
  const anonymous = await runtime.app.request(dispositionPath(), {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ input: { label: '任意', status: 'verified' } }),
  })
  expect([401, 403]).toContain(anonymous.status)
})
