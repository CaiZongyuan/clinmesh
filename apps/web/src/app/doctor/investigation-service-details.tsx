import type { ImagingReport, OutpatientInvestigationPrice } from '@clinmesh/contracts/his'
import { Fragment, type ReactNode } from 'react'
import type { WorkspaceLocale } from '../workspace-i18n.ts'
import { formatClinicalDateTime } from './clinical-date-time.ts'
import { InvestigationPrice } from './investigation-billing.tsx'

export function ReportText({ locale, report }: { locale: WorkspaceLocale; report: ImagingReport }) {
  const zh = locale === 'zh-CN'
  return (
    <dl className="mt-2 grid gap-2 text-sm">
      <div><dt className="text-xs text-muted-foreground">{zh ? '检查技术' : 'Technique'}</dt><dd>{report.technique}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{zh ? '检查所见' : 'Findings'}</dt><dd>{report.findings}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{zh ? '印象' : 'Impression'}</dt><dd>{report.impression}</dd></div>
      <div className="text-xs text-muted-foreground">
        {zh ? '签发时间 ' : 'Issued '}{formatClinicalDateTime(report.issuedAt, locale)}
        {zh ? ` · 第 ${report.revisionNumber} 版` : ` · Revision ${report.revisionNumber}`}
        {report.revisionReason === undefined ? '' : zh ? `，更正原因：${report.revisionReason}` : `: ${report.revisionReason}`}
        {report.acknowledgement === undefined ? '' : zh ? ` · 已阅 ${formatClinicalDateTime(report.acknowledgement.acknowledgedAt, locale)}` : ` · Acknowledged ${formatClinicalDateTime(report.acknowledgement.acknowledgedAt, locale)}`}
      </div>
    </dl>
  )
}

/** 三类检查在目录选择后使用同一事实层级；只呈现已取得的服务快照。 */
export function InvestigationServiceDetails({ code, facts, locale, name, price, priceFact }: {
  code?: string | undefined
  facts: ReadonlyArray<{ label: string; value: ReactNode }>
  locale: WorkspaceLocale
  name: string
  price?: OutpatientInvestigationPrice | undefined
  /** 住院等其他计价口径替换门诊价格行。 */
  priceFact?: { label: string; value: ReactNode } | undefined
}) {
  return <>
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 className="min-w-0 break-words text-sm font-semibold">{name}</h3>
      {code === undefined ? null : <span className="break-all font-mono text-xs text-muted-foreground">{code}</span>}
    </div>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-3 text-sm">
      {facts.map(({ label, value }) => <Fragment key={label}><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{value}</dd></Fragment>)}
      <dt className="text-muted-foreground">{priceFact?.label ?? (locale === 'zh-CN' ? '门诊价格' : 'Outpatient price')}</dt>
      <dd className="min-w-0">{priceFact === undefined ? <InvestigationPrice locale={locale} price={price} presentation="fact" /> : priceFact.value}</dd>
    </dl>
  </>
}
