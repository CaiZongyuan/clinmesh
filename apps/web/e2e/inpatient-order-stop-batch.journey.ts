import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { createPatientResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema, inpatientPharmacySchema } from '@clinmesh/contracts/inpatient-clinical'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { expect } from './fixtures.ts'
import { openQueue } from './queue-overlay.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

/** 仅沿公开接口准备已有发药与待执行事实；正式停嘱和核停由产品页面办理。 */
export async function prepareOrderStopBatchPatient(page: Page, app: { origin: string; password: string }) {
  const login = async (role: string) => expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin }, data: { email: `${role}@demo.clinmesh.local`, password: app.password },
  })).status()).toBe(200)
  const get = (path: string) => page.request.get(app.origin + path)
  const post = (path: string, input: unknown, patient = false) => page.request.post(app.origin + path, {
    headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { input, ...(patient ? { expectedVersions: {} } : {}) },
  })
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
  const s = await create('合成集中停嘱患者', 'bed-general-1')
  const read = async () => inpatientFullClinicalSchema.parse(await (await get(`${s.path}/clinical`)).json())
  await login('inpatient-doctor')
  expect((await post(`${s.path}/diagnoses/confirm`, { encounterVersion: (await read()).encounterVersion, expectedRevision: 0, entries: [
    { catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' },
  ] })).status()).toBe(200)
  const issue = async (selection: unknown) => {
    const before = await read()
    const response = await post(`${s.path}/orders/issue`, { encounterVersion: before.encounterVersion, duration: 'temporary', selection })
    expect(response.status(), response.ok() ? undefined : await response.text()).toBe(200)
    return inpatientFullClinicalResponseSchema.parse(await response.json()).data.orders.find(order => !before.orders.some(old => old.id === order.id))!
  }
  const medication = await issue({ kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1,
    doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' })
  const education = await issue({ kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 })
  const signed = await issue({ kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 2 })
  await login('ward-nurse')
  for (const order of [medication, education]) expect((await post(`${s.path}/orders/verify`, {
    orderId: order.id, expectedOrderVersion: order.version,
  })).status()).toBe(200)
  await login('pharmacist')
  const pharmacy = inpatientPharmacySchema.parse(await (await get(`${s.path}/pharmacy`)).json())
  const execution = pharmacy.executions.find(item => item.orderId === medication.id)!
  const lot = pharmacy.medications.find(item => item.id === medication.catalogItemId)!.lots[0]!
  expect((await post(`${s.path}/executions/dispense`, { executionId: execution.id, expectedExecutionVersion: execution.version,
    lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: 1 }],
  })).status()).toBe(200)
  const other = await create('合成停嘱范围隔离患者', 'bed-general-2')
  await login('inpatient-doctor')
  const baseline = await read()
  expect(baseline.executions.map(item => item.status)).toEqual(['dispensed', 'pending'])
  expect(baseline.dispenses).toHaveLength(1)
  expect(baseline.charges).toHaveLength(1)
  return { ...s, app, other, medication, education, signed, baseline, api: { login, get, post },
    commonReason: '合成病情稳定，结束本阶段治疗', overrideReason: '合成教育计划调整，保留后续随访安排' }
}

type Patient = Awaited<ReturnType<typeof prepareOrderStopBatchPatient>>
type Step = (caption: string) => Promise<void>

async function openPatient(page: Page, s: Patient, open: () => Promise<void>) {
  await open()
  await openQueue(page)
  await page.getByRole('button', { name: new RegExp(s.name) }).click()
  await selectInpatientStage(page, '诊断医嘱')
}

/** Web、双 React Surface 与精确提交原生录屏共用的岗位闭环。 */
export async function runOrderStopBatchJourney(page: Page, s: Patient, open: () => Promise<void>, step: Step = async () => {}) {
  const read = async () => inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json())
  await openPatient(page, s, open)
  const doctorChoice = (display: string) => page.getByRole('checkbox', { name: `选择停嘱：${display}`, exact: true }).first()
  await expect(doctorChoice(s.medication.display)).toBeVisible()
  await doctorChoice(s.medication.display).check()
  await doctorChoice(s.education.display).check()
  const common = page.getByRole('textbox', { name: '共同停嘱理由', exact: true })
  await common.fill(s.commonReason)
  await page.getByRole('button', { name: `单独填写理由：${s.education.display}`, exact: true }).click()
  const override = page.getByRole('textbox', { name: `单项停嘱理由：${s.education.display}`, exact: true })
  await override.fill('')
  await expect(page.getByRole('button', { name: '集中申请停嘱 (2)', exact: true })).toBeDisabled()
  await override.fill(s.overrideReason)
  await step('住院医生分别选择两条需停止的医嘱，保留已发药和待执行事实')
  await openQueue(page)
  await page.getByRole('button', { name: new RegExp(s.other.name) }).click()
  await expect(page.getByRole('checkbox', { name: /^选择停嘱：/ })).toHaveCount(0)
  await openPatient(page, s, async () => {})
  await expect(common).toHaveValue(s.commonReason)
  await expect(override).toHaveValue(s.overrideReason)
  await page.reload()
  await openPatient(page, s, async () => {})
  await expect(common).toHaveValue(s.commonReason)
  await expect(override).toHaveValue(s.overrideReason)
  for (const order of [s.medication, s.education]) await expect(doctorChoice(order.display)).toBeChecked()
  await expect(page.getByRole('checkbox', { name: `选择停嘱：${s.signed.display}`, exact: true }).nth(1)).not.toBeChecked()
  expect((await read()).orders.filter(order => order.state === 'verified')).toHaveLength(2)
  await step('切患者和刷新后恢复两项选择、共同理由和单项覆盖，尚未申请停嘱')

  const requestKeys: string[] = [], requestedIds: string[] = [], requestReasons: string[] = []
  await page.route(`**${s.path}/orders/request-stop`, async route => {
    requestKeys.push(route.request().headers()['idempotency-key']!)
    const input = route.request().postDataJSON().input
    requestedIds.push(input.orderId); requestReasons.push(input.reason)
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientFullClinicalResponseSchema.parse(await response.json())
    if (requestKeys.length === 2) await route.abort('failed'); else await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '集中申请停嘱 (2)', exact: true }).click()
  const requestDialog = page.getByRole('dialog', { name: '集中申请停嘱', exact: true })
  await expect(requestDialog).toContainText(s.commonReason)
  await expect(requestDialog).toContainText(s.overrideReason)
  await expect(requestDialog.getByRole('article')).toHaveCount(2)
  await step('集中预览逐条最终停嘱理由，共同理由与教育医嘱覆盖分别确认')
  await requestDialog.getByRole('button', { name: '确认申请 2 条停嘱', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复原停嘱申请', exact: true })).toBeEnabled()
  expect(requestKeys).toHaveLength(2)
  expect(requestedIds).toEqual([s.medication.id, s.education.id])
  expect(requestReasons).toEqual([s.commonReason, s.overrideReason])
  await step('首条停嘱申请成功，第二条响应丢失；保留逐项结果并仅恢复原尝试')
  await page.reload()
  await openPatient(page, s, async () => {})
  const requestReceipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原停嘱申请', exact: true }).click()
  expect(new URL((await requestReceipt).url()).searchParams.get('idempotencyKey')).toBe(requestKeys[1])
  await expect(page.getByRole('button', { name: '恢复原停嘱申请', exact: true })).toHaveCount(0)
  expect(requestKeys).toHaveLength(2)
  const requested = await read()
  expect(requested.orders.filter(order => order.state === 'stop-requested').map(order => order.id)).toEqual([s.medication.id, s.education.id])
  expect(requested.orders.find(order => order.id === s.medication.id)).toMatchObject({ stopReason: s.commonReason })
  expect(requested.orders.find(order => order.id === s.education.id)).toMatchObject({ stopReason: s.overrideReason })
  expect(requested.executions).toEqual(s.baseline.executions)
  await step('原回执确认两项已申请停嘱，不重复提交；原发药和待执行记录继续保留')

  // Surface 合同也从真实 auth shell 注销，沿产品入口清理原岗位未提交输入。
  await page.goto(`${s.app.origin}/inpatient`)
  await page.getByRole('button', { name: '用户菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await page.getByLabel('账户邮箱').fill('ward-nurse@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(s.app.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '用户菜单', exact: true })).toBeVisible()
  await openPatient(page, s, open)
  await expect(page.getByRole('textbox', { name: '共同停嘱理由', exact: true })).toHaveCount(0)
  const nurseChoice = (display: string) => page.getByRole('checkbox', { name: `选择核停：${display}`, exact: true })
  await expect(nurseChoice(s.medication.display)).not.toBeChecked()
  await expect(nurseChoice(s.education.display)).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: /^选择核停：/ })).toHaveCount(2)
  await expect(page.getByRole('checkbox', { name: /^选择校对：/ })).toHaveCount(1)
  await expect(page.getByRole('checkbox', { name: /^选择校对：/ })).not.toBeChecked()
  await nurseChoice(s.medication.display).check()
  await nurseChoice(s.education.display).check()
  await page.reload()
  await openPatient(page, s, async () => {})
  for (const order of [s.medication, s.education]) await expect(nurseChoice(order.display)).toBeChecked()
  await step('病区护士单独选择两条待核停医嘱，刷新保留；新医嘱校对保持独立未选中')

  const verifyKeys: string[] = [], verifiedIds: string[] = []
  await page.route(`**${s.path}/orders/verify-stop`, async route => {
    verifyKeys.push(route.request().headers()['idempotency-key']!)
    verifiedIds.push(route.request().postDataJSON().input.orderId)
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientFullClinicalResponseSchema.parse(await response.json())
    if (verifyKeys.length === 2) await route.abort('failed'); else await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '集中核对停嘱 (2)', exact: true }).click()
  const verifyDialog = page.getByRole('dialog', { name: '集中核对停嘱', exact: true })
  await expect(verifyDialog).toContainText(s.commonReason)
  await expect(verifyDialog).toContainText(s.overrideReason)
  await expect(verifyDialog).toContainText('已发药')
  await expect(verifyDialog).toContainText('待执行')
  await expect(verifyDialog.getByRole('article')).toHaveCount(2)
  await step('护士核对原医嘱、两项正式停嘱理由和待执行影响，再集中确认核停')
  await verifyDialog.getByRole('button', { name: '确认核对 2 条停嘱', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复原停嘱核对', exact: true })).toBeEnabled()
  expect(verifyKeys).toHaveLength(2)
  await page.reload()
  await openPatient(page, s, async () => {})
  const verifyReceipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原停嘱核对', exact: true }).click()
  expect(new URL((await verifyReceipt).url()).searchParams.get('idempotencyKey')).toBe(verifyKeys[1])
  await expect(page.getByRole('button', { name: '恢复原停嘱核对', exact: true })).toHaveCount(0)
  expect(verifyKeys).toHaveLength(2)
  expect(verifiedIds).toEqual([s.medication.id, s.education.id])
  const final = await read()
  expect(final.orders.filter(order => order.state === 'stopped').map(order => order.id)).toEqual([s.medication.id, s.education.id])
  expect(final.orders.find(order => order.id === s.signed.id)).toMatchObject({ state: 'signed', version: 1 })
  expect(final.executions.map(item => [item.id, item.status])).toEqual(s.baseline.executions.map(item => [item.id, 'cancelled']))
  expect(final.dispenses).toEqual(s.baseline.dispenses)
  expect(final.charges).toEqual(s.baseline.charges)
  expect(final.chargesFen).toBe(s.baseline.chargesFen)
  expect(final.executions.filter(item => item.administrationId !== undefined)).toEqual([])
  expect(new Set([...requestKeys, ...verifyKeys]).size).toBe(4)
  for (const [operation, key] of [['request-stop', requestKeys[1]!], ['verify-stop', verifyKeys[1]!]]) {
    const receipt = commandReceiptLookupSchema.parse(await (await s.api.get(`/api/his/v1/command-receipts?operationId=inpatient.order.${operation}&idempotencyKey=${key}`)).json())
    expect(receipt.status).toBe('completed')
  }
  await step('两项已核停、两条待执行取消，原发药与费用保留；新医嘱仍待校对且无实际给药')
  return { requestPosts: requestKeys.length, verifyPosts: verifyKeys.length, requestKeys, verifyKeys, requestedIds, verifiedIds, requestReasons,
    stopReasons: final.orders.filter(order => order.state === 'stopped').map(order => order.stopReason),
    stoppedOrders: 2, cancelledExecutions: 2, signedOrders: 1, dispenses: final.dispenses.length, charges: final.charges.length, chargesFen: final.chargesFen }
}
