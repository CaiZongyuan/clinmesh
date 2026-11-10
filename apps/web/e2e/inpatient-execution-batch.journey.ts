import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullCatalogSchema, inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema,
  inpatientPharmacyResponseSchema, inpatientPharmacySchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import { expect, loginPciBrowser, type PciBrowserApp } from './inpatient-pci.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

function post(page: Page, app: PciBrowserApp, path: string, input: unknown) {
  return page.request.post(app.origin + path, { headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { input } })
}
async function clinical(page: Page, app: PciBrowserApp, path: string) {
  const response = await page.request.get(app.origin + path + '/clinical')
  expect(response.status()).toBe(200)
  return inpatientFullClinicalSchema.parse(await response.json())
}

/** 公开岗位准备两份待给药、两份待教育和两条未发起PRN；不预写任何实际执行。 */
export async function prepareInpatientExecutionBatch(page: Page, app: PciBrowserApp, options: { educationCount?: number } = {}) {
  const stay = await app.fixture.preparePciAdmission([])
  const path = stay.path
  const medicationIds = ['aspirin', 'clopidogrel', 'heparin', 'iohexol']
  for (const suffix of medicationIds) {
    await loginPciBrowser(page, app, 'inpatient-doctor')
    const catalogResponse = await page.request.get(app.origin + '/api/his/v1/inpatient/clinical-catalog')
    expect(catalogResponse.status()).toBe(200)
    const catalog = inpatientFullCatalogSchema.parse(await catalogResponse.json())
    const item = catalog.medications.find(item => item.id === `medication-pci-${suffix}`)!
    const dose = item.doses[0]!, frequencyCode = item.frequencyCodes[0]!
    const medication = { catalogItemId: item.id, catalogVersion: item.version, doseText: dose.doseText, doseQuantity: dose.quantity, frequencyCode }
    const evaluationResponse = await post(page, app, path + '/drg/simulation', { medications: [medication], services: [] })
    expect(evaluationResponse.status(), await evaluationResponse.text()).toBe(200)
    const evaluation = inpatientDrgSimulationSchema.parse(await evaluationResponse.json())
    const current = await clinical(page, app, path)
    const issuedResponse = await post(page, app, path + '/orders/issue', { encounterVersion: current.encounterVersion, duration: 'temporary',
      expectedDrgFingerprint: evaluation.fingerprint, selection: { kind: 'medication', ...medication } })
    expect(issuedResponse.status(), await issuedResponse.text()).toBe(200)
    const order = inpatientFullClinicalResponseSchema.parse(await issuedResponse.json()).data.orders.find(item => item.catalogItemId === medication.catalogItemId)!
    await loginPciBrowser(page, app, 'ward-nurse')
    const verified = await post(page, app, path + '/orders/verify', { orderId: order.id, expectedOrderVersion: order.version })
    expect(verified.status(), await verified.text()).toBe(200)
    inpatientFullClinicalResponseSchema.parse(await verified.json())
  }
  for (let count = 0; count < (options.educationCount ?? 2); count++) {
    await loginPciBrowser(page, app, 'inpatient-doctor')
    const before = await clinical(page, app, path)
    const issuedResponse = await post(page, app, path + '/orders/issue', { encounterVersion: before.encounterVersion, duration: 'temporary',
      selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 } })
    expect(issuedResponse.status(), await issuedResponse.text()).toBe(200)
    const order = inpatientFullClinicalResponseSchema.parse(await issuedResponse.json()).data.orders.find(item => !before.orders.some(old => old.id === item.id))!
    await loginPciBrowser(page, app, 'ward-nurse')
    const verified = await post(page, app, path + '/orders/verify', { orderId: order.id, expectedOrderVersion: order.version })
    expect(verified.status(), await verified.text()).toBe(200)
  }
  await loginPciBrowser(page, app, 'ward-nurse')
  const beforeDispense = await clinical(page, app, path)
  const prnOrders = beforeDispense.orders.filter(item => item.frequencyCode === 'PRN')
  expect(prnOrders).toHaveLength(2)
  expect(beforeDispense.executions.some(execution => prnOrders.some(order => order.id === execution.orderId))).toBe(false)
  const administeredOrderIds = beforeDispense.orders.filter(item => item.kind === 'medication' && item.frequencyCode !== 'PRN').map(item => item.id)
  for (const orderId of administeredOrderIds) {
    await loginPciBrowser(page, app, 'pharmacist')
    const pharmacyResponse = await page.request.get(app.origin + path + '/pharmacy')
    expect(pharmacyResponse.status()).toBe(200)
    const pharmacy = inpatientPharmacySchema.parse(await pharmacyResponse.json()), order = pharmacy.orders.find(item => item.id === orderId)!
    const execution = pharmacy.executions.find(item => item.orderId === order.id)!, medication = pharmacy.medications.find(item => item.id === order.catalogItemId)!, lot = medication.lots[0]!
    const response = await post(page, app, path + '/executions/dispense', { executionId: execution.id, expectedExecutionVersion: execution.version,
      lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: order.doseQuantity }] })
    expect(response.status(), await response.text()).toBe(200)
    inpatientPharmacyResponseSchema.parse(await response.json())
  }
  await loginPciBrowser(page, app, 'ward-nurse')
  const before = await clinical(page, app, path)
  const admission = inpatientDetailSchema.parse(await (await page.request.get(app.origin + path)).json()).admission
  const context = sessionContextSchema.parse(await (await page.request.get(app.origin + '/api/auth/context')).json())
  const administrations = fhirBundleSchema.parse(await (await page.request.get(`${app.origin}/fhir/R5/MedicationAdministration?encounter=Encounter/${admission.id}&_total=accurate`)).json())
  expect(administrations.total).toBe(0)
  expect(before.executions.filter(item => item.status === 'dispensed')).toHaveLength(2)
  expect(before.executions.filter(item => item.status === 'pending')).toHaveLength(options.educationCount ?? 2)
  expect(before.executions.some(item => item.administrationId !== undefined || item.status === 'completed')).toBe(false)
  expect(before.dispenses).toHaveLength(2)
  expect(before.charges).toHaveLength(2)
  expect(app.modelCalls).toBe(0)
  const result = { app, path, admission, context, before, prnOrders }
  await openInpatientExecutionWorkspace(page, result)
  return result
}

export async function openInpatientExecutionWorkspace(page: Page, subject: { app: PciBrowserApp; admission: { patientName: string } },
  open = async () => { await page.goto(subject.app.origin + '/inpatient') }) {
  await open()
  await page.getByRole('button', { name: new RegExp(subject.admission.patientName) }).click()
  await selectInpatientStage(page, '诊断医嘱')
}
