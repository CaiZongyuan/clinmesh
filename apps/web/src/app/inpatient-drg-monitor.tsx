import type { InpatientCosts, InpatientDrgSimulation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { DrgGroupingResult } from '@clinmesh/contracts/drg'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { ChevronRightIcon } from 'lucide-react'
import { DrgGroupingEvidence, drgGroupingStatusLabel } from './inpatient-drg-summary.tsx'
import { inpatientChargeCategoryLabel } from './inpatient-labels.ts'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

const sum = (items: InpatientDrgSimulation['formal']['items']) => items.reduce((total, item) => total + (item.estimatedFen ?? 0), 0)

export function drgGroupingReason(result: DrgGroupingResult, locale: WorkspaceLocale): string {
  const zh = locale === 'zh-CN', reason = result.reason ?? ''
  if (reason.includes('兼容操作编码') || (reason.includes('coding-incompatible') && reason.includes('操作')))
    return zh ? '计划术式不在当前分组规则可识别的操作编码里，暂不能预分组；规则更新或病案编码审核时再确定。'
      : 'The planned procedure code is not recognized by the current grouping rules; determine the group after a rule update or coding review.'
  if (reason.includes('兼容诊断编码') || reason.includes('coding-incompatible'))
    return zh ? '当前诊断不在分组规则可识别的编码里，暂不能预分组；规则更新或病案编码审核时再确定。'
      : 'The current diagnosis code is not recognized by the current grouping rules; determine the group after a rule update or coding review.'
  if (reason.includes('birthWeightGrams') || reason.includes('出生体重'))
    return zh ? '当前分组条件缺少新生儿出生体重，暂不能预分组。' : 'Birth weight is required for grouping.'
  if (reason.includes('ageDays') || reason.includes('日龄'))
    return zh ? '婴儿分组缺少日龄信息，暂不能预分组。' : 'Infant age in days is required for grouping.'
  if (reason.includes('歧义病案') || result.status === 'ambiguous')
    return zh ? '当前主要诊断与手术操作组合存在分组歧义，需核对主诊断与主操作选择。' : 'The diagnosis and procedure combination is ambiguous; verify the principal diagnosis and procedure.'
  const cleaned = reason.replace(/^coding-incompatible[：:\s]*/i, '').replace(/\s+[0-9]{2}\.[0-9A-Za-z.]+/g, '').replace(/\s*[A-Za-z][A-Za-z0-9_.-]*\b/g, '').trim()
  return cleaned || drgGroupingStatusLabel(result.status, locale)
}

/** 主块只比较医院支付参考与已用费用，状态只分未超和已超；系统没有标杆住院日或预警阈值。 */
export function DrgPaymentMonitor({ data, costs, locale }: { data: InpatientDrgSimulation; costs: InpatientCosts | null | undefined; locale: WorkspaceLocale }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const reference = data.paymentReference?.referenceFen ?? costs?.currentPaymentReference?.referenceFen ?? null
  const posted = data.formal.chargesFen, pending = sum(data.committed.items.filter(item => item.kind !== 'surgery')), spent = posted + pending
  const over = reference !== null && spent > reference
  const exceptionTriggered = costs?.exceptionAlert === 'triggered' || (reference !== null && reference > 0 && BigInt(posted) > 3n * BigInt(reference))
  const scale = over ? spent * 1.08 : reference ?? spent
  const percent = (value: number) => `${scale > 0 ? Math.min(100, value / scale * 100).toFixed(2) : 0}%`
  const formal = data.grouping.formal
  return <section aria-label={t('费用与支付参考', 'Charges and payment reference')} data-testid="drg-charges" className="flex min-w-0 flex-col gap-3 rounded-lg border p-3">
    <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">{t('费用与支付参考', 'Charges and payment reference')}</h4><span className="flex-1" />
      {reference === null ? <Badge variant="outline">{t('暂无支付参考', 'No payment reference')}</Badge>
        : <Badge variant="outline" className={over ? 'text-warning' : 'text-success'}>{over ? t('已超支付参考', 'Above payment reference') : t('未超支付参考', 'Within payment reference')}</Badge>}</div>
    <dl className="grid grid-cols-3 gap-x-4 gap-y-2">
      <div className="min-w-0"><dt className="text-xs text-muted-foreground">{t('当前病组', 'Current group')}</dt><dd className="text-lg font-semibold tabular-nums">{formal.drgCode ?? drgGroupingStatusLabel(formal.status, locale)}</dd></div>
      <div className="min-w-0"><dt className="text-xs text-muted-foreground">{t('医院支付参考', 'Hospital payment reference')}</dt><dd className="text-lg font-semibold tabular-nums">{reference === null ? '—' : formatFen(reference, locale)}</dd></div>
      <div className="min-w-0"><dt className="text-xs text-muted-foreground">{over ? t('已超出', 'Over by') : t('还剩', 'Remaining')}</dt><dd className={`text-lg font-semibold tabular-nums ${over ? 'text-warning' : 'text-success'}`}>{reference === null ? '—' : formatFen(Math.abs(reference - spent), locale)}</dd></div>
    </dl>
    {reference !== null ? <>
      <div role="img" aria-label={`${t('已用 ', 'Used ')}${formatFen(spent, locale)}${t('，支付参考 ', ', payment reference ')}${formatFen(reference, locale)}`} className="relative h-3.5 rounded-full border bg-muted">
        <div className="absolute inset-y-0 left-0 flex overflow-hidden rounded-full" style={{ width: percent(spent) }}>
          <i className={over ? 'bg-warning' : 'bg-info'} style={{ width: spent > 0 ? `${posted / spent * 100}%` : 0 }} /><i className={`flex-1 ${over ? 'bg-warning/40' : 'bg-info/40'}`} /></div>
        <span aria-hidden="true" className="absolute -inset-y-1.5 w-0.5 rounded-sm bg-foreground" style={{ left: percent(reference) }} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><i aria-hidden="true" className={`size-2.5 rounded-sm ${over ? 'bg-warning' : 'bg-info'}`} />{t('已发生收费 ', 'Posted ')}<b className="font-medium text-foreground tabular-nums">{formatFen(posted, locale)}</b></span>
        <span className="inline-flex items-center gap-1.5"><i aria-hidden="true" className={`size-2.5 rounded-sm ${over ? 'bg-warning/40' : 'bg-info/40'}`} />{t('已开未记费医嘱 ', 'Ordered, not charged ')}<b className="font-medium text-foreground tabular-nums">{formatFen(pending, locale)}</b></span>
        <span className="flex-1" /><span>{t('竖线 = 支付参考 · 已用 ', 'Line = payment reference · used ')}{reference > 0 ? Math.round(spent / reference * 100) : 0}%</span>
      </div>
    </> : null}
    {data.grouping.projected ? <PlannedLine data={data} projected={data.grouping.projected} costs={costs} spent={spent} locale={locale} /> : null}
    {exceptionTriggered ? <Alert><AlertDescription>{t('已发生正式收费合计严格超过当前 DRG 支付参考额的 3 倍。建议本次住院诊疗结束后由医保办人工评估特例单议申请；此提醒不阻断出院，不自动申请、不调整分组或核定，也不预测补付。', 'Net posted charges exceed three times the current DRG payment reference. After inpatient care ends, the insurance office should assess an exceptional-case application. This advisory does not block discharge or change grouping or payment.')}</AlertDescription></Alert> : null}
    {formal.status !== 'grouped' ? <p className="text-sm text-muted-foreground">{drgGroupingReason(formal, locale)}</p> : null}
    <DrgGroupingEvidence result={{ ...formal, reason: null }} locale={locale} />
  </section>
}

function PlannedLine({ data, projected, costs, spent, locale }: { data: InpatientDrgSimulation; projected: DrgGroupingResult; costs: InpatientCosts | null | undefined; spent: number; locale: WorkspaceLocale }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const surgery = data.committed.items.filter(item => item.kind === 'surgery')
  const total = data.coverage.estimatedTotalFen, reference = costs?.projectedPaymentReference?.referenceFen ?? null
  const parts = [[t('手术费 ', 'procedure '), sum(surgery)], [t('预留耗材 ', 'reserved materials '), sum(data.reserved.items)], [t('待提交项目 ', 'pending items '), sum(data.draft.items)]] as const
  return <section aria-label={t('做完计划手术后', 'After the planned surgery')} className="flex min-w-0 flex-col gap-1 rounded-md bg-muted p-3 text-sm">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><b>{t('做完计划手术后', 'After the planned surgery')}</b>
      <span className="text-xs text-muted-foreground">{surgery.map(item => item.display).join('、')}</span>
      {projected.status !== 'grouped' ? <Badge variant="outline" className="text-warning">{t('无法预分组', 'Cannot pre-group')}</Badge> : null}</div>
    {projected.status === 'grouped' ? <div className="flex flex-wrap gap-x-4 gap-y-1">
      <span>{t('预计病组 ', 'Projected group ')}<b className="tabular-nums">{projected.drgCode}</b></span>
      <span>{t('支付参考 ', 'Payment reference ')}<b className="tabular-nums">{reference === null ? '—' : formatFen(reference, locale)}</b></span>
      <span>{t('预计住院总费用 ', 'Projected total ')}<b className="tabular-nums">{formatFen(total, locale)}</b></span>
      {reference !== null ? <span>{reference < total ? t('已超出 ', 'Over by ') : t('还剩 ', 'Remaining ')}<b className="tabular-nums">{formatFen(Math.abs(reference - total), locale)}</b></span> : null}
    </div> : <>
      <span>{t('预计住院总费用 ', 'Projected total ')}<b className="tabular-nums">{formatFen(total, locale)}</b>{t('，暂时没有参考额可比。', '; no reference to compare.')}</span>
      <span className="text-xs text-muted-foreground">{drgGroupingReason(projected, locale)}</span>
    </>}
    <span className="text-xs text-muted-foreground tabular-nums">{t('预计总费用 = 当前已用 ', 'Projected total = used ')}{formatFen(spent, locale)}{parts.filter(([, value]) => value !== 0).map(([label, value]) => ` + ${label}${formatFen(value, locale)}`).join('')}</span>
  </section>
}

export function DrgChargeMix({ data, locale, onOpenFees }: { data: InpatientDrgSimulation; locale: WorkspaceLocale; onOpenFees: (() => void) | undefined }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const total = data.formal.chargesFen
  const rows = Object.entries(data.formal.items.reduce<Record<string, number>>((result, item) => ({ ...result, [item.kind]: (result[item.kind] ?? 0) + (item.estimatedFen ?? 0) }), {}))
    .filter(([, value]) => value !== 0).sort(([, left], [, right]) => right - left)
  return <section aria-label={t('已发生收费构成', 'Posted charge mix')} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
    <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">{t('已发生收费构成', 'Posted charge mix')}</h4><span className="flex-1" /><span className="text-xs text-muted-foreground tabular-nums">{t('合计 ', 'Total ')}{formatFen(total, locale)}</span></div>
    {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('尚无已发生收费。', 'No posted charges yet.')}</p>
      : <Table><TableHeader><TableRow><TableHead>{t('类别', 'Category')}</TableHead><TableHead>{t('占比', 'Share')}</TableHead><TableHead className="text-right">{t('金额', 'Amount')}</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map(([kind, value]) => { const share = total > 0 ? Math.max(0, value / total * 100) : 0
          return <TableRow key={kind}><TableCell>{inpatientChargeCategoryLabel(kind, locale)}</TableCell>
            <TableCell className="tabular-nums"><span aria-hidden="true" className="relative mr-1.5 inline-block h-1.5 w-16 overflow-hidden rounded-full border bg-muted align-middle"><i className="absolute inset-y-0 left-0 bg-info" style={{ width: `${Math.min(100, share)}%` }} /></span>{Math.round(share)}%</TableCell>
            <TableCell className="text-right tabular-nums">{formatFen(value, locale)}</TableCell></TableRow> })}</TableBody></Table>}
    {onOpenFees ? <Button variant="link" size="sm" className="h-auto self-start px-0 text-info" onClick={onOpenFees}>{t('逐笔明细在「费用」页签', 'Itemized charges under Fees')}<ChevronRightIcon aria-hidden="true" data-icon="inline-end" /></Button> : null}
    <p className="text-xs text-muted-foreground">{t('医院支付参考 = 合成基础费率 × 病组权重，与患者医保待遇分别计算；不代表患者报销或医院盈亏。', 'Hospital payment reference = synthetic base rate × group weight, calculated separately from patient benefits; not reimbursement or hospital profit.')}</p>
  </section>
}
