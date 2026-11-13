import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  billingCaseSchema,
  paymentPreviewResponseSchema,
  paymentResponseSchema,
  sessionContextSchema,
} from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { expect } from './fixtures.ts'
import { readDoctorBillingCase, type startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { openOutpatientReportReaderWorkspace } from './outpatient-report-reader.journey.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

type App = Awaited<ReturnType<typeof startInvestigationBillingServer>>
const names = ['常规十二导联心电图', '经胸超声心动图']

export async function signInExaminationRole(page: Page, app: App, role: string) {
  const response = await page.request.post(app.origin + '/api/auth/sign-in/email', {
    headers: { origin: app.origin },
    data: { email: `${role}@demo.clinmesh.local`, password: app.password },
  })
  expect(response.status(), await response.text()).toBe(200)
}

function post(page: Page, app: App, path: string, input: unknown) {
  return page.request.post(app.origin + path, {
    headers: { origin: app.origin, 'idempotency-key': randomUUID() },
    data: { input },
  })
}

async function acknowledgeReports(page: Page, inpatient = false) {
  await page.getByRole('button', { name: inpatient ? '连续阅读住院报告' : '连续阅读报告', exact: true }).click()
  const dialog = page.getByRole('dialog', {
    name: inpatient ? '住院报告阅读与已阅确认' : '报告阅读与已阅确认',
    exact: true,
  })
  await expect(dialog.getByRole('checkbox', { name: /^选择已阅：/ })).toHaveCount(2)
  for (const name of names) {
    const choice = dialog.getByRole('checkbox', { name: `选择已阅：${name}`, exact: true })
    await expect(choice).toBeDisabled()
    await dialog.getByRole('button', { name: `打开报告：${name}`, exact: true }).click()
    await expect(dialog.getByRole('article', { name: '当前报告全文', exact: true })).toContainText(
      name.includes('心电') ? '心室率' : 'LVEF',
    )
    await expect(choice).toBeEnabled()
    await choice.check()
  }
  await dialog.getByRole('button', { name: '核对选中报告', exact: true }).click()
  const review = page.getByRole('dialog', { name: inpatient ? '住院报告已阅核对' : '报告已阅核对', exact: true })
  await expect(review.getByRole('article')).toHaveCount(2)
  await review.getByRole('button', { name: '确认选中报告已阅', exact: true }).click()
  await expect(page.getByRole('region', { name: '报告已阅逐项结果', exact: true })).toContainText('成功 2/2')
  await page.getByRole('button', { name: '关闭阅读窗口', exact: true }).click()
  await expect(dialog).toBeHidden()
}

/** 原申请由真实医生工作区开立；收费仅调用公开收费员HTTP边界。 */
export async function runOutpatientExamination(page: Page, app: App, reopen?: () => Promise<void>) {
  await openWorkspaceTab(page, '检验检查')
  await page.getByRole('tab', { name: /^功能检查/ }).click()
  for (const [index, name] of names.entries()) {
    await page.getByRole('combobox', { name: '功能检查项目', exact: true }).click()
    await page.getByRole('option', { name, exact: true }).click()
    await page.getByLabel('检查指征', { exact: true }).fill('合成胸部不适，评估心电与心脏结构功能。')
    const saved = page.waitForResponse(
      (response) => response.request().method() === 'PUT' && response.url().endsWith('/examination-request/draft'),
    )
    await page.getByRole('button', { name: '保存功能检查草稿', exact: true }).click()
    expect((await saved).status()).toBe(200)
    if (index === 0) {
      const deletions: string[] = []
      const record = (request: { method(): string; url(): string }) => {
        if (request.method() === 'DELETE' && request.url().endsWith('/examination-request/draft'))
          deletions.push(request.url())
      }
      page.on('request', record)
      try {
        await page.getByRole('button', { name: '删除草稿', exact: true }).click()
        const review = page.getByRole('dialog', { name: '删除功能检查草稿', exact: true })
        await expect(review).toContainText(name)
        await expect(review).toContainText('合成胸部不适，评估心电与心脏结构功能。')
        await review.getByRole('button', { name: '保留草稿', exact: true }).click()
        expect(deletions).toEqual([])
        await page.getByRole('button', { name: '删除草稿', exact: true }).click()
        const deleted = page.waitForResponse(
          (response) =>
            response.request().method() === 'DELETE' && response.url().endsWith('/examination-request/draft'),
        )
        await review.getByRole('button', { name: '确认删除草稿', exact: true }).click()
        expect((await deleted).status()).toBe(200)
        expect(deletions).toHaveLength(1)
        await expect(review).toBeHidden()
        const savedAgain = page.waitForResponse(
          (response) => response.request().method() === 'PUT' && response.url().endsWith('/examination-request/draft'),
        )
        await page.getByRole('button', { name: '保存功能检查草稿', exact: true }).click()
        expect((await savedAgain).status()).toBe(200)
      } finally {
        page.off('request', record)
      }
    }
    const issued = page.waitForResponse((response) => response.url().endsWith('/examination-request/actions/issue'))
    await page.getByRole('button', { name: '开立功能检查', exact: true }).click()
    expect((await issued).status()).toBe(200)
    await expect(page.getByText('暂无功能检查草稿', { exact: true })).toBeVisible()
  }
  const issued = await readDoctorBillingCase(page, app)
  expect(issued.examinationRequests?.requests).toHaveLength(2)
  expect(
    issued.examinationRequests?.requests.every(
      (request) => request.status === 'issued' && request.report === undefined,
    ),
  ).toBe(true)
  await signInExaminationRole(page, app, 'cashier')
  const bill = billingCaseSchema.parse(
    await (await page.request.get(`${app.origin}/api/his/v1/billing/cases/${app.caseId}`)).json(),
  )
  for (const charge of bill.charges.filter((charge) => charge.category === 'examination')) {
    const expectedVersions = { [`ChargeItem/${charge.chargeItemId}`]: String(charge.chargeVersion) }
    const previewResponse = await page.request.post(app.origin + '/api/his/v1/payments/actions/preview', {
      headers: { origin: app.origin, 'idempotency-key': randomUUID() },
      data: {
        expectedVersions,
        input: {
          caseId: app.caseId,
          category: 'examination',
          chargeItemId: charge.chargeItemId,
          simulatorRule: 'success',
        },
      },
    })
    expect(previewResponse.status(), await previewResponse.text()).toBe(200)
    const preview = paymentPreviewResponseSchema.parse(await previewResponse.json()).data
    const confirmed = await page.request.post(
      `${app.origin}/api/his/v1/payments/${preview.previewId}/actions/confirm`,
      {
        headers: { origin: app.origin, 'idempotency-key': randomUUID() },
        data: { expectedVersions, input: { commitToken: preview.commitToken } },
      },
    )
    expect(confirmed.status(), await confirmed.text()).toBe(200)
    expect(paymentResponseSchema.parse(await confirmed.json()).data.outcome).toBe('success')
  }
  await drainExaminations(app)
  await signInExaminationRole(page, app, 'doctor')
  const before = await readDoctorBillingCase(page, app)
  for (const request of before.examinationRequests?.requests ?? [])
    expect(request, JSON.stringify(request.generationError)).toMatchObject({
      status: 'reported',
      report: expect.any(Object),
    })
  await openOutpatientReportReaderWorkspace(
    page,
    { app, before },
    reopen ??
      (async () => {
        await page.reload()
      }),
  )
  await page.getByRole('tab', { name: /^功能检查/ }).click()
  await acknowledgeReports(page)
  expect(
    (await readDoctorBillingCase(page, app)).examinationRequests?.requests.every(
      (request) => request.status === 'acknowledged',
    ),
  ).toBe(true)
  return before
}

async function drainExaminations(app: App) {
  for (let index = 0; index < 20; index++) {
    if (
      (await app.runtime.dispatcher.dispatchOnce({
        kinds: ['examination.accept-request', 'examination.start-request', 'examination.report-request'],
      })) === undefined
    )
      return
  }
  throw new Error('Controlled examination reports exceeded their bounded setup')
}

/** 公开岗位接诊同一来源患者，医生开立、护士集中送检、医生连续阅读均使用真实UI。 */
export async function runInpatientExamination(
  page: Page,
  app: App,
  open = async () => {
    await page.goto(app.origin + '/inpatient')
  },
) {
  const outpatient = await readDoctorBillingCase(page, app)
  await signInExaminationRole(page, app, 'registrar')
  const patient = fhirResourceSchema.parse(
    await (await page.request.get(`${app.origin}/fhir/R5/Patient/${outpatient.patient.id}`)).json(),
  )
  const context = sessionContextSchema.parse(await (await page.request.get(app.origin + '/api/auth/context')).json())
  const registeredResponse = await post(page, app, '/api/his/v1/inpatient/admissions', {
    expectedEpoch: context.actor.epoch,
    patientId: patient.id,
    patientVersion: patient.meta!.versionId,
    admissionRoute: 'direct',
    wardId: 'ward-general',
    depositFen: 100000,
  })
  expect(registeredResponse.status(), await registeredResponse.text()).toBe(200)
  const registered = inpatientCommandResponseSchema.parse(await registeredResponse.json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${registered.id}`
  await signInExaminationRole(page, app, 'ward-nurse')
  const received = await post(page, app, path + '/receive', {
    encounterVersion: registered.versionId,
    bedId: 'bed-general-1',
  })
  expect(received.status(), await received.text()).toBe(200)
  const admission = inpatientCommandResponseSchema.parse(await received.json()).data.admission
  await signInExaminationRole(page, app, 'inpatient-doctor')
  const workspace = async (nurse = false) => {
    await open()
    await page
      .getByRole('button', {
        name: nurse ? `1床 ${admission.patientName}` : `查看${admission.patientName}`,
        exact: true,
      })
      .click()
    await selectInpatientStage(page, '检查检验')
  }
  await workspace()
  await page.getByRole('button', { name: '开立住院检查', exact: true }).click()
  const composer = page.getByRole('dialog', { name: '开立住院检查', exact: true })
  await composer.getByRole('button', { name: '功能检查', exact: true }).click()
  for (const name of names) await composer.getByRole('button', { name: `选择${name}`, exact: true }).click()
  for (const input of await composer.getByRole('textbox', { name: '检查指征', exact: true }).all())
    await input.fill('住院心功能评估')
  await composer.getByRole('button', { name: '开立所选功能检查（2）', exact: true }).click()
  await expect(composer.getByText('已成功开立 2 项', { exact: true })).toBeVisible()
  await composer.getByRole('button', { name: '关闭', exact: true }).click()
  await signInExaminationRole(page, app, 'ward-nurse')
  await workspace(true)
  const dispatch = page.getByRole('region', { name: '集中送检', exact: true })
  await expect(dispatch.getByRole('checkbox', { name: /^选择送检：/ })).toHaveCount(2)
  await dispatch.getByRole('button', { name: '全选本页可送检申请', exact: true }).click()
  await page.getByRole('button', { name: '集中送检', exact: true }).click()
  await page
    .getByRole('dialog', { name: '集中送检核对', exact: true })
    .getByRole('button', { name: '确认送检', exact: true })
    .click()
  await expect(page.getByRole('region', { name: '送检逐项结果', exact: true })).toContainText('成功 2/2')
  await drainExaminations(app)
  await signInExaminationRole(page, app, 'cashier')
  const charges = inpatientChargesSchema.parse(
    await (await page.request.get(app.origin + path + '/charges')).json(),
  ).charges
  expect(
    charges.filter((charge) => charge.kind === 'examination').reduce((sum, charge) => sum + charge.amountFen, 0),
  ).toBe(21000)
  await signInExaminationRole(page, app, 'inpatient-doctor')
  await workspace()
  await acknowledgeReports(page, true)
  const after = inpatientInvestigationsSchema.parse(
    await (await page.request.get(app.origin + path + '/investigations')).json(),
  )
  expect(after.examinationRequests).toHaveLength(2)
  expect(after.examinationRequests.every((request) => request.status === 'acknowledged')).toBe(true)
  return admission
}
