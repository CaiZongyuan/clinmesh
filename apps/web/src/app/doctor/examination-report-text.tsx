import type { examinationReportSchema } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import type { WorkspaceLocale } from '../workspace-i18n.ts'

const reportDateFormatters: Record<WorkspaceLocale, Intl.DateTimeFormat> = {
  'en-US': new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }),
  'zh-CN': new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }),
}
const formatReportDateTime = (value: string, locale: WorkspaceLocale) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : reportDateFormatters[locale].format(date)
}

export function ExaminationReportText({
  report,
  locale,
}: {
  report: z.infer<typeof examinationReportSchema>
  locale: WorkspaceLocale
}) {
  const zh = locale === 'zh-CN'
  const mark = (interpretation: z.infer<typeof examinationReportSchema>['results'][number]['interpretation']) =>
    interpretation === 'high' ? ' ↑' : interpretation === 'low' ? ' ↓' : interpretation === 'abnormal' ? (zh ? '（异常）' : ' (Abnormal)') : ''
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{report.technique}</span>
        <span>
          {zh ? '签发 ' : 'Issued '}
          {formatReportDateTime(report.issuedAt, locale)}
          {report.acknowledgement === undefined
            ? ''
            : ` · ${zh ? '已阅 ' : 'Acknowledged '}${formatReportDateTime(report.acknowledgement.acknowledgedAt, locale)}`}
        </span>
      </div>
      <table className="w-full text-left">
        <thead>
          <tr>
            <th>{zh ? '指标' : 'Measurement'}</th>
            <th>{zh ? '结果' : 'Result'}</th>
            <th>{zh ? '参考' : 'Reference'}</th>
          </tr>
        </thead>
        <tbody>
          {report.results.map((result) => (
            <tr key={result.code}>
              <td>{result.display}</td>
              <td className={result.interpretation === 'normal' ? undefined : 'font-medium text-warning'}>
                {typeof result.value === 'object' ? result.value.display : String(result.value)}
                {result.unit === undefined ? '' : ` ${result.unit.display}`}
                {mark(result.interpretation)}
              </td>
              <td>{result.referenceRange.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="whitespace-pre-wrap">{report.impression}</p>
    </div>
  )
}
