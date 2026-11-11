import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { z } from 'zod'
import { createPatientResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema, type InpatientOrder } from '@clinmesh/contracts/inpatient-clinical'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { expect } from './fixtures.ts'
import { selectInpatientStage } from './inpatient-ui.ts'
import { openQueue } from './queue-overlay.fixture.ts'

/** 合成病例仅通过公开登记、入科、诊断、开嘱与停嘱准备。 */
export async function prepareOrderVerificationBatchPatient(page: Page, app: { origin: string; password: string }) {
  const login = async (role: string) => expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin }, data: { email: `${role}@demo.clinmesh.local`, password: app.password },
  })).status()).toBe(200)
  const post = (path: string, input: unknown, patient = false) => page.request.post(`${app.origin}${path}`, {
    headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { input, ...(patient ? { expectedVersions: {} } : {}) },
  })
  const get = (path: string) => page.request.get(`${app.origin}${path}`)
  const create = async (name: string, bedId: string) => {
    await login('registrar')
    const patient = createPatientResponseSchema.parse(await (await post('/api/his/v1/patients', {
      name, gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}`,
    }, true)).json()).data.patient
    const session = sessionContextSchema.parse(await (await get('/api/auth/context')).json())
    const admission = inpatientCommandResponseSchema.parse(await (await post('/api/his/v1/inpatient/admissions', {
      expectedEpoch: session.actor.epoch, patientId: patient.id, patientVersion: patient.versionId,
      admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0,
    })).json()).data.admission
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    await login('ward-nurse')
    expect((await post(`${path}/receive`, { encounterVersion: admission.versionId, bedId })).status()).toBe(200)
    return { name, path, admissionId: admission.id }
  }
  const s = await create('合成集中校对患者', 'bed-general-1')
  await login('inpatient-doctor')
  const read = async () => inpatientFullClinicalSchema.parse(await (await get(`${s.path}/clinical`)).json())
  const clinical = await read()
  expect((await post(`${s.path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion, expectedRevision: 0, entries: [
    { catalogItemId: 'diagnosis-type-2-diabetes-hyperglycemia', role: 'primary', admissionCondition: '1' },
    { catalogItemId: 'diagnosis-fever', role: 'secondary', admissionCondition: '1' },
  ] })).status()).toBe(200)
  const issue = async (duration: 'long' | 'temporary', selection: unknown) => {
    const before = await read()
    const response = await post(`${s.path}/orders/issue`, { encounterVersion: before.encounterVersion, duration, selection })
    expect(response.status(), response.ok() ? undefined : await response.text()).toBe(200)
    const next = inpatientFullClinicalResponseSchema.parse(await response.json()).data.orders.find(row => !before.orders.some(old => old.id === row.id))!
    return next
  }
  const medication = await issue('long', { kind: 'medication', catalogItemId: 'medication-acetaminophen', catalogVersion: 1,
    doseText: '0.5 g', doseQuantity: 1, frequencyCode: 'PRN' })
  const education = await issue('temporary', { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 })
  const remaining = await issue('temporary', { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 2 })
  const stopped = await issue('temporary', { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 3 })
  expect((await post(`${s.path}/orders/request-stop`, { orderId: stopped.id, expectedOrderVersion: stopped.version, reason: '合成独立停嘱，禁止混入新医嘱校对' })).status()).toBe(200)
  const other = await create('合成校对范围隔离患者', 'bed-general-2')
  return { ...s, other, app, api: { login, post, get }, medication, education, remaining, stopped }
}

type Patient = Awaited<ReturnType<typeof prepareOrderVerificationBatchPatient>>
type Step = (caption: string) => Promise<void>

async function openPatient(page: Page, s: Patient, open: () => Promise<void>) {
  await open()
  await openQueue(page)
  await page.getByRole('button', { name: new RegExp(s.name) }).click()
  await selectInpatientStage(page, '诊断医嘱')
}

/** Web、双React Surface与最终精确提交录制共用同一可观察旅程。 */
export async function runOrderVerificationBatchJourney(page: Page, s: Patient, open: () => Promise<void>, step: Step = async () => {}) {
  const read = async () => inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json())
  await openPatient(page, s, open)
  const checkbox = (order: InpatientOrder) => page.getByRole('checkbox', { name: `选择校对：${order.display}`, exact: true }).nth(order.id === s.remaining.id ? 1 : 0)
  await expect(checkbox(s.medication)).toBeVisible()
  await expect(checkbox(s.education)).toBeVisible()
  await expect(checkbox(s.remaining)).toBeVisible()
  await expect(page.getByRole('button', { name: '校对下一条医嘱', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '全选当前页可校对医嘱', exact: true }).click()
  for (const order of [s.medication, s.education, s.remaining]) await expect(checkbox(order)).toBeChecked()
  await page.getByRole('region', { name: '新医嘱校对', exact: true }).getByRole('button', { name: '清空选择', exact: true }).click()
  for (const order of [s.medication, s.education, s.remaining]) await expect(checkbox(order)).not.toBeChecked()
  for (const order of [s.medication, s.education, s.remaining]) await checkbox(order).check()
  await step('病区护士选择三条新医嘱：PRN药品与两条不同用量的教育医嘱；停嘱核对保持独立')
  await openQueue(page)
  await page.getByRole('button', { name: new RegExp(s.other.name) }).click()
  await expect(page.getByRole('checkbox', { name: /^选择校对：/ })).toHaveCount(0)
  await openPatient(page, s, async () => {})
  for (const order of [s.medication, s.education, s.remaining]) await expect(checkbox(order)).toBeChecked()
  await page.reload()
  await openPatient(page, s, async () => {})
  for (const order of [s.medication, s.education, s.remaining]) await expect(checkbox(order)).toBeChecked()
  expect((await read()).orders.filter(row => row.state === 'signed')).toHaveLength(3)
  await step('切换患者和刷新后恢复本患者三条选择，校对前没有执行或费用事实')
  let posts = 0
  const keys: string[] = [], orderIds: string[] = []
  await page.route(`**${s.path}/orders/verify`, async route => {
    posts += 1
    keys.push(route.request().headers()['idempotency-key']!)
    orderIds.push(route.request().postDataJSON().input.orderId)
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientFullClinicalResponseSchema.parse(await response.json())
    if (posts === 2) await route.abort('failed'); else await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '集中核对新医嘱 (3)', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '集中核对新医嘱', exact: true })
  await expect(dialog).toContainText(s.medication.display)
  await expect(dialog).toContainText('0.5 g')
  await expect(dialog).toContainText(s.education.display)
  await expect(dialog).toContainText('按需')
  await expect(dialog).toContainText('长期')
  await expect(dialog).toContainText('临时')
  await step('集中核对每项药品或服务、剂量、频次和长期临时，明确确认三条新医嘱')
  await dialog.getByRole('button', { name: '确认校对 3 条新医嘱', exact: true }).click()
  const results = page.getByRole('region', { name: '逐项校对结果', exact: true })
  await expect.poll(() => posts).toBe(2)
  await expect(page.getByRole('button', { name: '恢复原校对结果', exact: true })).toBeEnabled()
  await expect(results).toContainText('待核实')
  expect(posts).toBe(2)
  expect((await read()).orders.find(order => order.id === s.remaining.id)?.state).toBe('signed')
  await step('首项成功保留，第二项响应丢失后暂停，第三条教育医嘱仍未发送')
  await page.reload()
  await openPatient(page, s, async () => {})
  const receiptRequest = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原校对结果', exact: true }).click()
  expect(new URL((await receiptRequest).url()).searchParams.get('idempotencyKey')).toBe(keys[1])
  await expect(page.getByRole('button', { name: '恢复原校对结果', exact: true })).toHaveCount(0)
  expect(posts).toBe(2)
  expect((await read()).orders.find(order => order.id === s.remaining.id)?.state).toBe('signed')
  await step('刷新后查询第二项原回执，不重复校对；剩余医嘱仍需重新核对')
  await page.getByRole('button', { name: '集中核对新医嘱 (1)', exact: true }).click()
  await dialog.getByRole('button', { name: '确认校对 1 条新医嘱', exact: true }).click()
  await expect.poll(() => posts).toBe(3)
  const final = await read()
  expect(final.orders.filter(order => order.state === 'verified').map(order => order.id)).toEqual([s.medication.id, s.education.id, s.remaining.id])
  expect(final.orders.find(order => order.id === s.stopped.id)).toMatchObject({ state: 'stop-requested', version: 2 })
  expect(final.executions.map(execution => [execution.orderId, execution.status])).toEqual([[s.education.id, 'pending'], [s.remaining.id, 'pending']])
  expect(final.dispenses).toEqual([])
  expect(final.charges).toEqual([])
  expect(final.chargesFen).toBe(0)
  expect(new Set(keys).size).toBe(3)
  expect(orderIds).toEqual([s.medication.id, s.education.id, s.remaining.id])
  const receipt = commandReceiptLookupSchema.parse(await (await s.api.get(`/api/his/v1/command-receipts?operationId=inpatient.order.verify&idempotencyKey=${keys[1]}`)).json())
  expect(receipt.status).toBe('completed')
  const administrations = fhirBundleSchema.parse(await (await s.api.get(`/fhir/R5/MedicationAdministration?encounter=Encounter/${s.admissionId}&_total=accurate`)).json())
  expect(administrations.total).toBe(0)
  let audits = 0, next: string | undefined = '/fhir/R5/AuditEvent?_total=accurate&_count=100'
  for (let pageNumber = 0; next !== undefined && pageNumber < 10; pageNumber += 1) {
    const bundle = fhirBundleSchema.parse(await (await s.api.get(next)).json())
    audits += (bundle.entry ?? []).filter(entry => {
      const event = z.object({ code: z.object({ text: z.string() }), outcome: z.object({ code: z.object({ code: z.string() }) }) }).loose().parse(entry.resource)
      return event.code.text === 'inpatient.order.verify' && event.outcome.code.code === '0'
    }).length
    const link = bundle.link?.find(item => item.relation === 'next')?.url
    const url = link === undefined ? undefined : new URL(link, s.app.origin)
    if (url) expect(url.origin).toBe(s.app.origin)
    next = url === undefined ? undefined : `${url.pathname}${url.search}`
  }
  expect(next).toBeUndefined()
  expect(audits).toBe(3)
  await step('三条新医嘱各校对一次，形成两条待执行任务；PRN未发起、停嘱未核停，未发药给药或收费')
  return { posts, keys, orderIds, audits, verifiedOrders: 3, executionCount: 2, stopRequestedOrders: 1, dispenses: 0, administrations: 0, chargesFen: final.chargesFen }
}
