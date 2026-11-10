import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { createPatientResponseSchema, scenarioStateSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { advanceVirtualTimeResponseSchema, inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientChargesSchema, inpatientDispenseInputSchema, inpatientFullCatalogSchema, inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema, inpatientPharmacyResponseSchema, inpatientPharmacySchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientPciDataResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { referenceDiagnosisCatalogSearchSchema } from '@clinmesh/contracts/reference-data'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { preparePciPaymentDrgFixture } from '../../server/tests/fixtures/pci-payment-drg.ts'
import { expect } from './fixtures.ts'
import { selectWorkspaceMode } from './inpatient-ui.ts'

/** 独立录屏复用既有受控 PCI reference；不启动任何真实模型。 */
export async function createDispenseBatchApp(webRoot: string) {
  const prepared = await preparePciPaymentDrgFixture()
  try {
    const app = await startBrowserServer(webRoot, { ...prepared.data,
      activeReferenceReleaseId: prepared.options.activeReferenceReleaseId!,
      chatCompletionsProvider: prepared.options.chatCompletionsProvider! })
    return { ...app, close: async () => { try { await app.close() } finally { await rm(prepared.directory, { recursive: true, force: true }) } } }
  } catch (error) { await rm(prepared.directory, { recursive: true, force: true }); throw error }
}

/** 公开准备PCI合法联合用药，停在护士校对后；不调用任何已发药fixture。 */
export async function prepareDispenseBatchPatient(page: Page, app: { origin: string; password: string }, options: { sameLot?: boolean; expandTimes?: boolean; name?: string; bedId?: string } = {}) {
  const login = async (role: string) => expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin }, data: { email: `${role}@demo.clinmesh.local`, password: app.password },
  })).status()).toBe(200)
  const get = (path: string) => page.request.get(app.origin + path)
  const post = (path: string, input: unknown, patient = false) => page.request.post(app.origin + path, {
    headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { input, ...(patient ? { expectedVersions: {} } : {}) },
  })
  await login('admin')
  const context = sessionContextSchema.parse(await (await get('/api/auth/context')).json())
  if (!options.sameLot) {
    const prepared = await post('/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: context.actor.epoch })
    expect(prepared.status()).toBe(200)
    inpatientPciDataResponseSchema.parse(await prepared.json())
  }
  await login('registrar')
  const name = options.name ?? (options.sameLot ? '合成同批多时点患者' : '合成集中发药患者')
  const patient = createPatientResponseSchema.parse(await (await post('/api/his/v1/patients', {
    name, gender: 'male', birthDate: '1966-05-20', identifier: `SYN-${randomUUID()}`,
  }, true)).json()).data.patient
  const registered = inpatientCommandResponseSchema.parse(await (await post('/api/his/v1/inpatient/admissions', {
    expectedEpoch: context.actor.epoch, patientId: patient.id, patientVersion: patient.versionId,
    admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0,
  })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${registered.id}`
  await login('ward-nurse')
  expect((await post(`${path}/receive`, { encounterVersion: registered.versionId, bedId: options.bedId ?? 'bed-general-1' })).status()).toBe(200)
  await login('inpatient-doctor')
  const clinical = () => get(`${path}/clinical`).then(async response => inpatientFullClinicalSchema.parse(await response.json()))
  const catalog = inpatientFullCatalogSchema.parse(await (await get('/api/his/v1/inpatient/clinical-catalog')).json())
  const diagnosisId = options.sameLot ? 'diagnosis-type-2-diabetes-hyperglycemia'
    : referenceDiagnosisCatalogSearchSchema.parse(await (await get('/api/his/v1/reference-catalogs/diagnoses?query=I25.103')).json()).items.find(item => item.code === 'I25.103')!.id
  const diagnosed = await post(`${path}/diagnoses/confirm`, { encounterVersion: (await clinical()).encounterVersion,
    expectedRevision: 0, entries: [{ catalogItemId: diagnosisId, role: 'primary', admissionCondition: '1' }] })
  expect(diagnosed.status()).toBe(200)
  inpatientFullClinicalResponseSchema.parse(await diagnosed.json())
  const orders = []
  for (const medication of options.sameLot ? [{ id: 'medication-metformin', doseText: '0.5 g', doseQuantity: 1 }] : [
    { id: 'medication-pci-aspirin', doseText: '100 mg', doseQuantity: 1 },
    { id: 'medication-pci-clopidogrel', doseText: '75 mg', doseQuantity: 1 },
    { id: 'medication-pci-atorvastatin', doseText: '20 mg', doseQuantity: 2 },
  ]) {
    const selected = catalog.medications.find(item => item.id === medication.id)!
    const response = await post(`${path}/orders/issue`, { encounterVersion: (await clinical()).encounterVersion, duration: options.sameLot ? 'long' : 'temporary',
      selection: { kind: 'medication', catalogItemId: selected.id, catalogVersion: selected.version,
        doseText: medication.doseText, doseQuantity: medication.doseQuantity, frequencyCode: options.sameLot ? 'BID' : 'QD' } })
    expect(response.status(), response.ok() ? undefined : await response.text()).toBe(200)
    orders.push(inpatientFullClinicalResponseSchema.parse(await response.json()).data.orders.find(item => item.catalogItemId === selected.id)!)
  }
  await login('ward-nurse')
  for (const order of orders) {
    const response = await post(`${path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })
    expect(response.status()).toBe(200)
    inpatientFullClinicalResponseSchema.parse(await response.json())
  }
  if (options.sameLot && options.expandTimes !== false) {
    await login('admin')
    const clock = scenarioStateSchema.parse(await (await get('/api/sim/v1/scenario-runs/current')).json())
    if (Date.parse(clock.virtualTime) < Date.parse('2026-08-25T01:00:00.000Z')) {
      const advanced = await post(`/api/sim/v1/scenario-runs/${context.actor.scenarioRunId}/actions/advance-time`, {
        expectedVirtualTime: clock.virtualTime, targetVirtualTime: '2026-08-25T01:00:00.000Z',
      })
      expect(advanced.status()).toBe(200)
      advanceVirtualTimeResponseSchema.parse(await advanced.json())
    }
  }
  await login('pharmacist')
  const baseline = inpatientPharmacySchema.parse(await (await get(`${path}/pharmacy`)).json())
  expect(baseline.executions.length).toBeGreaterThanOrEqual(options.sameLot ? 1 : 3)
  expect(baseline.executions.every(item => item.status === 'pending')).toBe(true)
  expect(baseline.dispenses).toEqual([])
  expect(baseline.orders.map(item => item.doseQuantity).sort()).toEqual(options.sameLot ? [1] : [1, 1, 2])
  return { app, name, path, admissionId: registered.id, orders, baseline, api: { login, get, post } }
}

type Patient = Awaited<ReturnType<typeof prepareDispenseBatchPatient>>
type Step = (caption: string) => Promise<void>

export async function openDispenseBatchPatient(page: Page, s: Pick<Patient, 'name'>, open: () => Promise<void>) {
  await open()
  const toggle = page.getByRole('button', { name: '展开队列', exact: true })
  await expect.poll(async () => await toggle.isVisible() || await page.getByRole('combobox', { name: '门诊与住院', exact: true }).isVisible()
    || await page.getByRole('region', { name: '住院药房', exact: true }).isVisible()).toBe(true)
  if (await toggle.isVisible()) await toggle.click()
  if (!await page.getByRole('region', { name: '住院药房', exact: true }).isVisible()) await selectWorkspaceMode(page, '住院')
  await expect(page.getByRole('region', { name: '住院药房', exact: true })).toBeVisible()
  if (await toggle.isVisible()) await toggle.click()
  await page.getByRole('button', { name: new RegExp(`^查看${s.name}`) }).first().click()
}

/** 真实RoleWorkspace住院模式的共享旅程，回读须沿传入的录屏page。 */
export async function runDispenseBatchJourney(page: Page, s: Patient, open: () => Promise<void>, step: Step = async () => {}, other?: Patient) {
  const get = (path: string) => page.request.get(s.app.origin + path)
  const pharmacy = async () => inpatientPharmacySchema.parse(await (await get(`${s.path}/pharmacy`)).json())
  await openDispenseBatchPatient(page, s, open)
  const choices = page.getByRole('checkbox', { name: /^选择发药：/ })
  await expect(choices).toHaveCount(3)
  await page.getByRole('button', { name: '全选本页可发药执行单', exact: true }).click()
  const drafts = page.getByRole('region', { name: '发药待处理清单', exact: true })
  await expect(drafts).toContainText(/已选\s*3\s*条/)
  await page.getByRole('button', { name: '清空选择', exact: true }).click()
  for (const choice of await choices.all()) await expect(choice).not.toBeChecked()
  await expect(drafts).toContainText('阿司匹林')
  await page.getByRole('button', { name: '全选本页可发药执行单', exact: true }).click()
  if (other) {
    await openDispenseBatchPatient(page, other, async () => {})
    await expect(choices).toHaveCount(1)
    await expect(choices).not.toBeChecked()
    await expect(drafts).toHaveCount(0)
    await openDispenseBatchPatient(page, s, async () => {})
    await expect(drafts).toContainText(/已选\s*3\s*条/)
  }
  await page.reload()
  await openDispenseBatchPatient(page, s, async () => {})
  for (const choice of await choices.all()) await expect(choice).toBeChecked()
  await step('住院药房选择同患者三条待发执行单，分别核对药品、1/1/2片、批次与时点')

  const keys: string[] = [], executionIds: string[] = []
  await page.route(`**${s.path}/executions/dispense`, async route => {
    keys.push(route.request().headers()['idempotency-key']!)
    executionIds.push(route.request().postDataJSON().input.executionId)
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientPharmacyResponseSchema.parse(await response.json())
    if (keys.length === 2) await route.abort('failed'); else await route.fulfill({ response })
  })
  const trigger = page.getByRole('button', { name: '集中发药', exact: true })
  const dialog = page.getByRole('dialog', { name: '集中发药核对', exact: true })
  await trigger.click()
  await expect(dialog.getByRole('article')).toHaveCount(3)
  for (const medication of ['阿司匹林', '氯吡格雷', '阿托伐他汀']) await expect(dialog).toContainText(medication)
  await expect(dialog).toContainText('库存批次')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
  expect(keys).toHaveLength(0)
  const cancelled = await pharmacy()
  expect(cancelled.dispenses).toEqual([])
  expect(cancelled.medications).toEqual(s.baseline.medications)
  await trigger.click()
  await step('集中核对三项药品、各自剂量与库存批次；取消不会发药，重新核对后再确认')
  await dialog.getByRole('button', { name: '确认发药', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复原发药', exact: true })).toBeEnabled()
  expect(keys).toHaveLength(2)
  expect(new Set(keys).size).toBe(2)
  const partial = await pharmacy()
  expect(partial.dispenses).toHaveLength(2)
  expect(partial.dispenses.map(item => item.executionId).sort()).toEqual([...executionIds].sort())
  expect(partial.executions.filter(item => item.status === 'pending')).toHaveLength(1)
  await expect(page.getByRole('region', { name: '发药逐项结果', exact: true })).toContainText('成功')
  await step('第一项成功、第二项提交后响应丢失，第三项停止发送；逐项结果保留原尝试')
  await page.reload()
  await openDispenseBatchPatient(page, s, async () => {})
  const receiptRequest = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原发药', exact: true }).click()
  expect(new URL((await receiptRequest).url()).searchParams.get('idempotencyKey')).toBe(keys[1])
  await expect(page.getByRole('button', { name: '恢复原发药', exact: true })).toHaveCount(0)
  expect(keys).toHaveLength(2)
  const receipt = commandReceiptLookupSchema.parse(await (await get(`/api/his/v1/command-receipts?operationId=inpatient.execution.dispense&idempotencyKey=${keys[1]}`)).json())
  expect(receipt.status).toBe('completed')
  expect((await pharmacy()).dispenses).toHaveLength(2)
  await step('刷新后按原幂等键恢复两项已发结果；第三项保留，人工重新核对才继续')
  await trigger.click()
  await expect(dialog.getByRole('article')).toHaveCount(1)
  await dialog.getByRole('button', { name: '确认发药', exact: true }).click()
  await expect.poll(async () => (await pharmacy()).dispenses.length).toBe(3)
  expect(keys).toHaveLength(3)
  expect(new Set(keys).size).toBe(3)
  expect(new Set(executionIds).size).toBe(3)
  const final = await pharmacy()
  expect(final.executions.every(item => item.status === 'dispensed')).toBe(true)
  expect(final.dispenses.map(item => item.quantity).sort()).toEqual([1, 1, 2])
  expect(final.dispenses.every(item => item.dispensedAt.length > 0 && item.dispensedBy.length > 0)).toBe(true)
  const stocks = []
  for (const dispense of final.dispenses) {
    const before = s.baseline.medications.flatMap(item => item.lots).find(lot => lot.id === dispense.lotId)!
    const inventory = fhirResourceSchema.parse(await (await get(`/fhir/R5/InventoryItem/${dispense.lotId}`)).json())
    expect(inventory).toMatchObject({ meta: { versionId: String(before.version + 1) }, netContent: { value: before.quantityOnHand - dispense.quantity } })
    stocks.push({ lotId: dispense.lotId, beforeVersion: before.version, afterVersion: before.version + 1,
      beforeQuantity: before.quantityOnHand, afterQuantity: before.quantityOnHand - dispense.quantity })
  }
  const login = async (role: string) => expect((await page.request.post(`${s.app.origin}/api/auth/sign-in/email`, {
    headers: { origin: s.app.origin }, data: { email: `${role}@demo.clinmesh.local`, password: s.app.password },
  })).status()).toBe(200)
  await login('cashier')
  const charges = inpatientChargesSchema.parse(await (await get(`${s.path}/charges`)).json())
  expect(charges.charges.filter(item => item.kind === 'medication').map(item => item.amountFen).sort((a, b) => a - b)).toEqual([50, 80, 140])
  expect(charges.chargesFen).toBe(270)
  await login('pharmacist')
  await expect(page.getByRole('region', { name: '发药逐项结果', exact: true })).toContainText('成功')
  await step('三项分别发药成功，1/1/2片仅扣一次库存、药费共2.70元；给药仍交病区护士')
  return { posts: keys.length, keys, executionIds, dispenses: final.dispenses.length,
    quantities: final.dispenses.map(item => item.quantity).sort(), charges: charges.charges.filter(item => item.kind === 'medication').length,
    chargesFen: charges.chargesFen, stocks }
}

/** 同一批次的两个真实 BID 时点共享审阅基线；外部扣减必须阻断余项。 */
export async function runSameLotDispenseJourney(page: Page, s: Patient, open: () => Promise<void>, external?: Patient) {
  await openDispenseBatchPatient(page, s, open)
  const choices = page.getByRole('checkbox', { name: /^选择发药：/ })
  await expect(choices).toHaveCount(3)
  expect(new Set(await choices.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).size).toBe(3)
  await choices.nth(0).check()
  await choices.nth(1).check()
  const reviewedLot = s.baseline.medications.find(item => item.id === 'medication-metformin')!.lots[0]!
  const attempts: { key: string; input: ReturnType<typeof inpatientDispenseInputSchema.parse> }[] = []
  await page.route(`**${s.path}/executions/dispense`, async route => {
    attempts.push({ key: route.request().headers()['idempotency-key']!,
      input: inpatientDispenseInputSchema.parse({ admissionId: s.admissionId, ...route.request().postDataJSON().input }) })
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientPharmacyResponseSchema.parse(await response.json())
    if (external && attempts.length === 1) {
      const current = inpatientPharmacySchema.parse(await (await page.request.get(s.app.origin + external.path + '/pharmacy')).json())
      const execution = current.executions.find(item => item.status === 'pending')!
      const lot = current.medications.find(item => item.id === 'medication-metformin')!.lots.find(item => item.id === reviewedLot.id)!
      const other = await page.request.post(s.app.origin + external.path + '/executions/dispense', {
        headers: { origin: s.app.origin, 'idempotency-key': randomUUID() },
        data: { input: { executionId: execution.id, expectedExecutionVersion: execution.version,
          lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: 1 }] } },
      })
      expect(other.status()).toBe(200)
      inpatientPharmacyResponseSchema.parse(await other.json())
    }
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '集中发药', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '集中发药核对', exact: true })
  await expect(dialog.getByRole('article')).toHaveCount(2)
  await expect(dialog).toContainText('二甲双胍')
  await expect(dialog).toContainText('库存批次')
  await dialog.getByRole('button', { name: '确认发药', exact: true }).click()
  const pharmacy = async () => inpatientPharmacySchema.parse(await (await page.request.get(s.app.origin + s.path + '/pharmacy')).json())
  if (external) {
    await expect(page.getByRole('region', { name: '发药逐项结果', exact: true })).toContainText(/库存.*(变化|重新核对)|重新核对.*库存/)
    expect(attempts).toHaveLength(1)
    expect((await pharmacy()).dispenses).toHaveLength(1)
  } else {
    await expect.poll(async () => (await pharmacy()).dispenses.length).toBe(2)
    expect(attempts).toHaveLength(2)
    expect(new Set(attempts.map(item => item.key)).size).toBe(2)
    expect(attempts.map(item => item.input.lotSelections)).toEqual([
      [{ lotId: reviewedLot.id, expectedVersion: reviewedLot.version, quantity: 1 }],
      [{ lotId: reviewedLot.id, expectedVersion: reviewedLot.version + 1, quantity: 1 }],
    ])
  }
  const inventory = fhirResourceSchema.parse(await (await page.request.get(`${s.app.origin}/fhir/R5/InventoryItem/${reviewedLot.id}`)).json())
  expect(inventory).toMatchObject({ meta: { versionId: String(reviewedLot.version + 2) }, netContent: { value: reviewedLot.quantityOnHand - 2 } })
  return { posts: attempts.length, lotId: reviewedLot.id, inventoryVersion: reviewedLot.version + 2, quantityOnHand: reviewedLot.quantityOnHand - 2 }
}
