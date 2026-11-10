import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getImagingStudy, getImagingStudyBlock, newIdempotencyKey } from '../api-client.ts'
import { ImagingViewer, type ImagingViewerSource } from '../imaging/imaging-viewer.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { formatClinicalDateTime } from './clinical-date-time.ts'
import { ReportText as ImagingReportText } from './investigation-service-details.tsx'
import { LaboratoryReportVersion } from './laboratory-page.tsx'
import type { OutpatientInvestigationActionContext } from './outpatient-investigation-action-store.ts'
import { reportDraftKey, reportIdentity, reportRecords, reportScope, reportSnapshot, ReportSelectionLimit, sameReport,
  type ReportRecord, type ReportRow } from './outpatient-report-reader-store.ts'
import { useOutpatientReportWriter } from './outpatient-report-writer.ts'
import { ReportText as PathologyReportText } from './pathology-page.tsx'

interface ReaderProps { context: OutpatientInvestigationActionContext; detail: DoctorCaseDetail; locale: WorkspaceLocale; readOnly: boolean }
export function OutpatientReportReader(props: ReaderProps) {
  return <ReportReaderSession key={reportDraftKey(reportScope(props.context))} {...props} />
}
function ReportPreview({ record, locale, onReady }: { record: ReportRecord; locale: WorkspaceLocale; onReady: (ready: boolean) => void }) {
  const report = record.request.report
  const studyId = report && 'studyId' in report ? report.studyId : undefined
  const study = useQuery({ enabled: studyId !== undefined, gcTime: 0, queryKey: ['outpatient-reader-study', studyId ?? 'none'], queryFn: ({ signal }) => getImagingStudy(studyId!, signal) })
  const source = useMemo<ImagingViewerSource | undefined>(() => study.data === undefined || studyId === undefined ? undefined
    : { study: study.data, loadBlock: (path, signal) => getImagingStudyBlock(studyId, path, signal) }, [study.data, studyId])
  const shown = useRef(false)
  useEffect(() => {
    if (report && 'results' in report) onReady(true)
    else if (study.isError || study.data?.available !== true) onReady(false)
    else if (shown.current) onReady(true)
  }, [report, study.isError, study.data?.available, onReady])
  const frameShown = useCallback(() => { shown.current = true; onReady(study.data?.available === true && !study.isError) }, [onReady, study.data?.available, study.isError])
  if (!report) return null
  return <article aria-label={locale === 'zh-CN' ? '当前报告全文' : 'Current full report'} className="min-w-0 space-y-3">
    <h3 className="font-semibold">{record.title}</h3>
    {'results' in report ? <LaboratoryReportVersion current locale={locale} messages={getWorkspaceMessages(locale)} report={report} />
      : 'microscopy' in report ? <PathologyReportText locale={locale} report={report} /> : <ImagingReportText locale={locale} report={report} />}
    {studyId === undefined ? null : study.isPending ? <p role="status">{locale === 'zh-CN' ? '正在读取影像或切片' : 'Loading images or slides'}</p>
      : study.isError || !source ? <Alert variant="destructive"><AlertTitle>{locale === 'zh-CN' ? '影像或切片暂不可读' : 'Images or slides unavailable'}</AlertTitle></Alert>
        : <ImagingViewer key={studyId} locale={locale} source={source} onFrameShown={frameShown} />}
  </article>
}
const messageCopy = {
  limit: ['最多保留20项，请先移除不需要的报告', 'Keep at most 20 items. Remove unwanted reports first.'],
  storage: ['无法读取或保存待确认清单，已停止写入。请恢复存储后重新读取。', 'The pending list could not be read or saved. Writes have stopped. Restore storage and reload.'],
  unknown: ['原结果仍待查明，后续项目已停止。请恢复原已阅。', 'The original result is unknown. Subsequent items have stopped. Recover the original acknowledgement.'],
  resolved: ['原已阅已查明，余项请重新打开报告并核对确认。', 'The original acknowledgement is resolved. Reopen and review the remaining reports before confirming.'],
  changed: ['阅读窗口、报告或患者状态已变化，请重新打开并核对。', 'The reading window, report or patient state changed. Reopen and review.'],
  stopped: ['本次办理已停止；原结果待查明时请先恢复，余项需重新阅读核对。', 'This attempt stopped. Recover any unknown original result, then reopen and review remaining reports.'],
} as const
const outcomeCopy = { success: ['已确认已阅', 'Acknowledged'], rejected: ['未完成，请重新核对', 'Not completed; review again'], unknown: ['结果待查明，后续项目已停止', 'Result unknown; subsequent items stopped'], waiting: ['尚未办理', 'Not yet processed'] } as const
function recordId(record: ReportRecord) { return `${record.kind}:${record.request.id}` }
function ReportReaderSession({ context, detail, locale, readOnly }: ReaderProps) {
  const text = (copy: readonly [string, string]) => copy[locale === 'zh-CN' ? 0 : 1]
  const writer = useOutpatientReportWriter(context), records = reportRecords(detail, locale)
  const [open, setOpen] = useState(false), [selectedId, setSelectedId] = useState<string | null>(null), [ready, setReady] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState(''), [page, setPage] = useState(0), [filter, setFilter] = useState<'all' | 'unread' | 'progress'>('all')
  const [review, setReview] = useState<ReportRow[] | null>(null), [discard, setDiscard] = useState(false)
  // Keep only already displayed studies observed while switching reports. Metadata cannot grant reading eligibility.
  const displayedStudies = records.flatMap(record => {
    const current = reportSnapshot(record), report = record.request.report
    return open && current && ready.has(reportIdentity(current)) && report && 'studyId' in report ? [{ identity: reportIdentity(current), studyId: report.studyId }] : []
  })
  const studyStates = useQueries({ queries: displayedStudies.map(item => ({ queryKey: ['outpatient-reader-study', item.studyId],
    queryFn: ({ signal }: { signal: AbortSignal }) => getImagingStudy(item.studyId, signal), gcTime: 0 })) })
  const unavailable = displayedStudies.filter((_, index) => studyStates[index]?.isError || studyStates[index]?.data?.available !== true).map(item => item.identity)
  const unavailableKey = JSON.stringify(unavailable)
  useEffect(() => {
    if (unavailableKey === '[]') return
    const identities: string[] = JSON.parse(unavailableKey)
    setReady(previous => { const next = new Set(previous); for (const identity of identities) next.delete(identity); return next })
  }, [unavailableKey])
  const generation = useRef(0), live = useRef({ open, ready, records, readOnly, unavailable })
  live.current = { open, ready, records, readOnly, unavailable }
  const selectedRecord = records.find(item => recordId(item) === selectedId), snapshot = selectedRecord && reportSnapshot(selectedRecord), shownIdentity = snapshot && reportIdentity(snapshot)
  const currentPreview = useRef(shownIdentity), readerGeneration = generation.current
  currentPreview.current = shownIdentity
  const onReady = useCallback((value: boolean) => {
    if (!shownIdentity || !open || generation.current !== readerGeneration || currentPreview.current !== shownIdentity) return
    setReady(previous => { if (previous.has(shownIdentity) === value) return previous; const next = new Set(previous); if (value) next.add(shownIdentity); else next.delete(shownIdentity); return next })
  }, [shownIdentity, open, readerGeneration])
  const close = () => { generation.current++; setOpen(false); setReady(new Set()); setSelectedId(null); setReview(null); setDiscard(false) }
  const blocked = readOnly || writer.error || writer.busy || writer.draft?.intent != null
  const eligible = (record: ReportRecord) => { const current = reportSnapshot(record); return record.request.status === 'reported' && current !== undefined && ready.has(reportIdentity(current)) && !unavailable.includes(reportIdentity(current)) }
  const rowEligible = (row: ReportRow) => { const record = records.find(item => item.kind === row.snapshot.kind && item.request.id === row.snapshot.requestId); return record !== undefined && sameReport(row, record) && eligible(record) }
  const reason = (record: ReportRecord | undefined) => record === undefined ? text(['报告已不存在', 'Report no longer exists'])
    : record.request.status === 'acknowledged' ? text(['已经确认已阅', 'Already acknowledged']) : record.request.status !== 'reported' ? text(['尚无可确认的正式报告', 'No final report is ready for acknowledgement'])
      : text(['请在本窗口打开最新报告；影像或切片须成功显示', 'Open the latest report in this window; images or slides must display successfully'])
  const rows = writer.draft?.rows ?? [], selected = rows.filter(row => row.selected)
  const filtered = records.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (filter === 'all' || (filter === 'unread' ? item.request.status === 'reported' : ['issued', 'accepted', 'in-progress'].includes(item.request.status))))
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 10) - 1)), visible = filtered.slice(currentPage * 10, currentPage * 10 + 10)
  const choose = (items: ReportRecord[], checked: boolean) => writer.change(value => {
    let next = value.rows
    for (const record of items) {
      const current = reportSnapshot(record)
      if (!current || (checked && !eligible(record))) continue
      const old = next.find(row => row.snapshot.kind === record.kind && row.snapshot.requestId === record.request.id)
      if (!checked) next = next.map(row => row === old ? { ...row, selected: false } : row)
      else if (old && sameReport(old, record)) next = next.map(row => row === old ? { ...row, selected: true } : row)
      else next = [...next.filter(row => row !== old), { revision: newIdempotencyKey(), snapshot: current, selected: true }]
    }
    if (next.length > 20) throw new ReportSelectionLimit()
    return { ...value, rows: next }
  })
  const run = (plan: ReportRow[] | null) => {
    const token = generation.current; setReview(null)
    void writer.run(plan, row => {
      const current = live.current
      if (generation.current !== token || !current.open || current.readOnly) return false
      if (!row) return true
      const record = current.records.find(item => item.kind === row.snapshot.kind && item.request.id === row.snapshot.requestId)
      return record !== undefined && sameReport(row, record) && record.request.status === 'reported' && current.ready.has(reportIdentity(row.snapshot)) && !current.unavailable.includes(reportIdentity(row.snapshot))
    }).finally(() => { generation.current++; setReady(new Set()); setSelectedId(null) })
  }
  return <>
    <Button aria-label={text(['连续阅读报告', 'Read reports continuously'])} variant="outline" onClick={() => { generation.current++; setReady(new Set()); setOpen(true) }}>{text(['连续阅读报告', 'Read reports continuously'])}<Badge variant="secondary">{records.filter(item => item.request.status === 'reported').length}{text([' 份待阅', ' unread'])}</Badge></Button>
    <Dialog open={open} onOpenChange={value => { if (!value) close() }}><DialogContent showCloseButton={false} className="max-w-[min(94vw,90rem)]">
      <DialogHeader className="pr-4"><div className="flex items-start justify-between gap-3"><DialogTitle>{review ? text(['报告已阅核对', 'Review report acknowledgements']) : text(['报告阅读与已阅确认', 'Read and acknowledge reports'])}</DialogTitle><Button size="sm" variant="ghost" onClick={close}>{text(['关闭阅读窗口', 'Close reading window'])}</Button></div><DialogDescription>{context.patientName}{text([' · 同患者同次就诊。打开报告不会自动确认已阅。', ' · This patient and encounter. Opening a report does not acknowledge it.'])}</DialogDescription></DialogHeader>
      <div className="min-h-0 overflow-y-auto p-4">
        {writer.error ? <Alert variant="destructive"><AlertTitle>{text(['待确认清单存储不可用', 'Pending-list storage unavailable'])}</AlertTitle><AlertDescription>{text(messageCopy.storage)}<Button size="sm" variant="outline" onClick={writer.reload}>{text(['重新读取清单', 'Reload pending list'])}</Button></AlertDescription></Alert> : null}
        {writer.message ? <p role="status" className="py-2 text-sm">{text(messageCopy[writer.message])}</p> : null}
        {writer.draft?.intent ? <Alert><AlertTitle>{text(['原已阅结果待查明', 'Original acknowledgement result unknown'])}</AlertTitle><AlertDescription><Button disabled={readOnly || writer.busy || writer.error} onClick={() => run(null)}>{text(['恢复原已阅', 'Recover original acknowledgement'])}</Button></AlertDescription></Alert> : null}
        {review ? <section className="space-y-3"><p>{text(['仅确认以下明确选择且本轮已阅读的报告。', 'Confirm only these explicitly selected reports read during this session.'])}</p>{review.map(row => <article className="rounded-lg border p-3" key={row.revision}><strong>{row.snapshot.title}</strong><p>{formatClinicalDateTime(row.snapshot.issuedAt, locale)} · {text(['第', 'Revision '])}{row.snapshot.revisionNumber}{text(['版', ''])}</p>{rowEligible(row) ? null : <p className="text-destructive">{text(messageCopy.changed)}</p>}</article>)}<div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setReview(null)}>{text(['返回阅读', 'Back to reading'])}</Button><Button disabled={blocked || review.some(row => !rowEligible(row))} onClick={() => run(review)}>{text(['确认选中报告已阅', 'Confirm selected reports acknowledged'])}</Button></div></section>
          : <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)_minmax(14rem,1fr)]">
            <section aria-label={text(['报告列表', 'Report list'])} className="min-w-0 space-y-3">
              <p className="text-sm">{text(['全部申请', 'All requests'])} {records.length} · {text(['待阅', 'Unread'])} {records.filter(item => item.request.status === 'reported').length}</p>
              <Input aria-label={text(['搜索报告', 'Search reports'])} value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} />
              <ToggleGroup aria-label={text(['筛选报告', 'Filter reports'])} size="sm" variant="outline" className="flex-wrap" value={[filter]} onValueChange={values => { const value = values[0]; if (value === 'all' || value === 'unread' || value === 'progress') { setFilter(value); setPage(0) } }}><ToggleGroupItem value="all">{text(['全部', 'All'])}</ToggleGroupItem><ToggleGroupItem value="unread">{text(['待阅', 'Unread'])}</ToggleGroupItem><ToggleGroupItem value="progress">{text(['进行中', 'In progress'])}</ToggleGroupItem></ToggleGroup>
              <Button size="sm" variant="outline" disabled={blocked} onClick={() => choose(visible.filter(eligible), true)}>{text(['全选本页可确认报告', 'Select eligible reports on this page'])}</Button>
              {visible.length === 0 ? <p>{text(['没有匹配的报告', 'No matching reports'])}</p> : <ul className="space-y-2">{visible.map(record => <li key={recordId(record)} className="space-y-2 rounded-lg border p-2"><Button className="h-auto w-full justify-start whitespace-normal text-left" variant={selectedId === recordId(record) ? 'secondary' : 'ghost'} disabled={!record.request.report} aria-label={`${text(['打开报告：', 'Open report: '])}${record.title}`} onClick={() => setSelectedId(recordId(record))}>{record.title}</Button><Field orientation="horizontal"><Checkbox aria-label={`${text(['选择已阅：', 'Select acknowledgement: '])}${record.title}`} checked={rows.some(row => row.selected && sameReport(row, record))} disabled={blocked || !eligible(record)} onCheckedChange={checked => choose([record], checked)} /><FieldLabel>{text(['确认已阅', 'Acknowledge'])}</FieldLabel></Field><p className="text-xs text-muted-foreground">{eligible(record) ? text(['本轮已阅读，可选择', 'Read this session; eligible for selection']) : reason(record)}</p></li>)}</ul>}
              <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{text(['上一页报告', 'Previous reports page'])}</Button><span className="text-xs">{currentPage + 1}/{Math.max(1, Math.ceil(filtered.length / 10))} · {text(['每页10项', '10 per page'])}</span><Button size="sm" variant="outline" disabled={(currentPage + 1) * 10 >= filtered.length} onClick={() => setPage(currentPage + 1)}>{text(['下一页报告', 'Next reports page'])}</Button></div>
            </section>
            <section className="min-w-0 rounded-lg border p-3">{selectedRecord && shownIdentity ? <ReportPreview key={shownIdentity} record={selectedRecord} locale={locale} onReady={onReady} /> : <p className="text-sm text-muted-foreground">{text(['请从列表打开一份报告，全文在此显示。', 'Open a report from the list to display its full content here.'])}</p>}</section>
            <section role="region" aria-label={text(['报告完整待确认清单', 'Complete pending report acknowledgements'])} className="min-w-0 space-y-3">
              <h3 className="text-sm font-semibold">{text(['待确认', 'Pending'])} {rows.length}/20 · {text(['已选', 'Selected'])} {selected.length}</h3>
              <div className="flex flex-wrap gap-2"><Button size="sm" disabled={blocked || selected.length === 0 || selected.some(row => !rowEligible(row))} onClick={() => setReview(structuredClone(selected))}>{text(['核对选中报告', 'Review selected reports'])}</Button><Button size="sm" variant="outline" disabled={blocked || selected.length === 0} onClick={() => writer.change(value => ({ ...value, rows: value.rows.map(row => ({ ...row, selected: false })) }))}>{text(['清空已阅选择', 'Clear acknowledgement selection'])}</Button><Button size="sm" variant="outline" disabled={blocked || rows.length === 0} onClick={() => setDiscard(true)}>{text(['丢弃已阅清单', 'Discard acknowledgement list'])}</Button></div>
              {discard ? <Alert><AlertTitle>{text(['确认丢弃待确认清单', 'Confirm discarding the pending list'])}</AlertTitle><AlertDescription>{text(['仅移除待办，不删除报告或正式已阅记录。', 'This removes pending items without deleting reports or acknowledgements.'])}<Button disabled={blocked} onClick={() => { writer.change(value => ({ ...value, rows: [] })); setDiscard(false) }}>{text(['确认丢弃', 'Confirm discard'])}</Button><Button variant="outline" onClick={() => setDiscard(false)}>{text(['保留清单', 'Keep list'])}</Button></AlertDescription></Alert> : null}
              {rows.map(row => { const record = records.find(item => item.kind === row.snapshot.kind && item.request.id === row.snapshot.requestId); return <div className="space-y-2 rounded-lg border p-2" key={row.revision}><Field orientation="horizontal"><Checkbox aria-label={`${text(['待确认已阅：', 'Pending acknowledgement: '])}${record?.title ?? row.snapshot.title}`} checked={row.selected} disabled={blocked || !rowEligible(row)} onCheckedChange={checked => writer.change(value => ({ ...value, rows: value.rows.map(item => item.revision === row.revision ? { ...item, selected: checked } : item) }))} /><FieldLabel>{record?.title ?? row.snapshot.title}</FieldLabel></Field>{!rowEligible(row) ? <p className="text-xs text-muted-foreground">{sameReport(row, record) ? reason(record) : text(['报告版本或申请已变化，请重新阅读并核对', 'The report revision or request changed. Reopen and review it.'])}</p> : null}{record && !sameReport(row, record) ? <Button size="sm" variant="outline" disabled={blocked || !eligible(record)} onClick={() => choose([record], true)}>{text(['重新核对此报告', 'Review this report again'])}</Button> : null}<Button size="sm" variant="ghost" disabled={blocked} aria-label={`${text(['移除已阅：', 'Remove acknowledgement: '])}${record?.title ?? row.snapshot.title}`} onClick={() => writer.change(value => ({ ...value, rows: value.rows.filter(item => item.revision !== row.revision) }))}>{text(['移除项目', 'Remove item'])}</Button></div> })}
            </section>
          </div>}
        {writer.draft?.results.length ? <section role="region" aria-label={text(['报告已阅逐项结果', 'Report acknowledgement results'])} className="mt-4 space-y-2 rounded-lg border p-3"><p role="status">{writer.busy ? text(['办理中', 'Processing']) : writer.draft.intent ? text(['已停止，原结果待查明', 'Stopped; original result unknown']) : text(['本次办理已结束', 'This attempt has finished'])} · {text(['成功', 'Succeeded'])} {writer.draft.results.filter(item => item.status === 'success').length}/{writer.draft.results.length}</p>{writer.draft.results.map(item => <p key={item.revision} className="text-sm">{item.title}{text(['：', ': '])}{text(outcomeCopy[item.status])}</p>)}</section> : null}
      </div>
    </DialogContent></Dialog>
  </>
}
