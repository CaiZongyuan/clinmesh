import { selectInpatientStage } from './inpatient-ui.ts'
import type { Page } from '@playwright/test'
import { inpatientSurgeryResponseSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientDrgSimulationSchema, inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { createDrgBrowserPatient, expect } from './inpatient-drg.fixture.ts'
import { openQueue } from './queue-overlay.fixture.ts'

type Patient = Awaited<ReturnType<typeof createDrgBrowserPatient>>

export async function runPostoperativeRecoveryConflictJourney(page: Page, s: Awaited<ReturnType<typeof preparePostoperativeMaterialsPatient>>, open: () => Promise<void>) {
  await open()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await selectInpatientStage(page, '手术')
  await page.getByRole('button', { name: '补登记与更正耗材', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '术后耗材补登记、更正与历史', exact: true })
  const entry = dialog.getByRole('region', { name: '补登记耗材', exact: true })
  await entry.getByLabel('耗材', { exact: true }).click()
  await page.getByRole('option', { name: '合成演示冠脉球囊', exact: true }).click()
  const note = entry.getByLabel('补登记依据', { exact: true }), basis = '合成断线恢复后保留的漏记依据'
  await note.fill(basis)
  const keys: Array<string | undefined> = []
  await page.route('**/surgeries/supplement-material', async route => {
    keys.push(route.request().headers()['idempotency-key'])
    if (keys.length === 1) await route.abort('failed')
    else await route.continue()
  })
  await entry.getByRole('button', { name: '确认补登记', exact: true }).click()
  const recover = dialog.getByRole('button', { name: '恢复原住院操作', exact: true })
  await expect(recover).toBeVisible()
  const state = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()), request = state.requests[0]!
  expect((await s.api.post(`${s.path}/surgeries/supplement-material`, {
    requestId: request.id, expectedRequestVersion: request.version, executionId: s.completed.id,
    note: '合成另一笔已保存的球囊使用', material: { materialId: 'hospital-material-balloon', catalogVersion: 1, quantity: 1 },
    expectedCharge: { id: 'hospital-charge-material-balloon', priceFen: 40000, unit: '个' },
  })).status()).toBe(200)
  await recover.click()
  const alert = dialog.getByRole('alert')
  await expect(alert).toContainText('手术申请或准备状态已变化，请刷新后重新核对。')
  await expect(recover).toHaveCount(0)
  await expect(note).toHaveValue(basis)
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])
  const read = page.waitForResponse(response => response.url().endsWith(`${s.path}/surgeries`) && response.request().method() === 'GET')
  await alert.getByRole('button', { name: '刷新目录与记录，保留编辑', exact: true }).click()
  expect((await read).status()).toBe(200)
  await expect(dialog.getByRole('row', { name: '合成演示冠脉球囊 × 1个', exact: true })).toHaveCount(1)
  await expect(note).toHaveValue(basis)
  await entry.getByRole('button', { name: '确认补登记', exact: true }).click()
  await expect(note).toHaveValue('')
  await expect(dialog.getByRole('row', { name: '合成演示冠脉球囊 × 1个', exact: true })).toHaveCount(2)
  expect(keys).toHaveLength(3)
  expect(keys[2]).not.toBe(keys[0])
  const saved = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).executions[0]!
  expect(saved.materialHistory.map(use => use.note)).toEqual(['合成另一笔已保存的球囊使用', basis])
  expect(inpatientDrgSimulationSchema.parse(await (await s.api.post(`${s.path}/drg/simulation`, {})).json()).formal.chargesFen).toBe(200000)
  await open()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await selectInpatientStage(page, '手术')
  await expect(page.getByRole('region', { name: '最终耗材', exact: true })).toContainText('合成演示冠脉球囊')
}

export async function preparePostoperativeMaterialsPatient(page: Page, app: Parameters<typeof createDrgBrowserPatient>[1]) {
  const s = await prepareSurgeryMaterialsPatient(page, app)
  const prepared = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()), request = prepared.requests[0]!
  const completed = inpatientSurgeryResponseSchema.parse(await (await s.api.post(`${s.path}/surgeries/execute`, {
    requestId: request.id, expectedRequestVersion: request.version, procedureId: 'hospital-surgery-1', catalogVersion: 1,
    materials: [], note: '合成已完成手术，术后发现漏记球囊',
  })).json()).data.executions[0]!
  const reservations = inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json()), reservation = reservations.reservations[0]!
  expect((await s.api.post(`${s.path}/drg/reservations/${reservation.id}/release`, { encounterVersion: reservations.encounterVersion, reason: '合成手术结束释放备用预留' })).status()).toBe(200)
  return { ...s, completed }
}

export async function runPostoperativeMaterialsJourney(page: Page, s: Awaited<ReturnType<typeof preparePostoperativeMaterialsPatient>>, open: () => Promise<void>, recoveryTarget: 'dialog' | 'workspace' = 'dialog') {
  await open()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await selectInpatientStage(page, '手术')
  await page.getByRole('button', { name: '补登记与更正耗材', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '术后耗材补登记、更正与历史', exact: true, includeHidden: true })
  const entry = dialog.getByRole('region', { name: '补登记耗材', exact: true })
  const submit = entry.getByRole('button', { name: '确认补登记', exact: true })
  await expect(submit).toBeDisabled()
  await entry.getByLabel('耗材', { exact: true }).click()
  await page.getByRole('option', { name: '合成演示冠脉球囊', exact: true }).click()
  await expect(submit).toBeDisabled()
  await entry.getByLabel('补登记依据', { exact: true }).fill('合成术后核实漏记一只球囊')
  await entry.getByLabel('数量', { exact: true }).fill('0')
  await expect(submit).toBeDisabled()
  await entry.getByLabel('数量', { exact: true }).fill('1')
  await expect(entry).toContainText('本笔新增费用 ¥400.00')
  let posts = 0, originalKey: string | undefined
  await page.route('**/surgeries/supplement-material', async route => {
    posts += 1
    originalKey = route.request().headers()['idempotency-key']
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    await route.abort('failed')
  })
  await submit.click()
  await expect(entry.getByLabel('补登记依据', { exact: true })).toHaveValue('合成术后核实漏记一只球囊')
  await expect(dialog.getByRole('button', { name: '恢复原住院操作', exact: true })).toBeVisible()
  if (recoveryTarget === 'workspace') {
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toBeHidden()
  }
  const recoveryButton = (recoveryTarget === 'dialog' ? dialog : page.getByRole('region', { name: '住院工作台', exact: true }))
    .getByRole('button', { name: '恢复原住院操作', exact: true })
  const recovery = page.waitForResponse(response => response.url().includes('/command-receipts?') && response.request().method() === 'GET')
  await recoveryButton.click()
  const receipt = await recovery
  expect(receipt.status()).toBe(200)
  expect(new URL(receipt.url()).searchParams.get('idempotencyKey')).toBe(originalKey)
  await expect(dialog.getByLabel('补登记依据', { exact: true })).toHaveValue('')
  if (recoveryTarget === 'workspace') {
    await expect(recoveryButton).toHaveCount(0)
    await page.getByRole('button', { name: '补登记与更正耗材', exact: true }).click()
  }
  await expect(dialog.getByRole('row', { name: '合成演示冠脉球囊 × 1个', exact: true })).toBeVisible()
  await expect(submit).toBeDisabled()
  await expect(dialog).toContainText('术后补登记')
  expect(posts).toBe(1)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('region', { name: '最终耗材', exact: true })).toContainText('合成演示冠脉球囊')
  const state = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()), execution = state.executions[0]!
  expect(state.inProgress).toEqual([])
  expect(execution).toMatchObject({ id: s.completed.id, completedAt: s.completed.completedAt, performedAt: s.completed.performedAt,
    materialHistory: [{ recordingKind: 'postoperative-addendum', quantity: 1, amountFen: 40000 }] })
  const simulation = inpatientDrgSimulationSchema.parse(await (await s.api.post(`${s.path}/drg/simulation`, {})).json())
  expect(simulation.formal.chargesFen).toBe(160000)
  expect(simulation.reserved.items).toEqual([])
  await page.getByRole('button', { name: '补登记与更正耗材', exact: true }).click()
  await dialog.getByRole('button', { name: '更正 合成演示冠脉球囊 × 1', exact: true }).click()
  await dialog.getByLabel('更正方式', { exact: true }).click()
  await page.getByRole('option', { name: '改数量（合成演示冠脉球囊）', exact: true }).click()
  await dialog.getByLabel('更正后数量', { exact: true }).fill('2')
  await dialog.getByLabel('更正依据', { exact: true }).fill('合成术后复核实际漏记两只球囊')
  await dialog.getByRole('button', { name: '确认更正', exact: true }).click()
  await expect(dialog.getByRole('row', { name: '合成演示冠脉球囊 × 2个', exact: true })).toContainText('术后补登记')
  expect(inpatientDrgSimulationSchema.parse(await (await s.api.post(`${s.path}/drg/simulation`, {})).json()).formal.chargesFen).toBe(200000)
  await dialog.getByRole('button', { name: '更正 合成演示冠脉球囊 × 2', exact: true }).click()
  await dialog.getByLabel('更正依据', { exact: true }).fill('合成术后复核撤销误补登记')
  await dialog.getByRole('button', { name: '确认更正', exact: true }).click()
  await expect.poll(async () => inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).executions[0]?.materials.length).toBe(0)
  expect(inpatientDrgSimulationSchema.parse(await (await s.api.post(`${s.path}/drg/simulation`, {})).json()).formal.chargesFen).toBe(120000)
}

export async function prepareSurgeryMaterialsPatient(page: Page, app: Parameters<typeof createDrgBrowserPatient>[1]) {
  const s = await createDrgBrowserPatient(page, app, '合成术中耗材逐笔患者')
  const surgery = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  const requested = inpatientSurgeryResponseSchema.parse(await (await s.api.post(`${s.path}/surgeries/request`, {
    encounterVersion: surgery.encounterVersion, procedureId: 'hospital-surgery-1', catalogVersion: 1,
    plannedFor: '2026-08-24T15:00:00+08:00', reason: '合成 PCI 逐笔耗材验证',
  })).json()).data.requests[0]!
  await s.api.login('ward-nurse')
  expect((await s.api.post(`${s.path}/surgeries/check-preop`, { requestId: requested.id, expectedRequestVersion: requested.version, note: '合成术前已核对' })).status()).toBe(200)
  await s.api.login('inpatient-doctor')
  const checked = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).requests[0]!
  expect((await s.api.post(`${s.path}/surgeries/confirm-consent`, { requestId: requested.id, expectedRequestVersion: checked.version, note: '合成签署已确认' })).status()).toBe(200)
  expect((await s.api.post(`${s.path}/drg/reservations`, { encounterVersion: surgery.encounterVersion,
    requestId: requested.id, materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 2, reason: '合成两枚支架备用' })).status()).toBe(200)
  return s
}

export async function runSurgeryMaterialsJourney(page: Page, s: Patient, open: () => Promise<void>) {
  const actions = page.getByRole('region', { name: '当前操作', exact: true })
  await open()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await selectInpatientStage(page, "手术")
  await page.getByRole('button', { name: '开始手术逐笔登记', exact: true }).click()
  const startDialog = page.getByRole('dialog', { name: '开始手术', exact: true })
  await startDialog.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: '00.6600 · 经皮冠状动脉腔内血管成形术[PTCA]', exact: true }).click()
  await startDialog.getByLabel('开始说明', { exact: true }).fill('合成开始术中逐笔记录')
  await startDialog.getByRole('button', { name: '开始手术', exact: true }).click()
  const panel = page.getByRole('region', { name: '本台耗材', exact: true })
  await expect(panel).toContainText('手术进行中')
  const entry = panel.getByRole('region', { name: '登记本笔使用', exact: true })
  await entry.getByLabel('耗材', { exact: true }).click()
  await page.getByRole('option', { name: /^合成演示冠脉支架/ }).click()
  await expect(entry).toContainText('本计划还预留 2 个')
  await entry.getByLabel('依据', { exact: true }).fill('合成第一枚支架实际使用')
  await entry.getByRole('button', { name: '登记这笔', exact: true }).click()
  await expect(panel.getByRole('row', { name: '合成演示冠脉支架 × 1个', exact: true })).toBeVisible()
  const partial = inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json()).reservations[0]!
  expect(partial).toMatchObject({ consumedQuantity: 1, remainingQuantity: 1, status: 'reserved' })
  expect(inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).executions).toEqual([])
  await expect(panel).toContainText('2 个 · 剩 1')
  await panel.getByRole('button', { name: '更正 合成演示冠脉支架 × 1', exact: true }).click()
  await panel.getByLabel('更正方式', { exact: true }).click()
  await page.getByRole('option', { name: '改数量（合成演示冠脉支架）', exact: true }).click()
  await panel.getByLabel('更正依据', { exact: true }).fill('同一部分预留核实更正原使用说明')
  await actions.getByRole('button', { name: '确认更正', exact: true }).click()
  await expect.poll(async () => inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).inProgress[0]?.materialHistory.length).toBe(2)
  const correctedReservation = inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json()).reservations[0]!
  expect(correctedReservation).toMatchObject({ consumedQuantity: 1, remainingQuantity: 1, status: 'reserved' })
  await expect(panel).toContainText('2 个 · 剩 1')
  await entry.getByLabel('耗材', { exact: true }).click()
  await page.getByRole('option', { name: '合成演示冠脉球囊', exact: true }).click()
  await entry.getByLabel('依据', { exact: true }).fill('合成临时增加球囊')
  await entry.getByRole('button', { name: '登记这笔', exact: true }).click()
  await expect(panel.getByRole('row', { name: '合成演示冠脉球囊 × 1个', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '更正 合成演示冠脉球囊 × 1', exact: true }).click()
  await panel.getByLabel('更正方式', { exact: true }).click()
  await page.getByRole('option', { name: '改数量（合成演示冠脉球囊）', exact: true }).click()
  await panel.getByLabel('更正后数量', { exact: true }).fill('2')
  await panel.getByLabel('更正依据', { exact: true }).fill('合成核实球囊实际为两枚')
  await actions.getByRole('button', { name: '确认更正', exact: true }).click()
  await expect(panel.getByRole('row', { name: '合成演示冠脉球囊 × 2个', exact: true })).toBeVisible()
  const evaluated = inpatientDrgSimulationSchema.parse(await (await s.api.post(`${s.path}/drg/simulation`, {})).json())
  expect(evaluated.formal.chargesFen).toBe(160000)
  await actions.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  const review = page.getByRole('dialog', { name: '核实最终耗材并完成手术', exact: true })
  await review.getByRole('checkbox', { name: /释放剩余预留/ }).check()
  await review.getByLabel('核实说明', { exact: true }).fill('合成 PCI 手术结束并明确释放备用余量')
  await page.getByRole('button', { name: '预览本次差额', exact: true }).click()
  await expect(review).toContainText('耗材差额合计 ¥0.00')
  await page.getByRole('button', { name: '确认完成手术', exact: true }).click()
  const done = page.getByRole('region', { name: '最终耗材', exact: true })
  await expect(done).toContainText('00.6600')
  await expect(done).toContainText('经皮冠状动脉腔内血管成形术[PTCA]')
  const final = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  expect(final.inProgress).toEqual([])
  expect(final.executions).toHaveLength(1)
  expect(final.executions[0]!.materialHistory).toHaveLength(4)
  const completion = inpatientDrgSimulationSchema.parse(await (await s.api.post(`${s.path}/drg/simulation`, {})).json())
  expect(completion.formal.chargesFen).toBe(280000)
  expect(completion.reserved.items).toEqual([])
}

export async function prepareFinalMaterialsPatient(page: Page, app: Parameters<typeof createDrgBrowserPatient>[1]) {
  const s = await prepareSurgeryMaterialsPatient(page, app)
  let state = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  const request = state.requests[0]!
  expect((await s.api.post(`${s.path}/drg/reservations`, { encounterVersion: state.encounterVersion, requestId: request.id,
    materialId: 'hospital-material-balloon', catalogVersion: 1, quantity: 2, reason: '合成未选备用球囊' })).status()).toBe(200)
  state = inpatientSurgeryResponseSchema.parse(await (await s.api.post(`${s.path}/surgeries/start`, { requestId: request.id,
    expectedRequestVersion: request.version, procedureId: 'hospital-surgery-1', catalogVersion: 1, note: '合成最终总量核实开始' })).json()).data
  for (const materialId of ['hospital-material-stent', 'hospital-material-balloon']) {
    const reservation = inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json()).reservations.find(item => item.materialId === materialId)!
    state = inpatientSurgeryResponseSchema.parse(await (await s.api.post(`${s.path}/surgeries/record-material`, {
      requestId: request.id, expectedRequestVersion: state.requests[0]!.version, executionId: state.inProgress[0]!.id, note: '合成核实前逐笔记录',
      material: { materialId, catalogVersion: 1, quantity: materialId === 'hospital-material-stent' ? 2 : 1,
        ...(materialId === 'hospital-material-stent' ? { reservationId: reservation.id, expectedReservationVersion: reservation.version } : {}) },
    })).json()).data
  }
  return s
}

export async function runFinalMaterialsJourney(page: Page, s: Patient, open: () => Promise<void>) {
  const actions = page.getByRole('region', { name: '当前操作', exact: true })
  await open()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await selectInpatientStage(page, "手术")
  const panel = page.getByRole('region', { name: '本台耗材', exact: true })
  await expect(panel).toBeVisible()
  await actions.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  let review = page.getByRole('dialog', { name: '核实最终耗材并完成手术', exact: true })
  await review.getByLabel('核实说明', { exact: true }).fill('合成取消审阅不写业务事实')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect(inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).executions).toEqual([])
  await actions.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  review = page.getByRole('dialog', { name: '核实最终耗材并完成手术', exact: true })
  await review.getByLabel('合成演示冠脉支架 · 最终总量 1', { exact: true }).fill('1')
  await review.getByLabel('合成演示冠脉球囊 · 最终总量 2', { exact: true }).fill('0')
  await review.getByRole('checkbox', { name: /释放剩余预留 · 合成演示冠脉支架/ }).check()
  await review.getByLabel('新增最终耗材', { exact: true }).click()
  await page.getByRole('option', { name: '合成演示缝合材料', exact: true }).click()
  await review.getByLabel('核实说明', { exact: true }).fill('核实支架一枚、球囊未用并新增缝线，保留未选预留')
  await page.getByRole('button', { name: '预览本次差额', exact: true }).click()
  await expect(review).toContainText('耗材差额合计 -¥1,180.00')
  await expect(review).toContainText('保留预留 · 合成演示冠脉球囊')
  await review.getByLabel('合成演示缝合材料 · 最终总量 4', { exact: true }).fill('2')
  await expect(page.getByRole('button', { name: '确认完成手术', exact: true })).toHaveCount(0)
  await review.getByLabel('合成演示缝合材料 · 最终总量 4', { exact: true }).fill('1')
  await review.getByRole('button', { name: '刷新核实依据，保留编辑', exact: true }).click()
  await page.getByRole('button', { name: '预览本次差额', exact: true }).click()
  await expect(page.getByRole('button', { name: '确认完成手术', exact: true })).toBeEnabled()
  let posts = 0, originalKey: string | undefined
  await page.route('**/surgeries/complete', async route => {
    posts += 1
    originalKey = route.request().headers()['idempotency-key']
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientSurgeryResponseSchema.parse(await response.json())
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '确认完成手术', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复原住院操作', exact: true })).toBeVisible()
  const receiptRequest = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  expect(new URL((await receiptRequest).url()).searchParams.get('idempotencyKey')).toBe(originalKey)
  const done = page.getByRole('region', { name: '最终耗材', exact: true })
  await expect(done).toContainText('00.6600')
  await expect(done).toContainText('经皮冠状动脉腔内血管成形术[PTCA]')
  expect(posts).toBe(1)
  const final = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  expect(final.inProgress).toEqual([])
  expect(final.executions[0]!.materials.map(item => [item.item.id, item.quantity])).toEqual([
    ['hospital-material-stent', 1], ['hospital-material-suture', 1],
  ])
  const reservationList = inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json())
  expect(reservationList.reservations.find(item => item.materialId === 'hospital-material-balloon')).toMatchObject({ status: 'reserved', remainingQuantity: 2 })
  expect(reservationList.reservations.find(item => item.materialId === 'hospital-material-stent')).toMatchObject({ status: 'released', consumedQuantity: 1 })
  const simulation = inpatientDrgSimulationSchema.parse(await (await s.api.post(`${s.path}/drg/simulation`, {})).json())
  expect(simulation.formal.chargesFen).toBe(202000)
}
