import type { Page } from '@playwright/test'
import { z } from 'zod'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import { commandResponseSchema } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientSurgeryResponseSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { createDrgBrowserPatient, expect } from './inpatient-drg.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'
import { openQueue } from './queue-overlay.fixture.ts'

export async function prepareReservationBatchPatient(page: Page, app: Parameters<typeof createDrgBrowserPatient>[1]) {
  const s = await createDrgBrowserPatient(page, app, '合成连续预留患者')
  const read = async () => inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  const plan = async (procedureId: string, reason: string) => {
    const before = await read()
    const response = await s.api.post(`${s.path}/surgeries/request`, {
      encounterVersion: before.encounterVersion, procedureId, catalogVersion: 1,
      plannedFor: '2026-11-10T09:00:00+08:00', reason,
    })
    expect(response.status()).toBe(200)
    return inpatientSurgeryResponseSchema.parse(await response.json()).data.requests.find(row => row.reason === reason)!.id
  }
  const requestId = await plan('hospital-surgery-4', '合成当前计划连续维护')
  const otherRequestId = await plan('hospital-surgery-1', '合成另一计划保持预留')
  const reserved = await s.api.post(`${s.path}/drg/reservations`, {
    encounterVersion: (await read()).encounterVersion, requestId: otherRequestId,
    materialId: 'hospital-material-catheter', catalogVersion: 1, quantity: 1, reason: '合成另一计划独立余量',
  })
  expect(reserved.status()).toBe(200)
  const reservations = inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json())
  const otherReservation = reservations.reservations.find(row => row.requestId === otherRequestId)!
  return { ...s, requestId, otherRequestId, otherReservation }
}

type Patient = Awaited<ReturnType<typeof prepareReservationBatchPatient>>
type Step = (caption: string) => Promise<void>
const responseSchema = commandResponseSchema(inpatientMaterialReservationListSchema)
const displays = ['合成演示冠脉支架', '合成演示冠脉球囊'] as const

async function openMaintenance(page: Page, s: Patient, open: () => Promise<void>) {
  await open()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await selectInpatientStage(page, '手术')
  const plan = page.getByLabel('当前计划', { exact: true })
  if (await plan.isEnabled()) {
    await plan.click()
    await page.getByRole('option', { name: /合成当前计划连续维护/ }).click()
  } else await expect(plan).toContainText('合成当前计划连续维护')
  const trigger = page.getByRole('button', { name: '手工预留维护', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '手工预留维护', exact: true })
  await expect(dialog).toBeVisible()
  return { dialog, trigger }
}

export async function runReservationBatchJourney(page: Page, s: Patient, open: () => Promise<void>, step: Step = async () => {}) {
  const read = async () => inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json())
  const auditCount = async (operation: string) => {
    const bundle = fhirBundleSchema.parse(await (await s.api.get('/fhir/R5/AuditEvent?_total=accurate&_count=100')).json())
    expect(bundle.entry).toHaveLength(bundle.total!)
    return bundle.entry!.map(entry => z.object({ code: z.object({ text: z.string() }),
      outcome: z.object({ code: z.object({ code: z.string() }) }) }).loose().parse(entry.resource))
      .filter(event => event.code.text === operation && event.outcome.code.code === '0').length
  }
  const beforeCreateAudit = await auditCount('inpatient.drg.reservation.create')
  const beforeReleaseAudit = await auditCount('inpatient.drg.reservation.release')
  let { dialog, trigger } = await openMaintenance(page, s, open)
  let create = dialog.getByRole('region', { name: '新增预留', exact: true })
  await create.getByRole('button', { name: '添加预留耗材', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '选择预留耗材', exact: true })
  await picker.getByLabel('搜索预留耗材', { exact: true }).fill('合成演示冠脉')
  for (const display of displays) {
    await picker.getByRole('button', { name: `加入${display}`, exact: true }).click()
    await expect(picker).toBeVisible()
  }
  await step('同一手术连续加入支架和球囊，选择窗保持打开')
  await picker.getByRole('button', { name: '完成选择', exact: true }).click()
  await create.getByLabel(`预留数量 ${displays[0]}`, { exact: true }).fill('2')
  await create.getByLabel(`预留数量 ${displays[1]}`, { exact: true }).fill('3')
  await create.getByLabel('新增预留共同理由', { exact: true }).fill('合成共同依据：当前手术备用耗材')
  await create.getByLabel(`逐项理由 ${displays[1]}`, { exact: true }).fill('合成球囊逐项覆盖：三根备用')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(create.getByLabel(`预留数量 ${displays[0]}`, { exact: true })).toHaveValue('2')
  await page.reload()
  ;({ dialog, trigger } = await openMaintenance(page, s, async () => {}))
  create = dialog.getByRole('region', { name: '新增预留', exact: true })
  await expect(create.getByLabel(`预留数量 ${displays[1]}`, { exact: true })).toHaveValue('3')
  await expect(create.getByLabel('新增预留共同理由', { exact: true })).toHaveValue('合成共同依据：当前手术备用耗材')
  await expect(create.getByLabel(`逐项理由 ${displays[1]}`, { exact: true })).toHaveValue('合成球囊逐项覆盖：三根备用')
  await step('关闭与刷新保留两条未提交输入，共同理由和逐项覆盖分别核对')
  let createPosts = 0, releasePosts = 0
  const createKeys: string[] = [], releaseKeys: string[] = []
  await page.route(`**${s.path}/drg/reservations`, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    createPosts += 1
    createKeys.push(route.request().headers()['idempotency-key']!)
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    responseSchema.parse(await response.json())
    if (createPosts === 2) await route.abort('failed'); else await route.fulfill({ response })
  })
  await create.getByRole('button', { name: '审阅新增预留', exact: true }).click()
  const createReview = page.getByRole('region', { name: '确认新增预留清单', exact: true })
  await expect(createReview).toContainText('合成共同依据：当前手术备用耗材')
  await expect(createReview).toContainText('合成球囊逐项覆盖：三根备用')
  await createReview.getByRole('button', { name: '确认新增所选预留', exact: true }).click()
  await expect.poll(() => createPosts).toBe(2)
  await expect(create.getByRole('button', { name: '核查并恢复原预留请求', exact: true })).toBeEnabled()
  await expect(create.getByRole('region', { name: '新增预留逐项结果', exact: true })).toContainText('结果未明，先核查原请求')
  expect(createPosts).toBe(2)
  await expect(create.getByLabel(`预留数量 ${displays[0]}`, { exact: true })).toHaveCount(0)
  await expect(create.getByLabel(`预留数量 ${displays[1]}`, { exact: true })).toHaveValue('3')
  await expect(create.getByRole('button', { name: '审阅新增预留', exact: true })).toBeDisabled()
  await step('第一条创建成功保留，第二条已落库但响应丢失，停止队列并锁定原输入')
  await page.reload()
  ;({ dialog } = await openMaintenance(page, s, async () => {}))
  create = dialog.getByRole('region', { name: '新增预留', exact: true })
  const createReceipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await create.getByRole('button', { name: '核查并恢复原预留请求', exact: true }).click()
  expect(new URL((await createReceipt).url()).searchParams.get('idempotencyKey')).toBe(createKeys[1])
  await expect(create.getByRole('button', { name: '核查并恢复原预留请求', exact: true })).toHaveCount(0)
  expect(createPosts).toBe(2)
  const reserved = await read()
  expect(reserved.reservations).toHaveLength(3)
  const currentReservations = reserved.reservations.filter(row => row.requestId === s.requestId)
  expect(currentReservations.map(row => [row.materialId, row.quantity, row.reason])).toEqual([
    ['hospital-material-stent', 2, '合成共同依据：当前手术备用耗材'],
    ['hospital-material-balloon', 3, '合成球囊逐项覆盖：三根备用'],
  ])
  expect(reserved.reservations.find(row => row.id === s.otherReservation.id)).toEqual(s.otherReservation)
  await step('刷新后读取第二条原回执，创建仅发送两次，另一手术预留保持不变')

  let release = dialog.getByRole('region', { name: '释放预留', exact: true })
  await expect(release.getByRole('checkbox', { name: `选择${s.otherReservation.materialDisplay}`, exact: true })).toHaveCount(0)
  for (const display of displays) await release.getByRole('checkbox', { name: `选择${display}`, exact: true }).check()
  await release.getByLabel('释放预留共同理由', { exact: true }).fill('合成共同释放：当前手术计划调整')
  await release.getByLabel(`逐项理由 ${displays[1]}`, { exact: true }).fill('合成球囊释放逐项覆盖')
  await page.route(`**${s.path}/drg/reservations/*/release`, async route => {
    releasePosts += 1
    releaseKeys.push(route.request().headers()['idempotency-key']!)
    const input = z.object({ input: z.object({ expectedReservationVersion: z.number().int().positive() }) }).parse(route.request().postDataJSON()).input
    expect(input.expectedReservationVersion).toBe(1)
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    responseSchema.parse(await response.json())
    if (releasePosts === 2) await route.abort('failed'); else await route.fulfill({ response })
  })
  await release.getByRole('button', { name: '审阅释放预留', exact: true }).click()
  const releaseReview = page.getByRole('region', { name: '确认释放预留清单', exact: true })
  await expect(releaseReview).toContainText('合成球囊释放逐项覆盖')
  await releaseReview.getByRole('button', { name: '确认释放所选预留', exact: true }).click()
  await expect.poll(() => releasePosts).toBe(2)
  await expect(release.getByRole('button', { name: '核查并恢复原预留请求', exact: true })).toBeEnabled()
  await expect(release.getByRole('region', { name: '释放预留逐项结果', exact: true })).toContainText('结果未明，先核查原请求')
  expect(releasePosts).toBe(2)
  await step('逐项核对原预留余量与最终理由，第二条响应丢失后先核查原请求')
  await page.reload()
  ;({ dialog } = await openMaintenance(page, s, async () => {}))
  release = dialog.getByRole('region', { name: '释放预留', exact: true })
  const releaseReceipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await release.getByRole('button', { name: '核查并恢复原预留请求', exact: true }).click()
  expect(new URL((await releaseReceipt).url()).searchParams.get('idempotencyKey')).toBe(releaseKeys[1])
  await expect(release.getByRole('button', { name: '核查并恢复原预留请求', exact: true })).toHaveCount(0)
  expect(releasePosts).toBe(2)
  expect(new Set(createKeys).size).toBe(2)
  expect(new Set(releaseKeys).size).toBe(2)
  const final = await read()
  expect(final.reservations.filter(row => row.requestId === s.requestId)).toEqual(expect.arrayContaining([
    expect.objectContaining({ materialId: 'hospital-material-stent', quantity: 2, consumedQuantity: 0, remainingQuantity: 0,
      status: 'released', releaseReason: '合成共同释放：当前手术计划调整' }),
    expect.objectContaining({ materialId: 'hospital-material-balloon', quantity: 3, consumedQuantity: 0, remainingQuantity: 0,
      status: 'released', releaseReason: '合成球囊释放逐项覆盖' }),
  ]))
  expect(final.reservations).toHaveLength(3)
  expect(final.reservations.find(row => row.id === s.otherReservation.id)).toEqual(s.otherReservation)
  for (const [operationId, keys] of [['inpatient.drg.reservation.create', createKeys], ['inpatient.drg.reservation.release', releaseKeys]] as const)
    for (const idempotencyKey of keys) {
      const receipt = commandReceiptLookupSchema.parse(await (await s.api.get(`/api/his/v1/command-receipts?operationId=${operationId}&idempotencyKey=${idempotencyKey}`)).json())
      expect(receipt.status).toBe('completed')
      responseSchema.parse(receipt.response)
    }
  const createAudits = await auditCount('inpatient.drg.reservation.create') - beforeCreateAudit
  const releaseAudits = await auditCount('inpatient.drg.reservation.release') - beforeReleaseAudit
  expect(createAudits).toBe(2)
  expect(releaseAudits).toBe(2)
  const procedureCount = fhirBundleSchema.parse(await (await s.api.get(`/fhir/R5/Procedure?encounter=Encounter/${s.admissionId}&_total=accurate`)).json()).total
  expect(procedureCount).toBe(0)
  await s.api.login('cashier')
  const chargesFen = inpatientChargesSchema.parse(await (await s.api.get(`${s.path}/charges`)).json()).chargesFen
  await s.api.login('inpatient-doctor')
  expect(chargesFen).toBe(0)
  await step('当前两项已释放，另一计划预留保持；未产生实际费用或手术执行记录')
  return { createPosts, releasePosts, createKeys, releaseKeys, createAudits, releaseAudits,
    chargesFen, procedureCount, reservations: final.reservations }
}
