import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import { serve } from '@hono/node-server'
import type { Page } from '@playwright/test'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture, type PciPaymentDrgFixture } from '../../server/tests/fixtures/pci-payment-drg.ts'
import { expect, test as base } from './fixtures.ts'

async function startPciBrowserServer(webRoot: string) {
  const prepared = await preparePciPaymentDrgFixture()
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
    return { origin, password: prepared.password, fixture, get modelCalls() { return prepared.modelCalls }, close }
  } catch (error) {
    await close()
    throw error
  }
}

export type PciBrowserApp = Awaited<ReturnType<typeof startPciBrowserServer>>
export const test = base.extend<{ pciApp: PciBrowserApp }>({ pciApp: async ({ webRoot }, use) => {
  const app = await startPciBrowserServer(webRoot)
  try { await use(app) }
  finally { await app.close() }
} })
export { expect }

export async function loginPciBrowser(page: Page, app: PciBrowserApp, role: string) {
  expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, { maxRetries: 1, headers: { origin: app.origin },
    data: { email: `${role}@demo.clinmesh.local`, password: app.password } })).status()).toBe(200)
}
