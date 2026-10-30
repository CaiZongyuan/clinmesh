import { randomUUID } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import {
  billingCaseSchema, firstVisitDraftResponseSchema, laboratoryOrderResponseSchema,
  paymentResponseSchema, startVisitResponseSchema,
} from '@clinmesh/contracts/his'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'

export async function startBillingBrowserServer(webRoot: string) {
  const server = await startBrowserServer(webRoot, {
    patientPersonaModel: 'synthetic-persona', syntheaProvider: new StubSyntheaProvider(),
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName !== 'patient_persona') throw new Error(`Unexpected synthetic model schema: ${input.schemaName}`)
      return { content: JSON.stringify(persona), model: 'synthetic' }
    } },
  })
  try {
    const started = await startConsultationCase(server.runtime, server.password, server.origin)
    const login = await fetch(`${server.origin}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: server.origin },
      body: JSON.stringify({ email: 'doctor@demo.clinmesh.local', password: server.password }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('Missing synthetic doctor session')
    const write = async (path: string, method: 'POST' | 'PUT', expectedVersions: Record<string, string>, input: object) => {
      const response = await fetch(`${server.origin}${path}`, {
        method, headers: { 'content-type': 'application/json', cookie, origin: server.origin, 'idempotency-key': randomUUID() },
        body: JSON.stringify({ expectedVersions, input }),
      })
      expect(response.status).toBe(200)
      return response.json()
    }
    const encounter = `Encounter/${started.encounterId}`
    const task = `Task/${started.doctorTaskId}`
    const visit = startVisitResponseSchema.parse(await write(
      `/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, 'POST',
      { [encounter]: started.encounterVersion, [task]: '1' }, {},
    )).data
    const draft = firstVisitDraftResponseSchema.parse(await write(
      `/api/his/v1/encounters/${started.encounterId}/drafts/first-visit`, 'PUT',
      { [encounter]: visit.encounterVersion }, { expectedDraftVersion: 0,
        assessment: '合成收费验收，完善检验。', historyOfPresentIllness: '反复头晕一周，合成检验收费场景。' },
    )).data
    const order = laboratoryOrderResponseSchema.parse(await write(
      `/api/his/v1/encounters/${started.encounterId}/actions/issue-laboratory-order`, 'POST',
      { [encounter]: visit.encounterVersion, [task]: visit.taskVersion },
      { catalogItemId: 'lab-fever-panel', expectedDraftVersion: draft.draftVersion, indicationCode: 'fever' },
    )).data
    expect(order.totalFen).toBe(6800)
    return { ...server, caseId: started.outpatientCaseId, chargeItemId: order.chargeItemId }
  } catch (error) {
    await server.close()
    throw error
  }
}

export async function signInCashier(page: Page, server: { origin: string; password: string }) {
  await page.goto(`${server.origin}/billing`)
  await page.getByLabel('账户邮箱').fill('cashier@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(server.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '门诊收费', exact: true })).toBeVisible()
}

export async function readBill(page: Page, server: { origin: string; caseId: string }) {
  const response = await page.request.get(`${server.origin}/api/his/v1/billing/cases/${server.caseId}`)
  expect(response.status()).toBe(200)
  return billingCaseSchema.parse(await response.json())
}

export async function submitPayment(page: Page) {
  await page.getByRole('button', { name: '预览支付', exact: true }).click()
  await page.getByRole('button', { name: '确认支付', exact: true }).click()
  const dialog = page.getByRole('region', { name: '确认支付', exact: true })
  await expect(dialog).toBeVisible()
  const received = page.waitForResponse(response => response.request().method() === 'POST'
    && /\/payments\/[^/]+\/actions\/confirm$/.test(new URL(response.url()).pathname))
  await dialog.getByRole('button', { name: '提交支付', exact: true }).click()
  const response = await received
  expect(response.status()).toBe(200)
  const result = paymentResponseSchema.parse(await response.json()).data
  await expect(dialog).toHaveCount(0)
  return result
}

export async function expectBillingFits(page: Page) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const bill = page.getByRole('region', { name: '本次就诊账单', exact: true })
    const bounds = await bill.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }))
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  }
}
