import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { createPatientResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullCatalogSchema, inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema, inpatientPharmacySchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientPciDataResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { referenceDiagnosisCatalogSearchSchema } from '@clinmesh/contracts/reference-data'
import { expect } from './fixtures.ts'
import { selectWorkspaceMode } from './inpatient-ui.ts'

/** 公开准备PCI合法联合用药，停在护士校对后；不调用任何已发药fixture。 */
export async function prepareDispenseBatchPatient(page: Page, app: { origin: string; password: string }) {
  const login = async (role: string) => expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin }, data: { email: `${role}@demo.clinmesh.local`, password: app.password },
  })).status()).toBe(200)
  const get = (path: string) => page.request.get(app.origin + path)
  const post = (path: string, input: unknown, patient = false) => page.request.post(app.origin + path, {
    headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { input, ...(patient ? { expectedVersions: {} } : {}) },
  })
  await login('admin')
  const context = sessionContextSchema.parse(await (await get('/api/auth/context')).json())
  const prepared = await post('/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: context.actor.epoch })
  expect(prepared.status()).toBe(200)
  inpatientPciDataResponseSchema.parse(await prepared.json())
  await login('registrar')
  const name = '合成集中发药患者'
  const patient = createPatientResponseSchema.parse(await (await post('/api/his/v1/patients', {
    name, gender: 'male', birthDate: '1966-05-20', identifier: `SYN-${randomUUID()}`,
  }, true)).json()).data.patient
  const registered = inpatientCommandResponseSchema.parse(await (await post('/api/his/v1/inpatient/admissions', {
    expectedEpoch: context.actor.epoch, patientId: patient.id, patientVersion: patient.versionId,
    admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0,
  })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${registered.id}`
  await login('ward-nurse')
  expect((await post(`${path}/receive`, { encounterVersion: registered.versionId, bedId: 'bed-general-1' })).status()).toBe(200)
  await login('inpatient-doctor')
  const clinical = () => get(`${path}/clinical`).then(async response => inpatientFullClinicalSchema.parse(await response.json()))
  const catalog = inpatientFullCatalogSchema.parse(await (await get('/api/his/v1/inpatient/clinical-catalog')).json())
  const diagnoses = referenceDiagnosisCatalogSearchSchema.parse(await (await get('/api/his/v1/reference-catalogs/diagnoses?query=I25.103')).json())
  const diagnosis = diagnoses.items.find(item => item.code === 'I25.103')!
  const diagnosed = await post(`${path}/diagnoses/confirm`, { encounterVersion: (await clinical()).encounterVersion,
    expectedRevision: 0, entries: [{ catalogItemId: diagnosis.id, role: 'primary', admissionCondition: '1' }] })
  expect(diagnosed.status()).toBe(200)
  inpatientFullClinicalResponseSchema.parse(await diagnosed.json())
  const orders = []
  for (const medication of [
    { suffix: 'aspirin', doseText: '100 mg', doseQuantity: 1 },
    { suffix: 'clopidogrel', doseText: '75 mg', doseQuantity: 1 },
    { suffix: 'atorvastatin', doseText: '20 mg', doseQuantity: 2 },
  ]) {
    const selected = catalog.medications.find(item => item.id === `medication-pci-${medication.suffix}`)!
    const response = await post(`${path}/orders/issue`, { encounterVersion: (await clinical()).encounterVersion, duration: 'temporary',
      selection: { kind: 'medication', catalogItemId: selected.id, catalogVersion: selected.version,
        doseText: medication.doseText, doseQuantity: medication.doseQuantity, frequencyCode: 'QD' } })
    expect(response.status(), response.ok() ? undefined : await response.text()).toBe(200)
    orders.push(inpatientFullClinicalResponseSchema.parse(await response.json()).data.orders.find(item => item.catalogItemId === selected.id)!)
  }
  await login('ward-nurse')
  for (const order of orders) {
    const response = await post(`${path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })
    expect(response.status()).toBe(200)
    inpatientFullClinicalResponseSchema.parse(await response.json())
  }
  await login('pharmacist')
  const baseline = inpatientPharmacySchema.parse(await (await get(`${path}/pharmacy`)).json())
  expect(baseline.executions).toHaveLength(3)
  expect(baseline.executions.every(item => item.status === 'pending')).toBe(true)
  expect(baseline.dispenses).toEqual([])
  expect(baseline.orders.map(item => item.doseQuantity).sort()).toEqual([1, 1, 2])
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
export async function runDispenseBatchJourney(page: Page, s: Patient, open: () => Promise<void>, step: Step = async () => {}) {
  await openDispenseBatchPatient(page, s, open)
  await expect(page.getByRole('checkbox', { name: /^选择发药：/ })).toHaveCount(3)
  await step('住院药房选择同患者三条待发执行单，分别核对药品、1/1/2片、批次与时点')
}
