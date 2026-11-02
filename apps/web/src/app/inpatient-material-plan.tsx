import type { InpatientMaterialPlan, InpatientMaterialPlanBasis } from '@clinmesh/contracts/inpatient-material-plan'
import { Badge } from '@clinmesh/ui/components/badge'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function InpatientMaterialPlanBasisDetails({ basis, locale }: { basis: InpatientMaterialPlanBasis; locale: WorkspaceLocale }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const sourceName = (source: InpatientMaterialPlan['source']) => source === 'material-estimate'
    ? t('单次耗材清单确认', 'Single material list confirmation') : t('持续跟进确认计划', 'Follow-up confirmed plan')
  const effective = basis.history.find(plan => plan.reference === basis.effectiveReference)
  const statusMessage = {
    confirmed: null,
    missing: t('尚无可核验的术前确认清单；未确认工作稿和单项预留不作为核查依据。', 'No verifiable preoperative list is available. Unconfirmed drafts and individual reservations are not review evidence.'),
    unverifiable: t('历史记录缺少可核验的原确认快照或绑定关系，请核实原始记录。', 'Historical records lack a verifiable original confirmation snapshot or binding. Verify the original records.'),
    conflict: t('确认来源存在冲突，核实有效依据及取代关系前不比较术前数量。', 'Confirmation sources conflict. Preoperative quantities are not compared until the effective basis and replacement relationship are verified.'),
  }[basis.status]
  return <section aria-label={`${t('手术术前确认依据', 'Surgery preoperative confirmation basis')} ${basis.requestId}`} className="flex flex-col gap-2">
    <h6 className="font-medium">{t('术前确认依据', 'Preoperative confirmation basis')} · {basis.requestId}</h6>
    {statusMessage ? <Alert><AlertDescription>{statusMessage}</AlertDescription></Alert> : null}
    {effective ? <p>{t('当前有效依据：', 'Effective basis: ')}{sourceName(effective.source)} v{effective.sourceVersion}</p> : null}
    <details><summary>{t('查看确认清单及来源历史', 'Review confirmed lists and source history')}</summary>
      <div className="flex flex-col gap-3">{basis.history.map(plan => <article key={plan.reference} className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2"><p>{sourceName(plan.source)} v{plan.sourceVersion}</p>
          <Badge variant="secondary">{plan.reference === basis.effectiveReference ? t('当前有效', 'Effective')
            : basis.history.some(later => later.supersedes === plan.reference) ? t('已被取代', 'Superseded') : t('待核实来源', 'Source to verify')}</Badge></div>
        <p>{plan.confirmedBy} · {plan.confirmedAt}</p>
        <p className="break-all">{t('确认引用：', 'Confirmation reference: ')}{plan.reference} · {t('来源：', 'Source: ')}{plan.sourceId}</p>
        {plan.supersedes ? <p className="break-all">{t('取代依据：', 'Supersedes: ')}{plan.supersedes}</p> : null}
        {plan.items.map(item => <div key={`${item.materialId}@${item.catalogVersion}`}>
          <p>{item.display} · {item.materialId} v{item.catalogVersion} · {item.specification ?? t('规格未留存', 'Specification not retained')}</p>
          <p>{t('原确认数量：', 'Originally confirmed quantity: ')}{item.quantity}{item.unit} · {t('冻结单价 ', 'Frozen unit price ')}{formatFen(item.unitPriceFen, locale)}/{item.unit} · {t('确认金额 ', 'Confirmed amount ')}{formatFen(item.estimatedFen, locale)}</p>
          <p>{item.reason} · {item.quantityBasis}</p>
        </div>)}
      </article>)}</div>
    </details>
  </section>
}
