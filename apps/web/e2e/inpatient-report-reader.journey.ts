import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { inpatientChargesSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { expect } from './fixtures.ts'
import { prepareInpatientInvestigationActions } from './investigation-actions-batch.journey.ts'
import type { startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

type ReportApp = Awaited<ReturnType<typeof startInvestigationBillingServer>>
async function signIn(page: Page, app: ReportApp, role: string) {
  expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, { headers: { origin: app.origin },
    data: { email: `${role}@demo.clinmesh.local`, password: app.password } })).status()).toBe(200)
}
function post(page: Page, app: ReportApp, path: string, input: unknown) {
  return page.request.post(app.origin + path, { headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { input } })
}

/** 公开岗位开三份独立申请、护士送检、原dispatcher签发；不提前确认已阅。 */
export async function prepareInpatientReportReader(page: Page, app: ReportApp) {
  const subject = await prepareInpatientInvestigationActions(page, app)
  const catalogResponse = await page.request.get(app.origin + '/api/his/v1/inpatient/investigation-catalog')
  expect(catalogResponse.status()).toBe(200)
  const catalog = inpatientInvestigationCatalogSchema.parse(await catalogResponse.json())
  const cbc = catalog.items.find(item => item.kind === 'laboratory' && item.display === '合成血常规（白细胞计数与血红蛋白联合检查）')
  if (!cbc) throw new Error('Missing the synthetic CBC catalog item')
  expect(cbc.available).toBe(true)
  const clinicalResponse = await page.request.get(app.origin + subject.path + '/clinical')
  expect(clinicalResponse.status()).toBe(200)
  const clinical = inpatientFullClinicalSchema.parse(await clinicalResponse.json())
  const issued = await post(page, app, subject.path + '/investigations/issue', { encounterVersion: clinical.encounterVersion,
    catalogVersion: cbc.version, selection: { kind: 'laboratory', catalogItemId: cbc.id, indicationCode: cbc.indicationCodes[0] } })
  expect(issued.status(), await issued.text()).toBe(200)
  const requests = inpatientInvestigationResponseSchema.parse(await issued.json()).data.laboratoryRequests
  expect(requests).toHaveLength(3)
  expect(requests.every(request => request.status === 'issued' && request.report === undefined)).toBe(true)
  await signIn(page, app, 'ward-nurse')
  for (const request of requests) {
    const response = await post(page, app, subject.path + '/investigations/send', { requestId: request.id, expectedRequestVersion: request.version,
      serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion })
    expect(response.status(), await response.text()).toBe(200)
    inpatientInvestigationResponseSchema.parse(await response.json())
  }
  const kinds = ['laboratory.accept-request', 'laboratory.start-request', 'laboratory.report-request']
  for (let count = 0; count < 20; count++) {
    if (await app.runtime.dispatcher.dispatchOnce({ kinds }) === undefined) break
    if (count === 19) throw new Error('Synthetic report generation exceeded its bounded setup')
  }
  await signIn(page, app, 'inpatient-doctor')
  const beforeResponse = await page.request.get(app.origin + subject.path + '/investigations')
  expect(beforeResponse.status()).toBe(200)
  const before = inpatientInvestigationsSchema.parse(await beforeResponse.json())
  expect(before.sent).toHaveLength(3)
  const reports = []
  for (const request of before.laboratoryRequests) {
    expect(request, JSON.stringify(request.generationError)).toMatchObject({ status: 'reported' })
    if (!request.report) throw new Error('Missing an original signed laboratory report')
    expect(request.report.acknowledgement).toBeUndefined()
    const response = await page.request.get(`${app.origin}/fhir/R5/DiagnosticReport/${request.report.diagnosticReportId}`)
    expect(response.status()).toBe(200)
    const report = fhirResourceSchema.parse(await response.json())
    reports.push({ name: request.laboratoryService?.nameZh ?? request.referenceConcept?.display ?? request.catalogItemId, requestId: request.id,
      diagnosticReportId: request.report.diagnosticReportId, reportVersion: request.report.diagnosticReportVersion, requestVersion: request.version,
      serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion, fhirVersion: report.meta?.versionId })
  }
  expect(new Set(reports.map(report => report.diagnosticReportId)).size).toBe(3)
  await signIn(page, app, 'cashier')
  const chargesResponse = await page.request.get(app.origin + subject.path + '/charges')
  expect(chargesResponse.status()).toBe(200)
  const charges = inpatientChargesSchema.parse(await chargesResponse.json()).charges
  expect(charges).toHaveLength(3)
  expect(charges.reduce((sum, charge) => sum + charge.amountFen, 0)).toBe(4100)
  await signIn(page, app, 'inpatient-doctor')
  const context = sessionContextSchema.parse(await (await page.request.get(app.origin + '/api/auth/context')).json())
  const clinicalBefore = inpatientFullClinicalSchema.parse(await (await page.request.get(app.origin + subject.path + '/clinical')).json())
  const result = { ...subject, before, reports, charges, context, clinicalBefore }
  await openInpatientReportReaderWorkspace(page, result)
  return result
}

export async function openInpatientReportReaderWorkspace(page: Page, subject: { app: ReportApp; admission: { patientName: string } },
  open = async () => { await page.goto(subject.app.origin + '/inpatient') }) {
  await open()
  await page.getByRole('button', { name: `查看${subject.admission.patientName}`, exact: true }).click()
  await selectInpatientStage(page, '检查检验')
}

type ReaderSubject = Awaited<ReturnType<typeof prepareInpatientReportReader>>

/** 真实住院阅读入口可丢弃坏私稿，不触发已阅或回执请求。 */
export async function verifyInpatientReportDiscard(page: Page, subject: ReaderSubject) {
  const key = await page.evaluate(() => {
    const current = Object.keys(sessionStorage).find(item => item.startsWith('clinmesh.inpatient-report-reader:'))
    if (!current) throw new Error('Missing inpatient report list')
    sessionStorage.setItem(current, '{')
    return current
  })
  const requests: string[] = []
  const record = (request: { url(): string; method(): string }) => {
    if (request.url().includes('/investigations/acknowledge') || request.url().includes('/command-receipts?')) requests.push(request.method())
  }
  page.on('request', record)
  try {
    await page.reload()
    await openInpatientReportReaderWorkspace(page, subject, async () => {})
    await page.getByRole('button', { name: '连续阅读住院报告', exact: true }).click()
    const reader = page.getByRole('dialog', { name: '住院报告阅读与已阅确认', exact: true })
    await expect(reader.getByText('待确认清单存储不可用', { exact: true })).toBeVisible()
    await reader.getByRole('button', { name: '丢弃已阅清单', exact: true }).click()
    await reader.getByRole('button', { name: '确认丢弃', exact: true }).click()
    await expect(reader.getByText('待确认清单存储不可用', { exact: true })).toBeHidden()
    await expect(reader.getByRole('region', { name: '报告完整待确认清单', exact: true }).getByRole('checkbox')).toHaveCount(0)
    expect(await page.evaluate(item => sessionStorage.getItem(item), key)).toBeNull()
    expect(requests).toEqual([])
  } finally { page.off('request', record) }
}

/** 同次住院经原开立、护士送检和合成dispatcher取得一份真实影像报告。 */
export async function addInpatientImageReport(page: Page, subject: ReaderSubject) {
  const { app, path } = subject
  const catalog = inpatientInvestigationCatalogSchema.parse(await (await page.request.get(app.origin + '/api/his/v1/inpatient/investigation-catalog')).json())
  const service = catalog.items.find(item => item.kind === 'imaging' && item.id === 'imaging-chest-radiograph')
  if (!service) throw new Error('Missing synthetic inpatient radiograph catalog item')
  const clinical = inpatientFullClinicalSchema.parse(await (await page.request.get(app.origin + path + '/clinical')).json())
  const response = await post(page, app, path + '/investigations/issue', { encounterVersion: clinical.encounterVersion, catalogVersion: service.version,
    selection: { kind: 'imaging', serviceId: service.id, indication: '合成住院报告实际首帧门禁验证' } })
  expect(response.status(), await response.text()).toBe(200)
  const request = inpatientInvestigationResponseSchema.parse(await response.json()).data.imagingRequests[0]!
  await signIn(page, app, 'ward-nurse')
  const sent = await post(page, app, path + '/investigations/send', { requestId: request.id, expectedRequestVersion: request.version,
    serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion })
  expect(sent.status(), await sent.text()).toBe(200)
  const kinds = ['imaging.accept-request', 'imaging.start-request', 'imaging.report-request']
  for (let count = 0; count < 10; count++) {
    if (await app.runtime.dispatcher.dispatchOnce({ kinds }) === undefined) break
    if (count === 9) throw new Error('Synthetic imaging report exceeded its bounded setup')
  }
  await signIn(page, app, 'inpatient-doctor')
  const facts = inpatientInvestigationsSchema.parse(await (await page.request.get(app.origin + path + '/investigations')).json())
  const report = facts.imagingRequests.find(item => item.id === request.id)!
  expect(report, JSON.stringify(report.generationError)).toMatchObject({ status: 'reported' })
  expect(report.report?.acknowledgement).toBeUndefined()
  if (!report.report) throw new Error('Missing the original synthetic inpatient image report')
  return { request: report, name: report.service.name, facts }
}

/** 第二份真实提交后丢响应；刷新仅恢复原回执，余项需重读并独立确认。 */
export async function runInpatientReportReaderJourney(page: Page, subject: ReaderSubject, step = async (_caption: string) => {}) {
  const attempts: Array<{ requestId: string; reportId: string; key: string }> = []
  await page.route(/\/(?:api|clinmesh-api)\/his\/v1\/inpatient\/admissions\/[^/]+\/investigations\/acknowledge$/, async route => {
    const request = route.request(), body = request.postDataJSON(), report = subject.reports.find(item => item.requestId === body.input.requestId)
    if (!report) throw new Error('Acknowledgement must belong to an original inpatient report')
    expect(new URL(request.url()).pathname.replace('/clinmesh-api/', '/api/')).toBe(subject.path + '/investigations/acknowledge')
    expect(body).toEqual({ input: { requestId: report.requestId, expectedRequestVersion: report.requestVersion,
      serviceRequestVersion: report.serviceRequestVersion, taskVersion: report.taskVersion,
      diagnosticReportId: report.diagnosticReportId, diagnosticReportVersion: report.reportVersion } })
    attempts.push({ requestId: report.requestId, reportId: report.diagnosticReportId, key: request.headers()['idempotency-key']! })
    const response = await route.fetch({ url: request.url().replace('/clinmesh-api/', '/api/') })
    expect(response.status()).toBe(200)
    const proof = inpatientInvestigationResponseSchema.parse(await response.json()).data
    expect(proof.admissionId).toBe(subject.admission.id)
    expect(proof.laboratoryRequests.find(item => item.id === report.requestId)).toMatchObject({ status: 'acknowledged',
      version: report.requestVersion + 1, serviceRequestVersion: report.serviceRequestVersion, taskVersion: report.taskVersion,
      report: { diagnosticReportId: report.diagnosticReportId, diagnosticReportVersion: report.reportVersion,
        acknowledgement: { acknowledgedBy: subject.context.actor.practitionerId } } })
    if (attempts.length === 2) await route.abort('failed')
    else await route.fulfill({ response })
  })
  const trigger = page.getByRole('button', { name: '连续阅读住院报告', exact: true })
  const reader = page.getByRole('dialog', { name: '住院报告阅读与已阅确认', exact: true })
  const review = page.getByRole('dialog', { name: '住院报告已阅核对', exact: true })
  const pending = reader.getByRole('region', { name: '报告完整待确认清单', exact: true })
  const choices = reader.getByRole('checkbox', { name: /^选择已阅：/ })
  const readReports = async (describe = false) => {
    for (const report of subject.reports) {
      await reader.getByRole('button', { name: `打开报告：${report.name}`, exact: true }).click()
      const full = reader.getByRole('article', { name: '当前报告全文', exact: true })
      await expect(full.getByRole('table')).toBeVisible()
      await expect(full.getByText(report.name, { exact: true }).first()).toBeVisible()
      const original = subject.before.laboratoryRequests.find(item => item.id === report.requestId)!
      for (const result of original.report!.results) await expect(full.getByRole('table')).toContainText(String(result.value))
      await expect(reader.getByRole('checkbox', { name: `选择已阅：${report.name}`, exact: true })).toBeEnabled()
      if (describe) await step(`连续查看：${report.name}；原签发全文显示后才允许选择已阅`)
    }
  }
  await trigger.click()
  await expect(choices).toHaveCount(3)
  for (const choice of await choices.all()) await expect(choice).toBeDisabled()
  await reader.getByRole('button', { name: '全选本页可确认报告', exact: true }).click()
  await expect(pending.getByRole('checkbox')).toHaveCount(0)
  await step('进入同一住院报告窗口；未打开不能选择，阅读不会自动确认已阅')
  await readReports(true)
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
  await step('关闭后保留明确选择，但阅读资格已清除；必须重新打开三份报告')
  await readReports()
  await reader.getByRole('button', { name: '核对选中报告', exact: true }).click()
  await expect(review.getByRole('article')).toHaveCount(3)
  await step('核对三份原报告及签发版本，最后明确确认才逐项发送已阅')
  await review.getByRole('button', { name: '确认选中报告已阅', exact: true }).click()
  await expect(reader.getByRole('button', { name: '恢复原已阅', exact: true })).toBeEnabled()
  expect(attempts).toHaveLength(2)
  const interrupted = inpatientInvestigationsSchema.parse(await (await page.request.get(subject.app.origin + subject.path + '/investigations')).json())
  expect(interrupted.laboratoryRequests.filter(item => item.status === 'acknowledged')).toHaveLength(2)
  await step('第一份成功，第二份已提交但响应丢失；第三份停止，等待查明原结果')
  await page.reload()
  await openInpatientReportReaderWorkspace(page, subject, async () => {})
  await trigger.click()
  await expect(reader.getByRole('button', { name: '核对选中报告', exact: true })).toBeDisabled()
  const recoveryRequest = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await reader.getByRole('button', { name: '恢复原已阅', exact: true }).click()
  const lookup = new URL((await recoveryRequest).url())
  expect(lookup.searchParams.get('operationId')).toBe('inpatient.investigation.acknowledge')
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
  await step('刷新后只查询原回执，前两份不重复确认；余下一份仍须重新阅读')
  await reader.getByRole('button', { name: `打开报告：${remaining.name}`, exact: true }).click()
  await expect(remainingChoice).toBeEnabled()
  await reader.getByRole('button', { name: '核对选中报告', exact: true }).click()
  await expect(review.getByRole('article')).toHaveCount(1)
  await review.getByRole('button', { name: '确认选中报告已阅', exact: true }).click()
  await expect(outcomes.getByRole('status')).toHaveText('本次办理已结束 · 成功 1/1')
  expect(attempts).toHaveLength(3)
  expect(new Set(attempts.map(item => item.key)).size).toBe(3)
  const after = inpatientInvestigationsSchema.parse(await (await page.request.get(subject.app.origin + subject.path + '/investigations')).json())
  expect(after.laboratoryRequests).toHaveLength(3)
  expect(new Set(after.laboratoryRequests.map(item => item.report?.acknowledgement?.id)).size).toBe(3)
  expect(after.sent).toEqual(subject.before.sent)
  const clinicalAfter = inpatientFullClinicalSchema.parse(await (await page.request.get(subject.app.origin + subject.path + '/clinical')).json())
  expect(clinicalAfter).toEqual(subject.clinicalBefore)
  for (const report of subject.reports) {
    const request = after.laboratoryRequests.find(item => item.id === report.requestId)!, original = subject.before.laboratoryRequests.find(item => item.id === report.requestId)!
    expect(request).toMatchObject({ status: 'acknowledged', version: report.requestVersion + 1,
      serviceRequestId: original.serviceRequestId, serviceRequestVersion: report.serviceRequestVersion,
      taskId: original.taskId, taskVersion: report.taskVersion,
      report: { diagnosticReportId: report.diagnosticReportId, diagnosticReportVersion: report.reportVersion, status: 'final',
        acknowledgement: { acknowledgedBy: subject.context.actor.practitionerId } } })
    expect(request.report!.acknowledgement!.id).toBeTruthy()
    expect(request.report!.acknowledgement!.acknowledgedAt).toBeTruthy()
    expect({ ...request.report, acknowledgement: undefined }).toEqual({ ...original.report, acknowledgement: undefined })
    const response = await page.request.get(`${subject.app.origin}/fhir/R5/DiagnosticReport/${report.diagnosticReportId}`)
    expect(response.status()).toBe(200)
    expect(fhirResourceSchema.parse(await response.json()).meta?.versionId).toBe(report.fhirVersion)
  }
  await signIn(page, subject.app, 'cashier')
  expect(inpatientChargesSchema.parse(await (await page.request.get(subject.app.origin + subject.path + '/charges')).json()).charges).toEqual(subject.charges)
  await signIn(page, subject.app, 'inpatient-doctor')
  await step('三份住院报告已逐项确认；原报告、送检记录及三笔合计41元费用均保持不变')
  return { posts: attempts.length, independentKeys: attempts.map(item => item.key), reportIds: subject.reports.map(item => item.diagnosticReportId),
    acknowledgements: after.laboratoryRequests.map(item => item.report!.acknowledgement!.id), originalChargesFen: subject.charges.reduce((sum, charge) => sum + charge.amountFen, 0) }
}
