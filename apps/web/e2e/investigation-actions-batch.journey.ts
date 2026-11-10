import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientChargesSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { expect } from './fixtures.ts'
import { issueDoctorLaboratoryRequest, openDoctorFirstVisit, readDoctorBillingCase, startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

export type InvestigationActionsApp = Awaited<ReturnType<typeof startInvestigationBillingServer>>

export async function prepareOutpatientInvestigationCancel(page: Page, app: InvestigationActionsApp, count = 2) {
  await openDoctorFirstVisit(page, app)
  const items = [
    { query: '白细胞', name: '合成白细胞计数', code: '0100101A' },
    { query: '血红蛋白', name: '合成血红蛋白', code: '0100501A' },
    { query: '血常规', name: '合成血常规', code: 'CN-LAB-CBC', priceYuan: '25.00' },
  ]
  const requestIds: string[] = []
  for (let i = 0; i < count; i++) requestIds.push(await issueDoctorLaboratoryRequest(page, items[i % items.length]!))
  const before = await readDoctorBillingCase(page, app)
  expect(before.laboratoryRequests?.requests.map(request => request.id).sort()).toEqual([...requestIds].sort())
  expect(before.laboratoryRequests?.requests.every(request => request.status === 'issued')).toBe(true)
  return { app, requestIds, before }
}

type OutpatientCancelPatient = Awaited<ReturnType<typeof prepareOutpatientInvestigationCancel>>

export async function openOutpatientInvestigationActions(page: Page, subject: OutpatientCancelPatient, open: () => Promise<void>) {
  await open()
  const rail = page.getByRole('button', { name: /^候诊队列 ·/ })
  if (await rail.isVisible()) await rail.click()
  await page.getByRole('tab', { name: '在诊', exact: true }).click()
  await page.getByRole('button', { name: `选择病例 ${subject.before.patient.name}`, exact: true }).click()
  await openWorkspaceTab(page, '检验检查')
  await page.getByRole('tab', { name: /^检验 \d+$/ }).click()
}

/** 第二项真实提交后丢响应，恢复只查原回执，第三项须另一次人工确认。 */
export async function runOutpatientInvestigationCancelJourney(page: Page, subject: OutpatientCancelPatient,
  loseSecondResponse = false, step = async (_caption: string) => {}) {
  const panel = page.getByRole('tabpanel', { name: /^检验 \d+$/ })
  const list = panel.getByRole('region', { name: '申请列表', exact: true })
  await expect(list.getByRole('checkbox', { name: /^选择取消：/ })).toHaveCount(subject.requestIds.length)
  await list.getByRole('button', { name: '全选本页可取消申请', exact: true }).click()
  const drafts = list.getByRole('region', { name: '取消申请完整待处理清单', exact: true })
  await expect(drafts.getByRole('checkbox')).toHaveCount(subject.requestIds.length)
  await list.getByRole('button', { name: '清空取消选择', exact: true }).click()
  for (const choice of await drafts.getByRole('checkbox').all()) await expect(choice).not.toBeChecked()
  await expect(drafts.getByRole('checkbox')).toHaveCount(subject.requestIds.length)
  await list.getByRole('button', { name: '全选本页可取消申请', exact: true }).click()
  await step('门诊医生选择同次就诊的多项检验；清空仅取消勾选，保留待处理清单')
  const attempts: Array<{ key: string; requestId: string }> = []
  await page.route('**/api/his/v1/laboratory-requests/*/actions/cancel', async route => {
    const requestId = new URL(route.request().url()).pathname.split('/').at(-3)!
    attempts.push({ requestId, key: route.request().headers()['idempotency-key']! })
    expect(route.request().postDataJSON().input.reasonCode).toBe('no-longer-needed')
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    if (loseSecondResponse && attempts.length === 2) await route.abort('failed')
    else await route.fulfill({ response })
  })
  const trigger = list.getByRole('button', { name: '集中取消申请', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '集中取消申请核对', exact: true })
  await expect(dialog.getByRole('article')).toHaveCount(subject.requestIds.length)
  await expect(dialog.getByText('取消原因：不再需要', { exact: false })).toHaveCount(subject.requestIds.length)
  await expect(dialog).toContainText('取消不等于退款')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
  expect(attempts).toEqual([])
  await trigger.click()
  await step('集中预览逐项申请与“不再需要”理由；取消申请不等于退款')
  await dialog.getByRole('button', { name: '确认取消申请', exact: true }).click()
  const outcomes = list.getByRole('region', { name: '取消申请逐项结果', exact: true })
  if (loseSecondResponse) {
    await expect(list.getByRole('button', { name: '恢复原取消', exact: true })).toBeEnabled()
    expect(attempts).toHaveLength(2)
    expect((await readDoctorBillingCase(page, subject.app)).laboratoryRequests?.requests.filter(request => request.status === 'cancelled')).toHaveLength(2)
    await expect(outcomes).toContainText('原结果待查明')
    await step('第一项取消成功，第二项已提交但响应丢失；第三项停止，保留原尝试')
    await page.reload()
    await openOutpatientInvestigationActions(page, subject, async () => {})
    const receiptRequest = page.waitForRequest(request => request.url().includes('/command-receipts?'))
    await list.getByRole('button', { name: '恢复原取消', exact: true }).click()
    const lookup = new URL((await receiptRequest).url())
    expect(lookup.searchParams.get('idempotencyKey')).toBe(attempts[1]!.key)
    expect(lookup.searchParams.get('operationId')).toBe('laboratory-request.cancel')
    await expect(list.getByRole('button', { name: '恢复原取消', exact: true })).toHaveCount(0)
    await expect(outcomes.getByRole('status')).toHaveText('本次办理已结束 · 成功 2/3')
    expect(attempts).toHaveLength(2)
    const receipt = commandReceiptLookupSchema.parse(await (await page.request.get(`${subject.app.origin}/api/his/v1/command-receipts?${new URLSearchParams({
      operationId: 'laboratory-request.cancel', idempotencyKey: attempts[1]!.key,
    })}`)).json())
    expect(receipt.status).toBe('completed')
    await step('刷新后恢复原取消结果，不再发送前两项；余项仍需重新核对并确认')
    await trigger.click()
    await expect(dialog.getByRole('article')).toHaveCount(1)
    await dialog.getByRole('button', { name: '确认取消申请', exact: true }).click()
  }
  await expect(outcomes.getByRole('status')).toHaveText(`本次办理已结束 · 成功 ${loseSecondResponse ? '1/1' : `${subject.requestIds.length}/${subject.requestIds.length}`}`)
  expect(attempts).toHaveLength(subject.requestIds.length)
  expect(new Set(attempts.map(item => item.key)).size).toBe(subject.requestIds.length)
  expect(attempts.map(item => item.requestId).sort()).toEqual([...subject.requestIds].sort())
  const after = await readDoctorBillingCase(page, subject.app)
  expect(after.laboratoryRequests?.requests.map(request => request.id).sort()).toEqual([...subject.requestIds].sort())
  expect(after.laboratoryRequests?.requests.every(request => request.status === 'cancelled' && request.report === undefined
    && request.billing?.status === 'cancelled' && request.billing.paidFen === 0)).toBe(true)
  await step('所选申请分别取消完成，原申请和关联费用保留，没有生成报告或退款')
  return { posts: attempts.length, keys: attempts.map(item => item.key), requestIds: subject.requestIds, cancelled: subject.requestIds.length }
}

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
