import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientChargesSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { expect } from './fixtures.ts'
import { openDoctorFirstVisit, readDoctorBillingCase, startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

export type InvestigationActionsApp = Awaited<ReturnType<typeof startInvestigationBillingServer>>

async function signIn(page: Page, app: InvestigationActionsApp, role: string) {
  expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin }, data: { email: `${role}@demo.clinmesh.local`, password: app.password },
  })).status()).toBe(200)
}

function post(page: Page, app: InvestigationActionsApp, path: string, input: unknown) {
  return page.request.post(app.origin + path, { headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { input } })
}

/** 通过公开岗位创建两项待送检，保留真实来源、目录和就诊边界。 */
export async function prepareInpatientInvestigationActions(page: Page, app: InvestigationActionsApp) {
  await openDoctorFirstVisit(page, app)
  const outpatient = await readDoctorBillingCase(page, app)
  await signIn(page, app, 'registrar')
  const patient = fhirResourceSchema.parse(await (await page.request.get(`${app.origin}/fhir/R5/Patient/${outpatient.patient.id}`)).json())
  const context = sessionContextSchema.parse(await (await page.request.get(`${app.origin}/api/auth/context`)).json())
  const registered = inpatientCommandResponseSchema.parse(await (await post(page, app, '/api/his/v1/inpatient/admissions', {
    expectedEpoch: context.actor.epoch, patientId: patient.id, patientVersion: patient.meta!.versionId,
    admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000,
  })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${registered.id}`
  await signIn(page, app, 'ward-nurse')
  const admission = inpatientCommandResponseSchema.parse(await (await post(page, app, `${path}/receive`, {
    encounterVersion: registered.versionId, bedId: 'bed-general-1',
  })).json()).data.admission
  await signIn(page, app, 'inpatient-doctor')
  const catalog = inpatientInvestigationCatalogSchema.parse(await (await page.request.get(`${app.origin}/api/his/v1/inpatient/investigation-catalog`)).json())
  for (const name of ['合成白细胞计数', '合成血红蛋白']) {
    const selected = catalog.items.find(item => item.kind === 'laboratory' && item.display === name)
    if (!selected || selected.kind !== 'laboratory') throw new Error(`Missing the synthetic inpatient catalog item: ${name}`)
    const clinical = inpatientFullClinicalSchema.parse(await (await page.request.get(app.origin + path + '/clinical')).json())
    const issued = await post(page, app, `${path}/investigations/issue`, {
      encounterVersion: clinical.encounterVersion, catalogVersion: selected.version,
      selection: { kind: 'laboratory', catalogItemId: selected.id, indicationCode: selected.indicationCodes[0] },
    })
    expect(issued.status(), await issued.text()).toBe(200)
    inpatientInvestigationResponseSchema.parse(await issued.json())
  }
  const before = inpatientInvestigationsSchema.parse(await (await page.request.get(app.origin + path + '/investigations')).json())
  expect(before.laboratoryRequests).toHaveLength(2)
  expect(before.laboratoryRequests.every(request => request.status === 'issued')).toBe(true)
  return { app, path, admission, before }
}

export type InpatientInvestigationActionsPatient = Awaited<ReturnType<typeof prepareInpatientInvestigationActions>>

/** 回读始终使用传入的真实操作页面会话，录像时也不借用准备上下文。 */
export async function runInpatientInvestigationCancelJourney(page: Page, subject: InpatientInvestigationActionsPatient,
  open = async () => { await page.goto(subject.app.origin + '/inpatient') },
  step = async (_caption: string) => {}) {
  await open()
  await page.getByRole('button', { name: `查看${subject.admission.patientName}`, exact: true }).click()
  await selectInpatientStage(page, '检查检验')
  const batch = page.getByRole('region', { name: '检查申请集中办理', exact: true })
  const choices = batch.getByRole('checkbox', { name: /^选择取消申请：/ })
  await expect(choices).toHaveCount(2)
  await batch.getByRole('button', { name: '全选本页可取消申请', exact: true }).click()
  await step('住院医生集中选择同患者两项待送检申请，核对状态与指征')
  const keys: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `${subject.path}/investigations/cancel`) keys.push(request.headers()['idempotency-key']!)
  })
  await page.getByRole('button', { name: '集中取消申请', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '集中取消检查申请', exact: true })
  await expect(dialog.getByRole('article')).toHaveCount(2)
  await expect(dialog).toContainText('合成白细胞计数')
  await expect(dialog).toContainText('合成血红蛋白')
  await expect(dialog).toContainText('不撤销已有记录或自动退款')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(keys).toEqual([])
  await page.getByRole('button', { name: '集中取消申请', exact: true }).click()
  await step('逐项核对后明确取消；取消申请保留既有记录，不自动退款')
  await dialog.getByRole('button', { name: '确认取消申请', exact: true }).click()
  const outcomes = page.getByRole('region', { name: '取消申请逐项结果', exact: true })
  await expect(outcomes.getByRole('heading', { name: '成功 2/2', exact: true })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /^已完成取消申请$/ })).toBeVisible()
  expect(keys).toHaveLength(2)
  expect(new Set(keys).size).toBe(2)
  const after = inpatientInvestigationsSchema.parse(await (await page.request.get(subject.app.origin + subject.path + '/investigations')).json())
  expect(after.laboratoryRequests.map(request => request.id).sort()).toEqual(subject.before.laboratoryRequests.map(request => request.id).sort())
  expect(after.laboratoryRequests.every(request => request.status === 'cancelled' && request.report === undefined)).toBe(true)
  expect(after.sent).toEqual([])
  await signIn(page, subject.app, 'cashier')
  const charges = inpatientChargesSchema.parse(await (await page.request.get(subject.app.origin + subject.path + '/charges')).json())
  expect(charges.charges).toEqual([])
  await signIn(page, subject.app, 'inpatient-doctor')
  await step('两项申请分别取消成功，原申请保留；没有送检、报告或新增费用')
  return { posts: keys.length, keys, requestIds: after.laboratoryRequests.map(request => request.id), cancelled: after.laboratoryRequests.length, charges: charges.charges.length }
}
