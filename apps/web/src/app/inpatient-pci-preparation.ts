import { useQuery } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientMaterialEstimatesSchema, type InpatientMaterialEstimate } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientGuidelineAdviceListSchema } from '@clinmesh/contracts/inpatient-guideline-advice'
import type { inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { z } from 'zod'
import { apiGet } from './api-client.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function useInpatientPciPreparation({ admission, session, plans, locale }: {
  admission: InpatientAdmission; session: SessionContext; plans: readonly z.infer<typeof inpatientSurgeryRequestSchema>[]; locale: WorkspaceLocale
}) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const enabled = session.actor.roleCode === 'inpatient-doctor' && admission.status === 'admitted'
    && admission.recordStatus !== 'archived' && plans.length > 0
  const scope = [...inpatientScopeKey(session), admission.id], path = `/api/his/v1/inpatient/admissions/${admission.id}`
  const selection = useQuery({ queryKey: [...scope, 'pci-selection'], enabled, retry: false,
    queryFn: ({ signal }) => apiGet(`${path}/pci-selection`, inpatientPciSelectionSchema, signal),
    refetchInterval: enabled ? 3_000 : false, refetchIntervalInBackground: false })
  const estimates = useQuery({ queryKey: [...scope, 'material-estimates'], enabled, retry: false,
    queryFn: ({ signal }) => apiGet(`${path}/material-estimates`, inpatientMaterialEstimatesSchema, signal),
    refetchInterval: enabled ? 3_000 : false, refetchIntervalInBackground: false })
  const guidelines = useQuery({ queryKey: [...scope, 'guideline-advice'], enabled, retry: false,
    queryFn: ({ signal }) => apiGet(`${path}/guideline-advice`, inpatientGuidelineAdviceListSchema, signal),
    refetchInterval: enabled ? 3_000 : false, refetchIntervalInBackground: false })
  const estimateStatus = (status: InpatientMaterialEstimate['status'] | undefined) => status === undefined ? t('尚未准备', 'Not prepared') : {
    incomplete: t('待补充资料', 'More information needed'), queued: t('正在准备', 'Preparing'), running: t('正在生成并核验', 'Generating and verifying'),
    succeeded: t('已准备', 'Prepared'), stale: t('依据已变化，需更新', 'Sources changed; update needed'),
    blocked: t('暂不可用，请核对设置与权限', 'Unavailable; check settings and permissions'),
    unknown: t('结果未知，先核查原请求', 'Outcome unknown; check the original request'),
    failed: t('生成或核验失败', 'Generation or verification failed'), cancelled: t('已取消', 'Cancelled'),
  }[status]
  const items = enabled ? plans.flatMap(plan => {
    const estimate = estimates.error === null ? estimates.data?.estimates.find(item => item.requestId === plan.id) : undefined
    if (estimate?.draft && estimate.draft.confirmedRevision === estimate.draft.revision) return []
    const draft = selection.error === null ? selection.data?.drafts?.find(item => item.requestId === plan.id) : undefined
    const manualConfirmed = selection.error === null && selection.data?.confirmation?.parameters.requestId === plan.id
    const draftReady = draft !== undefined && draft.parameters.targetSite !== null && draft.parameters.measurements.length === 3
      && draft.parameters.measurements.every(item => item.value !== null && item.unit !== null)
    const analysis = estimate?.analysis
    const fresh = estimate?.status === 'succeeded' && analysis?.basisFingerprint === estimate.basisFingerprint
    const materialReady = fresh && analysis !== null && analysis !== undefined && analysis.items.length > 0
    const costsReady = fresh && estimate?.costs !== null && analysis?.costExplanation !== null && analysis?.costExplanation !== undefined
    const advice = guidelines.error === null ? guidelines.data?.advice.find(item => item.requestId === plan.id) : undefined
    const guidelineReady = advice?.status === 'succeeded' && advice.result !== null && advice.result.fingerprint === advice.fingerprint
    const loading = t('正在读取', 'Loading'), failed = t('读取失败，请重试', 'Could not load; retry')
    return [
      { kind: 'selection', label: t('选型草稿', 'Selection draft'), ready: draftReady,
        status: selection.error ? failed : selection.isPending ? loading : draft ? draftReady ? draft.edited ? t('已修订，待核对', 'Edited; review needed') : t('已带入', 'Copied from report') : t('测量待补齐', 'Measurements incomplete')
          : manualConfirmed ? t('医生已确认', 'Confirmed by doctor') : t('尚无造影报告，可手填', 'No angiography report; enter manually') },
      { kind: 'materials', label: t('耗材清单', 'Material list'), ready: materialReady,
        status: estimates.error ? failed : estimates.isPending ? loading : estimateStatus(estimate?.status) },
      { kind: 'costs', label: t('费用说明', 'Cost explanation'), ready: costsReady,
        status: estimates.error ? failed : estimates.isPending ? loading : costsReady ? t('已准备', 'Prepared')
          : estimate?.costs ? t('规则费用可查，说明尚未准备', 'Rule-based costs available; explanation not prepared') : estimateStatus(estimate?.status) },
      { kind: 'guidelines', label: t('指南参考意见', 'Guideline advice'), ready: guidelineReady,
        status: guidelines.error ? failed : guidelines.isPending ? loading : advice ? {
          idle: t('尚未准备', 'Not prepared'), queued: t('正在准备', 'Preparing'), running: t('正在生成并核验', 'Generating and verifying'),
          succeeded: guidelineReady ? t('已准备，只读', 'Prepared; read only') : t('暂无可发布意见', 'No publishable advice'),
          incomplete: t('待补充资料', 'More information needed'), 'no-evidence': t('暂无适用指南', 'No applicable evidence'),
          blocked: t('模型暂不可用', 'Model unavailable'), unknown: t('结果未知，先核查原请求', 'Outcome unknown; check the original request'),
          rejected: t('未通过独立核验', 'Independent verification rejected'), failed: t('准备失败', 'Preparation failed'),
          cancelled: t('已取消', 'Cancelled'), stale: t('依据已变化，需重评', 'Sources changed; reassess'), frozen: t('历史只读', 'Historical; read only'),
        }[advice.status] : t('尚未准备', 'Not prepared') },
    ].map(item => ({ ...item, requestId: plan.id, planLabel: `${plan.plannedProcedure.coding.display} · ${plan.reason}` }))
  }) : []
  return { items, readyCount: items.filter(item => item.ready).length }
}
