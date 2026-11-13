import { useState } from 'react'
import type { z } from 'zod'
import { pciSelectionProcedureCodes, type inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import type { inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { InpatientMaterialEstimate } from '@clinmesh/contracts/inpatient-material-estimate'
import type { WorkspaceLocale } from './workspace-i18n.ts'

type Plan = z.infer<typeof inpatientSurgeryRequestSchema>
type Selection = z.infer<typeof inpatientPciSelectionSchema>
const initialSurgeryView = { selectedRequestId: null as string | null, step1ConfirmedPlanId: null as string | null,
  editingStep1: false, editingStep2: false, selectionEditedAfterReserve: false }
export function useSurgeryView() { return useState(initialSurgeryView) }
export type SurgeryView = ReturnType<typeof useSurgeryView>

/** 推演的通用 fingerprint 包含收费、申请版本等；只有真实选型修订使已确认清单需要再核对。 */
export function surgeryPreparation(plan: Plan, selection: Selection | undefined, estimate: InpatientMaterialEstimate | undefined,
  view: SurgeryView[0] = initialSurgeryView, hasReservations = false) {
  const isPci = pciSelectionProcedureCodes.includes(plan.plannedProcedure.coding.code)
  const draft = selection?.drafts?.find(item => item.requestId === plan.id)
  const confirmation = selection?.confirmation?.parameters.requestId === plan.id ? selection.confirmation : undefined
  const planBasis = estimate?.planBasis
  const frozen = planBasis?.history.find(item => item.reference === planBasis.effectiveReference)
  const confirmed = Boolean(frozen || estimate?.draft && estimate.draft.confirmedRevision === estimate.draft.revision || hasReservations)
  const selectionChanged = confirmed && isPci && (view.selectionEditedAfterReserve
    || draft?.edited === true && draft.confirmedSelectionVersion === null
    || frozen?.sources.selectionVersion !== undefined && confirmation !== undefined && frozen.sources.selectionVersion !== confirmation.version)
  const selectionDone = !isPci || !view.editingStep1 && Boolean(confirmation || draft?.edited || confirmed || view.step1ConfirmedPlanId === plan.id)
  const materialsDone = confirmed && !selectionChanged && !view.editingStep2
  const needsMaterials = isPci || estimate !== undefined || hasReservations
  const step: 'selection' | 'materials' | 'consent' | 'nurse' | 'start' = !selectionDone ? 'selection' : needsMaterials && !materialsDone ? 'materials'
    : !plan.consentConfirmation ? 'consent' : !plan.preopCheck ? 'nurse' : 'start'
  return { step, selectionDone, materialsDone, selectionChanged, needsMaterials }
}

export function surgeryStepLabel(step: ReturnType<typeof surgeryPreparation>['step'], locale: WorkspaceLocale) {
  return (locale === 'zh-CN' ? { selection: '确认选型参数', materials: '确认手术耗材', consent: '确认手术知情同意书已签', nurse: '等病区护士术前核对', start: '开始手术' }
    : { selection: 'Confirm selection parameters', materials: 'Confirm surgical materials', consent: 'Confirm signed consent', nurse: 'Waiting for ward nurse preoperative checks', start: 'Start surgery' })[step]
}
