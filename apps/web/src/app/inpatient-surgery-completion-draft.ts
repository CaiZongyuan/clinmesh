import { z } from 'zod'
import type { inpatientSurgeryExecutionSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'

const rowSchema = z.object({
  key: z.string().min(1), materialId: z.string().min(1), catalogVersion: z.number().int().positive(),
  quantity: z.string(), materialUseIds: z.array(z.string().min(1)).max(1000),
  reservationId: z.string().min(1).optional(), expectedReservationVersion: z.number().int().positive().optional(),
  previousQuantity: z.number().int().nonnegative(), display: z.string().min(1), unit: z.string().nullable(),
  priceFen: z.number().int().nonnegative().safe(),
}).strict()
export const completionDraftSchema = z.object({ rows: z.array(rowSchema).max(1000), note: z.string().max(2000), noteSource: z.enum(['rule', 'doctor']).default('doctor'),
  releases: z.array(z.object({ reservationId: z.string().min(1), expectedReservationVersion: z.number().int().positive(), display: z.string().min(1) }).strict()).max(1000),
}).strict()
export type CompletionDraftRow = z.infer<typeof rowSchema>
export type CompletionRelease = z.infer<typeof completionDraftSchema>['releases'][number]

export function initialCompletionDraft(execution: z.infer<typeof inpatientSurgeryExecutionSchema>, reservations: InpatientMaterialReservation[], requestId: string) {
  const rows: CompletionDraftRow[] = [], grouped = new Map<string, CompletionDraftRow>()
  for (const use of execution.materialHistory.filter(use => use.correction === null)) {
    const key = JSON.stringify([use.item, use.reservationId]), row = grouped.get(key)
    if (row) { row.materialUseIds.push(use.id); row.previousQuantity += use.quantity; row.quantity = String(row.previousQuantity); continue }
    const reservation = reservations.find(item => item.id === use.reservationId)
    const next: CompletionDraftRow = { key: `use:${use.id}`, materialId: use.item.id, catalogVersion: use.item.version,
      materialUseIds: [use.id], quantity: String(use.quantity), previousQuantity: use.quantity, display: use.item.display,
      unit: use.item.chargeDefinition.unit, priceFen: use.item.chargeDefinition.priceFen,
      ...(use.reservationId ? { reservationId: use.reservationId, expectedReservationVersion: reservation?.version } : {}) }
    rows.push(next); grouped.set(key, next)
  }
  for (const reservation of reservations.filter(item => item.requestId === requestId && item.status === 'reserved')) {
    if (rows.some(row => row.reservationId === reservation.id) || reservation.catalogVersion === undefined || reservation.unit === null) continue
    rows.push({ key: `reservation:${reservation.id}`, materialId: reservation.materialId, catalogVersion: reservation.catalogVersion,
      materialUseIds: [], quantity: '0', previousQuantity: 0, display: reservation.materialDisplay, unit: reservation.unit,
      priceFen: reservation.priceFen, reservationId: reservation.id, expectedReservationVersion: reservation.version })
  }
  return { rows, note: '', noteSource: 'rule' as const, releases: [] }
}

export function validFinalQuantity(text: string) {
  return text.trim() !== '' && Number.isSafeInteger(Number(text)) && Number(text) >= 0 && Number(text) <= 1000
}

export function remainingAfterCompletion(reservation: InpatientMaterialReservation, rows: CompletionDraftRow[]) {
  const related = rows.filter(row => row.reservationId === reservation.id)
  if (related.some(row => !validFinalQuantity(row.quantity))) return null
  return reservation.quantity - reservation.consumedQuantity - related.reduce((sum, row) => sum + Number(row.quantity) - row.previousQuantity, 0)
}
