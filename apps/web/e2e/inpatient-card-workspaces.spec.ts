import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { createPatientResponseSchema } from '@clinmesh/contracts/his'
import { expect, test } from './fixtures.ts'

async function login(page: Page, origin: string, password: string, role: string) {
  await page.goto(`${origin}/${role === 'registrar' ? 'registration' : 'inpatient'}`)
  await page.getByLabel('账户邮箱').fill(`${role}@demo.clinmesh.local`)
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
}

async function register(page: Page, origin: string, name: string) {
  const patientResponse = await page.request.post(`${origin}/api/his/v1/patients`, {
    headers: { origin, 'idempotency-key': randomUUID() },
    data: { expectedVersions: {}, input: { name, gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } },
  })
  expect(patientResponse.status()).toBe(200)
  const patient = createPatientResponseSchema.parse(await patientResponse.json()).data.patient
  const session = await (await page.request.get(`${origin}/api/auth/context`)).json()
  const admissionResponse = await page.request.post(`${origin}/api/his/v1/inpatient/admissions`, {
    headers: { origin, 'idempotency-key': randomUUID() }, data: { input: {
      expectedEpoch: session.actor.epoch, patientId: patient.id, patientVersion: patient.versionId,
      admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0,
    } },
  })
  expect(admissionResponse.status()).toBe(200)
  return inpatientCommandResponseSchema.parse(await admissionResponse.json()).data.admission
}

async function logout(page: Page) {
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()
}

test('护士从新入院队列办理分床，按本岗待办落点导航并可收起整列队列', async ({ page, browserApp }) => {
  const { origin, password } = browserApp
  await login(page, origin, password, 'registrar')
  const name = `合成卡片护士${randomUUID().slice(0, 6)}`
  await register(page, origin, name)
  await logout(page)
  await login(page, origin, password, 'ward-nurse')
  await expect(page.getByRole('heading', { name: '本病区', exact: true })).toBeVisible()
  await expect(page.getByLabel('新入院', { exact: true })).toContainText(name)
  await page.getByRole('button', { name: new RegExp(name) }).click()
  await expect(page.getByRole('tab', { name: '入科', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('轮到你：接诊并分床', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '接诊并分床', exact: true })).toBeVisible()
  await page.getByLabel('目标床位').click()
  await page.getByRole('option', { name: /1床/ }).click()
  await page.getByRole('button', { name: '接诊并分床', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已完成' }).first()).toBeVisible()
  await expect(page.getByRole('tab', { name: '诊断医嘱', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'DRG 预分组', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await expect(page.getByRole('tab', { name: '费用', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '收起队列', exact: true }).click()
  await expect(page.getByRole('heading', { name: '本病区', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '展开队列', exact: true }).click()
  await expect(page.getByRole('heading', { name: '本病区', exact: true })).toBeVisible()
  for (const width of [944, 720, 400]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})

test('护士能看见未来给药时间和出院缺项，门禁受阻时明确由谁处理', async ({ page, browserApp }) => {
  const { origin, password } = browserApp
  await login(page, origin, password, 'registrar')
  const name = `合成时间门禁${randomUUID().slice(0, 6)}`
  const admission = await register(page, origin, name), path = `/api/his/v1/inpatient/admissions/${admission.id}`
  const asRole = async (role: string) => expect((await page.request.post(`${origin}/api/auth/sign-in/email`, {
    headers: { origin }, data: { email: `${role}@demo.clinmesh.local`, password },
  })).status()).toBe(200)
  const post = (endpoint: string, input: unknown) => page.request.post(`${origin}${endpoint}`, { headers: { origin, 'idempotency-key': randomUUID() }, data: { input } })
  await asRole('ward-nurse')
  const received = (await (await post(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).json()).data.admission
  await asRole('inpatient-doctor')
  expect((await post(`${path}/diagnoses/confirm`, { encounterVersion: received.versionId, expectedRevision: 0,
    entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' }],
  })).status()).toBe(200)
  const clinical = await (await page.request.get(`${origin}${path}/clinical`)).json()
  const issued = await post(`${path}/orders/issue`, { encounterVersion: clinical.encounterVersion, duration: 'long',
    selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } })
  expect(issued.status()).toBe(200)
  const order = (await issued.json()).data.orders[0]
  await asRole('ward-nurse')
  expect((await post(`${path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).status()).toBe(200)
  await asRole('admin')
  expect((await post('/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
    expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00',
  })).status()).toBe(200)
  await asRole('pharmacist')
  await page.goto(`${origin}/pharmacy`)
  await page.getByRole('button', { name: '住院', exact: true }).click()
  await page.getByRole('button', { name: `查看${name}`, exact: true }).click()
  await expect(page.getByRole('heading', { name: '住院发药队列', exact: true })).toBeVisible()
  const dispensing = page.getByRole('region', { name: '当前操作', exact: true })
  await dispensing.getByRole('button', { name: '发药', exact: true }).click()
  expect((await (await page.request.get(`${origin}${path}/pharmacy`)).json()).executions[0].status).toBe('pending')
  await dispensing.getByRole('button', { name: '确认发药', exact: true }).click()
  await expect.poll(async () => (await (await page.request.get(`${origin}${path}/pharmacy`)).json()).executions[0].status).toBe('dispensed')
  await asRole('ward-nurse')
  await page.goto(`${origin}/inpatient`)
  await page.getByRole('button', { name: new RegExp(`1床 ${name}`) }).click()
  await expect(page.getByText('08:00 后可给药', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '给药', exact: true })).toBeDisabled()
  await asRole('inpatient-doctor')
  const current = (await (await page.request.get(`${origin}${path}`)).json()).admission
  expect((await post(`${path}/discharge/issue`, { encounterVersion: current.versionId, reason: '合成出院门禁核对' })).status()).toBe(200)
  await asRole('ward-nurse')
  await page.reload()
  await expect(page.getByRole('button', { name: new RegExp(`1床 ${name}`) })).toContainText('轮到你 1 项')
  await page.getByRole('button', { name: new RegExp(`1床 ${name}`) }).click()
  await expect(page.getByRole('tab', { name: '出院', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByLabel('出院处理说明', { exact: true }).fill('合成护士交班核对')
  await page.getByLabel('离院方式', { exact: true }).click()
  await page.getByRole('option', { name: '医嘱离院', exact: true }).click()
  const bar = page.getByRole('region', { name: '当前操作', exact: true })
  await expect(bar).toContainText('还差 1 条医嘱、1 次给药')
  await expect(bar).toContainText('住院医生')
  await expect(bar.getByRole('button', { name: '办理出院', exact: true })).toBeDisabled()
  expect((await (await page.request.get(`${origin}${path}`)).json()).admission.status).toBe('discharge-pending')
})

test('医保办只有归档核定队列，使用同一流程外壳且空队列说明前置岗位', async ({ page, browserApp }) => {
  const { origin, password } = browserApp
  await login(page, origin, password, 'registrar')
  const name = `合成未归档患者${randomUUID().slice(0, 6)}`
  await register(page, origin, name)
  await logout(page)
  await login(page, origin, password, 'medical-insurance')
  await expect(page.getByRole('list', { name: '办理流程', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '核定队列', exact: true })).toBeVisible()
  await expect(page.getByText('病案归档后进入核定队列。', { exact: true })).toBeVisible()
  await expect(page.getByText(name, { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '收起队列', exact: true }).click()
  await expect(page.getByRole('heading', { name: '核定队列', exact: true })).toHaveCount(0)
})
