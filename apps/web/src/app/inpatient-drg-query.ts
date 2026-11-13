import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import { inpatientDrgRecordChecksSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientDrgSimulationSchema, type InpatientDrgSimulationInput } from '@clinmesh/contracts/inpatient-drg-simulation'
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
  const plans = (surgery.data?.requests ?? []).filter(item => item.status === 'requested' || item.status === 'ready')
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
  return { scope, path, archived, visible, enabled, allowPlanSelection: selectPlan, surgery, plans, primarySurgeryRequestId,
    setSelectedPlanId, simulationInput, grouping, simulation, checks }
}

export type InpatientDrgQuery = ReturnType<typeof useInpatientDrgQuery>
