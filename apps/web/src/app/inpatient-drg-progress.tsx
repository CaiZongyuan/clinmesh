import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { InpatientDrgQuery } from './inpatient-drg-query.ts'
import type { InpatientCosts, InpatientDrgSimulation } from '@clinmesh/contracts/inpatient-drg-simulation'
import { ChevronRightIcon } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { Badge } from '@clinmesh/ui/components/badge'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { drgGroupingStatusLabel } from './inpatient-drg-summary.tsx'

function referenceProgress(total: number, reference: number | null) {
  const status = reference === null ? null : total > reference ? 'over' : BigInt(total) * 10n >= BigInt(reference) * 9n ? 'near' : 'within'
  return { status, remaining: reference === null ? null : reference - total }
}

/** 只读预计优先使用待实施计划，其次使用尚待医生确认主操作的术后实际操作。 */
export function drgProgress(data: InpatientDrgSimulation, costs: InpatientCosts | null | undefined) {
  const planned = data.grouping.projected?.status === 'grouped' ? data.grouping.projected : null
  const postoperative = planned === null ? data.postoperativeEstimate ?? null : null
  const pendingMainProcedure = postoperative !== null
  const projected = planned !== null || pendingMainProcedure
  const grouping = planned ?? (postoperative ? postoperative.grouping : data.grouping.formal)
  const spent = data.formal.chargesFen
  const total = projected ? costs?.components.projectedTotalFen ?? data.coverage.estimatedTotalFen : spent
  const reference = planned !== null
    ? (costs?.projectedPaymentReference?.drgCode === planned.drgCode ? costs.projectedPaymentReference.referenceFen : null)
    : postoperative ? (grouping?.status === 'grouped' && postoperative.paymentReference?.drgCode === grouping.drgCode
      ? postoperative.paymentReference.referenceFen : null)
      : data.paymentReference?.referenceFen ?? costs?.currentPaymentReference?.referenceFen ?? null
  return { projected, pendingMainProcedure, grouping, spent, total, reference, ...referenceProgress(total, reference) }
}

export function DrgProgressBar({ data, costs, locale, onOpenDrg }: {
  data: InpatientDrgSimulation; costs: InpatientCosts | null | undefined; locale: WorkspaceLocale; onOpenDrg(): void
}) {
  return <ProgressLine progress={drgProgress(data, costs)} locale={locale} onOpenDrg={onOpenDrg} />
}

/** 患者头部姓名行右侧的小条：常驻状态、病组、进度与余额；完整金额在悬停说明与无障碍描述里。 */
function ProgressChip({ locale, onOpenDrg, detail, over, children }: { locale: WorkspaceLocale; onOpenDrg(): void; detail: string; over?: boolean; children: ReactNode }) {
  const id = useId()
  return <button type="button" className="clinmesh-inpatient-drg-progress" data-over={over || undefined} title={detail} aria-describedby={id}
    aria-label={locale === 'zh-CN' ? 'DRG 费用进度，点击查看 DRG 预分组' : 'DRG charge progress; open DRG pre-grouping'} onClick={onOpenDrg}>
    {children}<span className="sr-only" id={id}>{detail}</span><ChevronRightIcon aria-hidden="true" />
  </button>
}

function ProgressLine({ progress, locale, onOpenDrg }: { progress: ReturnType<typeof drgProgress>; locale: WorkspaceLocale; onOpenDrg(): void }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const { projected, pendingMainProcedure, grouping, spent, total, reference, status } = progress
  const percent = (amount: number) => `${reference !== null && reference > 0 ? Math.min(100, Math.max(0, amount) / reference * 100) : 0}%`
  const group = grouping?.drgCode ?? (grouping ? drgGroupingStatusLabel(grouping.status, locale) : t('病组待确定', 'Group pending'))
  const remainingLabel = status === 'over' ? t('超出 ', 'Over by ') : t('还剩 ', 'Remaining '), remainingAmount = reference === null ? '' : formatFen(Math.abs(reference - total), locale)
  const detail = `${pendingMainProcedure ? t('术后预计 ', 'After surgery ') : projected ? t('按计划手术预计 ', 'With planned surgery ') : t('当前病组 ', 'Current group ')}${group} · ${t('已用 ', 'Used ')}${formatFen(spent, locale)}`
    + (projected ? ` · ${pendingMainProcedure ? t('预计 ', 'Projected ') : t('做完预计 ', 'Projected total ')}${formatFen(total, locale)}` : '')
    + (reference === null ? '' : ` / ${t('支付参考 ', 'Payment reference ')}${formatFen(reference, locale)} · ${status === 'over' ? projected ? t('预计超出 ', 'Projected over by ') : t('已超出 ', 'Over by ') : projected ? t('预计还剩 ', 'Projected remaining ') : t('还剩 ', 'Remaining ')}${remainingAmount}`)
  return <ProgressChip locale={locale} onOpenDrg={onOpenDrg} detail={detail} over={status === 'over'}>
    {status === null ? null : <Badge variant="outline" className={status === 'within' ? 'text-success' : 'text-warning'}>{status === 'over' ? t('已超', 'Above') : status === 'near' ? t('接近', 'Near') : t('未超', 'Within')}</Badge>}
    <b>{group}</b>{pendingMainProcedure ? <span className="text-warning">{t('待确认主操作', 'Main procedure pending')}</span> : null}
    {reference === null ? <span>{t('暂无支付参考', 'No payment reference')}</span> : <>
      <span aria-hidden="true" className="clinmesh-inpatient-drg-progress-track">
        <i className="clinmesh-inpatient-drg-progress-projected" style={{ width: percent(total) }} /><i className="clinmesh-inpatient-drg-progress-spent" style={{ width: percent(spent) }} />
      </span>
      <span aria-hidden="true">{remainingLabel}<b>{remainingAmount}</b></span>
    </>}
  </ProgressChip>
}


export function InpatientDrgHeader({ admission, session, query, locale, onOpenDrg }: {
  admission: InpatientAdmission; session: SessionContext; query: InpatientDrgQuery; locale: WorkspaceLocale; onOpenDrg(): void
}) {
  if (session.actor.roleCode !== 'inpatient-doctor') return null
  if (query.archived && query.grouping.data && !query.grouping.error) {
    const grouping = query.grouping.data.result, reference = query.grouping.data.paymentEstimate?.referenceFen ?? null, total = admission.chargesFen
    return <ProgressLine locale={locale} onOpenDrg={onOpenDrg} progress={{ projected: false, pendingMainProcedure: false, grouping, spent: total, total, reference,
      ...referenceProgress(total, reference) }} />
  }
  const data = query.simulation.error ? undefined : query.simulation.data
  const projectedGroup = data?.grouping.projected
  const postoperative = projectedGroup?.status === 'grouped' ? null : data?.postoperativeEstimate
  const reference = postoperative ? postoperative.paymentReference : query.projectedCosts?.projectedPaymentReference
  const referenceGroup = postoperative ? postoperative.grouping : projectedGroup
  const projectedReference = referenceGroup?.status === 'grouped' && reference?.drgCode === referenceGroup.drgCode ? reference : null
  const zh = locale === 'zh-CN'
  if (query.materialProjectionIncomplete && (projectedGroup?.status === 'grouped' || postoperative)) {
    const group = postoperative ? postoperative.grouping?.drgCode : projectedGroup?.drgCode
    const spent = query.simulation.data?.formal.chargesFen ?? admission.chargesFen
    const referenceFen = projectedReference?.referenceFen ?? null
    const over = referenceFen !== null && spent > referenceFen
    const spentPercent = `${referenceFen !== null && referenceFen > 0 ? Math.min(100, Math.max(0, spent) / referenceFen * 100) : 0}%`
    return <ProgressChip locale={locale} onOpenDrg={onOpenDrg} over={over}
      detail={`${postoperative ? zh ? '术后预计 ' : 'After surgery ' : zh ? '按计划手术预计 ' : 'With planned surgery '}${group ?? ''} · ${zh ? '已用 ' : 'Used '}${formatFen(spent, locale)} · ${projectedReference ? `${zh ? '支付参考 ' : 'Payment reference '}${formatFen(projectedReference.referenceFen, locale)}` : zh ? '暂无支付参考' : 'No payment reference'} · ${zh ? '计划耗材费用待核对，预计总费用暂不可用' : 'Review planned material prices; projected charges unavailable'}`}>
      {over ? <Badge variant="outline" className="text-warning">{zh ? '已超' : 'Above'}</Badge> : null}
      {group ? <b>{group}</b> : null}{postoperative ? <span className="text-warning">{zh ? '待确认主操作' : 'Main procedure pending'}</span> : null}
      {referenceFen === null ? <span aria-hidden="true">{zh ? '暂无支付参考' : 'No payment reference'}</span> : <>
        <span aria-hidden="true" className="clinmesh-inpatient-drg-progress-track"><i className="clinmesh-inpatient-drg-progress-spent" style={{ width: spentPercent }} /></span>
        <span aria-hidden="true">{zh ? '已用 ' : 'Used '}<b>{formatFen(spent, locale)}</b> / {formatFen(referenceFen, locale)}</span>
      </>}
      <span className="text-warning">{zh ? '耗材费用待核对' : 'Material prices pending'}</span>
    </ProgressChip>
  }
  if (data) return <DrgProgressBar data={data} costs={query.projectedCosts} locale={locale} onOpenDrg={onOpenDrg} />
  const unavailable = query.simulation.error || query.grouping.error || admission.status === 'registered'
  const text = unavailable ? zh ? '暂无支付参考' : 'No payment reference' : zh ? '正在核对费用' : 'Checking charges'
  return <ProgressChip locale={locale} onOpenDrg={onOpenDrg} detail={`DRG ${text}`}><b>DRG</b><span aria-hidden="true">{text}</span></ProgressChip>
}
