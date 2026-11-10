import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
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
  const result = { ...subject, before, reports, charges }
  await openInpatientReportReaderWorkspace(page, result)
  return result
}

export async function openInpatientReportReaderWorkspace(page: Page, subject: { app: ReportApp; admission: { patientName: string } },
  open = async () => { await page.goto(subject.app.origin + '/inpatient') }) {
  await open()
  await page.getByRole('button', { name: `查看${subject.admission.patientName}`, exact: true }).click()
  await selectInpatientStage(page, '检查检验')
}
