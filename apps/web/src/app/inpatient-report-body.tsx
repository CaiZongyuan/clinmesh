import { Badge } from '@clinmesh/ui/components/badge'
import type { z } from 'zod'
import type { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { formatClinicalDateTime } from './doctor/clinical-date-time.ts'
import { formatLabReferenceRange, formatLabResultDisplay } from './inpatient-report-format.ts'
type LabReport = NonNullable<z.infer<typeof inpatientInvestigationsSchema>['laboratoryRequests'][number]['report']>
type Report = NonNullable<(z.infer<typeof inpatientInvestigationsSchema>['laboratoryRequests'][number] | z.infer<typeof inpatientInvestigationsSchema>['imagingRequests'][number])['report']>

export function InpatientReportBody({ report, locale }: { report: Report; locale: WorkspaceLocale }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  return <>
    {'impression' in report ? <dl className="grid gap-3 text-sm">
      <div><dt className="text-xs text-muted-foreground">{t('印象 / 结论', 'Impression / conclusion')}</dt><dd className="whitespace-pre-wrap">{report.impression}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t('检查所见', 'Findings')}</dt><dd className="whitespace-pre-wrap">{report.findings}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t('检查技术', 'Technique')}</dt><dd>{report.technique}</dd></div>
    </dl> : <InpatientLabReportTable report={report} locale={locale} />}
    {report.revisionReason ? <p className="text-xs text-muted-foreground">{t('更正原因：', 'Correction reason: ')}{report.revisionReason}</p> : null}
    {report.acknowledgement ? <p className="text-xs text-muted-foreground">{t('已阅 ', 'Acknowledged ')}{formatClinicalDateTime(report.acknowledgement.acknowledgedAt, locale)}</p> : null}
  </>
}

export function InpatientLabReportTable({ locale, report }: { locale: WorkspaceLocale; report: LabReport }) {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  return <div className="flex flex-col gap-1.5 pt-1">
    {report.conclusion && !report.conclusion.includes('仅用于仿真') ? <p className="text-xs text-muted-foreground">{report.conclusion}</p> : null}
    <table className="clinmesh-inpatient-table">
      <thead>
        <tr>
          <th>{t('项目', 'Item')}</th>
          <th>{t('结果', 'Result')}</th>
          <th>{t('参考范围', 'Reference range')}</th>
          <th>{t('提示', 'Flag')}</th>
        </tr>
      </thead>
      <tbody>
        {report.results.map((result, index) => {
          const val = typeof result.value === 'object' ? result.value.display : String(result.value)
          const unit = 'unit' in result && result.unit.display !== '1' ? ` ${result.unit.display}` : ''
          const flag = result.interpretation === 'high' ? t('偏高 ↑', 'High ↑') : result.interpretation === 'low' ? t('偏低 ↓', 'Low ↓') : t('正常', 'Normal')
          const abnormal = result.interpretation === 'high' || result.interpretation === 'low'
          return <tr key={index}>
            <td className="font-medium">{formatLabResultDisplay(result.display)}</td>
            <td className={`tabular-nums ${abnormal ? 'font-semibold text-warning' : ''}`}>{val}{unit}</td>
            <td className="tabular-nums text-muted-foreground">{formatLabReferenceRange(result.referenceRange.text)}</td>
            <td>{abnormal ? <Badge variant="warning">{flag}</Badge> : <span className="text-xs text-muted-foreground">{flag}</span>}</td>
          </tr>
        })}
      </tbody>
    </table>
  </div>
}
