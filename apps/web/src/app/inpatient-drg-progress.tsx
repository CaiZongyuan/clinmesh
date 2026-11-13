import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { InpatientDrgQuery } from './inpatient-drg-query.ts'
import type { InpatientCosts, InpatientDrgSimulation } from '@clinmesh/contracts/inpatient-drg-simulation'
import { ChevronRightIcon } from 'lucide-react'
import { Badge } from '@clinmesh/ui/components/badge'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { drgGroupingStatusLabel } from './inpatient-drg-summary.tsx'

function referenceProgress(total: number, reference: number | null) {
  const status = reference === null ? null : total > reference ? 'over' : BigInt(total) * 10n >= BigInt(reference) * 9n ? 'near' : 'within'
  return { status, remaining: reference === null ? null : reference - total }
}

/** 同 DRG 费用页口径；计划分组可用时以做完计划手术后的总费用比较。 */
export function drgProgress(data: InpatientDrgSimulation, costs: InpatientCosts | null | undefined) {
  const planned = data.grouping.projected?.status === 'grouped' ? data.grouping.projected : null
  const projected = planned !== null, grouping = planned ?? data.grouping.formal
  const spent = data.formal.chargesFen
  const total = projected ? costs?.components.projectedTotalFen ?? data.coverage.estimatedTotalFen : spent
  const reference = projected
    ? (costs?.projectedPaymentReference?.drgCode === grouping.drgCode ? costs.projectedPaymentReference.referenceFen : null)
    : data.paymentReference?.referenceFen ?? costs?.currentPaymentReference?.referenceFen ?? null
  return { projected, grouping, spent, total, reference, ...referenceProgress(total, reference) }
}

export function DrgProgressBar({ data, costs, locale, onOpenDrg }: {
  data: InpatientDrgSimulation; costs: InpatientCosts | null | undefined; locale: WorkspaceLocale; onOpenDrg(): void
}) {
  return <ProgressLine progress={drgProgress(data, costs)} locale={locale} onOpenDrg={onOpenDrg} />
}

function ProgressLine({ progress, locale, onOpenDrg }: { progress: ReturnType<typeof drgProgress>; locale: WorkspaceLocale; onOpenDrg(): void }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const { projected, grouping, spent, total, reference, status } = progress
  const percent = (amount: number) => `${reference !== null && reference > 0 ? Math.min(100, Math.max(0, amount) / reference * 100) : 0}%`
  return <button type="button" className="clinmesh-inpatient-drg-progress" data-over={status === 'over' || undefined} aria-label={t('DRG 费用进度，点击查看 DRG 预分组', 'DRG charge progress; open DRG pre-grouping')} onClick={onOpenDrg}>
    <span className="clinmesh-inpatient-drg-progress-group">
      {status === null ? null : <Badge variant="outline" className={status === 'within' ? 'text-success' : 'text-warning'}>{status === 'over' ? t('已超', 'Above') : status === 'near' ? t('接近', 'Near') : t('未超', 'Within')}</Badge>}
      <span><span className="clinmesh-inpatient-drg-progress-group-label" data-current={!projected || undefined}>{projected ? t('按计划手术预计 ', 'With planned surgery ') : t('当前病组 ', 'Current group ')}</span><b>{grouping.drgCode ?? drgGroupingStatusLabel(grouping.status, locale)}</b></span>
    </span>
    <span className="clinmesh-inpatient-drg-progress-amount">{t('已用 ', 'Used ')}<b>{formatFen(spent, locale)}</b>{projected ? <> · {t('做完预计 ', 'Projected total ')}<b>{formatFen(total, locale)}</b></> : null}{reference === null ? null : <> / <span className="clinmesh-inpatient-drg-progress-payment-label">{t('支付参考 ', 'Payment reference ')}</span><b>{formatFen(reference, locale)}</b></>}</span>
    {reference === null ? <span>{t('暂无支付参考', 'No payment reference')}</span> : <>
      <span role="img" aria-label={`${t('已用 ', 'Used ')}${formatFen(spent, locale)}${projected ? `${t('，做完预计 ', ', projected total ')}${formatFen(total, locale)}` : ''}${t('，支付参考 ', ', payment reference ')}${formatFen(reference, locale)}`} className="clinmesh-inpatient-drg-progress-track">
        <i className="clinmesh-inpatient-drg-progress-projected" style={{ width: percent(total) }} /><i className="clinmesh-inpatient-drg-progress-spent" style={{ width: percent(spent) }} />
      </span>
      <span className="clinmesh-inpatient-drg-progress-remaining">{status === 'over' ? projected ? t('预计超出 ', 'Projected over by ') : t('已超出 ', 'Over by ') : projected ? t('预计还剩 ', 'Projected remaining ') : t('还剩 ', 'Remaining ')}<b>{formatFen(Math.abs(reference - total), locale)}</b><ChevronRightIcon aria-hidden="true" /></span>
    </>}
  </button>
}


export function InpatientDrgHeader({ admission, session, query, locale, onOpenDrg }: {
  admission: InpatientAdmission; session: SessionContext; query: InpatientDrgQuery; locale: WorkspaceLocale; onOpenDrg(): void
}) {
  if (session.actor.roleCode !== 'inpatient-doctor') return null
  if (query.archived && query.grouping.data && !query.grouping.error) {
    const grouping = query.grouping.data.result, reference = query.grouping.data.paymentEstimate?.referenceFen ?? null, total = admission.chargesFen
    return <ProgressLine locale={locale} onOpenDrg={onOpenDrg} progress={{ projected: false, grouping, spent: total, total, reference,
      ...referenceProgress(total, reference) }} />
  }
  if (query.simulation.data && !query.simulation.error) return <DrgProgressBar data={query.simulation.data} costs={query.projectedCosts} locale={locale} onOpenDrg={onOpenDrg} />
  const unavailable = query.simulation.error || query.grouping.error || admission.status === 'registered'
  return <button type="button" className="clinmesh-inpatient-drg-progress" onClick={onOpenDrg} aria-label={locale === 'zh-CN' ? 'DRG 费用进度，点击查看 DRG 预分组' : 'DRG charge progress; open DRG pre-grouping'}>
    <span>DRG</span><span>{unavailable ? locale === 'zh-CN' ? '暂无支付参考' : 'No payment reference' : locale === 'zh-CN' ? '正在核对费用' : 'Checking charges'}</span><ChevronRightIcon aria-hidden="true" />
  </button>
}
