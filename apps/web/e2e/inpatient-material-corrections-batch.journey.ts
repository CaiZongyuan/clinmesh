import type { Page } from '@playwright/test'
import { z } from 'zod'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientSurgeryCorrectMaterialInputSchema, inpatientSurgeryResponseSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { expect } from './inpatient-drg.fixture.ts'
import { prepareFinalMaterialsPatient } from './inpatient-surgery-materials.journey.ts'
import { selectInpatientStage } from './inpatient-ui.ts'
import { openQueue } from './queue-overlay.fixture.ts'

const stentLabel = '合成演示冠脉支架 × 2'
const balloonLabel = '合成演示冠脉球囊 × 1'
const commonReason = '合成核实：逐笔核对术后实际耗材'
const balloonReason = '合成逐项依据：球囊实际未使用，撤销原登记'

export async function prepareMaterialCorrectionsBatchPatient(page: Page, app: Parameters<typeof prepareFinalMaterialsPatient>[1]) {
  const s = await prepareFinalMaterialsPatient(page, app)
  const before = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  const request = before.requests[0]!, execution = before.inProgress[0]!
  const completed = await s.api.post(`${s.path}/surgeries/complete`, {
    requestId: request.id, expectedRequestVersion: request.version, executionId: execution.id,
    note: '合成已完成手术，术后按原使用记录核对更正',
  })
  expect(completed.status()).toBe(200)
  const initial = inpatientSurgeryResponseSchema.parse(await completed.json()).data
  expect(initial.executions).toHaveLength(1)
  expect(initial.inProgress).toEqual([])
  expect(initial.executions[0]!.materialHistory.map(use => [use.item.id, use.quantity])).toEqual([
    ['hospital-material-stent', 2], ['hospital-material-balloon', 1],
  ])
  const reservations = inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json())
  await s.api.login('cashier')
  const initialCharges = inpatientChargesSchema.parse(await (await s.api.get(`${s.path}/charges`)).json())
  expect(initialCharges.chargesFen).toBe(320000)
  await s.api.login('inpatient-doctor')
  return { ...s, requestId: request.id, executionId: execution.id, initial,
    stentReservation: reservations.reservations.find(row => row.materialId === 'hospital-material-stent')!,
    balloonReservation: reservations.reservations.find(row => row.materialId === 'hospital-material-balloon')! }
}

type Patient = Awaited<ReturnType<typeof prepareMaterialCorrectionsBatchPatient>>

async function openCorrections(page: Page, s: Patient, open: () => Promise<void>) {
  await open()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await selectInpatientStage(page, '手术')
  const trigger = page.getByRole('button', { name: '更正耗材', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '术后耗材更正与历史', exact: true })
  await expect(dialog).toBeVisible()
  return { dialog, trigger }
}

export async function runMaterialCorrectionsBatchJourney(page: Page, s: Patient, open: () => Promise<void>, step: (caption: string) => Promise<void> = async () => {}) {
  const read = async () => inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  const auditCount = async () => {
    const bundle = fhirBundleSchema.parse(await (await s.api.get('/fhir/R5/AuditEvent?_total=accurate&_count=100')).json())
    expect(bundle.entry).toHaveLength(bundle.total!)
    return bundle.entry!.map(entry => z.object({ code: z.object({ text: z.string() }),
      outcome: z.object({ code: z.object({ code: z.string() }) }) }).loose().parse(entry.resource))
      .filter(event => event.code.text === 'inpatient.surgery.correct-material' && event.outcome.code.code === '0').length
  }
  const beforeAudit = await auditCount()
  let { dialog, trigger } = await openCorrections(page, s, open)
  await dialog.getByRole('button', { name: `更正 ${stentLabel}`, exact: true }).click()
  await dialog.getByRole('button', { name: `更正 ${balloonLabel}`, exact: true }).click()
  let draft = dialog.getByRole('region', { name: '待更正清单', exact: true })
  await expect(draft.getByRole('article')).toHaveCount(2)
  await draft.getByLabel(`更正方式 ${stentLabel}`, { exact: true }).click()
  await page.getByRole('option', { name: '改数量', exact: true }).click()
  await draft.getByLabel(`更正后数量 ${stentLabel}`, { exact: true }).fill('1')
  await draft.getByLabel(`替换预留 ${stentLabel}`, { exact: true }).click()
  await page.getByRole('option', { name: /合成演示冠脉支架/ }).click()
  await dialog.getByLabel('共同更正依据', { exact: true }).fill(commonReason)
  await draft.getByLabel(`逐项更正依据 ${balloonLabel}`, { exact: true }).fill(balloonReason)
  await step('同一已完成手术连续准备两笔更正，支架改实际数量、球囊撤销，分别核对原用量与理由')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(draft.getByLabel(`更正后数量 ${stentLabel}`, { exact: true })).toHaveValue('1')
  await page.reload()
  ;({ dialog } = await openCorrections(page, s, async () => {}))
  draft = dialog.getByRole('region', { name: '待更正清单', exact: true })
  await expect(draft.getByRole('article')).toHaveCount(2)
  await expect(dialog.getByLabel('共同更正依据', { exact: true })).toHaveValue(commonReason)
  await expect(draft.getByLabel(`更正后数量 ${stentLabel}`, { exact: true })).toHaveValue('1')
  await expect(draft.getByLabel(`逐项更正依据 ${balloonLabel}`, { exact: true })).toHaveValue(balloonReason)
  await step('关闭重开和刷新保留两笔输入与各自理由，未提交时原用量和费用保持')
  expect((await read()).executions[0]!.materialHistory).toHaveLength(2)
  let posts = 0
  const keys: string[] = [], versions: number[] = []
  await page.route(`**${s.path}/surgeries/correct-material`, async route => {
    posts += 1
    keys.push(route.request().headers()['idempotency-key']!)
    const input = inpatientSurgeryCorrectMaterialInputSchema.omit({ admissionId: true }).parse(
      z.object({ input: z.unknown() }).parse(route.request().postDataJSON()).input)
    versions.push(input.expectedRequestVersion)
    expect(input.requestId).toBe(s.requestId)
    expect(input.executionId).toBe(s.executionId)
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientSurgeryResponseSchema.parse(await response.json())
    if (posts === 2) await route.abort('failed'); else await route.fulfill({ response })
  })
  await dialog.getByRole('button', { name: '集中核对更正', exact: true }).click()
  const review = dialog.getByRole('region', { name: '更正核对清单', exact: true })
  await expect(review).toContainText(commonReason)
  await expect(review).toContainText(balloonReason)
  await step('集中核对每笔原登记、实际替换数量、预留关系及最终更正依据')
  await review.getByRole('button', { name: '确认更正', exact: true }).click()
  await expect.poll(() => posts).toBe(2)
  await expect(dialog.getByRole('button', { name: '恢复原更正结果', exact: true })).toBeEnabled()
  await expect(draft.getByRole('article', { name: stentLabel, exact: true })).toHaveCount(0)
  await expect(draft.getByLabel(`逐项更正依据 ${balloonLabel}`, { exact: true })).toHaveValue(balloonReason)
  expect(versions).toEqual([s.initial.requests[0]!.version, s.initial.requests[0]!.version + 1])
  await step('第一笔更正已生效；第二笔响应丢失后停止办理，保留原尝试供恢复')
  await page.reload()
  ;({ dialog } = await openCorrections(page, s, async () => {}))
  const receiptRequest = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await dialog.getByRole('button', { name: '恢复原更正结果', exact: true }).click()
  expect(new URL((await receiptRequest).url()).searchParams.get('idempotencyKey')).toBe(keys[1])
  await expect(dialog.getByRole('button', { name: '恢复原更正结果', exact: true })).toHaveCount(0)
  const results = dialog.getByRole('region', { name: '逐项更正结果', exact: true })
  await expect(results).toContainText(commonReason)
  await expect(results).toContainText(balloonReason)
  expect(posts).toBe(2)
  expect(new Set(keys).size).toBe(2)
  for (const idempotencyKey of keys) {
    const receipt = commandReceiptLookupSchema.parse(await (await s.api.get(`/api/his/v1/command-receipts?operationId=inpatient.surgery.correct-material&idempotencyKey=${idempotencyKey}`)).json())
    expect(receipt.status).toBe('completed')
    inpatientSurgeryResponseSchema.parse(receipt.response)
  }
  const final = await read(), execution = final.executions[0]!
  expect(final.executions).toHaveLength(1)
  expect(final.inProgress).toEqual([])
  expect(execution.materialHistory).toHaveLength(3)
  expect(execution.materials.map(use => [use.item.id, use.quantity])).toEqual([['hospital-material-stent', 1]])
  const originalStent = execution.materialHistory.find(use => use.id === s.initial.executions[0]!.materialHistory[0]!.id)!
  const originalBalloon = execution.materialHistory.find(use => use.id === s.initial.executions[0]!.materialHistory[1]!.id)!
  expect(originalStent).toMatchObject({ quantity: 2, reservationId: s.stentReservation.id, correction: { note: commonReason } })
  expect(originalStent.correction!.replacementMaterialUseId).toBe(execution.materials[0]!.id)
  expect(originalBalloon).toMatchObject({ quantity: 1, reservationId: null, correction: { note: balloonReason, replacementMaterialUseId: null } })
  const reservations = inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json())
  expect(reservations.reservations.find(row => row.id === s.stentReservation.id)).toMatchObject({ consumedQuantity: 1, remainingQuantity: 1, status: 'reserved' })
  expect(reservations.reservations.find(row => row.id === s.balloonReservation.id)).toEqual(s.balloonReservation)
  const audits = await auditCount() - beforeAudit
  expect(audits).toBe(2)
  await s.api.login('cashier')
  const charges = inpatientChargesSchema.parse(await (await s.api.get(`${s.path}/charges`)).json())
  await s.api.login('inpatient-doctor')
  expect(charges.chargesFen).toBe(200000)
  expect(charges.charges.filter(charge => charge.reversalOf)).toEqual(expect.arrayContaining([
    expect.objectContaining({ reversalOf: originalStent.chargeId, amountFen: -160000 }),
    expect.objectContaining({ reversalOf: originalBalloon.chargeId, amountFen: -40000 }),
  ]))
  expect(charges.charges.filter(charge => charge.reversalOf)).toHaveLength(2)
  await step('原回执恢复完成，两笔更正各生效一次；原登记和冲正记录保留，实际只用一枚支架')
  return { posts, keys, audits, chargesFen: charges.chargesFen, historyCount: execution.materialHistory.length }
}
