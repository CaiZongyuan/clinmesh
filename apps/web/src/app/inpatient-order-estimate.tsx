import { inpatientDrgSimulationSchema, type InpatientDrgSimulationInput } from '@clinmesh/contracts/inpatient-drg-simulation'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { apiMutation } from './api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'

/** 当前医嘱草稿的费用预计。首个结果的 fingerprint 作为开立依据；轮询发现依据变化即过期，须重新预计后才能按预计开立。 */
export function useOrderEstimate({ scope, admissionId, draft, enabled, review, onReview }: { scope: readonly unknown[]; admissionId: string; draft: InpatientDrgSimulationInput | undefined; enabled: boolean;
  review: { fingerprint?: string | undefined; stale: boolean }; onReview(review: { fingerprint: string; stale: boolean }): void }) {
  const simulation = useQuery({ queryKey: [...scope, admissionId, 'order-drg-simulation', draft ?? null], enabled: enabled && draft !== undefined, retry: false,
    refetchInterval: enabled ? 3_000 : false, refetchIntervalInBackground: false,
    queryFn: ({ signal }) => apiMutation(`/api/his/v1/inpatient/admissions/${admissionId}/drg/simulation`, inpatientDrgSimulationSchema, { input: draft }, { signal }) })
  const fingerprint = simulation.data?.fingerprint, accepted = review.fingerprint
  const stale = review.stale || accepted !== undefined && fingerprint !== undefined && fingerprint !== accepted
  useEffect(() => {
    if (!enabled || !fingerprint || simulation.isFetching || simulation.error) return
    if (!review.fingerprint && !review.stale) onReview({ fingerprint, stale: false })
    else if (stale && !review.stale && review.fingerprint) onReview({ fingerprint: review.fingerprint, stale: true })
  }, [enabled, review, onReview, fingerprint, stale, simulation.isFetching, simulation.error])
  const recalculate = async () => {
    const result = await simulation.refetch()
    if (result.data && !result.error) {
      onReview({ fingerprint: result.data.fingerprint, stale: false })
    }
  }
  const ready = enabled && accepted !== undefined && !stale && !simulation.isFetching && simulation.error === null && simulation.data?.draft.missing.length === 0
  return { simulation, stale, recalculate, enabled, fingerprint: ready ? accepted : undefined }
}

export function OrderEstimate({ estimate, locale }: { estimate: ReturnType<typeof useOrderEstimate>; locale: WorkspaceLocale }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const { simulation, stale } = estimate, data = simulation.data
  const draftFen = data?.draft.items.reduce((sum, item) => sum + (item.estimatedFen ?? 0), 0) ?? 0
  return <section aria-label={t('费用预计', 'Charge estimate')} className="flex flex-col gap-2 rounded-md border bg-info/5 p-3 text-sm">
    {simulation.isPending ? <p role="status" className="text-muted-foreground">{t('正在预计分组与费用', 'Estimating grouping and charges')}</p> : null}
    {simulation.error ? <Alert variant="destructive"><AlertDescription>{t('费用预计失败：', 'Estimate failed: ')}{getWorkspaceErrorMessage(simulation.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {data ? <>
      <p className="flex flex-wrap gap-x-6 gap-y-1 tabular-nums">
        <span>{t('开立后病组 ', 'Group after ordering ')}<strong>{data.grouping.formal.drgCode ?? t('未确定', 'Undetermined')}</strong></span>
        <span>{t('预计总额 ', 'Estimated total ')}<strong>{formatFen(data.coverage.estimatedTotalFen - draftFen, locale)} → {formatFen(data.coverage.estimatedTotalFen, locale)}</strong></span>
        {data.paymentReference ? <span>{t('支付参考 ', 'Payment reference ')}<strong>{data.paymentReference.drgCode} · {formatFen(data.paymentReference.referenceFen, locale)}</strong></span> : null}
      </p>
      {data.draft.missing.length > 0 ? <p role="alert" className="text-destructive">{t('该项目缺少当前目录价格，费用预计不完整；请刷新后重新选择。', 'This item lacks a current catalog price; the estimate is incomplete. Refresh and select again.')}</p> : null}
      <p className="text-xs text-muted-foreground">{t('只供参考；开立时会重新核对诊疗、费用和目录，变化后需要重新预计。', 'For reference only. Care, charges and the catalog are checked again when ordering; re-estimate after changes.')}</p>
    </> : null}
    {stale ? <div role="alert" className="flex flex-wrap items-center gap-2 text-destructive">{t('评估已过期：诊疗、费用或目录已变化，请重新预计后再开立。', 'This estimate is stale. Care, charges or the catalog changed; re-estimate before ordering.')}
      <Button type="button" size="sm" variant="outline" disabled={!estimate.enabled || simulation.isFetching} onClick={() => void estimate.recalculate()}>{t('重新预计', 'Re-estimate')}</Button></div> : null}
  </section>
}
