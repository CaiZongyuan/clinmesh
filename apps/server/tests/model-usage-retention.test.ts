import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { modelUsageRetentionSchema, modelUsageControlSchema, modelUsageListSchema, modelUsageOverviewSchema } from '@clinmesh/contracts/model-usage'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { signIn, persona, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of dispose.splice(0).reverse()) await close()
  vi.useRealTimers()
})

async function fixture(settings: { unpriced?: boolean; unknownUsage?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-retention-'))
  dispose.push(() => rm(directory, { recursive: true, force: true }))
  let usageKnown = !settings.unknownUsage
  const configuredPrices = { prices: [{ provider: 'synthetic.invalid', model: 'synthetic-model', version: 'synthetic-v1', currency: 'CNY',
    rates: { input: 10000, output: 20000 } }], exchangeRates: [] }
  let modelPricing = settings.unpriced ? { prices: [], exchangeRates: [] } : configuredPrices
  const options = { authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'test.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'],
    syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid',
      fetch: async () => Response.json({ model: 'actual-synthetic', choices: [{ message: { content: JSON.stringify(persona) } }],
        ...(usageKnown ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) }) }) }
  let runtime = await createClinMeshRuntime({ ...options, modelPricing })
  dispose.push(() => runtime.close())
  let cookie = await signIn(runtime, 'admin@demo.clinmesh.local')
  const request = (path: string, body?: unknown, key = randomUUID()) => runtime.app.request(`/api/model-usage${path}`, body === undefined
    ? { headers: { cookie } } : { method: path.startsWith('/requests/') ? 'POST' : 'PUT', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json',
      'idempotency-key': key }, body: JSON.stringify(body) })
  return { get runtime() { return runtime }, request,
    async generatePersona() {
      const headers = { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }
      const generated = await runtime.app.request('/api/sim/v1/scenario-generation-jobs', { method: 'POST', headers,
        body: JSON.stringify({ name: '保留期合成病例', population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' },
          providerId: 'synthea', seeds: { clinical: 7331, population: 4242 },
          timeRange: { end: '2026-08-01', start: '2020-01-01' }, timeZone: 'Asia/Shanghai' }) })
      expect(generated.status).toBe(200)
      const generation = await runtime.scenarioData.processNextGenerationJob()
      const created = await runtime.app.request(`/api/sim/v1/synthetic-cases/${generation!.caseIds[0]}/patient-persona-jobs`, {
        method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() }, body: '{}' })
      expect(created.status).toBe(200)
      expect(await runtime.patientPersona.processNext()).toMatchObject({ status: 'succeeded' })
    },
    setUsageKnown(value: boolean) { usageKnown = value },
    configurePrices() { modelPricing = configuredPrices },
    async login(email: string) { cookie = await signIn(runtime, email) },
    async at(date: string) { vi.setSystemTime(new Date(date)); cookie = await signIn(runtime, 'admin@demo.clinmesh.local') },
    async restart(legacy = false) {
      await runtime.close()
      if (legacy) {
        // The new migration only adds these tables. Preserve the real nonempty ledger and budgets
        // while materializing the exact schema immediately before this release.
        const old = openClinMeshDatabase({ databasePath: options.databasePath, busyTimeoutMs: 5000 })
        try { old.driver.exec(`DROP TABLE model_usage_correction_audit; DROP TABLE model_usage_daily; DROP TABLE model_usage_retention;
          DELETE FROM schema_migration WHERE migration_id = '0076_model-usage-retention.sql'`) } finally { old.close() }
      }
      runtime = await createClinMeshRuntime({ ...options, modelPricing }); cookie = await signIn(runtime, 'admin@demo.clinmesh.local')
    } }
}

it('defaults to 90 days and persists protected custom or permanent retention with version and idempotency checks', async () => {
  const f = await fixture()
  const response = await f.request('/retention')
  expect(response.status).toBe(200)
  expect(modelUsageRetentionSchema.parse(await response.json())).toEqual({ days: 90, version: 1, compactedRequests: 0, lastCompactedAt: null })
  for (const days of [0, -1, 1.5, '3']) expect((await f.request('/retention', { days, expectedVersion: 1 })).status).toBe(400)
  const key = randomUUID()
  const body = { days: 17, expectedVersion: 1 }
  expect((await f.request('/retention', body, key)).status).toBe(200)
  expect((await f.request('/retention', body, key)).status).toBe(200)
  expect((await f.request('/retention', body)).status).toBe(409)
  await f.restart()
  expect(modelUsageRetentionSchema.parse(await (await f.request('/retention')).json())).toMatchObject({ days: 17, version: 2 })
  await f.login('doctor@demo.clinmesh.local')
  expect((await f.request('/retention', { days: null, expectedVersion: 2 })).status).toBe(403)
  await f.login('admin@demo.clinmesh.local')
  expect((await f.request('/retention', { days: null, expectedVersion: 2 })).status).toBe(200)
  await f.restart()
  expect(modelUsageRetentionSchema.parse(await (await f.request('/retention')).json()).days).toBeNull()
})

it('expires at 90 real days, retains daily filtered totals and independent budgets through restart and repeated cleanup', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T16:00:00.000Z'))
  const f = await fixture()
  await f.request('/control', { enabled: true, requests: 1, tokens: 100, cny: 1, automaticRetries: true, expectedVersion: 1 })
  await f.request('/control', { enabled: true, requests: 1, tokens: null, cny: null, automaticRetries: true, expectedVersion: 2 })
  await startConsultationCase(f.runtime)
  const before = modelUsageListSchema.parse(await (await f.request('/requests')).json())
  const attempt = before.items[0]!
  const overview = modelUsageOverviewSchema.parse(await (await f.request('/overview')).json())
  expect(overview.totals).toMatchObject({ requests: 1, knownTokens: 15, cny: 0.2 })
  expect(overview.trend).toEqual([{ date: '2026-01-02', requests: 1, knownTokens: 15 }])
  const control = modelUsageControlSchema.parse(await (await f.request('/control')).json())
  await f.at('2026-04-01T15:59:59.999Z')
  expect(modelUsageListSchema.parse(await (await f.request('/requests')).json()).total).toBe(1)
  await f.at('2026-04-01T16:00:00.000Z')
  expect(modelUsageListSchema.parse(await (await f.request('/requests')).json()).total).toBe(0)
  expect((await f.request(`/requests/${attempt.id}`)).status).toBe(404)
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview')).json())).toEqual(overview)
  expect(modelUsageControlSchema.parse(await (await f.request('/control')).json())).toEqual(control)
  for (const query of ['from=2026-01-02&to=2026-01-02', 'model=actual-synthetic', 'model=synthetic-model',
    'provider=synthetic.invalid&feature=patient_persona&status=succeeded']) {
    expect(modelUsageOverviewSchema.parse(await (await f.request(`/overview?${query}`)).json()).totals).toEqual(overview.totals)
  }
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview?to=2026-01-01')).json()).totals.requests).toBe(0)
  await f.restart()
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview')).json())).toEqual(overview)
  expect(modelUsageControlSchema.parse(await (await f.request('/control')).json())).toEqual(control)
  expect(modelUsageRetentionSchema.parse(await (await f.request('/retention')).json())).toMatchObject({ compactedRequests: 1,
    lastCompactedAt: '2026-04-01T16:00:00.000Z' })
  await expect(startConsultationCase(f.runtime)).rejects.toThrow('Persona generation failed')
  expect(modelUsageControlSchema.parse(await (await f.request('/control')).json()).lastRejection?.code).toBe('MODEL_REQUEST_LIMIT')
})

it('keeps permanent details until an administrator shortens retention and never restores deleted details', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  const f = await fixture()
  await f.request('/retention', { days: null, expectedVersion: 1 })
  await startConsultationCase(f.runtime)
  await f.at('2027-01-01T00:00:00.000Z')
  await f.restart()
  expect(modelUsageListSchema.parse(await (await f.request('/requests')).json()).total).toBe(1)
  const response = await f.request('/retention', { days: 137, expectedVersion: 2 })
  expect(modelUsageRetentionSchema.parse(await response.json())).toMatchObject({ days: 137, compactedRequests: 1 })
  expect(modelUsageListSchema.parse(await (await f.request('/requests')).json()).total).toBe(0)
  await f.request('/retention', { days: null, expectedVersion: 3 })
  await f.restart()
  expect(modelUsageListSchema.parse(await (await f.request('/requests')).json()).total).toBe(0)
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview')).json()).totals.requests).toBe(1)
})

it('retains unknown consumption and its independent reservations across expiry and restart for partial reconciliation', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  const f = await fixture()
  await f.request('/control', { enabled: true, requests: 5, tokens: 100, cny: 1, automaticRetries: true, expectedVersion: 1 })
  await f.request('/control', { enabled: true, requests: 5, tokens: null, cny: null, automaticRetries: true, expectedVersion: 2 })
  await f.generatePersona()
  f.setUsageKnown(false)
  await f.generatePersona()
  const records = modelUsageListSchema.parse(await (await f.request('/requests')).json())
  const unknown = records.items.find(item => item.usage.totalTokens === null)!
  const before = modelUsageControlSchema.parse(await (await f.request('/control')).json())
  expect(before.workspace).toMatchObject({ used: 2, tokensUsed: 15, cnyUsed: 0.2, tokensUnknownReservations: 1, cnyUnknownReservations: 1 })
  await f.at('2026-04-02T00:00:00.000Z')
  await f.restart()
  expect(modelUsageListSchema.parse(await (await f.request('/requests')).json()).items.map(item => item.id)).toEqual([unknown.id])
  expect(modelUsageControlSchema.parse(await (await f.request('/control')).json())).toEqual(before)
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview')).json()).totals).toMatchObject({ requests: 2, knownTokens: 15, unknownTokenRequests: 1, cny: 0.2, unpricedRequests: 1 })
  const tokens = await f.request(`/requests/${unknown.id}/reconcile`, { expectedRevision: 0, totalTokens: 20, evidence: 'synthetic-receipt-tokens' })
  expect(tokens.status).toBe(200)
  expect((await f.request(`/requests/${unknown.id}`)).status).toBe(200)
  const moneyInput = { expectedRevision: 1, cny: 0.3, evidence: 'synthetic-receipt-money' }
  const key = randomUUID()
  expect((await f.request(`/requests/${unknown.id}/reconcile`, moneyInput, key)).status).toBe(200)
  expect(modelUsageListSchema.parse(await (await f.request('/requests')).json()).total).toBe(0)
  expect((await f.request(`/requests/${unknown.id}/reconcile`, moneyInput, key)).status).toBe(404)
  const after = modelUsageControlSchema.parse(await (await f.request('/control')).json())
  expect(after.workspace).toMatchObject({ used: 2, tokensUsed: 35, cnyUsed: 0.5, tokensUnknownReservations: 0, cnyUnknownReservations: 0,
    requestsStartedAt: before.workspace.requestsStartedAt, tokensStartedAt: before.workspace.tokensStartedAt, cnyStartedAt: before.workspace.cnyStartedAt })
  // Necessary audit is a storage contract; it must not retain the deleted task/context.
  const audit = f.runtime.database.driver.prepare('SELECT evidence_json FROM model_usage_correction_audit WHERE attempt_id = ?').get(unknown.id) as { evidence_json: string }
  expect(JSON.parse(audit.evidence_json)).toMatchObject({ usage: { totalTokens: null }, priceSnapshot: unknown.priceSnapshot,
    corrections: [{ evidence: 'synthetic-receipt-tokens', totalTokens: 20 }, { evidence: 'synthetic-receipt-money', cny: 0.3 }] })
  expect(audit.evidence_json).not.toContain(unknown.context.taskId)
  const receipt = f.runtime.database.driver.prepare(`SELECT response_json FROM command_receipt
    WHERE operation = 'model-usage.reconcile' AND idempotency_key = ?`).get(key) as { response_json: string }
  expect(JSON.parse(receipt.response_json).data).toEqual({ attemptId: unknown.id, detailExpired: true })
  await f.restart()
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview')).json()).totals).toMatchObject({ requests: 2, knownTokens: 35, unknownTokenRequests: 0, cny: 0.5, unpricedRequests: 0 })
})

it('keeps cross-Epoch aggregates bound to the current Workspace and retains historical details only for administrators', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  const f = await fixture()
  await f.request('/retention', { days: null, expectedVersion: 1 })
  await f.generatePersona()
  const original = modelUsageListSchema.parse(await (await f.request('/requests')).json()).items[0]!
  new WorkspaceRepository(f.runtime.database).install({ workspaceId: 'workspace-other', workspaceName: 'Synthetic other',
    epoch: 'epoch-other', scenarioId: 'synthetic-other', scenarioRunId: 'run-other' })
  const foreign = { ...original, id: randomUUID(), context: { ...original.context, workspaceId: 'workspace-other', epoch: 'epoch-other' } }
  // Foreign Workspace fixture at the persistence boundary, never granted by a query parameter.
  f.runtime.database.driver.prepare(`INSERT INTO model_usage_attempt
    (attempt_id, workspace_id, epoch, case_id, feature, provider, requested_model, actual_model, status, started_at, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(foreign.id, foreign.context.workspaceId, foreign.context.epoch, null,
    foreign.feature, foreign.provider, foreign.requestedModel, foreign.actualModel, foreign.status, foreign.startedAt, JSON.stringify(foreign))
  const admin = await signIn(f.runtime, 'admin@demo.clinmesh.local')
  expect((await f.runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', { method: 'POST',
    headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{}' })).status).toBe(200)
  await f.login('doctor@demo.clinmesh.local')
  expect(modelUsageListSchema.parse(await (await f.request('/requests')).json()).total).toBe(0)
  expect((await f.request(`/requests/${original.id}`)).status).toBe(404)
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview')).json()).totals.requests).toBe(1)
  await f.login('admin@demo.clinmesh.local')
  expect((await f.request(`/requests/${original.id}`)).status).toBe(200)
  expect((await f.request(`/requests/${foreign.id}`)).status).toBe(404)
  await f.at('2026-04-02T00:00:00.000Z')
  await f.request('/retention', { days: 90, expectedVersion: 2 })
  await f.restart()
  expect(modelUsageListSchema.parse(await (await f.request('/requests')).json()).total).toBe(0)
  await f.login('doctor@demo.clinmesh.local')
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview')).json()).totals).toMatchObject({ requests: 1, knownTokens: 15, cny: 0.2 })
  expect((await f.request(`/requests/${foreign.id}`)).status).toBe(404)
  expect((await f.request('/overview?workspaceId=workspace-other')).status).toBe(400)
})

it('rolls back aggregation, receipts and settings together if expired detail deletion fails', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  const f = await fixture()
  await f.generatePersona()
  f.runtime.database.driver.exec(`CREATE TRIGGER synthetic_retention_failure BEFORE DELETE ON model_usage_attempt
    BEGIN SELECT RAISE(ABORT, 'synthetic retention failure'); END`)
  await f.at('2026-04-02T00:00:00.000Z')
  expect((await f.request('/retention', { days: 1, expectedVersion: 1 })).status).toBe(500)
  expect(modelUsageRetentionSchema.parse(await (await f.request('/retention')).json())).toMatchObject({ days: 90, version: 1, compactedRequests: 0 })
  f.runtime.database.driver.exec('DROP TRIGGER synthetic_retention_failure')
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview')).json()).totals).toMatchObject({ requests: 1, knownTokens: 15, cny: 0.2 })
  expect(modelUsageRetentionSchema.parse(await (await f.request('/retention')).json()).compactedRequests).toBe(1)
  await f.restart()
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview')).json()).totals.requests).toBe(1)
})

it('preserves missing-price aggregates as incomplete and never offers expired detail for repricing', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  const f = await fixture({ unpriced: true })
  await startConsultationCase(f.runtime)
  const attempt = modelUsageListSchema.parse(await (await f.request('/requests')).json()).items[0]!
  await f.at('2026-04-02T00:00:00.000Z')
  f.configurePrices()
  await f.restart()
  expect((await f.request(`/requests/${attempt.id}/reprice`, { expectedRevision: 0, evidence: 'synthetic-price-v1' })).status).toBe(404)
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview')).json()).totals).toMatchObject({ requests: 1, knownTokens: 15, cny: null, unpricedRequests: 1 })
  expect(modelUsageListSchema.parse(await (await f.request('/requests')).json()).total).toBe(0)
})

it('upgrades a nonempty pre-retention ledger without losing known totals, unknown evidence or independent budget starts', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  const f = await fixture()
  await f.request('/control', { enabled: true, requests: 5, tokens: 100, cny: 1, automaticRetries: true, expectedVersion: 1 })
  await f.request('/control', { enabled: true, requests: 5, tokens: null, cny: null, automaticRetries: true, expectedVersion: 2 })
  await f.generatePersona()
  f.setUsageKnown(false)
  await f.generatePersona()
  const control = modelUsageControlSchema.parse(await (await f.request('/control')).json())
  const overview = modelUsageOverviewSchema.parse(await (await f.request('/overview')).json())
  const records = modelUsageListSchema.parse(await (await f.request('/requests')).json())
  await f.at('2026-04-02T00:00:00.000Z')
  await f.restart(true)
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview')).json())).toEqual(overview)
  expect(modelUsageControlSchema.parse(await (await f.request('/control')).json())).toEqual(control)
  const retained = modelUsageListSchema.parse(await (await f.request('/requests')).json())
  expect(retained.items).toEqual(records.items.filter(item => item.usage.totalTokens === null))
  expect(modelUsageRetentionSchema.parse(await (await f.request('/retention')).json())).toMatchObject({ days: 90, compactedRequests: 1 })
  await f.restart()
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview')).json())).toEqual(overview)
})
