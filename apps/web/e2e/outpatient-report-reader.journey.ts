import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { billingCaseSchema, paymentPreviewResponseSchema, paymentResponseSchema } from '@clinmesh/contracts/his'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { expect } from './fixtures.ts'
import { issueDoctorLaboratoryRequest, openDoctorFirstVisit, readDoctorBillingCase, type startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

type ReportApp = Awaited<ReturnType<typeof startInvestigationBillingServer>>
const laboratoryItems = [
  { query: '白细胞', name: '合成白细胞计数', code: '0100101A' },
  { query: '血红蛋白', name: '合成血红蛋白', code: '0100501A' },
  { query: '血常规', name: '合成血常规（白细胞计数与血红蛋白联合检查）', code: 'CN-LAB-CBC', priceYuan: '25.00' },
]

async function signIn(page: Page, app: ReportApp, role: string) {
  expect((await page.request.post(app.origin + '/api/auth/sign-in/email', {
    headers: { origin: app.origin }, data: { email: `${role}@demo.clinmesh.local`, password: app.password },
  })).status()).toBe(200)
}

/** 真实医生开三申请，收费员公开缴清原费用，再由原outbox签发报告；不提前写已阅。 */
export async function prepareOutpatientReportReader(page: Page, app: ReportApp) {
  await openDoctorFirstVisit(page, app)
  const items: Array<{ name: string; requestId: string }> = []
  for (const item of laboratoryItems) items.push({ name: item.name, requestId: await issueDoctorLaboratoryRequest(page, item) })
  const issued = await readDoctorBillingCase(page, app)
  expect(issued.laboratoryRequests?.requests.every(request => request.status === 'issued' && request.report === undefined)).toBe(true)
  await signIn(page, app, 'cashier')
  const billResponse = await page.request.get(`${app.origin}/api/his/v1/billing/cases/${app.caseId}`)
  expect(billResponse.status()).toBe(200)
  const bill = billingCaseSchema.parse(await billResponse.json())
  for (const item of items) {
    const charge = bill.charges.find(charge => charge.requestId === item.requestId)
    if (!charge) throw new Error(`Missing original charge for ${item.name}`)
    const expectedVersions = { [`ChargeItem/${charge.chargeItemId}`]: String(charge.chargeVersion) }
    const headers = { origin: app.origin, 'idempotency-key': randomUUID() }
    const previewResponse = await page.request.post(`${app.origin}/api/his/v1/payments/actions/preview`, { headers,
      data: { expectedVersions, input: { caseId: app.caseId, category: 'laboratory', chargeItemId: charge.chargeItemId, simulatorRule: 'success' } } })
    expect(previewResponse.status(), await previewResponse.text()).toBe(200)
    const preview = paymentPreviewResponseSchema.parse(await previewResponse.json()).data
    const confirmed = await page.request.post(`${app.origin}/api/his/v1/payments/${preview.previewId}/actions/confirm`, {
      headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { expectedVersions, input: { commitToken: preview.commitToken } },
    })
    expect(confirmed.status(), await confirmed.text()).toBe(200)
    expect(paymentResponseSchema.parse(await confirmed.json()).data.outcome).toBe('success')
  }
  const kinds = ['laboratory.accept-request', 'laboratory.start-request', 'laboratory.report-request']
  for (let index = 0; index < 20; index++) {
    if (await app.runtime.dispatcher.dispatchOnce({ kinds }) === undefined) break
    if (index === 19) throw new Error('Synthetic report generation exceeded its bounded setup')
  }
  await signIn(page, app, 'doctor')
  const before = await readDoctorBillingCase(page, app)
  expect(before.laboratoryRequests?.requests).toHaveLength(3)
  const reports = []
  for (const item of items) {
    const request = before.laboratoryRequests?.requests.find(request => request.id === item.requestId)
    expect(request, JSON.stringify(request?.generationError)).toMatchObject({ status: 'reported', billing: { status: 'paid', remainingFen: 0 } })
    if (!request?.report) throw new Error(`Missing signed report for ${item.name}`)
    expect(request.report.acknowledgement).toBeUndefined()
    const report = fhirResourceSchema.parse(await (await page.request.get(`${app.origin}/fhir/R5/DiagnosticReport/${request.report.diagnosticReportId}`)).json())
    reports.push({ ...item, diagnosticReportId: request.report.diagnosticReportId, version: request.report.diagnosticReportVersion,
      requestVersion: request.version, fhirVersion: report.meta?.versionId })
  }
  expect(new Set(reports.map(report => report.diagnosticReportId)).size).toBe(3)
  await openOutpatientReportReaderWorkspace(page, { app, before }, async () => { await page.reload() })
  return { app, before, reports }
}

export async function openOutpatientReportReaderWorkspace(page: Page, subject: { app: ReportApp; before: Awaited<ReturnType<typeof readDoctorBillingCase>> },
  open = async () => { await page.goto(subject.app.origin + '/consultation') }) {
  await open()
  const queue = page.getByRole('button', { name: /^候诊队列 ·/ })
  if (await queue.isVisible()) await queue.click()
  await page.getByRole('tab', { name: '在诊', exact: true }).click()
  await page.getByRole('button', { name: `选择病例 ${subject.before.patient.name}`, exact: true }).click()
  await openWorkspaceTab(page, '检验检查')
}
