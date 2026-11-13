import type { Page } from '@playwright/test'
import { z } from 'zod'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import { inpatientSurgeryResponseSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { createDrgBrowserPatient, expect } from './inpatient-drg.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'
import { openQueue } from './queue-overlay.fixture.ts'

type Step = (caption: string) => Promise<void>

export async function prepareSurgeryBatchPatient(page: Page, app: Parameters<typeof createDrgBrowserPatient>[1]) {
  const s = await createDrgBrowserPatient(page, app, '合成手术双清单患者')
  const read = async () => inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  const ready = async (procedureId: string, reason: string) => {
    const before = await read()
    const requested = inpatientSurgeryResponseSchema.parse(await (await s.api.post(`${s.path}/surgeries/request`, {
      encounterVersion: before.encounterVersion, procedureId, catalogVersion: 1,
      plannedFor: '2026-11-10T09:00:00+08:00', reason,
    })).json()).data.requests.find(row => row.reason === reason)!
    await s.api.login('ward-nurse')
    expect((await s.api.post(`${s.path}/surgeries/check-preop`, { requestId: requested.id,
      expectedRequestVersion: requested.version, note: '合成术前准备已核对' })).status()).toBe(200)
    await s.api.login('inpatient-doctor')
    const checked = (await read()).requests.find(row => row.id === requested.id)!
    expect((await s.api.post(`${s.path}/surgeries/confirm-consent`, { requestId: checked.id,
      expectedRequestVersion: checked.version, note: '合成知情同意已签' })).status()).toBe(200)
    return requested.id
  }
  const batchRequestId = await ready('hospital-surgery-4', '合成第一台整台补录')
  const completionRequestId = await ready('hospital-surgery-1', '合成第二台最终核实')
  for (const [requestId, materialId, quantity, reason] of [
    [batchRequestId, 'hospital-material-stent', 2, '合成第一台双枚支架'],
    [completionRequestId, 'hospital-material-stent', 3, '合成第二台支架备用'],
    [completionRequestId, 'hospital-material-balloon', 3, '合成第二台球囊备用'],
  ] as const) {
    expect((await s.api.post(`${s.path}/drg/reservations`, { encounterVersion: (await read()).encounterVersion,
      requestId, materialId, catalogVersion: 1, quantity, reason })).status()).toBe(200)
  }
  return { ...s, batchRequestId, completionRequestId }
}

type Patient = Awaited<ReturnType<typeof prepareSurgeryBatchPatient>>

async function recoverSurgeryBatchWrite(page: Page, s: Patient, requestId: string, action: 'execute' | 'complete', originalKey: string | undefined, recovery: 'valid' | 'unreadable') {
  let damagedKey: string | undefined
  const damagedRaw = '{synthetic-unreadable-surgery-draft'
  if (recovery === 'unreadable') {
    const prefix = 'clinmesh.surgery-draft:v1:'
    const keys = await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)), prefix)
    const matching = keys.filter(key => {
      const scope = z.object({ patientId: z.string(), admissionId: z.string(), requestId: z.string(), action: z.enum(['execute', 'complete']) })
        .parse(JSON.parse(decodeURIComponent(key.slice(prefix.length))))
      return scope.admissionId === s.admissionId && scope.requestId === requestId && scope.action === action
    })
    expect(matching).toHaveLength(1)
    damagedKey = matching[0]!
    await page.evaluate(({ key, raw }) => sessionStorage.setItem(key, raw), { key: damagedKey, raw: damagedRaw })
  }
  await page.reload()
  await openSurgeryBatchPatient(page, s, async () => {})
  const receipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  expect(new URL((await receipt).url()).searchParams.get('idempotencyKey')).toBe(originalKey)
  if (damagedKey !== undefined) {
    const recoveryPanel = page.getByRole('region', { name: '待确认操作', exact: true })
    await expect(recoveryPanel).toContainText('原操作已成功')
    expect(await page.evaluate(key => sessionStorage.getItem(key), damagedKey)).toBe(damagedRaw)
    await recoveryPanel.getByRole('button', { name: '丢弃原不可读记录', exact: true }).click()
    await recoveryPanel.getByRole('button', { name: '保留原记录', exact: true }).click()
    expect(await page.evaluate(key => sessionStorage.getItem(key), damagedKey)).toBe(damagedRaw)
    await recoveryPanel.getByRole('button', { name: '丢弃原不可读记录', exact: true }).click()
    await recoveryPanel.getByRole('button', { name: '确认丢弃并恢复', exact: true }).click()
    await expect(recoveryPanel).toBeHidden()
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), damagedKey!)).toBeNull()
  }
  await expect(page.getByRole('button', { name: '恢复原住院操作', exact: true })).toBeHidden()
}

export async function openSurgeryBatchPatient(page: Page, s: Patient, open: () => Promise<void>) {
  await open()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await selectInpatientStage(page, '手术')
}

export async function fillSurgeryBatch(page: Page, step: Step = async () => {}) {
  await page.getByLabel('当前计划', { exact: true }).click()
  await page.getByRole('option', { name: /合成第一台整台补录/ }).click()
  const trigger = page.getByRole('button', { name: '整台补录', exact: true })
  await trigger.click()
  const batch = page.getByRole('dialog', { name: '整台补录', exact: true })
  await batch.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: '47.0100 · 腹腔镜下阑尾切除术', exact: true }).click()
  await batch.getByLabel('搜索手术耗材', { exact: true }).fill('合成演示冠脉')
  await batch.getByRole('button', { name: '添加 合成演示冠脉支架', exact: true }).click()
  await expect(batch).toBeVisible()
  await batch.getByRole('button', { name: '添加 合成演示冠脉球囊', exact: true }).click()
  await expect(batch).toBeVisible()
  await step('同窗连续加入两种耗材，数量与预留逐项保留')
  await batch.getByLabel('合成演示冠脉球囊实际用量', { exact: true }).fill('3')
  const stent = batch.getByLabel('合成演示冠脉支架实际用量', { exact: true })
  await stent.locator('..').getByLabel('替换治疗预留', { exact: true }).click()
  await page.getByRole('option', { name: '合成演示冠脉支架 × 2 · 合成第一台双枚支架', exact: true }).click()
  await expect(stent).toHaveValue('2')
  await batch.getByLabel('补录依据', { exact: true }).fill('合成整台核实：支架两枚，球囊三枚')
  return { batch, trigger }
}

export async function runSurgeryBatchConflictJourney(page: Page, s: Patient, open: () => Promise<void>, step: Step = async () => {}) {
  await openSurgeryBatchPatient(page, s, open)
  const { batch } = await fillSurgeryBatch(page, step)
  const before = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  const reservations = inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json())
  const reserved = reservations.reservations.find(row => row.requestId === s.batchRequestId)!
  expect((await s.api.post(`${s.path}/drg/reservations/${reserved.id}/release`, {
    encounterVersion: reservations.encounterVersion, reason: '合成另一操作台已释放所选预留',
  })).status()).toBe(200)
  await s.api.login('cashier')
  const beforeCharges = inpatientChargesSchema.parse(await (await s.api.get(`${s.path}/charges`)).json())
  await s.api.login('inpatient-doctor')
  const submitted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`${s.path}/surgeries/execute`))
  await batch.getByRole('button', { name: '记录实际手术', exact: true }).click()
  const response = await submitted
  expect(response.status()).toBe(409)
  await expect(batch.getByRole('alert')).toBeVisible()
  await expect(batch.getByLabel('合成演示冠脉支架实际用量', { exact: true })).toHaveValue('2')
  await expect(batch.getByLabel('合成演示冠脉球囊实际用量', { exact: true })).toHaveValue('3')
  await expect(batch.getByLabel('补录依据', { exact: true })).toHaveValue('合成整台核实：支架两枚，球囊三枚')
  expect(inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())).toEqual(before)
  expect(fhirBundleSchema.parse(await (await s.api.get(`/fhir/R5/Procedure?encounter=Encounter/${s.admissionId}&_total=accurate`)).json()).total).toBe(0)
  await s.api.login('cashier')
  expect(inpatientChargesSchema.parse(await (await s.api.get(`${s.path}/charges`)).json())).toEqual(beforeCharges)
  await s.api.login('inpatient-doctor')
  await step('公开接口制造真实预留冲突：整台409保留双材输入，未产生部分使用或费用')
  return { status: response.status(), executions: before.executions.length, chargesFen: beforeCharges.chargesFen }
}

export async function runSurgeryBatchJourney(page: Page, s: Patient, open: () => Promise<void>, step: Step = async () => {}, recovery: 'valid' | 'unreadable' = 'valid') {
  const auditCount = async (operation: string) => {
    const bundle = fhirBundleSchema.parse(await (await s.api.get('/fhir/R5/AuditEvent?_total=accurate&_count=100')).json())
    expect(bundle.entry).toHaveLength(bundle.total!)
    return bundle.entry!.map(entry => z.object({ code: z.object({ text: z.string() }) }).loose().parse(entry.resource))
      .filter(event => event.code.text === operation).length
  }
  await openSurgeryBatchPatient(page, s, open)
  let { batch, trigger } = await fillSurgeryBatch(page, step)
  await page.keyboard.press('Escape')
  await expect(batch).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(batch.getByLabel('合成演示冠脉球囊实际用量', { exact: true })).toHaveValue('3')
  await page.reload()
  await openSurgeryBatchPatient(page, s, async () => {})
  await page.getByLabel('当前计划', { exact: true }).click()
  await page.getByRole('option', { name: /合成第一台整台补录/ }).click()
  trigger = page.getByRole('button', { name: '整台补录', exact: true })
  await trigger.click()
  batch = page.getByRole('dialog', { name: '整台补录', exact: true })
  await expect(batch.getByLabel('合成演示冠脉支架实际用量', { exact: true })).toHaveValue('2')
  await expect(batch.getByLabel('合成演示冠脉球囊实际用量', { exact: true })).toHaveValue('3')
  await expect(batch.getByLabel('补录依据', { exact: true })).toHaveValue('合成整台核实：支架两枚，球囊三枚')
  await step('关闭、重开与刷新恢复整台私稿；整台只提交一次')
  const beforeExecuteAudit = await auditCount('inpatient.surgery.execute')
  let executePosts = 0, executeKey: string | undefined
  await page.route(`**${s.path}/surgeries/execute`, async route => {
    executePosts += 1
    executeKey = route.request().headers()['idempotency-key']
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientSurgeryResponseSchema.parse(await response.json())
    await route.abort('failed')
  })
  await batch.getByRole('button', { name: '记录实际手术', exact: true }).click()
  await expect(batch.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await expect(batch.getByRole('button', { name: '记录实际手术', exact: true })).toBeDisabled()
  await step('响应丢失时原清单锁定，刷新后从原操作回执恢复')
  await recoverSurgeryBatchWrite(page, s, s.batchRequestId, 'execute', executeKey, recovery)
  expect(executePosts).toBe(1)
  expect(await auditCount('inpatient.surgery.execute')).toBe(beforeExecuteAudit + 1)
  const afterBatch = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  const recorded = afterBatch.executions.find(row => row.requestId === s.batchRequestId)!
  expect(recorded.materials.map(row => [row.item.id, row.quantity])).toEqual([
    ['hospital-material-stent', 2], ['hospital-material-balloon', 3],
  ])
  await step('丢失响应后读取原回执，未重复执行或计费；继续核实另一台手术')

  await page.getByRole('button', { name: '开始手术', exact: true }).click()
  const start = page.getByRole('dialog', { name: '开始手术', exact: true })
  await start.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: '00.6600 · 经皮冠状动脉腔内血管成形术[PTCA]', exact: true }).click()
  await start.getByLabel('开始说明', { exact: true }).fill('合成第二台开始，按实际逐笔登记')
  const started = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`${s.path}/surgeries/start`))
  await start.getByRole('button', { name: '开始手术', exact: true }).click()
  expect((await started).status()).toBe(200)
  const entry = page.getByRole('region', { name: '登记本笔使用', exact: true })
  for (const display of ['合成演示冠脉支架', '合成演示冠脉球囊']) {
    await entry.getByLabel('耗材', { exact: true }).click()
    await page.getByRole('option', { name: new RegExp(`^${display} ·`) }).click()
    await expect(entry).toContainText('本计划还预留 3 个')
    await entry.getByLabel('依据', { exact: true }).fill('合成第二台实际使用一件')
    const used = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`${s.path}/surgeries/record-material`))
    await entry.getByRole('button', { name: '登记这笔', exact: true }).click()
    expect((await used).status()).toBe(200)
  }
  await step('第二台从真实入口开始，支架与球囊各登记一件，各留下两件预留')

  await page.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  let review = page.getByRole('dialog', { name: '核实最终耗材并完成手术', exact: true })
  await review.getByRole('button', { name: '有出入，改数量', exact: true }).click()
  await review.getByRole('button', { name: '新增最终耗材', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '选择最终耗材', exact: true })
  await expect(picker).toBeVisible()
  await step('在最终耗材目录连续选择，窗口与完成选择入口始终可达')
  await picker.getByLabel('搜索耗材', { exact: true }).fill('合成演示')
  await picker.getByRole('button', { name: /^加入\s*合成演示缝合材料$/ }).click()
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: /^加入\s*合成演示导管$/ }).click()
  await expect(picker).toBeVisible()
  const selected = picker.getByRole('region', { name: '完整待提交耗材清单', exact: true })
  await expect(selected.getByRole('spinbutton')).toHaveCount(4)
  await selected.getByLabel('合成演示缝合材料 · 最终总量 3', { exact: true }).fill('2')
  await picker.getByLabel('搜索耗材', { exact: true }).fill('球囊')
  await expect(selected.getByLabel('合成演示缝合材料 · 最终总量 3', { exact: true })).toHaveValue('2')
  await selected.getByRole('button', { name: '移除此新增项 4', exact: true }).click()
  await expect(selected.getByRole('spinbutton')).toHaveCount(3)
  await picker.getByLabel('搜索耗材', { exact: true }).fill('合成演示导管')
  await picker.getByRole('button', { name: /^加入\s*合成演示导管$/ }).click()
  await expect(selected.getByRole('spinbutton')).toHaveCount(4)
  await step('目录搜索时完整清单持续可见，可直接修改最终数量和移除新增项')
  await picker.getByRole('button', { name: '完成选择', exact: true }).click()
  await expect(review.getByLabel('合成演示缝合材料 · 最终总量 3', { exact: true })).toHaveValue('2')
  await review.getByLabel('核实说明', { exact: true }).fill('合成最终核实，明确只释放支架余量')
  const releases = review.getByRole('group', { name: '剩余预留释放', exact: true })
  await expect(releases.getByRole('checkbox')).toHaveCount(2)
  await releases.getByRole('button', { name: '全选当前页可释放预留', exact: true }).click()
  await expect(releases.getByRole('checkbox', { checked: true })).toHaveCount(2)
  await releases.getByRole('button', { name: '清空释放选择', exact: true }).click()
  await expect(releases.getByRole('checkbox', { checked: true })).toHaveCount(0)
  await expect(review.getByLabel('合成演示缝合材料 · 最终总量 3', { exact: true })).toHaveValue('2')
  await releases.getByRole('checkbox', { name: /释放剩余预留 · 合成演示冠脉支架/ }).check()
  await step('两条余量全选、清空后明确只选支架，清空选择保留全部输入')
  await page.reload()
  await openSurgeryBatchPatient(page, s, async () => {})
  await page.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  review = page.getByRole('dialog', { name: '核实最终耗材并完成手术', exact: true })
  await review.getByRole('button', { name: '有出入，改数量', exact: true }).click()
  await expect(review.getByLabel('合成演示缝合材料 · 最终总量 3', { exact: true })).toHaveValue('2')
  await expect(review.getByRole('checkbox', { checked: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '确认完成手术', exact: true })).toBeDisabled()
  let previews = 0, completePosts = 0, completeKey: string | undefined
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`${s.path}/surgeries/preview-completion`)) previews += 1 })
  await expect(page.getByRole('button', { name: '确认完成手术', exact: true })).toBeEnabled()
  await expect(review.getByRole('region', { name: '本次差额', exact: true })).toContainText('保留预留 · 合成演示冠脉球囊')
  await step('统一预览最终差额，支架释放、球囊保留，再一次完成手术')
  const beforeCompleteAudit = await auditCount('inpatient.surgery.complete')
  await page.route(`**${s.path}/surgeries/complete`, async route => {
    completePosts += 1
    completeKey = route.request().headers()['idempotency-key']
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientSurgeryResponseSchema.parse(await response.json())
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '确认完成手术', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复原住院操作', exact: true })).toBeVisible()
  await recoverSurgeryBatchWrite(page, s, s.completionRequestId, 'complete', completeKey, recovery)
  await expect(page.getByRole('region', { name: '最终耗材', exact: true })).toContainText('合成演示导管')
  expect({ executePosts, completePosts, previews }).toEqual({ executePosts: 1, completePosts: 1, previews: 1 })
  expect(await auditCount('inpatient.surgery.complete')).toBe(beforeCompleteAudit + 1)
  const final = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  expect(final.executions).toHaveLength(2)
  expect(final.inProgress).toEqual([])
  const completed = final.executions.find(row => row.requestId === s.completionRequestId)!
  expect(completed.materials).toHaveLength(4)
  expect(Object.fromEntries(completed.materials.map(row => [row.item.id, row.quantity]))).toEqual({
    'hospital-material-stent': 1, 'hospital-material-balloon': 1, 'hospital-material-suture': 2, 'hospital-material-catheter': 1,
  })
  const reservations = inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json()).reservations
  expect(reservations.find(row => row.requestId === s.completionRequestId && row.materialId === 'hospital-material-stent'))
    .toMatchObject({ status: 'released', consumedQuantity: 1, remainingQuantity: 0 })
  expect(reservations.find(row => row.requestId === s.completionRequestId && row.materialId === 'hospital-material-balloon'))
    .toMatchObject({ status: 'reserved', consumedQuantity: 1, remainingQuantity: 2 })
  expect(reservations.find(row => row.requestId === s.batchRequestId)).toMatchObject({ status: 'replaced', consumedQuantity: 2, remainingQuantity: 0 })
  const procedures = fhirBundleSchema.parse(await (await s.api.get(`/fhir/R5/Procedure?encounter=Encounter/${s.admissionId}&_total=accurate`)).json())
  expect(procedures.total).toBe(2)
  await s.api.login('cashier')
  const charges = inpatientChargesSchema.parse(await (await s.api.get(`${s.path}/charges`)).json())
  expect(charges.chargesFen).toBe(729000)
  expect(charges.charges.filter(row => row.kind === 'surgery')).toHaveLength(2)
  expect(charges.charges.filter(row => row.kind === 'material')).toHaveLength(6)
  await s.api.login('inpatient-doctor')
  await step('公开回读两台实际手术、六笔耗材费用与未选球囊余量，均无重复')
  return { executePosts, completePosts, previews, executeKey, completeKey, chargesFen: charges.chargesFen,
    procedureCount: procedures.total, executionIds: final.executions.map(row => row.id),
    reservations: reservations.map(({ id, requestId, materialId, status, consumedQuantity, remainingQuantity }) =>
      ({ id, requestId, materialId, status, consumedQuantity, remainingQuantity })) }
}
