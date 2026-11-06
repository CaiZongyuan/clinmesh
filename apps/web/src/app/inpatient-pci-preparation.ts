import { useQuery } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientMaterialEstimatesSchema, type InpatientMaterialEstimate } from '@clinmesh/contracts/inpatient-material-estimate'
import type { inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { z } from 'zod'
import { apiGet } from './api-client.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function useInpatientPciPreparation({ admission, session, plans, allPlans = plans, locale }: {
  admission: InpatientAdmission; session: SessionContext; plans: readonly z.infer<typeof inpatientSurgeryRequestSchema>[]; allPlans?: readonly z.infer<typeof inpatientSurgeryRequestSchema>[]; locale: WorkspaceLocale
}) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const isDoctorAdmitted = session.actor.roleCode === 'inpatient-doctor' && admission.status === 'admitted' && admission.recordStatus !== 'archived'
  const enabled = isDoctorAdmitted && plans.length > 0
  const estimatesEnabled = isDoctorAdmitted && allPlans.length > 0
  const scope = [...inpatientScopeKey(session), admission.id], path = `/api/his/v1/inpatient/admissions/${admission.id}`
  const selection = useQuery({ queryKey: [...scope, 'pci-selection'], enabled, retry: false,
    queryFn: ({ signal }) => apiGet(`${path}/pci-selection`, inpatientPciSelectionSchema, signal),
    refetchInterval: enabled ? 3_000 : false, refetchIntervalInBackground: false })
  const estimates = useQuery({ queryKey: [...scope, 'material-estimates'], enabled: estimatesEnabled, retry: false,
    queryFn: ({ signal }) => apiGet(`${path}/material-estimates`, inpatientMaterialEstimatesSchema, signal),
    refetchInterval: estimatesEnabled ? 3_000 : false, refetchIntervalInBackground: false })
  const estimateStatus = (status: InpatientMaterialEstimate['status'] | undefined, selReady: boolean) => status === undefined ? (selReady ? t('待你确认', 'Awaiting confirmation') : t('等选型', 'Awaiting selection')) : {
    incomplete: selReady ? t('待你确认', 'Awaiting confirmation') : t('等选型', 'Awaiting selection'),
    queued: t('生成中', 'Generating'),
    running: t('生成中', 'Generating'),
    succeeded: t('待你确认', 'Awaiting confirmation'),
    stale: t('待你核对', 'Review needed'),
    blocked: t('未能预填', 'Prefill unavailable'),
    unknown: t('未能预填', 'Prefill unavailable'),
    failed: t('未能预填', 'Prefill unavailable'),
    cancelled: t('已取消', 'Cancelled'),
  }[status]
  const items = enabled ? plans.flatMap(plan => {
    const estimate = estimates.error === null ? estimates.data?.estimates.find(item => item.requestId === plan.id) : undefined
    const matConfirmed = Boolean(estimate?.draft && estimate.draft.confirmedRevision === estimate.draft.revision)
    const draft = selection.error === null ? selection.data?.drafts?.find(item => item.requestId === plan.id) : undefined
    const manualConfirmed = selection.error === null && selection.data?.confirmation?.parameters.requestId === plan.id
    const draftReady = draft !== undefined && draft.parameters.targetSite !== null && draft.parameters.measurements.length > 0
      && draft.parameters.measurements.some(item => item.value !== null && item.unit !== null)
    const selConfirmed = Boolean(manualConfirmed || draft?.edited || matConfirmed)
    const analysis = estimate?.analysis
    const fresh = estimate?.status === 'succeeded' && analysis?.basisFingerprint === estimate.basisFingerprint
    const materialReady = fresh && analysis !== null && analysis !== undefined && analysis.items.length > 0
    const loading = t('正在读取', 'Loading'), failed = t('读取失败，请重试', 'Could not load; retry')
    return [
      { kind: 'selection', label: t('选型参数', 'Selection parameters'), ready: draftReady || selConfirmed,
        active: Boolean(selection.error || draft || selConfirmed),
        status: selection.error ? failed : selection.isPending ? loading : selConfirmed ? t('已确认', 'Confirmed') : draft ? draftReady ? t('待你确认', 'Awaiting confirmation') : t('测量待补齐', 'Measurements incomplete')
          : t('尚无造影报告，可手填', 'No angiography report; enter manually') },
      { kind: 'materials', label: t('手术耗材', 'Surgical materials'), ready: selection.error === null && (materialReady || matConfirmed || Boolean(estimate && estimate.status !== 'cancelled')),
        active: Boolean(estimates.error || matConfirmed || (estimate && estimate.status !== 'incomplete') || draftReady || selConfirmed),
        status: estimates.error ? failed : estimates.isPending ? loading : matConfirmed ? t('已预留', 'Reserved') : estimateStatus(estimate?.status, selConfirmed) },
    ].map(item => ({ ...item, requestId: plan.id, planLabel: `${plan.plannedProcedure.coding.display} · ${plan.reason}` }))
  }) : []
  const showPrepared = items.some(item => item.ready)
  const hasEstimateUsage = (estimates.data?.estimates ?? []).some(item => item.status !== 'incomplete')
  return { items, showPrepared, readyCount: items.filter(item => item.ready).length, hasEstimateUsage, selectionData: selection.data, estimatesData: estimates.data }
}
