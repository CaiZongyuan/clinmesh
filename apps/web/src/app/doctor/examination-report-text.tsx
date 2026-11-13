import type { examinationReportSchema } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import type { WorkspaceLocale } from '../workspace-i18n.ts'

export function ExaminationReportText({
  report,
  locale,
}: {
  report: z.infer<typeof examinationReportSchema>
  locale: WorkspaceLocale
}) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>{report.technique}</p>
      <table className="w-full text-left">
        <thead>
          <tr>
            <th>{locale === 'zh-CN' ? '指标' : 'Measurement'}</th>
            <th>{locale === 'zh-CN' ? '结果' : 'Result'}</th>
            <th>{locale === 'zh-CN' ? '参考' : 'Reference'}</th>
          </tr>
        </thead>
        <tbody>
          {report.results.map((result) => (
            <tr key={result.code}>
              <td>{result.display}</td>
              <td>
                {typeof result.value === 'object' ? result.value.display : String(result.value)} {result.unit?.display}
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
