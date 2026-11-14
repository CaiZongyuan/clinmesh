import type { InpatientCosts } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { formatFen } from './workspace-format.ts'

export function InpatientPciCosts({ costs, locale }: { costs: InpatientCosts | null; locale: WorkspaceLocale }): React.JSX.Element | null {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  if (costs === null) return null
  const { components } = costs
  const rows = [
    [t('已发生正式收费（含造影）', 'Posted charges (including angiography)'), components.formalChargesFen],
    [t('待执行医嘱', 'Pending orders'), components.pendingOrdersFen],
    [t('剩余计划耗材', 'Remaining planned materials'), components.remainingMaterialsFen],
    [t('计划手术费', 'Planned procedure charge'), components.plannedSurgeryFen],
    [t('预计住院总费用', 'Projected admission total'), components.projectedTotalFen],
  ] as const
  return <section aria-label={t('住院费用与医保参考', 'Admission costs and payment reference')} className="flex min-w-0 flex-col gap-3">
    <h5 className="font-medium">{t('住院费用与医保参考', 'Admission costs and payment reference')}</h5>
    <dl className="grid gap-2">{rows.map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt>{label}</dt><dd className="tabular-nums">{costs.projectionComplete === false && (label === t('预计住院总费用', 'Projected admission total') || label === t('剩余计划耗材', 'Remaining planned materials')) ? t('预计费用暂不可用', 'Projected total unavailable') : formatFen(value, locale)}</dd></div>)}</dl>
    <p className="text-sm text-muted-foreground">{t('差额为医院支付参考减预计住院总费用，不代表患者报销或医院利润。预分组不改变正式病组或治疗方案。', 'Differences are hospital payment references minus projected admission costs, not patient reimbursement or hospital profit. Projections do not change formal grouping or treatment.')}</p>
    <div className="grid gap-3 @lg:grid-cols-2">
      <Payment title={t('当前正式分组', 'Current formal group')} grouping={costs.currentGrouping} payment={costs.currentPaymentReference} difference={costs.currentDifferenceFen} locale={locale} />
      <Payment title={t('计划手术的预计分组', 'Projected group for the planned procedure')} grouping={costs.projectedGrouping} payment={costs.projectedPaymentReference} difference={costs.projectedDifferenceFen} locale={locale} />
    </div>
    <p role="status">{costs.paymentMessage}</p>
    {costs.exceptionAlert === 'triggered' ? <Alert><AlertTitle>{t('特例提醒', 'Exception review')}</AlertTitle><AlertDescription>{t('已发生正式费用（已扣除退费）超过当前医院支付参考的三倍，请核实正式费用与适用政策。', 'Posted net charges exceed three times the current hospital payment reference. Review formal charges and applicable policy.')}</AlertDescription></Alert> : null}
  </section>
}

function Payment({ title, grouping, payment, difference, locale }: { title: string; grouping: InpatientCosts['currentGrouping']; payment: InpatientCosts['currentPaymentReference']; difference: number | null; locale: WorkspaceLocale }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  return <section aria-label={title} className="flex min-w-0 flex-col gap-1 border-t pt-2">
    <h6 className="font-medium">{title}</h6>
    <p>{grouping?.status === 'grouped' ? grouping.drgCode : t('暂时无法分组', 'Grouping unavailable')}</p>
    <p>{t('医院支付参考：', 'Hospital payment reference: ')}<span className="tabular-nums">{payment ? formatFen(payment.referenceFen, locale) : t('暂无支付参考', 'No payment reference')}</span></p>
    <p>{t('与预计总费用的差额：', 'Difference from projected total: ')}<span className="tabular-nums">{difference === null ? t('金额暂不可估', 'Amount unavailable') : formatFen(difference, locale)}</span></p>
    {payment ? <details><summary>{t('合成医院支付参数', 'Synthetic hospital payment parameters')}</summary><p>{payment.note}</p><p className="break-words text-xs text-muted-foreground">{payment.parameterSetId} · {payment.parameterVersion}</p></details> : null}
  </section>
}
