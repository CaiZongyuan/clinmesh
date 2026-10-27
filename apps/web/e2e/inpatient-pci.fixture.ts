import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import { serve } from '@hono/node-server'
import type { Page } from '@playwright/test'
import { z } from 'zod'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture, type PciPaymentDrgFixture } from '../../server/tests/fixtures/pci-payment-drg.ts'
import { pciAgentGeneration, pciAgentVerification } from '../../server/tests/fixtures/inpatient-drg-agent.ts'
import { OpenAIChatCompletionsClient } from '../../server/src/infrastructure/ai/openai-chat-completions.ts'
import { expect, test as base } from './fixtures.ts'

async function startPciBrowserServer(webRoot: string, agent = false) {
  const prepared = await preparePciPaymentDrgFixture()
  const modelFeatures: string[] = []
  if (agent) {
    prepared.options.consultationModel = 'synthetic-drg-model'
    prepared.options.autoDispatchIntervalMs = 25
    prepared.options.chatCompletionsProvider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid/v1',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)), feature = body.response_format.json_schema.name
        if (feature !== 'inpatient_drg_recommendation' && feature !== 'inpatient_drg_verification') {
          throw new Error('The PCI Agent browser fixture only permits controlled DRG requests')
        }
        const payload = z.object({ remaining: z.array(z.object({ materialId: z.string(), quantity: z.number() })).optional(),
          proposed: z.array(z.object({ materialId: z.string() })).optional(),
        }).parse(JSON.parse(body.messages.find((message: { role: string }) => message.role === 'user').content))
        const result = feature === 'inpatient_drg_recommendation' ? { items: pciAgentGeneration.items.flatMap(item => {
          const remaining = payload.remaining?.find(candidate => candidate.materialId === item.materialId)
          if (payload.remaining !== undefined && (!remaining || remaining.quantity <= 0)) return []
          return [{ ...item, quantity: remaining?.quantity ?? item.quantity }]
        }) } : { items: pciAgentVerification.items.filter(item => payload.proposed === undefined
          || payload.proposed.some(proposed => proposed.materialId === item.materialId)) }
        modelFeatures.push(feature)
        return Response.json({ id: `synthetic-drg-${modelFeatures.length}`, model: 'synthetic-drg-model',
          choices: [{ message: { content: JSON.stringify(result) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
      } })
  }
  let fixture: PciPaymentDrgFixture | undefined
  const server = serve({ hostname: '127.0.0.1', port: 0,
    fetch: request => fixture?.runtime.app.fetch(request) ?? new Response('Starting', { status: 503 }) })
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
    if (address === null || typeof address === 'string') throw new Error('Missing PCI browser server address')
    const origin = `http://127.0.0.1:${address.port}`
    Object.assign(prepared.options, { authBaseUrl: origin, webRoot, trustedOrigins: ['http://localhost', origin] })
    fixture = await createPciPaymentDrgFixture(prepared)
    return { origin, password: prepared.password, fixture, modelFeatures,
      get modelCalls() { return agent ? modelFeatures.length : prepared.modelCalls }, close }
  } catch (error) {
    await close()
    throw error
  }
}

export type PciBrowserApp = Awaited<ReturnType<typeof startPciBrowserServer>>
export const test = base.extend<{ pciApp: PciBrowserApp; pciAgentApp: PciBrowserApp }>({ pciApp: async ({ webRoot }, use) => {
  const app = await startPciBrowserServer(webRoot)
  try { await use(app) }
  finally { await app.close() }
}, pciAgentApp: async ({ webRoot }, use) => {
  const app = await startPciBrowserServer(webRoot, true)
  try { await use(app) }
  finally { await app.close() }
} })
export { expect }

export async function loginPciBrowser(page: Page, app: PciBrowserApp, role: string) {
  expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, { maxRetries: 1, headers: { origin: app.origin },
    data: { email: `${role}@demo.clinmesh.local`, password: app.password } })).status()).toBe(200)
}
