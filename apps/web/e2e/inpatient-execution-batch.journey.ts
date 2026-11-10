import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullCatalogSchema, inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema,
  inpatientPharmacyResponseSchema, inpatientPharmacySchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { fhirBundleSchema, fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { expect, loginPciBrowser, type PciBrowserApp } from './inpatient-pci.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

function post(page: Page, app: PciBrowserApp, path: string, input: unknown) {
  return page.request.post(app.origin + path, { headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { input } })
}
async function clinical(page: Page, app: PciBrowserApp, path: string) {
  const response = await page.request.get(app.origin + path + '/clinical')
  expect(response.status()).toBe(200)
  return inpatientFullClinicalSchema.parse(await response.json())
}

/** 公开岗位准备两份待给药、两份待教育和两条未发起PRN；不预写任何实际执行。 */
export async function prepareInpatientExecutionBatch(page: Page, app: PciBrowserApp, options: { educationCount?: number } = {}) {
  const stay = await app.fixture.preparePciAdmission([])
  const path = stay.path
  const medicationIds = ['aspirin', 'clopidogrel', 'heparin', 'iohexol']
  for (const suffix of medicationIds) {
    await loginPciBrowser(page, app, 'inpatient-doctor')
    const catalogResponse = await page.request.get(app.origin + '/api/his/v1/inpatient/clinical-catalog')
    expect(catalogResponse.status()).toBe(200)
    const catalog = inpatientFullCatalogSchema.parse(await catalogResponse.json())
    const item = catalog.medications.find(item => item.id === `medication-pci-${suffix}`)!
    const dose = item.doses[0]!, frequencyCode = item.frequencyCodes[0]!
    const medication = { catalogItemId: item.id, catalogVersion: item.version, doseText: dose.doseText, doseQuantity: dose.quantity, frequencyCode }
    const evaluationResponse = await post(page, app, path + '/drg/simulation', { medications: [medication], services: [] })
    expect(evaluationResponse.status(), await evaluationResponse.text()).toBe(200)
    const evaluation = inpatientDrgSimulationSchema.parse(await evaluationResponse.json())
    const current = await clinical(page, app, path)
    const issuedResponse = await post(page, app, path + '/orders/issue', { encounterVersion: current.encounterVersion, duration: 'temporary',
      expectedDrgFingerprint: evaluation.fingerprint, selection: { kind: 'medication', ...medication } })
    expect(issuedResponse.status(), await issuedResponse.text()).toBe(200)
    const order = inpatientFullClinicalResponseSchema.parse(await issuedResponse.json()).data.orders.find(item => item.catalogItemId === medication.catalogItemId)!
    await loginPciBrowser(page, app, 'ward-nurse')
    const verified = await post(page, app, path + '/orders/verify', { orderId: order.id, expectedOrderVersion: order.version })
    expect(verified.status(), await verified.text()).toBe(200)
    inpatientFullClinicalResponseSchema.parse(await verified.json())
  }
  for (let count = 0; count < (options.educationCount ?? 2); count++) {
    await loginPciBrowser(page, app, 'inpatient-doctor')
    const before = await clinical(page, app, path)
    const issuedResponse = await post(page, app, path + '/orders/issue', { encounterVersion: before.encounterVersion, duration: 'temporary',
      selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 } })
    expect(issuedResponse.status(), await issuedResponse.text()).toBe(200)
    const order = inpatientFullClinicalResponseSchema.parse(await issuedResponse.json()).data.orders.find(item => !before.orders.some(old => old.id === item.id))!
    await loginPciBrowser(page, app, 'ward-nurse')
    const verified = await post(page, app, path + '/orders/verify', { orderId: order.id, expectedOrderVersion: order.version })
    expect(verified.status(), await verified.text()).toBe(200)
  }
  await loginPciBrowser(page, app, 'ward-nurse')
  const beforeDispense = await clinical(page, app, path)
  const prnOrders = beforeDispense.orders.filter(item => item.frequencyCode === 'PRN')
  expect(prnOrders).toHaveLength(2)
  expect(beforeDispense.executions.some(execution => prnOrders.some(order => order.id === execution.orderId))).toBe(false)
  const administeredOrderIds = beforeDispense.orders.filter(item => item.kind === 'medication' && item.frequencyCode !== 'PRN').map(item => item.id)
  for (const orderId of administeredOrderIds) {
    await loginPciBrowser(page, app, 'pharmacist')
    const pharmacyResponse = await page.request.get(app.origin + path + '/pharmacy')
    expect(pharmacyResponse.status()).toBe(200)
    const pharmacy = inpatientPharmacySchema.parse(await pharmacyResponse.json()), order = pharmacy.orders.find(item => item.id === orderId)!
    const execution = pharmacy.executions.find(item => item.orderId === order.id)!, medication = pharmacy.medications.find(item => item.id === order.catalogItemId)!, lot = medication.lots[0]!
    const response = await post(page, app, path + '/executions/dispense', { executionId: execution.id, expectedExecutionVersion: execution.version,
      lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: order.doseQuantity }] })
    expect(response.status(), await response.text()).toBe(200)
    inpatientPharmacyResponseSchema.parse(await response.json())
  }
  await loginPciBrowser(page, app, 'ward-nurse')
  const before = await clinical(page, app, path)
  const admission = inpatientDetailSchema.parse(await (await page.request.get(app.origin + path)).json()).admission
  const context = sessionContextSchema.parse(await (await page.request.get(app.origin + '/api/auth/context')).json())
  const administrations = fhirBundleSchema.parse(await (await page.request.get(`${app.origin}/fhir/R5/MedicationAdministration?encounter=Encounter/${admission.id}&_total=accurate`)).json())
  expect(administrations.total).toBe(0)
  expect(before.executions.filter(item => item.status === 'dispensed')).toHaveLength(2)
  expect(before.executions.filter(item => item.status === 'pending')).toHaveLength(options.educationCount ?? 2)
  expect(before.executions.some(item => item.administrationId !== undefined || item.status === 'completed')).toBe(false)
  expect(before.dispenses).toHaveLength(2)
  expect(before.charges).toHaveLength(2)
  expect(app.modelCalls).toBe(0)
  const catalog = inpatientFullCatalogSchema.parse(await (await page.request.get(app.origin + '/api/his/v1/inpatient/clinical-catalog')).json())
  const result = { app, path, admission, context, before, prnOrders, catalog }
  await openInpatientExecutionWorkspace(page, result)
  return result
}

export async function openInpatientExecutionWorkspace(page: Page, subject: { app: PciBrowserApp; admission: { patientName: string } },
  open = async () => { await page.goto(subject.app.origin + '/inpatient') }) {
  await open()
  await page.getByRole('button', { name: new RegExp(subject.admission.patientName) }).click()
  await selectInpatientStage(page, '诊断医嘱')
}

export type ExecutionBatchPatient = Awaited<ReturnType<typeof prepareInpatientExecutionBatch>>
type Action = 'administer' | 'complete' | 'request-prn'
type Step = (caption: string) => Promise<void>
const actionLabels = {
  administer: { title: '集中记录给药', label: '给药', review: '核对给药记录', confirm: '确认保存给药记录' },
  complete: { title: '集中记录健康教育', label: '教育', review: '核对教育记录', confirm: '确认保存教育记录' },
  'request-prn': { title: '集中发起 PRN', label: 'PRN', review: '核对 PRN 发起', confirm: '确认发起 PRN' },
} as const

export async function openExecutionBatch(page: Page, action: Action) {
  const labels = actionLabels[action]
  await page.getByRole('button', { name: labels.title, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: labels.title, exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

/** 兼容旧黄金旅程，但每条实际事实仍须人工核实、选择、核对与确认。 */
export async function recordOneActualExecution(page: Page, action: 'administer' | 'complete') {
  const labels = actionLabels[action], dialog = await openExecutionBatch(page, action)
  const rows = dialog.getByRole('article', { name: new RegExp(`^${labels.label}项目：`) })
  await expect(rows.first()).toBeVisible()
  let selected = false
  for (const row of await rows.all()) {
    const verified = row.getByRole('checkbox', { name: new RegExp(`^已核实实际${labels.label}：`) })
    if (!await verified.isEnabled()) continue
    await verified.check()
    await row.getByRole('checkbox', { name: new RegExp(`^选择${labels.label}：`) }).check()
    selected = true
    break
  }
  expect(selected).toBe(true)
  await dialog.getByRole('button', { name: `${labels.review} (1)`, exact: true }).click()
  await dialog.getByRole('button', { name: labels.confirm, exact: true }).click()
  await expect(dialog.getByRole('region', { name: `${labels.label}逐项结果`, exact: true })).toContainText('成功 1/1')
  await dialog.getByRole('button', { name: '关闭办理窗口', exact: true }).click()
}

/** 三类动作只保存各自核实的原执行/原医嘱，不相互混入载荷。 */
export async function runInpatientExecutionBatchJourney(page: Page, subject: ExecutionBatchPatient, step: Step = async () => {},
  reasons: readonly [string, string] = ['本次介入治疗前逐项核对需要，现发起待执行任务', '本次造影专用理由：核对造影需求后发起，尚未实际给药']) {
  const attempts: Array<{ action: Action; key: string; input: Record<string, unknown>; response: ReturnType<typeof inpatientFullClinicalResponseSchema.parse> }> = []
  await page.route(/\/(?:api|clinmesh-api)\/his\/v1\/inpatient\/admissions\/[^/]+\/executions\/(administer|complete|request-prn)$/, async route => {
    const request = route.request(), action = new URL(request.url()).pathname.split('/').at(-1)! as Action
    const response = await route.fetch({ url: request.url().replace('/clinmesh-api/', '/api/') })
    expect(response.status(), await response.text()).toBe(200)
    attempts.push({ action, key: request.headers()['idempotency-key']!, input: request.postDataJSON().input,
      response: inpatientFullClinicalResponseSchema.parse(await response.json()) })
    await route.fulfill({ response })
  })
  const medications = subject.before.executions.filter(row => row.status === 'dispensed')
  const education = subject.before.executions.filter(row => row.status === 'pending')
  let dialog = await openExecutionBatch(page, 'administer')
  await expect(dialog.getByRole('button', { name: /全选/ })).toHaveCount(0)
  for (const choice of await dialog.getByRole('checkbox', { name: /^选择给药：/ }).all()) await expect(choice).toBeDisabled()
  await step('实际给药须逐项核实后才能选择；核实前不可选，也没有全选')
  for (const execution of medications) {
    const row = dialog.getByRole('article', { name: `给药项目：${execution.id}`, exact: true })
    await expect(row.getByRole('checkbox', { name: /^选择给药：/ })).not.toBeChecked()
    await expect(row.getByRole('checkbox', { name: /^选择给药：/ })).toBeDisabled()
    await row.getByRole('checkbox', { name: /^已核实实际给药：/ }).check()
    await row.getByRole('checkbox', { name: /^选择给药：/ }).check()
  }
  await step('病区护士逐项核实两次实际给药，核实后才能选择；没有全选')
  await dialog.getByRole('button', { name: '关闭办理窗口', exact: true }).click()
  dialog = await openExecutionBatch(page, 'complete')
  await expect(dialog.getByRole('checkbox', { name: /^选择教育：/ })).toHaveCount(education.length)
  for (const choice of await dialog.getByRole('checkbox', { name: /^选择教育：/ }).all()) { await expect(choice).not.toBeChecked(); await expect(choice).toBeDisabled() }
  await expect(dialog.getByRole('region', { name: '教育待办清单', exact: true }).getByRole('article')).toHaveCount(0)
  await dialog.getByRole('button', { name: '关闭办理窗口', exact: true }).click()
  dialog = await openExecutionBatch(page, 'administer')
  await dialog.getByRole('button', { name: '核对给药记录 (2)', exact: true }).click()
  for (const execution of medications) await expect(dialog.getByRole('article', { name: `核对项目：${execution.id}`, exact: true })).toContainText('已逐项核实实际发生')
  expect(attempts).toEqual([])
  await step('集中核对两项原给药时点、剂量和执行记录，明确保存实际给药事实')
  await dialog.getByRole('button', { name: '确认保存给药记录', exact: true }).click()
  await expect(dialog.getByRole('region', { name: '给药逐项结果', exact: true })).toContainText('成功 2/2')
  expect(attempts.map(item => item.action)).toEqual(['administer', 'administer'])
  const afterMedication = await clinical(page, subject.app, subject.path)
  expect(afterMedication.dispenses).toEqual(subject.before.dispenses)
  expect(afterMedication.charges).toEqual(subject.before.charges)
  await dialog.getByRole('button', { name: '关闭办理窗口', exact: true }).click()
  dialog = await openExecutionBatch(page, 'complete')
  await expect(dialog.getByRole('button', { name: /全选/ })).toHaveCount(0)
  for (const execution of education) {
    const row = dialog.getByRole('article', { name: `教育项目：${execution.id}`, exact: true })
    await row.getByRole('checkbox', { name: /^已核实实际教育：/ }).check()
    await row.getByRole('checkbox', { name: /^选择教育：/ }).check()
  }
  await dialog.getByRole('button', { name: `核对教育记录 (${education.length})`, exact: true }).click()
  for (const execution of education) await expect(dialog.getByRole('article', { name: `核对项目：${execution.id}`, exact: true })).toContainText('已逐项核实实际发生')
  await step('健康教育独立核实与集中确认，同名教育仍按各自原执行记录分别保存')
  await dialog.getByRole('button', { name: '确认保存教育记录', exact: true }).click()
  await expect(dialog.getByRole('region', { name: '教育逐项结果', exact: true })).toContainText(`成功 ${education.length}/${education.length}`)
  await dialog.getByRole('button', { name: '关闭办理窗口', exact: true }).click()
  dialog = await openExecutionBatch(page, 'request-prn')
  const [commonReason, overrideReason] = reasons
  await dialog.getByRole('textbox', { name: 'PRN共同理由', exact: true }).fill(commonReason)
  for (const order of subject.prnOrders) await dialog.getByRole('article', { name: `PRN项目：${order.id}`, exact: true }).getByRole('checkbox', { name: /^选择 PRN：|^选择PRN：/ }).check()
  const overrideOrder = subject.prnOrders[1]!
  const draft = dialog.getByRole('region', { name: 'PRN待办清单', exact: true }).getByRole('article', { name: `待办项目：${overrideOrder.id}`, exact: true })
  await draft.getByRole('button', { name: '单独填写理由', exact: true }).click()
  await draft.getByRole('textbox', { name: `单项 PRN 理由：${overrideOrder.display}`, exact: true }).fill(overrideReason)
  await dialog.getByRole('button', { name: '核对 PRN 发起 (2)', exact: true }).click()
  await expect(dialog.getByRole('article', { name: `核对项目：${subject.prnOrders[0]!.id}`, exact: true })).toContainText(commonReason)
  await expect(dialog.getByRole('article', { name: `核对项目：${overrideOrder.id}`, exact: true })).toContainText(overrideReason)
  await step('PRN 单独核对共同理由和逐项覆盖理由；发起任务仍不代表已给药')
  await dialog.getByRole('button', { name: '确认发起 PRN', exact: true }).click()
  await expect(dialog.getByRole('region', { name: 'PRN逐项结果', exact: true })).toContainText('成功 2/2')
  await expect(dialog.getByRole('region', { name: 'PRN逐项结果', exact: true }).getByText(/已发起，仍待执行/)).toHaveCount(2)
  const final = await clinical(page, subject.app, subject.path)
  const catalog = inpatientFullCatalogSchema.parse(await (await page.request.get(subject.app.origin + '/api/his/v1/inpatient/clinical-catalog')).json())
  expect(catalog.medications).toEqual(subject.catalog.medications)
  expect(final.dispenses).toEqual(subject.before.dispenses)
  for (const execution of [...medications, ...education]) {
    const completed = final.executions.find(row => row.id === execution.id)!
    expect(completed).toMatchObject({ orderId: execution.orderId, scheduledFor: execution.scheduledFor, status: 'completed', version: execution.version + 1 })
    expect(final.orders.find(row => row.id === execution.orderId)?.state).toBe('completed')
    const task = fhirResourceSchema.parse(await (await page.request.get(`${subject.app.origin}/fhir/R5/Task/${execution.id}`)).json())
    expect(task).toMatchObject({ status: 'completed', meta: { versionId: String(completed.version) } })
    if (medications.some(row => row.id === execution.id)) {
      const order = subject.before.orders.find(row => row.id === execution.orderId)!
      const administration = fhirResourceSchema.parse(await (await page.request.get(`${subject.app.origin}/fhir/R5/MedicationAdministration/${completed.administrationId}`)).json())
      expect(administration).toMatchObject({ status: 'completed', request: { reference: `MedicationRequest/${order.id}` }, encounter: { reference: `Encounter/${subject.admission.id}` },
        partOf: subject.before.dispenses.filter(row => row.executionId === execution.id).map(row => ({ reference: `MedicationDispense/${row.id}` })),
        dosage: { text: order.doseText, dose: { value: order.doseQuantity, unit: order.unit } } })
    } else {
      const charges = final.charges.filter(row => row.sourceId === execution.id)
      expect(charges).toHaveLength(1)
      expect(charges[0]).toMatchObject({ kind: 'service', amountFen: 3000 })
    }
  }
  for (const [index, order] of subject.prnOrders.entries()) {
    const attempt = attempts.find(item => item.action === 'request-prn' && item.input.orderId === order.id)!
    const taskEffect = attempt.response.effects.filter(effect => effect.kind === 'created' && effect.reference.startsWith('Task/'))
    expect(taskEffect).toHaveLength(1)
    const execution = final.executions.find(row => `Task/${row.id}` === taskEffect[0]!.reference)!
    expect(execution).toMatchObject({ orderId: order.id, status: 'pending', version: 1, reason: index === 0 ? commonReason : overrideReason })
    expect(execution.administrationId).toBeUndefined()
    expect(final.orders.find(row => row.id === order.id)).toEqual(order)
    expect(final.dispenses.some(row => row.executionId === execution.id)).toBe(false)
    expect(final.charges.some(row => row.sourceId === execution.id)).toBe(false)
    expect(fhirResourceSchema.parse(await (await page.request.get(`${subject.app.origin}/fhir/R5/Task/${execution.id}`)).json())).toMatchObject({ status: 'ready', description: execution.reason })
  }
  const administrations = fhirBundleSchema.parse(await (await page.request.get(`${subject.app.origin}/fhir/R5/MedicationAdministration?encounter=Encounter/${subject.admission.id}&_total=accurate`)).json())
  expect(administrations.total).toBe(2)
  expect(final.chargesFen).toBe(subject.before.chargesFen + education.length * 3000)
  expect(attempts.map(item => item.action)).toEqual(['administer', 'administer', ...education.map(() => 'complete'), 'request-prn', 'request-prn'])
  expect(new Set(attempts.map(item => item.key)).size).toBe(attempts.length)
  expect(attempts.filter(item => item.action === 'administer').map(item => item.input)).toEqual(medications.map(row => ({ executionId: row.id, expectedExecutionVersion: row.version })))
  expect(attempts.filter(item => item.action === 'complete').map(item => item.input)).toEqual(education.map(row => ({ executionId: row.id, expectedExecutionVersion: row.version })))
  expect(subject.app.modelCalls).toBe(0)
  await step('两次实际给药与两次教育各保存一次；两项 PRN 仅待执行，库存和原药费没有重复扣记')
  return { posts: attempts.length, keys: attempts.map(item => item.key), administrations: administrations.total, educationChargesFen: education.length * 3000,
    prnPending: 2, executionIds: final.executions.map(row => row.id) }
}

/** 使用真实登录退出与刷新，证明只保存当前动作的人工草稿而不预写临床事实。 */
export async function runInpatientExecutionSelectionJourney(page: Page, subject: ExecutionBatchPatient,
  open = async () => { await page.goto(subject.app.origin + '/inpatient') }) {
  let dialog = await openExecutionBatch(page, 'administer')
  const execution = subject.before.executions.find(row => row.status === 'dispensed')!
  const candidate = () => dialog.getByRole('article', { name: `给药项目：${execution.id}`, exact: true })
  await candidate().getByRole('checkbox', { name: /^已核实实际给药：/ }).check()
  await candidate().getByRole('checkbox', { name: /^选择给药：/ }).check()
  await dialog.getByRole('textbox', { name: '搜索给药项目', exact: true }).fill('无匹配的合成药品')
  await expect(dialog.getByRole('checkbox', { name: /^选择给药：/ })).toHaveCount(0)
  const drafts = () => dialog.getByRole('region', { name: '给药待办清单', exact: true })
  await expect(drafts().getByRole('checkbox', { name: /^清单选择：/ })).toBeChecked()
  await dialog.getByRole('button', { name: '关闭办理窗口', exact: true }).click()
  await page.reload()
  await openInpatientExecutionWorkspace(page, subject, async () => {})
  dialog = await openExecutionBatch(page, 'administer')
  await expect(candidate().getByRole('checkbox', { name: /^已核实实际给药：/ })).toBeChecked()
  await expect(candidate().getByRole('checkbox', { name: /^选择给药：/ })).toBeChecked()
  await dialog.getByRole('button', { name: '清空选择', exact: true }).click()
  await expect(drafts().getByRole('article')).toHaveCount(1)
  await expect(candidate().getByRole('checkbox', { name: /^已核实实际给药：/ })).toBeChecked()
  await expect(candidate().getByRole('checkbox', { name: /^选择给药：/ })).not.toBeChecked()
  await drafts().getByRole('button', { name: '丢弃待办清单', exact: true }).click()
  const discard = page.getByRole('dialog', { name: '丢弃未提交清单？', exact: true })
  await discard.getByRole('button', { name: '保留清单', exact: true }).click()
  await expect(drafts().getByRole('article')).toHaveCount(1)
  await drafts().getByRole('button', { name: '丢弃待办清单', exact: true }).click()
  await discard.getByRole('button', { name: '确认丢弃待办清单', exact: true }).click()
  await expect(drafts().getByRole('article')).toHaveCount(0)
  await candidate().getByRole('checkbox', { name: /^已核实实际给药：/ }).check()
  await candidate().getByRole('checkbox', { name: /^选择给药：/ }).check()
  await dialog.getByRole('button', { name: '关闭办理窗口', exact: true }).click()
  await page.getByRole('button', { name: '用户菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
  await loginPciBrowser(page, subject.app, 'ward-nurse')
  await openInpatientExecutionWorkspace(page, subject, open)
  dialog = await openExecutionBatch(page, 'administer')
  await expect(drafts().getByRole('article')).toHaveCount(0)
  await expect(candidate().getByRole('checkbox', { name: /^已核实实际给药：/ })).not.toBeChecked()
  await expect(candidate().getByRole('checkbox', { name: /^选择给药：/ })).toBeDisabled()
  expect(await clinical(page, subject.app, subject.path)).toEqual(subject.before)
  expect(subject.app.modelCalls).toBe(0)
}

/** 第二项真实完成后丢响应，刷新只恢复原键，第三项仍须重新核对确认。 */
export async function runInpatientExecutionRecoveryJourney(page: Page, subject: ExecutionBatchPatient,
  open = async () => { await page.goto(subject.app.origin + '/inpatient') }, step: Step = async () => {}) {
  const education = subject.before.executions.filter(row => row.status === 'pending')
  expect(education).toHaveLength(3)
  let dialog = await openExecutionBatch(page, 'complete')
  for (const execution of education) {
    const row = dialog.getByRole('article', { name: `教育项目：${execution.id}`, exact: true })
    await row.getByRole('checkbox', { name: /^已核实实际教育：/ }).check()
    await row.getByRole('checkbox', { name: /^选择教育：/ }).check()
  }
  const attempts: Array<{ key: string; input: unknown }> = []
  await page.route(/\/(?:api|clinmesh-api)\/his\/v1\/inpatient\/admissions\/[^/]+\/executions\/complete$/, async route => {
    const request = route.request()
    attempts.push({ key: request.headers()['idempotency-key']!, input: request.postDataJSON().input })
    const response = await route.fetch({ url: request.url().replace('/clinmesh-api/', '/api/') })
    expect(response.status(), await response.text()).toBe(200)
    inpatientFullClinicalResponseSchema.parse(await response.json())
    if (attempts.length === 2) await route.abort('failed'); else await route.fulfill({ response })
  })
  await dialog.getByRole('button', { name: '核对教育记录 (3)', exact: true }).click()
  await dialog.getByRole('button', { name: '确认保存教育记录', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '恢复原教育结果', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('region', { name: '教育逐项结果', exact: true })).toContainText('原结果待查明')
  expect(attempts).toHaveLength(2)
  const partial = await clinical(page, subject.app, subject.path)
  expect(partial.executions.filter(row => row.status === 'completed')).toHaveLength(2)
  expect(partial.executions.find(row => row.id === education[2]!.id)?.status).toBe('pending')
  expect(partial.chargesFen).toBe(subject.before.chargesFen + 6000)
  await step('第二条教育已真实保存但响应丢失；后续项目停止，第三条尚未发送')
  await page.reload()
  await openInpatientExecutionWorkspace(page, subject, async () => {})
  dialog = await openExecutionBatch(page, 'complete')
  const lookupRequest = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await dialog.getByRole('button', { name: '恢复原教育结果', exact: true }).click()
  const lookup = new URL((await lookupRequest).url())
  expect(lookup.searchParams.get('operationId')).toBe('inpatient.execution.complete')
  expect(lookup.searchParams.get('idempotencyKey')).toBe(attempts[1]!.key)
  await expect(dialog.getByRole('button', { name: '恢复原教育结果', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('region', { name: '教育逐项结果', exact: true })).toContainText('成功 2/3')
  expect(attempts).toHaveLength(2)
  await step('刷新后查回第二条原回执，不重发成功项；第三条须再次核对并确认')
  await dialog.getByRole('button', { name: '核对教育记录 (1)', exact: true }).click()
  await expect(dialog.getByRole('article', { name: /^核对项目：/ })).toHaveCount(1)
  await expect(dialog.getByRole('article', { name: `核对项目：${education[2]!.id}`, exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '确认保存教育记录', exact: true }).click()
  await expect(dialog.getByRole('region', { name: '教育逐项结果', exact: true })).toContainText('成功 1/1')
  expect(attempts).toHaveLength(3)
  expect(new Set(attempts.map(item => item.key)).size).toBe(3)
  expect(attempts.map(item => item.input)).toEqual(education.map(row => ({ executionId: row.id, expectedExecutionVersion: row.version })))
  const receipt = commandReceiptLookupSchema.parse(await (await page.request.get(`${subject.app.origin}/api/his/v1/command-receipts?${new URLSearchParams({
    operationId: 'inpatient.execution.complete', idempotencyKey: attempts[1]!.key,
  })}`)).json())
  expect(receipt.status).toBe('completed')
  const final = await clinical(page, subject.app, subject.path)
  expect(final.executions.filter(row => row.status === 'completed').map(row => row.id).sort()).toEqual(education.map(row => row.id).sort())
  expect(final.charges.filter(row => row.kind === 'service').map(row => row.sourceId).sort()).toEqual(education.map(row => row.id).sort())
  expect(final.chargesFen).toBe(subject.before.chargesFen + 9000)
  expect(final.dispenses).toEqual(subject.before.dispenses)
  expect(final.executions.some(row => row.administrationId !== undefined)).toBe(false)
  expect(subject.app.modelCalls).toBe(0)
  // 重新进入同一入口的能力供双React与录制共用；不得借用准备页面会话读事实。
  await dialog.getByRole('button', { name: '关闭办理窗口', exact: true }).click()
  await openInpatientExecutionWorkspace(page, subject, open)
  return { posts: attempts.length, keys: attempts.map(item => item.key), educationChargesFen: 9000, administrations: 0 }
}
