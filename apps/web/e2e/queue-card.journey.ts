import type { Page } from '@playwright/test'
import { createPatientResponseSchema, registrationCatalogSchema, registrationResponseSchema } from '@clinmesh/contracts/his'
import { expect } from '@playwright/test'

export const queueCardRoles = [
  ['registrar', 'registration', '患者选择'], ['triage', 'triage', '分诊队列'],
  ['cashier', 'billing', '收费队列'], ['medical-insurance', 'inpatient', '核定队列'],
  ['pharmacist', 'pharmacy', undefined], ['inpatient-doctor', 'inpatient', undefined],
  ['ward-nurse', 'inpatient', undefined], ['medical-records', 'inpatient', undefined],
] as const

export async function expectQueueCardBounds(page: Page) {
  const queue = page.locator('.clinmesh-card-queue')
  await expect(queue).toBeVisible()
  await expect.poll(() => queue.evaluate(element => {
    const column = element.getBoundingClientRect()
    const card = element.querySelector('[data-slot="card"]')!.getBoundingClientRect()
    const main = element.parentElement!.querySelector('.clinmesh-card-main')!.getBoundingClientRect()
    return column.height > 0 && [card.top - column.top, card.bottom - column.bottom,
      card.top - main.top, card.bottom - main.bottom].every(delta => Math.abs(delta) <= 1)
  }), { message: '队列卡片应铺满队列列高，并与右侧主卡顶部和底部对齐' }).toBe(true)
}

export async function expectQueueToggle(page: Page, resize: (width: number) => Promise<void>) {
  await page.getByRole('button', { name: '收起队列', exact: true }).click()
  await expect(page.locator('.clinmesh-card-queue')).toHaveCount(0)
  await page.getByRole('button', { name: '展开队列', exact: true }).click()
  await expectQueueCardBounds(page)
  await resize(760)
  await expect(page.locator('.clinmesh-card-queue')).toHaveCount(0)
  await page.getByRole('button', { name: '展开队列', exact: true }).click()
  await expect(page.locator('.clinmesh-card-queue')).toHaveAttribute('data-overlay')
  await expectQueueCardBounds(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.clinmesh-card-queue')).toHaveCount(0)
}

export async function prepareTriageQueue(page: Page, app: { origin: string; password: string }, count: number) {
  const login = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin }, data: { email: 'registrar@demo.clinmesh.local', password: app.password },
  })
  expect(login.status()).toBe(200)
  const catalog = registrationCatalogSchema.parse(await (await page.request.get(`${app.origin}/api/his/v1/catalogs/registration`)).json())
  for (let index = 0; index < count; index++) {
    const response = await page.request.post(`${app.origin}/api/his/v1/patients`, {
      headers: { origin: app.origin, 'idempotency-key': crypto.randomUUID() },
      data: { expectedVersions: {}, input: { name: `合成队列高度患者${index}`, identifier: `SYN-QUEUE-HEIGHT-${index}`, birthDate: '1990-01-01', gender: 'female' } },
    })
    expect(response.status()).toBe(200)
    const patient = createPatientResponseSchema.parse(await response.json()).data.patient
    const registration = await page.request.post(`${app.origin}/api/his/v1/registrations/actions/register`, {
      headers: { origin: app.origin, 'idempotency-key': crypto.randomUUID() },
      data: { expectedVersions: { [`Patient/${patient.id}`]: patient.versionId }, input: {
        patientId: patient.id, departmentId: catalog.departments[0]!.id, locationId: catalog.locations[0]!.id,
        visitTypeId: catalog.visitTypes[0]!.id, visitDate: catalog.virtualDate,
      } },
    })
    expect(registration.status()).toBe(200)
    registrationResponseSchema.parse(await registration.json())
  }
  expect((await page.request.post(`${app.origin}/api/auth/sign-out`, { headers: { origin: app.origin }, data: {} })).status()).toBe(200)
}

export async function expectTriageQueueSelection(page: Page, resize: (width: number) => Promise<void>, count: number) {
  const queue = page.getByRole('region', { name: '分诊队列', exact: true })
  const last = queue.getByRole('button', { name: '选择病例 合成队列高度患者0', exact: true })
  await expect(queue.getByRole('button', { name: /^选择病例 / })).toHaveCount(count)
  await expectQueueCardBounds(page)
  const tail = queue.getByRole('button', { name: /^选择病例 / }).last()
  await tail.scrollIntoViewIfNeeded()
  await expect(tail).toBeInViewport({ ratio: 1 })
  await tail.click()
  await expect(page.getByRole('region', { name: '当前患者', exact: true })).toContainText('合成队列高度患者')
  await resize(760)
  await page.getByRole('button', { name: '展开队列', exact: true }).click()
  await last.scrollIntoViewIfNeeded()
  await expect(last).toBeInViewport({ ratio: 1 })
  await last.click()
  await expect(page.locator('.clinmesh-card-queue')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '当前患者', exact: true })).toContainText('合成队列高度患者0')
}
