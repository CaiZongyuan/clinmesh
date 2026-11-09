import { z } from 'zod'
import { inpatientMaterialReservationSchema, type InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'

export const reservationInputRowSchema = z.object({
  id: z.string().min(1), revision: z.string().min(1), selected: z.boolean(),
  materialId: z.string().min(1), catalogVersion: z.number().int().positive().optional(),
  display: z.string().min(1), unit: z.string().nullable(), priceFen: z.number().int().nonnegative(),
  quantity: z.string(), reason: z.string(), reservation: inpatientMaterialReservationSchema.optional(),
}).strict()
export const reservationInputSchema = z.object({ rows: z.array(reservationInputRowSchema).max(1000), commonReason: z.string() }).strict()
export type ReservationInputRow = z.infer<typeof reservationInputRowSchema>
export type ReservationInput = z.infer<typeof reservationInputSchema>

export function reservationRemaining(item: InpatientMaterialReservation) {
  return item.remainingQuantity ?? (item.status === 'reserved' ? item.quantity - item.consumedQuantity : 0)
}

export function reservationReason(row: ReservationInputRow, commonReason: string) {
  return (row.reason.trim() || commonReason.trim())
}

export function validReservationQuantity(quantity: string) {
  return quantity.trim() !== '' && Number.isSafeInteger(Number(quantity)) && Number(quantity) >= 1 && Number(quantity) <= 1000
}

export function releaseInputRow(reservation: InpatientMaterialReservation, previous?: ReservationInputRow): ReservationInputRow {
  return { id: reservation.id, revision: crypto.randomUUID(), selected: true, materialId: reservation.materialId,
    ...(reservation.catalogVersion === undefined ? {} : { catalogVersion: reservation.catalogVersion }),
    display: reservation.materialDisplay, unit: reservation.unit, priceFen: reservation.priceFen,
    quantity: String(reservationRemaining(reservation)), reason: previous?.reason ?? '', reservation }
}
