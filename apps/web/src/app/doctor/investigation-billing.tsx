import type { OutpatientInvestigationBilling, OutpatientInvestigationPrice } from '@clinmesh/contracts/his'
import { Badge } from '@clinmesh/ui/components/badge'
import { formatFen } from '../workspace-format.ts'
import type { WorkspaceLocale } from '../workspace-i18n.ts'

export function missingInvestigationPrice(locale: WorkspaceLocale) {
  return locale === 'zh-CN'
    ? '未配置本院门诊价格，可保存草稿，暂不能正式开立。'
    : 'The hospital outpatient price is missing. You can save a draft, but cannot issue this order yet.'
}

export function InvestigationPrice({ locale, price }: { locale: WorkspaceLocale; price?: OutpatientInvestigationPrice | undefined }) {
  if (price === undefined) return <p className="text-xs text-muted-foreground">{missingInvestigationPrice(locale)}</p>
  const zh = locale === 'zh-CN'
  return <div className="text-xs text-muted-foreground">
    <p>{zh ? '本院门诊价格：' : 'Hospital outpatient price: '}{formatFen(price.priceFen, locale)} / {price.unit} · {zh ? '数量 1' : 'Quantity 1'}</p>
    <details><summary className="cursor-pointer">{price.source.startsWith('synthetic-') ? zh ? '合成门诊价目' : 'Synthetic outpatient price' : zh ? '价目来源' : 'Price source'}</summary>
      <p className="break-all">{price.source} · {zh ? `第 ${price.version} 版` : `v${price.version}`} · {zh ? '生效日期 ' : 'Effective '}{price.effectiveOn}</p>
    </details>
  </div>
}

const billingStatusLabels: Record<OutpatientInvestigationBilling['status'], [string, string]> = {
  pending: ['待缴费', 'Awaiting payment'], partial: ['部分缴费', 'Partially paid'],
  ambiguous: ['资金结果待确认', 'Funds outcome unknown'], paid: ['已满足放行', 'Cleared for execution'],
  cancelled: ['已取消', 'Cancelled'],
}

export function InvestigationBilling({ billing, locale }: { billing?: OutpatientInvestigationBilling | undefined; locale: WorkspaceLocale }) {
  if (billing === undefined) return null
  const zh = locale === 'zh-CN'
  return <section aria-label={zh ? '申请收费信息' : 'Request billing'} className="my-3 flex min-w-0 flex-col gap-2 rounded-md border p-3">
    <Badge variant={billing.status === 'ambiguous' ? 'warning' : 'outline'}>{billingStatusLabels[billing.status][zh ? 0 : 1]}</Badge>
    <InvestigationPrice locale={locale} price={billing.price} />
    <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
      <div><dt>{zh ? '净实收' : 'Net received'}</dt><dd>{formatFen(billing.paidFen, locale)}</dd></div>
      <div><dt>{zh ? '医保覆盖' : 'Insurance coverage'}</dt><dd>{formatFen(billing.insuranceFen, locale)}</dd></div>
      <div><dt>{zh ? '待缴金额' : 'Remaining amount'}</dt><dd>{formatFen(billing.remainingFen, locale)}</dd></div>
    </dl>
    <p className="break-all text-xs text-muted-foreground">{zh ? '原费用：' : 'Original charge: '}<span>{billing.chargeItemId}</span></p>
    {billing.status === 'cancelled' && billing.paidFen > 0 ? <p className="text-sm">{zh ? '已取消，原付款由收费员按原交易退款。' : 'Cancelled. The cashier refunds the original payments through their original transactions.'}</p> : null}
    {billing.status === 'ambiguous' ? <p className="text-sm">{zh ? '请由收费员查询原交易结果，确认前不重复收退或执行。' : 'Ask the cashier to query the original transaction before collecting, refunding or executing again.'}</p> : null}
  </section>
}
