import type { Page } from '@playwright/test'
import { doctorCaseDetailSchema, doctorQueueSchema, patientSearchSchema, registrationResponseSchema } from '@clinmesh/contracts/his'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullCatalogSchema, inpatientFullClinicalResponseSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { doctorCaseHistoryDetailSchema } from '@clinmesh/contracts/agent'
import { parsePciResponse, type PciPaymentDrgFixture } from '../../server/tests/fixtures/pci-payment-drg.ts'
import { expect, test, type PciBrowserApp } from './inpatient-pci.fixture.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

async function signIn(page: Page, app: PciBrowserApp, role: string, path: string) {
  await page.goto(app.origin + path)
  await page.getByLabel('账户邮箱').fill(`${role}@demo.clinmesh.local`)
  await page.getByLabel('账户密码').fill(app.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: '用户菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await expect(page.getByLabel('账户邮箱')).toBeVisible()
}

async function prepareStoppedMedication(fixture: PciPaymentDrgFixture, path: string) {
  const catalog = await fixture.read('inpatient-doctor', '/api/his/v1/inpatient/clinical-catalog', inpatientFullCatalogSchema)
  const medication = catalog.medications.find(item => item.id === 'medication-pci-aspirin')!
  const evaluation = await parsePciResponse(inpatientDrgSimulationSchema, await fixture.request('inpatient-doctor', `${path}/drg/simulation`, {
    medications: [{ catalogItemId: medication.id, catalogVersion: medication.version, doseText: '100 mg', frequencyCode: 'QD', doseQuantity: 1 }], services: [],
  }))
  const current = await fixture.read('inpatient-doctor', path, inpatientDetailSchema)
  const issued = await parsePciResponse(inpatientFullClinicalResponseSchema, await fixture.request('inpatient-doctor', `${path}/orders/issue`, {
    encounterVersion: current.admission.versionId, duration: 'long', expectedDrgFingerprint: evaluation.fingerprint,
    selection: { kind: 'medication', catalogItemId: medication.id, catalogVersion: medication.version, doseText: '100 mg', frequencyCode: 'QD', doseQuantity: 1 },
  }))
  const order = issued.data.orders.find(item => item.catalogItemId === medication.id && item.state === 'signed')!
  const verified = await parsePciResponse(inpatientFullClinicalResponseSchema, await fixture.request('ward-nurse', `${path}/orders/verify`, {
    orderId: order.id, expectedOrderVersion: order.version,
  }))
  const stopping = await parsePciResponse(inpatientFullClinicalResponseSchema, await fixture.request('inpatient-doctor', `${path}/orders/request-stop`, {
    orderId: order.id, expectedOrderVersion: verified.data.orders.find(item => item.id === order.id)!.version, reason: '合成院后病史验收：出院前停止本次住院长期医嘱',
  }))
  const stopped = await parsePciResponse(inpatientFullClinicalResponseSchema, await fixture.request('ward-nurse', `${path}/orders/verify-stop`, {
    orderId: order.id, expectedOrderVersion: stopping.data.orders.find(item => item.id === order.id)!.version,
  }))
  expect(stopped.data.orders.find(item => item.id === order.id)?.state).toBe('stopped')
  return medication.display
}

test('出院患者从既有档案办理独立门诊问诊并读取有日期和停嘱状态的住院摘要', async ({ page, pciApp: app }) => {
  test.setTimeout(120_000)
  const errors: string[] = [], pixelRequests: string[] = [], historyRequests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (/\/(pixels|tiles)(\/|$)/.test(path)) pixelRequests.push(path)
    if (/\/doctor\/cases\/[^/]+\/history/.test(path)) historyRequests.push(path)
  })
  const stay = await app.fixture.preparePciAdmission()
  await app.fixture.completePciLaboratories(stay)
  await app.fixture.dispensePciMedications(stay, 'preoperative')
  await app.fixture.executeAngiography(stay)
  const surgery = await app.fixture.executePci(stay)
  await app.fixture.dispensePostoperativePciAspirin(stay, surgery.id)
  const stoppedMedication = await prepareStoppedMedication(app.fixture, stay.path)
  expect((await app.fixture.depart(stay)).status).toBe('departed')
  const patients = await app.fixture.read('registrar', `/api/his/v1/patients?query=${encodeURIComponent('合成冠脉')}`, patientSearchSchema)
  const patient = patients.items.find(item => item.id === stay.patientId)!

  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page, app, 'registrar', '/registration')
  const queue = page.getByRole('region', { name: '患者选择', exact: true })
  await queue.getByRole('tab', { name: '检索', exact: true }).click()
  await queue.getByLabel('姓名、门诊号或合成标识', { exact: true }).fill(patient.name)
  await queue.getByRole('button', { name: '搜索', exact: true }).click()
  await queue.getByRole('button', { name: `选择患者 ${patient.name}`, exact: true }).click()
  await expect(page.getByRole('region', { name: '当前患者', exact: true })).toContainText('已有患者档案')
  await expect(page.getByText('使用该患者身份发起新的门诊就诊。已出院患者可在此办理院后门诊复诊，无需重新建档。', { exact: true })).toBeVisible()
  const registrationResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/his/v1/registrations/actions/register')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认挂号', exact: true }).click()
  const registered = registrationResponseSchema.parse(await (await registrationResponse).json()).data
  expect(registered.patientId).toBe(stay.patientId)
  expect(registered.encounterId).not.toBe(stay.admissionId)
  await expect(page.getByText('挂号已完成，患者已进入分诊待办队列', { exact: true })).toBeVisible()

  await signOut(page)
  await signIn(page, app, 'triage', '/triage')
  await page.getByRole('button', { name: `选择病例 ${patient.name}`, exact: true }).click()
  await page.getByLabel('主诉', { exact: true }).fill('冠脉介入出院后按约复诊，复查恢复情况。')
  await page.getByRole('group', { name: '分诊级别', exact: true }).getByRole('button', { name: '四级 · 非急症', exact: true }).click()
  await page.getByLabel('体温（°C）', { exact: true }).fill('36.7')
  await page.getByRole('button', { name: '完成分诊', exact: true }).click()
  await expect(page.getByText('分诊完成', { exact: true })).toBeVisible()

  await signOut(page)
  await signIn(page, app, 'doctor', '/consultation')
  await page.getByRole('tab', { name: '待诊', exact: true }).click()
  await page.getByText(patient.name, { exact: true }).first().click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await openWorkspaceTab(page, '问诊记录')
  await expect(page.getByRole('textbox', { name: '向患者提问', exact: true })).toBeEditable()
  const doctorQueue = doctorQueueSchema.parse(await (await page.request.get(`${app.origin}/api/his/v1/doctor/queue`)).json())
  const outpatient = doctorQueue.items.find(item => item.encounterId === registered.encounterId)!
  const detail = doctorCaseDetailSchema.parse(await (await page.request.get(`${app.origin}/api/his/v1/doctor/cases/${outpatient.caseId}`)).json())
  expect(detail.patient.id).toBe(stay.patientId)
  expect(detail.consultation).toMatchObject({ turns: [], version: 1 })
  expect(historyRequests).toEqual([])

  const historyTitle = '本院既往诊疗（门诊与已出院住院）'
  const history = page.locator('details').filter({ has: page.getByText(historyTitle, { exact: true }) })
  await history.locator('summary').click()
  const historyItem = history.getByRole('button', { name: /本院住院诊疗摘要/ })
  await expect(historyItem).toContainText('2026年8月24日')
  await historyItem.click()
  await expect(history.getByText(/冠状动脉粥样硬化性心脏病/)).toBeVisible()
  await expect(history.getByText(/冠状动脉支架/)).toBeVisible()
  const stopped = history.getByRole('listitem').filter({ hasText: stoppedMedication }).filter({ hasText: '已停用' })
  await expect(stopped).toHaveCount(1)
  await expect(stopped).toContainText('100 mg · QD · 已停用')
  const record = doctorCaseHistoryDetailSchema.parse(await (await page.request.get(`${app.origin}/api/his/v1/doctor/cases/${outpatient.caseId}/history/detail?source=local-completed&entryId=${encodeURIComponent(`inpatient:${stay.admissionId}`)}`)).json())
  expect(record).toMatchObject({ source: 'local-completed', record: { kind: 'inpatient', admissionId: stay.admissionId,
    medications: expect.arrayContaining([expect.objectContaining({ display: stoppedMedication, state: 'stopped' })]) } })
  await page.setViewportSize({ width: 826, height: 900 })
  const scroll = history.locator('div.overflow-auto')
  await expect.poll(() => scroll.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(history.getByRole('heading', { name: '已签发检验检查结论', exact: true })).toBeVisible()
  expect(pixelRequests).toEqual([])
  expect(errors).toEqual([])
  expect(app.modelCalls).toBe(0)
})
