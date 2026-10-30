import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { inpatientCatalogSchema, inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema, inpatientPharmacySchema } from '@clinmesh/contracts/inpatient-clinical'
import { createPatientResponseSchema } from '@clinmesh/contracts/his'
import { inpatientSettlementPreviewSchema } from '@clinmesh/contracts/inpatient-discharge'
import { expect, test } from './fixtures.ts'
import { archiveDrgBrowserPatient, createDrgBrowserPatient, drgBrowserApi, test as drgTest } from './inpatient-drg.fixture.ts'

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

async function prepareDischarge(page: Page, app: { origin: string; password: string }, name: string) {
  const { origin, password } = app
  await login(page, origin, password, 'registrar')
  const admission = await register(page, origin, name)
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  const asRole = async (role: string) => expect((await page.request.post(`${origin}/api/auth/sign-in/email`, {
    headers: { origin }, data: { email: `${role}@demo.clinmesh.local`, password },
  })).status()).toBe(200)
  const post = async (endpoint: string, input: unknown) => {
    const response = await page.request.post(`${origin}${endpoint}`, {
      headers: { origin, 'idempotency-key': randomUUID() }, data: { input },
    })
    expect(response.status()).toBe(200)
    return response
  }
  await asRole('ward-nurse')
  const received = inpatientCommandResponseSchema.parse(await (await post(`${path}/receive`, {
    encounterVersion: admission.versionId, bedId: 'bed-general-1',
  })).json()).data.admission
  await asRole('inpatient-doctor')
  const pending = inpatientCommandResponseSchema.parse(await (await post(`${path}/discharge/issue`, {
    encounterVersion: received.versionId, reason: '合成出院待办核对',
  })).json()).data.admission
  return { admission: pending, path, asRole, post }
}

async function captureCard(page: Page, role: string) {
  for (const width of [944, 720, 400]) {
    await page.setViewportSize({ width, height: 900 })
    for (const [theme, label] of [['light', '亮色'], ['dark', '暗色']] as const) {
      await page.getByRole('button', { name: '用户菜单' }).click()
      await page.getByRole('menuitemradio', { name: label, exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      const path = test.info().outputPath(`${role}-${width}-${theme}.png`)
      await page.screenshot({ path, animations: 'disabled' })
      await test.info().attach(`${role}-${width}-${theme}`, { path, contentType: 'image/png' })
    }
  }
}

async function expectHorizontalQueue(page: Page, rows: Locator) {
  const first = await rows.nth(0).boundingBox(), second = await rows.nth(1).boundingBox()
  expect(first).not.toBeNull()
  expect(second).not.toBeNull()
  await test.info().attach('queue-geometry', { body: JSON.stringify({ first, second }), contentType: 'application/json' })
  expect(Math.abs(first!.y - second!.y)).toBeLessThan(1)
  expect(second!.x).toBeGreaterThanOrEqual(first!.x + first!.width)
  expect(await rows.first().evaluate(element => {
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowX) && parent.scrollWidth > parent.clientWidth) return true
    }
    return false
  })).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400)
}

for (const role of ['registrar', 'cashier', 'inpatient-doctor', 'medical-records']) {
  test(`400px ${role} 多患者队列横排且保留岗位入口`, async ({ page, browserApp }) => {
    const { origin, password } = browserApp
    await login(page, origin, password, 'registrar')
    const names = ['合成横排甲', '合成横排乙']
    for (const name of names) await register(page, origin, name)
    await logout(page)
    await page.setViewportSize({ width: 400, height: 900 })
    await login(page, origin, password, role)
    if (role === 'registrar' || role === 'cashier') await page.getByRole('button', { name: '住院', exact: true }).click()
    const rows = page.getByRole('button', { name: /^查看合成横排/ })
    await expect(rows).toHaveCount(2)
    await expectHorizontalQueue(page, rows)
    if (role === 'cashier') await expect(page.getByRole('region', { name: '待入科', exact: true })).toContainText(names[0]!)
    await rows.first().click()
    const patient = page.getByRole('heading', { name: names[0]!, exact: true })
    await patient.scrollIntoViewIfNeeded()
    await expect(patient).toBeInViewport()
    await expect(page.getByRole('button', { name: '返回住院患者', exact: true })).toBeVisible()
    if (role === 'registrar') {
      await page.setViewportSize({ width: 944, height: 900 })
      await expect(page.getByRole('table')).toBeVisible()
      await expect(page.getByRole('columnheader', { name: '住院号', exact: true })).toBeVisible()
    }
  })
}

test('400px 护士的新入院患者和床位行横排，保留时间和空床价格', async ({ page, browserApp }) => {
  const { origin, password } = browserApp
  await login(page, origin, password, 'registrar')
  const admission = await register(page, origin, '合成横排护士甲')
  await register(page, origin, '合成横排护士乙')
  await logout(page)
  await page.setViewportSize({ width: 400, height: 900 })
  await login(page, origin, password, 'ward-nurse')
  await expectHorizontalQueue(page, page.getByRole('region', { name: '新入院', exact: true }).getByRole('button'))
  const received = await page.request.post(`${origin}/api/his/v1/inpatient/admissions/${admission.id}/receive`, {
    headers: { origin, 'idempotency-key': randomUUID() }, data: { input: { encounterVersion: admission.versionId, bedId: 'bed-general-1' } },
  })
  expect(received.status()).toBe(200)
  await page.reload()
  const catalog = inpatientCatalogSchema.parse(await (await page.request.get(`${origin}/api/his/v1/inpatient/catalog`)).json())
  const ward = page.getByRole('region', { name: catalog.wards.find(item => item.id === 'ward-general')!.name, exact: true })
  await expectHorizontalQueue(page, ward.getByRole('listitem'))
  await expect(page.getByText('¥50.00/天', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/2026.*8.*24.*09:00/).first()).toBeVisible()
  await page.getByRole('button', { name: '1床 合成横排护士甲', exact: true }).click()
  const patient = page.getByRole('region', { name: '当前住院患者', exact: true })
  await patient.scrollIntoViewIfNeeded()
  await expect(patient).toBeInViewport()
  await expect(page.getByRole('button', { name: '返回住院患者', exact: true })).toBeVisible()
})

test('400px 住院药房多患者队列横排，发药主区可达', async ({ page, browserApp }) => {
  const { origin, password } = browserApp
  await login(page, origin, password, 'registrar')
  const admissions = [await register(page, origin, '合成横排药房甲'), await register(page, origin, '合成横排药房乙')]
  const api = drgBrowserApi(page, browserApp)
  for (const [index, admission] of admissions.entries()) {
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    await api.login('ward-nurse')
    expect((await api.post(`${path}/receive`, { encounterVersion: admission.versionId, bedId: `bed-general-${index + 1}` })).status()).toBe(200)
    await api.login('inpatient-doctor')
    const clinical = await (await api.get(`${path}/clinical`)).json()
    expect((await api.post(`${path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion, expectedRevision: clinical.diagnosis.revision,
      entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' }],
    })).status()).toBe(200)
    const diagnosed = await (await api.get(`${path}/clinical`)).json()
    const issued = await api.post(`${path}/orders/issue`, { encounterVersion: diagnosed.encounterVersion, duration: 'long',
      selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } })
    expect(issued.status()).toBe(200)
    const order = (await issued.json()).data.orders[0]
    await api.login('ward-nurse')
    expect((await api.post(`${path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).status()).toBe(200)
  }
  await api.login('pharmacist')
  await page.setViewportSize({ width: 400, height: 900 })
  await page.goto(`${origin}/pharmacy`)
  await page.getByRole('button', { name: '住院', exact: true }).click()
  const rows = page.getByRole('button', { name: /^查看合成横排药房/ })
  await expect(rows).toHaveCount(2)
  await expectHorizontalQueue(page, rows)
  await rows.first().click()
  const patient = page.getByRole('region', { name: '当前住院患者', exact: true })
  await patient.scrollIntoViewIfNeeded()
  await expect(patient).toBeInViewport()
  await expect(page.getByRole('button', { name: '返回住院患者', exact: true })).toBeVisible()
})

drgTest('400px 医保核定多患者队列横排且保留归档分组入口', async ({ page, browserApp }) => {
  const first = await createDrgBrowserPatient(page, browserApp, '合成横排核定甲')
  await archiveDrgBrowserPatient(first)
  const second = await createDrgBrowserPatient(page, browserApp, '合成横排核定乙')
  await archiveDrgBrowserPatient(second)
  await second.api.login('medical-insurance')
  await page.setViewportSize({ width: 400, height: 900 })
  await page.goto(`${browserApp.origin}/inpatient`)
  const rows = page.getByRole('region', { name: '核定队列', exact: true }).getByRole('button')
  await expect(rows).toHaveCount(2)
  await expectHorizontalQueue(page, rows)
  const history = page.getByRole('region', { name: '历史核定', exact: true })
  await history.scrollIntoViewIfNeeded()
  await expect(history).toBeInViewport()
  await expect(page.getByText('已归档病案', { exact: true })).toBeVisible()
})

for (const state of ['signed', 'dispensed'] as const) {
  test(`待出院护士不接收 ${state} 诊疗待办，医生停嘱后仍可核停并取消未完成执行`, async ({ page, browserApp }) => {
    const { origin, password } = browserApp
    await login(page, origin, password, 'registrar')
    const name = `合成停嘱门禁${state}`, admission = await register(page, origin, name)
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    const api = drgBrowserApi(page, browserApp)
    const clinical = async () => inpatientFullClinicalSchema.parse(await (await api.get(`${path}/clinical`)).json())
    await api.login('ward-nurse')
    const received = inpatientCommandResponseSchema.parse(await (await api.post(`${path}/receive`, {
      encounterVersion: admission.versionId, bedId: 'bed-general-1',
    })).json()).data.admission
    await api.login('inpatient-doctor')
    expect((await api.post(`${path}/diagnoses/confirm`, { encounterVersion: received.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' }],
    })).status()).toBe(200)
    expect((await api.post(`${path}/orders/issue`, { encounterVersion: (await clinical()).encounterVersion,
      duration: state === 'signed' ? 'long' : 'temporary', selection: { kind: 'medication', catalogItemId: 'medication-amlodipine',
        catalogVersion: 1, doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' },
    })).status()).toBe(200)
    const order = (await clinical()).orders[0]!
    if (state === 'dispensed') {
      await api.login('ward-nurse')
      expect((await api.post(`${path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).status()).toBe(200)
      await api.login('pharmacist')
      const pharmacy = inpatientPharmacySchema.parse(await (await api.get(`${path}/pharmacy`)).json())
      const execution = pharmacy.executions[0]!, lot = pharmacy.medications[0]!.lots[0]!
      expect((await api.post(`${path}/executions/dispense`, { executionId: execution.id, expectedExecutionVersion: execution.version,
        lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: order.doseQuantity }],
      })).status()).toBe(200)
    }
    await api.login('inpatient-doctor')
    const current = inpatientDetailSchema.parse(await (await api.get(path)).json()).admission
    expect((await api.post(`${path}/discharge/issue`, { encounterVersion: current.versionId, reason: '合成治疗已结束，待停嘱核对' })).status()).toBe(200)
    await api.login('ward-nurse')
    await page.goto(`${origin}/inpatient`)
    const bed = page.getByRole('button', { name: `1床 ${name}`, exact: true })
    await expect(bed).toContainText('轮到你 1 项')
    await bed.click()
    await expect(page.getByRole('tab', { name: '出院', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tabpanel', { name: '出院', exact: true })).toContainText('等住院医生申请停嘱')
    await expect(page.getByRole('tabpanel', { name: '出院', exact: true })).not.toContainText('轮到你：办理出院')
    await expect(page.getByText(/待校对 1|待执行\/给药 1/)).toHaveCount(0)
    await page.getByRole('tab', { name: '诊断医嘱', exact: true }).click()
    const panel = page.getByRole('tabpanel', { name: '诊断医嘱', exact: true })
    await expect(panel).toContainText('等住院医生申请停嘱')
    await expect(panel).not.toContainText('轮到你：校对或执行医嘱')
    await expect(panel.getByRole('button', { name: state === 'signed' ? '校对医嘱' : '给药', exact: true })).toBeDisabled()
    await api.login('inpatient-doctor')
    const beforeStop = (await clinical()).orders[0]!
    expect((await api.post(`${path}/orders/request-stop`, { orderId: beforeStop.id, expectedOrderVersion: beforeStop.version, reason: '合成出院停嘱' })).status()).toBe(200)
    await api.login('ward-nurse')
    await page.reload()
    await page.getByRole('button', { name: `1床 ${name}`, exact: true }).click()
    await expect(page.getByRole('tab', { name: '诊断医嘱', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('轮到你：核对停嘱', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '核对停嘱', exact: true }).click()
    await expect.poll(async () => (await clinical()).orders[0]?.state).toBe('stopped')
    if (state === 'dispensed') expect((await clinical()).executions.map(item => item.status)).toEqual(['cancelled'])
    await page.getByRole('tab', { name: '出院', exact: true }).click()
    await page.getByLabel('出院处理说明', { exact: true }).fill('合成医嘱与执行已结束')
    await page.getByLabel('离院方式', { exact: true }).click()
    await page.getByRole('option', { name: '医嘱离院', exact: true }).click()
    await page.getByRole('button', { name: '办理出院', exact: true }).click()
    await expect.poll(async () => inpatientDetailSchema.parse(await (await api.get(path)).json()).admission.status).toBe('departed')
  })
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
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText('女 · 46 岁')
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
  await page.setViewportSize({ width: 400, height: 900 })
  const panel = page.getByRole('tabpanel', { name: '诊断医嘱', exact: true })
  await expect.poll(async () => (await panel.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(240)
  const reason = page.getByLabel('停嘱或按需执行理由', { exact: true })
  await reason.scrollIntoViewIfNeeded()
  await expect(reason).toBeInViewport({ ratio: 1 })
  await test.info().attach('narrow-workspace-geometry', { body: JSON.stringify({ panel: await panel.boundingBox(), control: await reason.boundingBox() }), contentType: 'application/json' })
  await page.screenshot({ path: test.info().outputPath('ward-nurse-400-work.png'), animations: 'disabled' })
  await expect(page.getByRole('button', { name: '返回住院患者', exact: true })).toBeVisible()
  await expect(page.getByText('¥50.00/天', { exact: true }).first()).toBeVisible()
  await captureCard(page, 'ward-nurse')
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

test('护士床位卡将已结算患者计为一项待清床，不读取额外诊疗资料', async ({ page, browserApp }) => {
  const name = `合成清床待办${randomUUID().slice(0, 6)}`
  const { origin } = browserApp
  const state = await prepareDischarge(page, browserApp, name)
  await state.asRole('ward-nurse')
  const departed = inpatientCommandResponseSchema.parse(await (await state.post(`${state.path}/discharge/depart`, {
    encounterVersion: state.admission.versionId, reason: '合成护理核对完成', departureMethod: 'home',
  })).json()).data.admission
  expect(departed.status).toBe('departed')
  await state.asRole('cashier')
  const previewResponse = await page.request.get(`${origin}${state.path}/discharge/preview`)
  expect(previewResponse.status()).toBe(200)
  const preview = inpatientSettlementPreviewSchema.parse(await previewResponse.json())
  await state.post(`${state.path}/discharge/settle`, {
    encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint,
    expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen,
  })
  await state.asRole('ward-nurse')
  const clinicalRequests: string[] = []
  page.on('request', request => {
    if (request.url() === `${origin}${state.path}/clinical`) clinicalRequests.push(request.url())
  })
  await page.goto(`${origin}/inpatient`)
  const bed = page.getByRole('button', { name: `1床 ${name}`, exact: true })
  await expect(bed).toContainText('已结算 · 待清床')
  await expect(bed).toContainText('轮到你 1 项')
  expect(clinicalRequests).toEqual([])
})

test('护士收起队列后可重试医嘱资料读取失败，恢复原出院门禁和办理入口', async ({ page, browserApp }) => {
  const name = `合成诊疗恢复${randomUUID().slice(0, 6)}`
  const { origin } = browserApp
  const state = await prepareDischarge(page, browserApp, name)
  await state.asRole('ward-nurse')
  let unavailable = true
  const clinicalUrl = `${origin}${state.path}/clinical`
  await page.route(clinicalUrl, route => unavailable
    ? route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: '合成医嘱资料暂不可用' } } }) : route.continue())
  const failedRead = page.waitForResponse(response => response.url() === clinicalUrl && response.status() === 503)
  await page.goto(`${origin}/inpatient`)
  await failedRead
  await page.getByRole('button', { name: `1床 ${name}`, exact: true }).click()
  await expect(page.getByRole('tab', { name: '出院', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: '收起队列', exact: true }).click()
  await expect(page.getByRole('heading', { name: '本病区', exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: '诊断医嘱', exact: true }).click()
  const orders = page.getByRole('tabpanel', { name: '诊断医嘱', exact: true })
  await expect(orders).toContainText('请先读取医嘱资料，核对停嘱情况。')
  await expect(orders).not.toContainText('医嘱已结束')
  await page.getByRole('tab', { name: '出院', exact: true }).click()
  await page.getByLabel('出院处理说明', { exact: true }).fill('合成护士出院核对')
  await page.getByLabel('离院方式', { exact: true }).click()
  await page.getByRole('option', { name: '医嘱离院', exact: true }).click()
  const depart = page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '办理出院', exact: true })
  await expect(depart).toBeDisabled()
  const failure = page.getByRole('alert').filter({ hasText: '医嘱资料读取失败' })
  await expect(failure).toBeVisible()
  unavailable = false
  await page.getByRole('button', { name: '重试医嘱资料', exact: true }).click()
  await expect(failure).toHaveCount(0)
  await expect(depart).toBeEnabled()
  await depart.click()
  await expect.poll(async () => (await (await page.request.get(`${origin}${state.path}`)).json()).admission.status).toBe('departed')
})

test('医生队列保留住院天数与欠费提示，患者可直接选择', async ({ page, browserApp }) => {
  const { origin, password } = browserApp
  await login(page, origin, password, 'registrar')
  const name = `合成队列提示${randomUUID().slice(0, 6)}`, admission = await register(page, origin, name)
  const asRole = async (role: string) => expect((await page.request.post(`${origin}/api/auth/sign-in/email`, {
    headers: { origin }, data: { email: `${role}@demo.clinmesh.local`, password },
  })).status()).toBe(200)
  await asRole('ward-nurse')
  expect((await page.request.post(`${origin}/api/his/v1/inpatient/admissions/${admission.id}/receive`, {
    headers: { origin, 'idempotency-key': randomUUID() }, data: { input: { encounterVersion: admission.versionId, bedId: 'bed-general-1' } },
  })).status()).toBe(200)
  await asRole('admin')
  expect((await page.request.post(`${origin}/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time`, {
    headers: { origin, 'idempotency-key': randomUUID() }, data: { input: {
      expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T09:00:00+08:00',
    } },
  })).status()).toBe(200)
  await asRole('inpatient-doctor')
  await page.goto(`${origin}/inpatient`)
  const row = page.getByRole('button', { name: `查看${name}`, exact: true })
  await expect(row).toContainText('第 2 天')
  await expect(row).toContainText('欠费')
  await row.click()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText(name)
  await captureCard(page, 'inpatient-doctor')
})

test('住院队列读取失败不显示空列表，人工重试后恢复患者入口', async ({ page, browserApp }) => {
  const { origin, password } = browserApp
  await login(page, origin, password, 'registrar')
  const name = `合成读取恢复${randomUUID().slice(0, 6)}`
  await register(page, origin, name)
  await logout(page)
  let unavailable = true
  await page.route(`${origin}/api/his/v1/inpatient/admissions`, route => unavailable
    ? route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: '合成队列暂不可用' } } }) : route.continue())
  await login(page, origin, password, 'ward-nurse')
  await expect(page.getByRole('alert')).toContainText('住院患者读取失败')
  await expect(page.getByText('暂无符合条件的住院患者；新登记的患者会在这里出现。', { exact: true })).toHaveCount(0)
  unavailable = false
  await page.getByRole('button', { name: '重试读取', exact: true }).click()
  await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
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
