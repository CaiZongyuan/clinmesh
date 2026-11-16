import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { doctorInpatientHistoryRecordSchema } from '@clinmesh/contracts/agent'
import type { DoctorCompletedCaseDetail } from '@clinmesh/contracts/his'
import { Button } from '@clinmesh/ui/components/button'
import { getDoctorCaseHistory, getDoctorCaseHistoryDetail } from '../api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { formatClinicalDateTime } from './clinical-date-time.ts'

export function InpatientHistorySummary({ record, locale }: { record: z.infer<typeof doctorInpatientHistoryRecordSchema>; locale: WorkspaceLocale }) {
  const zh = locale === 'zh-CN'
  return <div className="flex min-w-0 flex-col gap-3 text-sm">
    <p>{zh ? '入院' : 'Admitted'}：{formatClinicalDateTime(record.admittedAt, locale)} · {zh ? '出院' : 'Discharged'}：{formatClinicalDateTime(record.dischargedAt, locale)}</p>
    <section><h5 className="font-medium">{zh ? '正式住院诊断' : 'Confirmed inpatient diagnoses'}</h5>
      {record.diagnoses.length === 0 ? <p className="text-muted-foreground">{zh ? '未记录' : 'Not recorded'}</p> : <ul>{record.diagnoses.map((item, index) => <li key={index}>{item.role === 'primary' ? (zh ? '主诊断' : 'Primary') : (zh ? '次诊断' : 'Secondary')} · {item.display}（{item.code}）{item.note ? ` · ${item.note}` : ''}</li>)}</ul>}</section>
    <section><h5 className="font-medium">{zh ? '已完成手术与冠脉造影' : 'Completed procedures and angiography'}</h5>
      {record.procedures.length === 0 ? <p className="text-muted-foreground">{zh ? '未记录' : 'Not recorded'}</p> : <ul>{record.procedures.map((item, index) => <li key={index}>{formatClinicalDateTime(item.performedAt, locale)} · {item.display}{item.conclusion ? ` · ${item.conclusion}` : ''}</li>)}</ul>}</section>
    <section><h5 className="font-medium">{zh ? '住院有效药物医嘱' : 'Valid inpatient medication orders'}</h5>
      {record.medications.length === 0 ? <p className="text-muted-foreground">{zh ? '未记录' : 'Not recorded'}</p> : <ul>{record.medications.map((item, index) => <li key={index}>{item.display} · {item.doseText} · {item.frequencyCode} · {zh ? ({ signed: '已下达', verified: '已核对', 'stop-requested': '待停嘱核对', stopped: '已停用', completed: '已完成' }[item.state] ?? item.state) : item.state}</li>)}</ul>}</section>
    <section><h5 className="font-medium">{zh ? '已签发检验检查结论' : 'Issued investigation reports'}</h5>
      {record.reports.length === 0 ? <p className="text-muted-foreground">{zh ? '未记录' : 'Not recorded'}</p> : record.reports.map((item, index) => <div className="mt-2" key={index}><p className="font-medium">{item.title}{item.issuedAt ? ` · ${formatClinicalDateTime(item.issuedAt, locale)}` : ''}</p><p className="whitespace-pre-wrap">{item.conclusion}</p><ul>{item.findings.map((finding, i) => <li key={i}>{finding}</li>)}</ul></div>)}</section>
  </div>
}

function OutpatientHistorySummary({ record, locale }: { record: DoctorCompletedCaseDetail; locale: WorkspaceLocale }) {
  const messages = getWorkspaceMessages(locale)
  return <div className="flex min-w-0 flex-col gap-3 text-sm">
    <p>{messages.completedAt}：{formatClinicalDateTime(record.completedAt, locale)}</p>
    {record.diagnosis === undefined ? null : <section>
      <h5 className="font-medium">{locale === 'zh-CN' ? '门诊确诊' : 'Confirmed outpatient diagnoses'}</h5>
      <ul>{record.diagnosis.entries.map(item => <li key={item.conditionId}>{item.display}（{item.code}）{item.note ? ` · ${item.note}` : ''}</li>)}</ul>
    </section>}
    {record.clinicalDocuments.map(document => {
      const { content } = document
      const facts: Array<[string, string | undefined]> = 'plan' in content
        ? [[messages.assessment, content.assessment], [messages.clinicalPlan, content.plan]]
        : [
            [messages.chiefComplaint, content.chiefComplaint],
            [messages.historyOfPresentIllness, content.historyOfPresentIllness],
            [messages.priorMedicalHistory, content.priorMedicalHistory],
            [messages.familyHistory, content.familyHistory],
            [messages.allergyHistory, content.allergyHistory],
            [messages.menstrualHistory, content.menstrualHistory],
            [messages.obstetricHistory, content.obstetricHistory],
            [messages.physicalExamination, content.physicalExamination],
            [messages.auxiliaryExamination, content.auxiliaryExamination],
            [messages.assessment, content.assessment],
            [messages.disposition, content.disposition],
            [messages.followUp, content.followUp],
          ]
      return <section className="flex min-w-0 flex-col gap-2" key={document.compositionId}>
        <h5 className="font-medium">{messages.signedAt} · {formatClinicalDateTime(document.signedAt, locale)}</h5>
        <dl className="flex flex-col gap-2">{facts.map(([label, value]) => value === undefined ? null : <div key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="whitespace-pre-wrap break-words">{value || messages.clinicalHistoryNotRecorded}</dd>
        </div>)}</dl>
      </section>
    })}
    {record.clinicalDocuments.length === 0 ? <p className="text-muted-foreground">{messages.noSignedClinicalDocuments}</p> : null}
  </div>
}

export function DoctorHistoryPanel({ caseId, scope, locale }: { caseId: string; scope: string; locale: WorkspaceLocale }) {
  const zh = locale === 'zh-CN'
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string>()
  const history = useQuery({ queryKey: ['doctor-patient-history', scope, caseId, page], enabled: open,
    queryFn: ({ signal }) => getDoctorCaseHistory(caseId, page, signal) })
  const detail = useQuery({ queryKey: ['doctor-patient-history-detail', scope, caseId, selected], enabled: open && selected !== undefined,
    queryFn: ({ signal }) => getDoctorCaseHistoryDetail(caseId, selected!, signal) })
  return <details className="shrink-0 border-b px-4 py-2 text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">{zh ? '本院既往诊疗（门诊与已出院住院）' : 'Previous care at this hospital (outpatient and discharged inpatient)'}</summary>
    {open ? <div className="mt-3 flex max-h-96 min-w-0 flex-col gap-3 overflow-auto">
      {history.isPending ? <p role="status">{zh ? '正在读取病史…' : 'Loading history…'}</p> : history.isError ? <p role="alert">{zh ? '病史读取失败，请重新展开重试。' : 'History could not be loaded. Reopen to retry.'}</p> : <>
        {history.data.total === 0 ? <p>{zh ? '暂无本院完诊或已出院记录' : 'No completed outpatient or discharged inpatient records'}</p> : <ul className="flex flex-col gap-2">{history.data.items.map(item => <li key={item.entryId}>
          <Button variant="ghost" className="h-auto max-w-full justify-start whitespace-normal text-left" onClick={() => setSelected(item.entryId)}>{formatClinicalDateTime(item.clinicalDate, locale)} · {item.title}</Button>
        </li>)}</ul>}
        {history.data.total > 10 ? <div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={page === 1} onClick={() => { setPage(value => value - 1); setSelected(undefined) }}>{zh ? '上一页' : 'Previous'}</Button><span>{page}</span><Button size="sm" variant="outline" disabled={page * 10 >= history.data.total} onClick={() => { setPage(value => value + 1); setSelected(undefined) }}>{zh ? '下一页' : 'Next'}</Button></div> : null}
      </>}
      {selected === undefined ? null : detail.isPending ? <p role="status">{zh ? '正在读取详情…' : 'Loading details…'}</p> : detail.isError ? <p role="alert">{zh ? '无法读取该病史详情' : 'This history record could not be read'}</p> : detail.data.source === 'local-completed' ? 'kind' in detail.data.record ? <InpatientHistorySummary record={detail.data.record} locale={locale} /> : <OutpatientHistorySummary record={detail.data.record} locale={locale} /> : null}
    </div> : null}
  </details>
}
