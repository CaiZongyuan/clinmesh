import { z } from 'zod'
import { inpatientSurgeryCompletionPreviewSchema, type inpatientSurgeryCompletionReviewInputSchema,
  type inpatientSurgeryExecutionSchema, type inpatientSurgeryCatalogSchema, type inpatientMaterialItemSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { InpatientMaterialReservationList } from '@clinmesh/contracts/inpatient-drg-simulation'
import { InpatientError } from './inpatient-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import type { ActorContext } from './command-executor.ts'

export type MaterialChargeBasis = Record<string, { chargeId: string; version: number; amountFen: number; reversalId: string | null }>

export function materialReductions(uses: Array<{ id: string; quantity: number }>, finalQuantity: number) {
  let reduction = uses.reduce((sum, use) => sum + use.quantity, 0) - finalQuantity
  return uses.toReversed().flatMap(use => {
    if (reduction <= 0) return []
    const quantity = Math.max(0, use.quantity - reduction)
    reduction -= use.quantity - quantity
    return [{ materialUseId: use.id, quantity }]
  })
}

/** 只规划原事件的增量和追加更正；写入仍由原手术 Command 负责。 */
export function planSurgeryCompletion(input: z.infer<typeof inpatientSurgeryCompletionReviewInputSchema>,
  execution: z.infer<typeof inpatientSurgeryExecutionSchema>, catalog: z.infer<typeof inpatientSurgeryCatalogSchema>,
  reservations: InpatientMaterialReservationList, reservationItems: Record<string, z.infer<typeof inpatientMaterialItemSchema>>,
  charges: MaterialChargeBasis, context: Pick<ActorContext, 'workspaceId' | 'epoch' | 'actorId' | 'practitionerRoleId'>) {
  const conflict = (message: string): never => { throw new InpatientError('INPATIENT_SURGERY_REVIEW_CONFLICT', message) }
  const seen = new Set<string>(), releases = new Set<string>(), reviewedReservationItems = new Set<string>()
  const reservationDeltas = new Map<string, number>()
  const materials = input.finalMaterials.map(row => {
    const uses = row.materialUseIds.map(id => {
      const use = execution.materialHistory.find(use => use.id === id && use.correction === null)
      if (!use || seen.has(id)) return conflict('实际使用来源缺失、重复或已更正，请重新核实')
      seen.add(id)
      if (use.item.id !== row.materialId || use.item.version !== row.catalogVersion || use.reservationId !== (row.reservationId ?? null))
        return conflict('实际使用的产品、版本或预留来源不能改写；新增用量请另列一项')
      return use
    })
    const first = uses[0]
    if (first && uses.some(use => JSON.stringify(use.item) !== JSON.stringify(first.item)))
      return conflict('不同冻结依据的实际使用须分别核实')
    const previousQuantity = uses.reduce((sum, use) => sum + use.quantity, 0), deltaQuantity = row.quantity - previousQuantity
    const reservation = row.reservationId === undefined ? undefined : reservations.reservations.find(item => item.id === row.reservationId)
    if (row.reservationId !== undefined && (!reservation || reservation.version !== row.expectedReservationVersion
      || reservation.materialId !== row.materialId || reservation.catalogVersion !== row.catalogVersion
      || (reservation.requestId !== undefined && reservation.requestId !== input.requestId)))
      return conflict('原预留身份、版本或手术归属已变化，请重新核实')
    const current = catalog.materials.find(item => item.id === row.materialId && item.version === row.catalogVersion)
    if (deltaQuantity > 0 && (!current || !('chargeDefinition' in current))) return conflict('新增用量的目录或单位已失效，请重新选择')
    if (reservation && deltaQuantity > 0 && (reservation.status === 'released' || reservation.releaseReason != null))
      return conflict('已关闭预留不能增加使用；额外使用请另列一项')
    const available = current && 'chargeDefinition' in current ? current : undefined
    if (!first && reservation && (reservation.unit === null || reservation.unit !== available?.chargeDefinition.unit))
      return conflict('原预留计价依据不完整或单位已变化，请核实原记录')
    const item = first?.item ?? (reservation ? reservationItems[reservation.id] : available)
    if (!item) return conflict('无法读取本项冻结依据，请重新核实')
    if (reservation) {
      const key = canonicalJsonHash({ reservationId: reservation.id, item })
      if (reviewedReservationItems.has(key)) conflict('同一原预留的相同冻结依据须合并核实')
      reviewedReservationItems.add(key)
      reservationDeltas.set(reservation.id, (reservationDeltas.get(reservation.id) ?? 0) + deltaQuantity)
    }
    if (reservation && (item.id !== reservation.materialId || item.version !== reservation.catalogVersion
      || item.chargeDefinition.priceFen !== reservation.priceFen || item.chargeDefinition.unit !== reservation.unit))
      return conflict('原预留与冻结计价依据不一致，请核实原记录')
    if (first && deltaQuantity > 0 && available && (item.chargeDefinition.unit !== available.chargeDefinition.unit
      || (!reservation && item.chargeDefinition.priceFen !== available.chargeDefinition.priceFen)))
      return conflict('原使用与当前目录的计价依据不同，新增用量请另列一项审阅')
    const deltaFen = deltaQuantity >= 0 ? deltaQuantity * item.chargeDefinition.priceFen
      : materialReductions(uses, row.quantity).reduce((sum, correction) => {
        const use = uses.find(use => use.id === correction.materialUseId)!, charge = charges[use.id]
        if (!charge || charge.amountFen !== use.amountFen) return conflict('原使用与费用不一致，请核实账务')
        return sum + correction.quantity * item.chargeDefinition.priceFen - (charge.reversalId === null ? charge.amountFen : 0)
      }, 0)
    return { item, materialUseIds: row.materialUseIds, reservationId: row.reservationId ?? null,
      previousQuantity, quantity: row.quantity, deltaQuantity, deltaFen }
  })
  if (seen.size !== execution.materials.length) conflict('须核实本手术全部当前有效使用，不能遗漏或覆盖历史更正')
  for (const [id, deltaQuantity] of reservationDeltas) {
    const reservation = reservations.reservations.find(item => item.id === id)!
    const consumedQuantity = reservation.consumedQuantity + deltaQuantity
    if (consumedQuantity < 0 || consumedQuantity > reservation.quantity)
      conflict('本次净用量超过原预留余量；额外使用请另列一项')
  }
  for (const selected of input.releaseReservations) {
    const reservation = reservations.reservations.find(item => item.id === selected.reservationId)
    if (!reservation || releases.has(selected.reservationId) || reservation.requestId !== input.requestId
      || reservation.status === 'released' || reservation.version !== selected.expectedReservationVersion)
      conflict('只能明确释放本手术当前版本的原预留')
    releases.add(selected.reservationId)
  }
  const materialDeltaFen = materials.reduce((sum, row) => sum + row.deltaFen, 0)
  const procedureAmountFen = execution.actualProcedure.chargeDefinition.priceFen
  return inpatientSurgeryCompletionPreviewSchema.parse({
    fingerprint: canonicalJsonHash({ input, execution, catalog, reservations, reservationItems, charges, context }),
    materials, materialDeltaFen, procedureAmountFen, totalDeltaFen: materialDeltaFen + procedureAmountFen,
    retainedReservations: reservations.reservations.flatMap(item => {
      if (item.requestId !== input.requestId || item.status === 'released' || item.releaseReason != null || releases.has(item.id)) return []
      const consumedQuantity = item.consumedQuantity + (reservationDeltas.get(item.id) ?? 0)
      const remainingQuantity = item.quantity - consumedQuantity
      return remainingQuantity > 0 ? [{ ...item, status: 'reserved' as const, consumedQuantity, remainingQuantity }] : []
    }),
  })
}
