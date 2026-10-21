import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { modelUsageAttemptSchema, modelUsageControlSchema, modelUsageListSchema, modelUsageOverviewSchema } from '@clinmesh/contracts/model-usage'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of dispose.splice(0).reverse()) await close() })
async function fixture(settings: { unknownUsage?: boolean; unpriced?: boolean; noFx?: boolean; zeroPrice?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-cost-'))
  dispose.push(() => rm(directory, { recursive: true, force: true }))
  let prices = { prices: settings.unpriced ? [] : [{ provider: 'synthetic.invalid', model: 'synthetic-model', version: 'price-v1', currency: settings.zeroPrice ? 'CNY' : 'USD', rates: { input: settings.zeroPrice ? 0 : 2, output: settings.zeroPrice ? 0 : 4 } }],
    exchangeRates: settings.noFx ? [] : [{ currency: 'USD', version: 'fx-v1', cnyPerUnit: 7 }] }
  const options = { authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'test.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'],
    syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid', fetch: async () => Response.json({
      choices: [{ message: { content: JSON.stringify(persona) } }], ...(settings.unknownUsage ? {} : { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }),
    }) }) }
  let runtime = await createClinMeshRuntime({ ...options, modelPricing: prices })
  dispose.push(() => runtime.close())
  let cookie = await signIn(runtime, 'admin@demo.clinmesh.local')
  const request = (path: string, body?: unknown, key = randomUUID()) => runtime.app.request(`/api/model-usage${path}`, body === undefined ? { headers: { cookie } }
    : { method: path === '/control' ? 'PUT' : 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) })
  return { get runtime() { return runtime }, request, changePrices(next: typeof prices) { prices = next }, async restart() {
    await runtime.close(); runtime = await createClinMeshRuntime({ ...options, modelPricing: prices }); cookie = await signIn(runtime, 'admin@demo.clinmesh.local')
  } }
}

it('freezes original currency, price and FX for each dispatched request across configuration changes and restart', async () => {
  const f = await fixture()
  await startConsultationCase(f.runtime)
  const before = modelUsageListSchema.parse(await (await f.request('/requests')).json()).items[0]!
  expect(before.cost).toMatchObject({ status: 'priced', original: 0.0004, cny: 0.0028 })
  expect(before.priceSnapshot).toMatchObject({ price: { version: 'price-v1' }, exchangeRate: { version: 'fx-v1' } })
  f.changePrices({ prices: [{ provider: 'synthetic.invalid', model: 'synthetic-model', version: 'price-v2', currency: 'USD', rates: { input: 20, output: 40 } }],
    exchangeRates: [{ currency: 'USD', version: 'fx-v2', cnyPerUnit: 8 }] })
  await f.restart()
  expect(modelUsageAttemptSchema.parse(await (await f.request(`/requests/${before.id}`)).json()).cost.cny).toBe(0.0028)
  const overview = modelUsageOverviewSchema.parse(await (await f.request('/overview')).json())
  expect(overview.totals).toMatchObject({ requests: 1, cny: 0.0028, unpricedRequests: 0 })
})

it('establishes independent token and money starts without resetting them through unlimited or restart', async () => {
  const f = await fixture()
  const update = async (tokens: number | null, cny: number | null) => {
    const before = modelUsageControlSchema.parse(await (await f.request('/control')).json())
    const response = await f.request('/control', { expectedVersion: before.workspace.version, enabled: true, requests: null, automaticRetries: true, tokens, cny })
    expect(response.status).toBe(200)
    return modelUsageControlSchema.parse(await response.json())
  }
  await startConsultationCase(f.runtime)
  const token = await update(500, null)
  expect(token.workspace).toMatchObject({ tokensUsed: 0, tokensRemaining: 500, cnyStartedAt: null })
  expect(token.workspace.tokensStartedAt).not.toBeNull()
  const money = await update(null, 5)
  expect(money.workspace.tokensStartedAt).toBe(token.workspace.tokensStartedAt)
  expect(money.workspace.cnyStartedAt).not.toBeNull()
  await f.restart()
  const restored = await update(500, null)
  expect(restored.workspace.tokensStartedAt).toBe(token.workspace.tokensStartedAt)
  expect(restored.workspace.cnyStartedAt).toBe(money.workspace.cnyStartedAt)
})

it('reconciles unknown dimensions separately with protected idempotent audit and preserves original Provider evidence', async () => {
  const f = await fixture({ unknownUsage: true })
  let state = modelUsageControlSchema.parse(await (await f.request('/control')).json())
  const set = async (tokens: number | null, cny: number | null) => {
    const response = await f.request('/control', { expectedVersion: state.workspace.version, enabled: true, requests: null, automaticRetries: true, tokens, cny })
    expect(response.status).toBe(200)
    state = modelUsageControlSchema.parse(await response.json())
  }
  await set(500, 5)
  await set(null, null)
  await startConsultationCase(f.runtime)
  const attempt = modelUsageListSchema.parse(await (await f.request('/requests')).json()).items[0]!
  expect(attempt.usage.totalTokens).toBeNull()
  await f.restart()
  state = modelUsageControlSchema.parse(await (await f.request('/control')).json())
  expect(state.workspace).toMatchObject({ tokensUnknownReservations: 1, cnyUnknownReservations: 1 })
  const key = randomUUID()
  const tokens = { expectedRevision: 0, evidence: 'synthetic-provider-receipt-1', totalTokens: 120 }
  const reconciledResponse = await f.request(`/requests/${attempt.id}/reconcile`, tokens, key)
  expect(reconciledResponse.status).toBe(200)
  const reconciled = modelUsageAttemptSchema.parse(await reconciledResponse.json())
  expect(reconciled).toMatchObject({ usage: { totalTokens: null }, accounting: { totalTokens: 120, cny: null } })
  expect(reconciled.corrections).toHaveLength(1)
  expect((await f.request(`/requests/${attempt.id}/reconcile`, tokens, key)).status).toBe(200)
  expect((await f.request(`/requests/${attempt.id}/reconcile`, tokens)).status).toBe(409)
  state = modelUsageControlSchema.parse(await (await f.request('/control')).json())
  expect(state.workspace).toMatchObject({ tokensUsed: 120, tokensUnknownReservations: 0, cnyUnknownReservations: 1 })
  const costResponse = await f.request(`/requests/${attempt.id}/reconcile`, { expectedRevision: 1, evidence: 'synthetic-provider-invoice-2', cny: 0.001 })
  expect(costResponse.status).toBe(200)
  expect(modelUsageAttemptSchema.parse(await costResponse.json())).toMatchObject({ accounting: { totalTokens: 120, cny: 0.001 } })
  const doctor = await signIn(f.runtime, 'doctor@demo.clinmesh.local')
  const denied = await f.runtime.app.request(`/api/model-usage/requests/${attempt.id}/reconcile`, { method: 'POST', headers: { cookie: doctor, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedRevision: 2, evidence: 'synthetic', cny: 0 }) })
  expect(denied.status).toBe(403)
  await f.restart()
  expect(modelUsageControlSchema.parse(await (await f.request('/control')).json()).workspace).toMatchObject({ tokensUsed: 120, cnyUsed: 0.001, cnyUnknownReservations: 0 })
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview')).json()).totals).toMatchObject({ requests: 1, knownTokens: 120, cny: 0.001, unpricedRequests: 0 })
})

it('explicitly reprices retained missing-price detail without changing the invocation snapshot or counting twice', async () => {
  const f = await fixture({ unpriced: true })
  await startConsultationCase(f.runtime)
  const attempt = modelUsageListSchema.parse(await (await f.request('/requests')).json()).items[0]!
  expect(attempt.cost.status).toBe('price-not-configured')
  f.changePrices({ prices: [{ provider: 'synthetic.invalid', model: 'synthetic-model', version: 'supplement-price', currency: 'USD', rates: { input: 2, output: 4 } }],
    exchangeRates: [{ currency: 'USD', version: 'supplement-fx', cnyPerUnit: 7 }] })
  await f.restart()
  const input = { expectedRevision: 0, evidence: 'synthetic-price-schedule-1' }
  const key = randomUUID()
  const response = await f.request(`/requests/${attempt.id}/reprice`, input, key)
  expect(response.status).toBe(200)
  const repriced = modelUsageAttemptSchema.parse(await response.json())
  expect(repriced).toMatchObject({ cost: { status: 'price-not-configured', cny: null }, priceSnapshot: { price: null }, effectiveCost: { cny: 0.0028 } })
  expect(repriced.corrections[0]).toMatchObject({ kind: 'reprice', evidence: input.evidence, priceSnapshot: { price: { version: 'supplement-price' } } })
  expect((await f.request(`/requests/${attempt.id}/reprice`, input, key)).status).toBe(200)
  expect((await f.request(`/requests/${attempt.id}/reprice`, { ...input, expectedRevision: 1 })).status).toBe(409)
  expect(modelUsageOverviewSchema.parse(await (await f.request('/overview')).json()).totals).toMatchObject({ requests: 1, cny: 0.0028, unpricedRequests: 0 })
})

it('uses a trusted zero CNY upper bound even when Token usage and bounds are unavailable', async () => {
  const f = await fixture({ unknownUsage: true, zeroPrice: true })
  const state = modelUsageControlSchema.parse(await (await f.request('/control')).json())
  const response = await f.request('/control', { expectedVersion: state.workspace.version, enabled: true, requests: null, automaticRetries: true, tokens: null, cny: 0 })
  expect(response.status).toBe(200)
  await startConsultationCase(f.runtime)
  const attempt = modelUsageListSchema.parse(await (await f.request('/requests')).json()).items[0]!
  expect(attempt).toMatchObject({ usage: { totalTokens: null }, cost: { status: 'priced', cny: 0, original: 0 } })
  expect(modelUsageControlSchema.parse(await (await f.request('/control')).json()).workspace).toMatchObject({ cny: 0, cnyUsed: 0, cnyReserved: 0, cnyUnknownReservations: 0 })
})

it('supplements only the missing FX while preserving the original unit price', async () => {
  const f = await fixture({ noFx: true })
  await startConsultationCase(f.runtime)
  const attempt = modelUsageListSchema.parse(await (await f.request('/requests')).json()).items[0]!
  expect(attempt.cost).toMatchObject({ status: 'exchange-rate-not-configured', original: 0.0004, cny: null })
  f.changePrices({ prices: [{ provider: 'synthetic.invalid', model: 'synthetic-model', version: 'changed-price', currency: 'CNY', rates: { input: 200, output: 400 } }],
    exchangeRates: [{ currency: 'USD', version: 'supplement-fx', cnyPerUnit: 7 }] })
  await f.restart()
  const response = await f.request(`/requests/${attempt.id}/reprice`, { expectedRevision: 0, evidence: 'synthetic-fx-schedule' })
  expect(response.status).toBe(200)
  expect(modelUsageAttemptSchema.parse(await response.json())).toMatchObject({
    cost: { original: 0.0004, cny: null }, effectiveCost: { original: 0.0004, cny: 0.0028 },
    corrections: [{ priceSnapshot: { price: { currency: 'USD', version: 'price-v1' }, exchangeRate: { version: 'supplement-fx' } } }],
  })
})
