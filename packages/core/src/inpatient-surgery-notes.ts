import type { InpatientMaterialPlan, InpatientMaterialPlanBasis } from '@clinmesh/contracts/inpatient-material-plan'

export const DEFAULT_ROUTINE_START_NOTE = '按计划术式开始手术'
export const DEFAULT_ROUTINE_EXECUTE_NOTE = '按计划术式及预留实施手术'
export const DEFAULT_ROUTINE_MATERIAL_NOTE = '按本台预留消耗'
export const DEFAULT_AD_HOC_PCI_CONVERSION_NOTE = '冠脉造影明确血运重建指征，台内直接转行同台 PCI'
export const DEFAULT_STANDBY_FINALIZATION_NOTE = '冠脉造影评估无需同台 PCI，仅完成造影结束本台手术'

export interface ProcedureIdentity {
  id: string
  coding: { code: string }
}

export function isSamePlannedProcedure(actual: ProcedureIdentity, planned: ProcedureIdentity): boolean {
  return actual.id === planned.id && actual.coding.code === planned.coding.code
}

export function resolveMaterialPlanBasis(planBasis: InpatientMaterialPlanBasis | undefined): {
  plan: InpatientMaterialPlan | undefined
  unverifiable: boolean
} {
  const unverifiable = planBasis !== undefined && (planBasis.status === 'conflict' || planBasis.status === 'unverifiable')
  const plan = planBasis?.history.find(item => item.reference === planBasis.effectiveReference)
  return { plan, unverifiable }
}

export function formatPlannedReservationMaterialNote(reservationReason: string | undefined): string {
  const reason = reservationReason?.trim()
  return reason ? `按计划 · ${reason}`.slice(0, 2000) : DEFAULT_ROUTINE_MATERIAL_NOTE
}

export function evaluateExecuteNoteRequirement(params: {
  actual: ProcedureIdentity
  planned: ProcedureIdentity
  materials: ReadonlyArray<{ materialId: string; catalogVersion: number; quantity: number; reservationId?: string | null | undefined }>
  activeRequestReservations: ReadonlyArray<{ id: string; quantity: number }>
  planBasis?: InpatientMaterialPlanBasis | undefined
}): { noteRequired: boolean; procedureChanged: boolean } {
  const procedureChanged = !isSamePlannedProcedure(params.actual, params.planned)
  const allBoundToRequestReservations = params.materials.every(row =>
    Boolean(row.reservationId) && params.activeRequestReservations.some(item => item.id === row.reservationId))
  const noUnconsumedRequestReservations = params.activeRequestReservations.every(item =>
    params.materials.some(row => row.reservationId === item.id && row.quantity === item.quantity))
  const { plan, unverifiable } = resolveMaterialPlanBasis(params.planBasis)
  const matchesConfirmedPlan = !unverifiable && (!plan || (
    plan.items.every(item => params.materials.some(row =>
      row.materialId === item.materialId && row.catalogVersion === item.catalogVersion && row.quantity === item.quantity))
    && params.materials.every(row => plan.items.some(item =>
      item.materialId === row.materialId && item.catalogVersion === row.catalogVersion && item.quantity === row.quantity))
  ))
  return {
    procedureChanged,
    noteRequired: procedureChanged || !allBoundToRequestReservations || !noUnconsumedRequestReservations || !matchesConfirmedPlan,
  }
}

export function evaluateCompletionNoteRequirement(params: {
  finalMaterials: ReadonlyArray<{
    materialId: string
    catalogVersion: number
    quantity: number
    deltaQuantity: number
    reservationId: string | null
  }>
  requestReservationIds: ReadonlySet<string>
  hasUnusedReservation: boolean
  planBasis?: InpatientMaterialPlanBasis | undefined
  samePlannedProcedure: boolean
}): {
  noteRequired: boolean
  hasExplainedExtraUse: boolean
  defaultNote: string
} {
  const { plan, unverifiable } = resolveMaterialPlanBasis(params.planBasis)
  const quantityByVersion = (materialId: string, catalogVersion: number) => params.finalMaterials
    .filter(row => row.materialId === materialId && row.catalogVersion === catalogVersion)
    .reduce((sum, row) => sum + row.quantity, 0)
  const hasQuantityDelta = params.finalMaterials.some(row => row.deltaQuantity !== 0)
  const hasUnusedPlan = plan !== undefined && plan.items.some(item => quantityByVersion(item.materialId, item.catalogVersion) < item.quantity)
  const noteRequired = hasQuantityDelta || params.hasUnusedReservation || unverifiable || hasUnusedPlan
  const hasPlanExcess = plan !== undefined && (
    plan.items.some(item => quantityByVersion(item.materialId, item.catalogVersion) > item.quantity)
    || params.finalMaterials.some(row => row.quantity > 0 && !plan.items.some(item => item.materialId === row.materialId && item.catalogVersion === row.catalogVersion))
  )
  const hasUnreservedRetainedUse = params.finalMaterials.some(row =>
    row.quantity > 0 && (row.reservationId === null || !params.requestReservationIds.has(row.reservationId)))
  const hasExplainedExtraUse = !noteRequired && (hasPlanExcess || hasUnreservedRetainedUse)
  const defaultNote = hasExplainedExtraUse
    ? '最终用量按术中已登记量核实，偏离原因已在术中登记'
    : params.samePlannedProcedure
      ? '最终耗材经核实无差额，按计划完成手术'
      : '最终耗材经核实无差额，按术中调整术式完成手术'
  return { noteRequired, hasExplainedExtraUse, defaultNote }
}

export function mergeExecutionCompletionNote(startNote: string, completionNote: string, explicitCompletionNote: boolean): string {
  const trimmedStart = startNote.trim()
  if (explicitCompletionNote || !trimmedStart || trimmedStart === DEFAULT_ROUTINE_START_NOTE) return completionNote
  return `${trimmedStart}；${completionNote}`.slice(0, 2000)
}
