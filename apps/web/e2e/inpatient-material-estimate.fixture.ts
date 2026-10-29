import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { serve } from '@hono/node-server'
import { OpenAIChatCompletionsClient } from '../../server/src/infrastructure/ai/openai-chat-completions.ts'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture, type PciPaymentDrgFixture } from '../../server/tests/fixtures/pci-payment-drg.ts'
import { expect, test as base } from './fixtures.ts'

async function startEstimateBrowserServer(webRoot: string, unknown = false, beforeGeneration?: () => Promise<void>) {
  const prepared = await preparePciPaymentDrgFixture()
  const modelFeatures: string[] = []
  prepared.options.consultationModel = 'synthetic-estimate-model'
  prepared.options.autoDispatchIntervalMs = 25
  prepared.options.chatCompletionsProvider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid/v1',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)), feature: string = body.response_format.json_schema.name
      if (feature !== 'inpatient_drg_recommendation' && feature !== 'inpatient_drg_verification') throw new Error('Only controlled material estimates are permitted')
      modelFeatures.push(feature)
      if (unknown) throw new Error('Synthetic connection lost after dispatch')
      if (feature === 'inpatient_drg_recommendation') await beforeGeneration?.()
      const result = feature === 'inpatient_drg_recommendation'
        ? { items: [{ materialId: 'hospital-material-catheter', catalogVersion: 1, quantity: 2, reason: '独立合成双根造影方案', evidenceIds: ['angiography-two-catheter'] }] }
        : { items: [{ materialId: 'hospital-material-catheter', applicable: true, compatible: true, quantitySupported: true, evidenceSupported: true, reason: '独立核对双根造影方案' }] }
      return Response.json({ id: `synthetic-estimate-${modelFeatures.length}`, model: 'synthetic-estimate-model',
        choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
    } })
  let fixture: PciPaymentDrgFixture | undefined
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: request => fixture?.runtime.app.fetch(request) ?? new Response('Starting', { status: 503 }) })
  const close = async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
        if ('closeAllConnections' in server) server.closeAllConnections()
      })
    } finally {
      if (fixture) await fixture.close()
      else await rm(prepared.directory, { recursive: true, force: true })
    }
  }
  try {
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing material estimate browser server address')
    const origin = `http://127.0.0.1:${address.port}`
    Object.assign(prepared.options, { authBaseUrl: origin, webRoot, trustedOrigins: ['http://localhost', origin] })
    fixture = await createPciPaymentDrgFixture(prepared)
    return { origin, password: prepared.password, fixture, modelFeatures, close }
  } catch (error) { await close(); throw error }
}

export type EstimateBrowserApp = Awaited<ReturnType<typeof startEstimateBrowserServer>>
export type PendingEstimateBrowserApp = EstimateBrowserApp & { releaseGeneration: () => void }
export const test = base.extend<{ estimateApp: EstimateBrowserApp; unknownEstimateApp: EstimateBrowserApp; pendingEstimateApp: PendingEstimateBrowserApp }>({
  estimateApp: async ({ webRoot }, use) => {
    const app = await startEstimateBrowserServer(webRoot)
    try { await use(app) } finally { await app.close() }
  },
  unknownEstimateApp: async ({ webRoot }, use) => {
    const app = await startEstimateBrowserServer(webRoot, true)
    try { await use(app) } finally { await app.close() }
  },
  pendingEstimateApp: async ({ webRoot }, use) => {
    let releaseGeneration!: () => void
    const gate = new Promise<void>(resolve => { releaseGeneration = resolve })
    const app = await startEstimateBrowserServer(webRoot, false, () => gate)
    try { await use({ ...app, releaseGeneration }) } finally { releaseGeneration(); await app.close() }
  },
})
export { expect }

export async function openEstimatePatient(page: Page, app: EstimateBrowserApp, role = 'inpatient-doctor') {
  expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, { headers: { origin: app.origin },
    data: { email: `${role}@demo.clinmesh.local`, password: app.password } })).status()).toBe(200)
  await page.goto(`${app.origin}/inpatient`)
  await page.getByRole('button', { name: /合成固定病组联合验收/ }).click()
  await page.getByRole('tab', { name: '手术', exact: true }).click()
}

export async function requestAngiography(page: Page) {
  await page.getByLabel('计划术式', { exact: true }).click()
  await page.getByRole('option', { name: /88.5600/ }).click()
  await page.getByLabel('计划手术时间（上海时间）', { exact: true }).fill('2026-08-24T15:00')
  await page.getByLabel('手术申请理由', { exact: true }).fill('医生已确认合成双根导管造影方向')
  await page.getByRole('button', { name: '申请手术', exact: true }).click()
}
