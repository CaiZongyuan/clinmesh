import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { billingCaseSchema, paymentPreviewResponseSchema, paymentResponseSchema } from '@clinmesh/contracts/his'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
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

type ReaderSubject = Awaited<ReturnType<typeof prepareOutpatientReportReader>>

/** 阅读不写入；第二份真实提交后丢响应，余项刷新后必须重新阅读并明确确认。 */
export async function runOutpatientReportReaderJourney(page: Page, subject: ReaderSubject, step = async (_caption: string) => {}) {
  const attempts: Array<{ requestId: string; reportId: string; key: string }> = []
  await page.route(/\/(?:api|clinmesh-api)\/his\/v1\/laboratory-requests\/[^/]+\/reports\/[^/]+\/actions\/acknowledge$/, async route => {
    const request = route.request(), parts = new URL(request.url()).pathname.split('/')
    const requestId = parts.at(-5)!, reportId = parts.at(-3)!, report = subject.reports.find(item => item.requestId === requestId)
    if (!report) throw new Error('Acknowledgement must belong to an original report')
    expect(reportId).toBe(report.diagnosticReportId)
    expect(request.postDataJSON()).toEqual({ expectedVersions: { [`DiagnosticReport/${reportId}`]: report.version }, input: { expectedRequestVersion: report.requestVersion } })
    attempts.push({ requestId, reportId, key: request.headers()['idempotency-key']! })
    const response = await route.fetch({ url: request.url().replace('/clinmesh-api/', '/api/') })
    expect(response.status()).toBe(200)
    if (attempts.length === 2) await route.abort('failed')
    else await route.fulfill({ response })
  })
  const trigger = page.getByRole('button', { name: '连续阅读报告', exact: true })
  const reader = page.getByRole('dialog', { name: '报告阅读与已阅确认', exact: true })
  const review = page.getByRole('dialog', { name: '报告已阅核对', exact: true })
  const pending = reader.getByRole('region', { name: '报告完整待确认清单', exact: true })
  const choices = reader.getByRole('checkbox', { name: /^选择已阅：/ })
  const readReports = async () => {
    for (const report of subject.reports) {
      await reader.getByRole('button', { name: `打开报告：${report.name}`, exact: true }).click()
      const full = reader.getByRole('article', { name: '当前报告全文', exact: true })
      await expect(full.getByRole('table')).toBeVisible()
      await expect(full.getByText(report.name, { exact: true }).first()).toBeVisible()
      await expect(reader.getByRole('checkbox', { name: `选择已阅：${report.name}`, exact: true })).toBeEnabled()
    }
  }
  await trigger.click()
  await expect(choices).toHaveCount(3)
  for (const choice of await choices.all()) await expect(choice).toBeDisabled()
  await reader.getByRole('button', { name: '全选本页可确认报告', exact: true }).click()
  await expect(pending.getByRole('checkbox')).toHaveCount(0)
  await step('进入同一报告窗口；未打开的报告不能选择，打开不会自动确认已阅')
  await readReports()
  await reader.getByRole('button', { name: '全选本页可确认报告', exact: true }).click()
  await expect(pending.getByRole('checkbox')).toHaveCount(3)
  await reader.getByRole('button', { name: '清空已阅选择', exact: true }).click()
  for (const choice of await pending.getByRole('checkbox').all()) await expect(choice).not.toBeChecked()
  await expect(pending.getByRole('checkbox')).toHaveCount(3)
  await reader.getByRole('textbox', { name: '搜索报告', exact: true }).fill('血红蛋白')
  await expect(choices).toHaveCount(2)
  await expect(pending.getByRole('checkbox')).toHaveCount(3)
  await reader.getByRole('textbox', { name: '搜索报告', exact: true }).clear()
  await reader.getByRole('button', { name: '全选本页可确认报告', exact: true }).click()
  await reader.getByRole('button', { name: '核对选中报告', exact: true }).click()
  await expect(review.getByRole('article')).toHaveCount(3)
  await page.keyboard.press('Escape')
  await expect(review).toBeHidden()
  await expect(trigger).toBeFocused()
  expect(attempts).toEqual([])
  await trigger.click()
  for (const choice of await choices.all()) { await expect(choice).toBeChecked(); await expect(choice).toBeDisabled() }
  await expect(pending.getByRole('checkbox')).toHaveCount(3)
  await expect(reader.getByRole('button', { name: '核对选中报告', exact: true })).toBeDisabled()
  await step('关闭后保留明确选择，但本轮阅读资格已清除；必须重新打开三份报告')
  await readReports()
  await reader.getByRole('button', { name: '核对选中报告', exact: true }).click()
  await expect(review.getByRole('article')).toHaveCount(3)
  await step('核对三份报告及签发版本，最后明确确认才逐项发送已阅')
  await review.getByRole('button', { name: '确认选中报告已阅', exact: true }).click()
  await expect(reader.getByRole('button', { name: '恢复原已阅', exact: true })).toBeEnabled()
  expect(attempts).toHaveLength(2)
  expect((await readDoctorBillingCase(page, subject.app)).laboratoryRequests?.requests.filter(item => item.status === 'acknowledged')).toHaveLength(2)
  await step('第一份成功，第二份已提交但响应丢失；第三份停止，等待查明原结果')
  await page.reload()
  await openOutpatientReportReaderWorkspace(page, subject, async () => {})
  await trigger.click()
  await expect(reader.getByRole('button', { name: '核对选中报告', exact: true })).toBeDisabled()
  const recoveryRequest = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await reader.getByRole('button', { name: '恢复原已阅', exact: true }).click()
  const lookup = new URL((await recoveryRequest).url())
  expect(lookup.searchParams.get('operationId')).toBe('laboratory-report.acknowledge')
  expect(lookup.searchParams.get('idempotencyKey')).toBe(attempts[1]!.key)
  const outcomes = reader.getByRole('region', { name: '报告已阅逐项结果', exact: true })
  await expect(outcomes.getByRole('status')).toHaveText('本次办理已结束 · 成功 2/3')
  expect(attempts).toHaveLength(2)
  const receiptResponse = await page.request.get(`${subject.app.origin}/api/his/v1/command-receipts?${lookup.searchParams}`)
  expect(receiptResponse.status()).toBe(200)
  expect(commandReceiptLookupSchema.parse(await receiptResponse.json()).status).toBe('completed')
  const remaining = subject.reports.find(item => !attempts.some(attempt => attempt.requestId === item.requestId))!
  const remainingChoice = reader.getByRole('checkbox', { name: `选择已阅：${remaining.name}`, exact: true })
  await expect(remainingChoice).toBeChecked()
  await expect(remainingChoice).toBeDisabled()
  await expect(reader.getByRole('button', { name: '核对选中报告', exact: true })).toBeDisabled()
  await step('刷新后只查询原回执，前两份不会重复确认；余下一份仍须重新阅读')
  await reader.getByRole('button', { name: `打开报告：${remaining.name}`, exact: true }).click()
  await expect(remainingChoice).toBeEnabled()
  await reader.getByRole('button', { name: '核对选中报告', exact: true }).click()
  await expect(review.getByRole('article')).toHaveCount(1)
  await review.getByRole('button', { name: '确认选中报告已阅', exact: true }).click()
  await expect(outcomes.getByRole('status')).toHaveText('本次办理已结束 · 成功 1/1')
  expect(attempts).toHaveLength(3)
  expect(new Set(attempts.map(item => item.key)).size).toBe(3)
  const after = await readDoctorBillingCase(page, subject.app), requests = after.laboratoryRequests!.requests
  expect(requests).toHaveLength(3)
  expect(new Set(requests.map(item => item.report?.acknowledgement?.id)).size).toBe(3)
  expect(after.diagnosis).toEqual(subject.before.diagnosis)
  expect(after.presentation).toEqual(subject.before.presentation)
  for (const report of subject.reports) {
    const request = requests.find(item => item.id === report.requestId)!, original = subject.before.laboratoryRequests!.requests.find(item => item.id === report.requestId)!
    expect(request).toMatchObject({ status: 'acknowledged', version: report.requestVersion + 1,
      serviceRequestVersion: original.serviceRequestVersion, taskVersion: original.taskVersion, billing: original.billing,
      report: { diagnosticReportId: report.diagnosticReportId, diagnosticReportVersion: report.version, status: 'final' } })
    expect(request.report?.acknowledgement?.id).toBeTruthy()
    const response = await page.request.get(`${subject.app.origin}/fhir/R5/DiagnosticReport/${report.diagnosticReportId}`)
    expect(response.status()).toBe(200)
    expect(fhirResourceSchema.parse(await response.json()).meta?.versionId).toBe(report.fhirVersion)
  }
  await step('三份报告逐项确认完成；没有重复报告、执行、收费、诊断或摘要改写')
  return { posts: attempts.length, independentKeys: attempts.map(item => item.key), reportIds: subject.reports.map(item => item.diagnosticReportId), acknowledgements: requests.map(item => item.report!.acknowledgement!.id) }
}
