import type { OutpatientInvestigationPrice } from '@clinmesh/contracts/his'
import { Fragment, type ReactNode } from 'react'
import type { WorkspaceLocale } from '../workspace-i18n.ts'
import { InvestigationPrice } from './investigation-billing.tsx'

/** 三类检查在目录选择后使用同一事实层级；只呈现已取得的服务快照。 */
export function InvestigationServiceDetails({ code, facts, locale, name, price }: {
  code: string
  facts: ReadonlyArray<{ label: string; value: ReactNode }>
  locale: WorkspaceLocale
  name: string
  price?: OutpatientInvestigationPrice | undefined
}) {
  return <>
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 className="min-w-0 break-words text-sm font-semibold">{name}</h3>
      <span className="break-all font-mono text-xs text-muted-foreground">{code}</span>
    </div>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-3 text-sm">
      {facts.map(({ label, value }) => <Fragment key={label}><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{value}</dd></Fragment>)}
      <dt className="text-muted-foreground">{locale === 'zh-CN' ? '门诊价格' : 'Outpatient price'}</dt>
      <dd className="min-w-0"><InvestigationPrice locale={locale} price={price} presentation="fact" /></dd>
    </dl>
  </>
}
