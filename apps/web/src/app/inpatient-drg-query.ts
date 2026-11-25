import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import { inpatientDrgRecordChecksSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientDrgSimulationSchema, type InpatientDrgSimulationInput } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { apiGet, apiMutation } from './api-client.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'

/** 患者头部和 DRG 页共用同一观察者；隐藏页只保留缓存，不进行轮询。 */
export function useInpatientDrgQuery({ admission, session, active, draft, allowPlanSelection = true }: {
  admission: InpatientAdmission; session: SessionContext; active: boolean; draft?: InpatientDrgSimulationInput | undefined; allowPlanSelection?: boolean
}) {
  const scope = [...inpatientScopeKey(session), admission.id]
  const path = `/api/his/v1/inpatient/admissions/${admission.id}/drg`
  const archived = admission.recordStatus === 'archived'
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  const enabled = active && visible && !archived && admission.status !== 'registered'
  const selectPlan = allowPlanSelection && draft === undefined && !archived
  const surgery = useQuery({ queryKey: [...scope, 'surgeries'], enabled: enabled && selectPlan,
    refetchInterval: enabled && selectPlan ? 3_000 : false, refetchIntervalInBackground: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/surgeries`, inpatientSurgerySchema, signal) })
  const plans = (surgery.data?.requests ?? []).filter(item => item.status === 'requested' || item.status === 'ready'
    || (item.status === 'standby-pci' && item.adHocPci?.status === 'converted'))
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const primarySurgeryRequestId = selectPlan && plans.length > 1 && plans.some(item => item.id === selectedPlanId) ? selectedPlanId : null
  const simulationInput = draft ?? (primarySurgeryRequestId === null ? undefined : { medications: [], services: [], primarySurgeryRequestId })
  const grouping = useQuery({ queryKey: [...scope, 'drg-pregroup'], enabled: active && visible && archived, retry: false,
    queryFn: ({ signal }) => apiGet(`${path}/pregroup`, inpatientDrgPregroupResultSchema, signal) })
  const simulation = useQuery({ queryKey: [...scope, 'drg-simulation', simulationInput ?? null], enabled, retry: false,
    refetchInterval: enabled ? 3_000 : false, refetchIntervalInBackground: false,
    queryFn: ({ signal }) => apiMutation(`${path}/simulation`, inpatientDrgSimulationSchema, { input: simulationInput ?? {} }, { signal }) })
  const checks = useQuery({ queryKey: [...scope, 'drg-record-checks'], enabled: active && visible && selectPlan && admission.status !== 'registered', retry: false,
    refetchInterval: enabled && selectPlan ? 3_000 : false, refetchIntervalInBackground: false,
    queryFn: ({ signal }) => apiGet(`${path}/record-checks`, inpatientDrgRecordChecksSchema, signal) })
  // 术前准备拥有读取；这里只订阅同一缓存，避免另一组轮询。
  const estimates = useQuery({ queryKey: [...scope, 'material-estimates'], enabled: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/material-estimates`, inpatientMaterialEstimatesSchema, signal) })
  const planEstimates = (estimates.data?.estimates ?? []).filter(estimate => plans.some(plan => {
    const stage = plan.status === 'standby-pci' && plan.adHocPci?.status === 'converted' ? 'ad-hoc-pci' : 'primary'
    return plan.id === estimate.requestId && (estimate.surgeryStage ?? 'primary') === stage
  }))
  const previewEstimates = selectPlan ? planEstimates.filter(estimate => estimate.status !== 'cancelled'
    && !surgery.data?.inProgress.some(execution => execution.requestId === estimate.requestId)
    && (estimate.draft === null || estimate.draft.confirmedRevision !== estimate.draft.revision)) : []
  const referencePlanId = primarySurgeryRequestId ?? (plans.length === 1 ? plans[0]!.id : null)
  const selectedEstimateCosts = planEstimates.find(estimate => estimate.requestId === referencePlanId)?.costs
  // 未加载不等于空清单；disabled 缓存也不能一直盖过后来读到的完整费用。
  // 更新时间只用于选择最近观察到的投影，不作为服务端修订号。
  const useEstimateProjection = estimates.data !== undefined
    && (checks.data === undefined || checks.error !== null || estimates.dataUpdatedAt > checks.dataUpdatedAt)
  const checkedCosts = checks.error === null ? checks.data?.costs : undefined
  const referenceCosts = useEstimateProjection ? selectedEstimateCosts ?? checkedCosts : checkedCosts
  const data = simulation.error === null ? simulation.data : undefined
  const reservationBasis = data ? JSON.stringify(data.reserved.items.map((item): [string, number, number | null] => [item.id, item.quantity, item.estimatedFen])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) : undefined
  const pendingEstimates = previewEstimates.filter(estimate => estimate.materialDraftDeltaFen !== null && estimate.materialDraftReservationBasis !== null
    && JSON.stringify(estimate.materialDraftReservationBasis) === reservationBasis)
  const materialProjectionIncomplete = referenceCosts?.projectionComplete === false || useEstimateProjection && data !== undefined && previewEstimates.some(estimate => !pendingEstimates.includes(estimate)
    && (estimate.draft?.items.length ?? 0) > 0)
  const delta = pendingEstimates.reduce((sum, estimate) => sum + estimate.materialDraftDeltaFen!, 0)
  const sum = (items: NonNullable<typeof data>['reserved']['items']) => items.reduce((total, item) => total + (item.estimatedFen ?? 0), 0)
  // 仅读取显示投影，不覆盖 Query 的正式事实或审阅指纹。
  const components = (!selectPlan || useEstimateProjection) && data ? { formalChargesFen: data.formal.chargesFen,
      pendingOrdersFen: sum(data.committed.items.filter(item => item.kind !== 'surgery')),
      plannedSurgeryFen: sum(data.committed.items.filter(item => item.kind === 'surgery')),
      remainingMaterialsFen: sum(data.reserved.items) + delta, projectedTotalFen: data.coverage.estimatedTotalFen + delta }
    : referenceCosts?.components
  const plannedReference = [referenceCosts?.projectedPaymentReference, selectedEstimateCosts?.projectedPaymentReference]
    .find(reference => reference != null && reference.drgCode === data?.grouping.projected?.drgCode) ?? null
  const projectedCosts = data && referenceCosts && components ? { ...referenceCosts, components,
    currentGrouping: data.grouping.formal, projectedGrouping: data.grouping.projected,
    currentPaymentReference: data.paymentReference,
    projectedPaymentReference: plannedReference,
    currentDifferenceFen: materialProjectionIncomplete || data.paymentReference === null ? null : data.paymentReference.referenceFen - components.projectedTotalFen,
    projectedDifferenceFen: materialProjectionIncomplete || plannedReference === null ? null : plannedReference.referenceFen - components.projectedTotalFen,
  } : referenceCosts
  return { materialProjectionIncomplete, projectedCosts, scope, path, archived, visible, enabled, allowPlanSelection: selectPlan, surgery, plans, primarySurgeryRequestId,
    setSelectedPlanId, simulationInput, grouping, simulation, checks }
}

export type InpatientDrgQuery = ReturnType<typeof useInpatientDrgQuery>
