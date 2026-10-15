import type { ClinicalDocumentContent, ConsultationHistoryDecision, DoctorCaseDetail } from '@clinmesh/contracts/his'
import { findCompleteStatementQuote } from '@clinmesh/core/document-text'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import type { getWorkspaceMessages, WorkspaceLocale } from '../workspace-i18n.ts'
import { formatClinicalDateTime } from './clinical-date-time.ts'

function QuotedReply({ text, quotes }: { text: string; quotes: string[] }): React.JSX.Element {
  const ranges = quotes.flatMap(quote => {
    const range = findCompleteStatementQuote(text, quote)
    return range === undefined ? [] : [range]
  }).sort((left, right) => left.start - right.start)
  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.end <= cursor) continue
    parts.push(text.slice(cursor, range.start))
    parts.push(<mark className="bg-accent text-accent-foreground" key={`${range.start}:${range.end}`}>{text.slice(Math.max(cursor, range.start), range.end)}</mark>)
    cursor = range.end
  }
  parts.push(text.slice(cursor))
  return <blockquote className="whitespace-pre-wrap break-words">{parts}</blockquote>
}

export interface ConsultationHistoryReviewAction {
  additionId?: string | undefined
  error: Error | null
  pending: boolean
  onSubmit: (additionId: string, decision: ConsultationHistoryDecision) => void
}

export function ConsultationHistoryReview({ detail, field, workingDocument, action, disabled, messages, locale }: {
  detail: DoctorCaseDetail
  field: keyof ClinicalDocumentContent
  workingDocument: ClinicalDocumentContent
  action: ConsultationHistoryReviewAction | undefined
  disabled: boolean
  messages: ReturnType<typeof getWorkspaceMessages>
  locale: WorkspaceLocale
}): React.JSX.Element | null {
  const additions = detail.consultationRecording?.additions.filter(addition => addition.field === field) ?? []
  if (additions.length === 0) return null
  const turns = detail.consultation?.turns ?? []
  const turnsById = new Map(turns.map(turn => [turn.id, turn]))
  const recordingSources = detail.consultationRecording?.sources ?? []
  const sourcesById = new Map(recordingSources.map(source => [source.id, source]))
  const active = additions.filter(addition => addition.status === 'pending'
    || (addition.status === 'applied' && addition.reviewStatus !== 'confirmed'))
  const history = additions.filter(addition => !active.includes(addition))
  const renderAddition = (addition: typeof additions[number]) => {
    const applied = addition.status === 'applied'
    const pending = addition.status === 'pending'
    const undoPending = applied && addition.reviewStatus === 'undo-pending'
    const dirty = (workingDocument[addition.field] ?? '') !== (detail.clinicalDocument?.draft?.[addition.field] ?? '')
    const facts = addition.facts ?? []
    const summary = addition.summary || addition.quote
    const citations = facts.length === 0 ? [{ sourceTurnId: addition.sourceTurnId, quote: addition.quote }]
      : facts.flatMap(fact => fact.sources)
    const sourceIds = [...new Set(citations.map(source => source.sourceTurnId))]
    const sources = sourceIds
      .flatMap(id => {
        const source = sourcesById.get(id)
        if (source !== undefined) return [source]
        const turn = turnsById.get(id)
        return turn?.speaker !== 'patient' || turn.kind !== 'text' ? [] : [{ id: turn.id, kind: 'patient' as const,
          messageText: turn.messageText, recordedAt: turn.recordedAt, consultationTurnId: turn.id }]
      })
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
    const kinds = [...new Set(sources.map(source => source.kind))]
    const sourceLabels = { patient: messages.consultationHistoryPatientSource,
      doctor: messages.consultationHistoryDoctorSource, report: messages.consultationHistoryReportSource }
    const sourceTitle = kinds.length !== 1 || sources.length !== sourceIds.length ? messages.consultationHistoryMixedSource
      : kinds[0] === 'patient' ? messages.consultationHistorySource
        : kinds[0] === 'doctor' ? messages.consultationHistoryDoctorOriginal : messages.consultationHistoryReportOriginal
    const label = addition.status === 'undone' ? messages.consultationHistoryUndone
      : addition.status === 'ignored' ? messages.consultationHistoryIgnored
        : addition.status === 'superseded' ? messages.consultationHistorySuperseded
          : pending ? messages.consultationHistoryPending : undoPending ? messages.consultationRecordingReview
            : addition.reviewStatus === 'confirmed' ? messages.consultationHistoryApplied
              : addition.relation === 'correction' ? messages.consultationHistoryCorrected : messages.consultationRecordingAdded
    return <li className="flex min-w-0 flex-col gap-2" data-consultation-addition={addition.status}
      data-consultation-review={addition.reviewStatus} key={addition.id}>
      <p className="whitespace-pre-wrap break-words"><Badge variant={pending || (applied && addition.reviewStatus === 'unreviewed') ? 'secondary' : 'outline'}>
        {label}
      </Badge>{' '}{messages[addition.field]}：{summary}</p>
      {pending ? <>
        {addition.currentText ? <p className="whitespace-pre-wrap break-words">{messages.consultationHistoryOriginal}：{addition.currentText}</p>
          : addition.reviewable ? <p>{messages.consultationHistoryAppend}</p> : null}
        {addition.reviewable ? null : <p>{messages.consultationHistoryNoTarget}</p>}
      </> : null}
      {undoPending ? <>
        <p>{messages.consultationHistoryUndoPending}</p>
        <p className="whitespace-pre-wrap break-words">{messages.consultationHistoryOriginal}：{addition.currentText}</p>
      </> : null}
      {(pending || applied) && dirty ? <p>{messages.consultationHistorySaveFirst}</p> : null}
      {sources.length === sourceIds.length ? null
        : <p>{messages.consultationHistorySourceUnavailable}</p>}
      {action?.additionId !== addition.id || action.error === null ? null : <p role="alert">{getWorkspaceErrorMessage(action.error, messages)}</p>}
      <div className="flex flex-wrap gap-2">
        {sources.length === 0 ? null : <Dialog>
          <DialogTrigger render={<Button size="sm" variant="outline" type="button" />}>
            {messages.consultationHistoryViewSource}
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{sourceTitle}</DialogTitle>
              <DialogDescription>{messages[addition.field]} · {kinds.map(kind => sourceLabels[kind]).join(' / ')}
                {kinds.includes('patient') ? ` · ${messages.consultationHistoryPatientStatement}` : ''}</DialogDescription>
            </DialogHeader>
            <div data-consultation-source-content className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3">
              <p className="whitespace-pre-wrap break-words">{messages.consultationHistorySummary}：{summary}</p>
              {facts.length === 0 ? null : <ul className="flex flex-col gap-2">
                {facts.map((fact, index) => <li key={index} className="whitespace-pre-wrap break-words">
                  {fact.text} · {messages.consultationHistoryCitation} {sources.filter(source => fact.sources.some(citation => citation.sourceTurnId === source.id))
                    .map(source => turnsById.get(source.consultationTurnId ?? source.id)?.sequence ?? sourceLabels[source.kind]).join(', ')}
                </li>)}
              </ul>}
              {sources.map(source => {
                const sourceTurn = turnsById.get(source.consultationTurnId ?? source.id)
                const question = source.kind !== 'patient' || sourceTurn === undefined ? undefined
                  : turns.findLast(turn => turn.sequence < sourceTurn.sequence && turn.speaker === 'doctor' && turn.kind === 'text')
                return <section key={source.id} className="flex flex-col gap-2" data-consultation-source={source.id}>
                  <p>{sourceLabels[source.kind]}{source.kind !== 'patient' || sourceTurn === undefined ? '' : ` · ${messages.consultationHistoryTurn} ${sourceTurn.sequence}`}
                    {' · '}{formatClinicalDateTime(source.recordedAt, locale)}</p>
                  {source.reportReference === undefined ? null : <p className="break-words">{source.reportReference}</p>}
                  {question === undefined ? null : <p className="whitespace-pre-wrap break-words">{messages.consultationHistoryQuestion}：{question.messageText}</p>}
                  <QuotedReply text={source.messageText} quotes={citations.filter(citation => citation.sourceTurnId === source.id).map(citation => citation.quote)} />
                </section>
              })}
            </div>
          </DialogContent>
        </Dialog>}
        {action === undefined ? null : pending ? <>
          <Button size="sm" type="button" disabled={disabled || action.pending || dirty || !addition.reviewable}
            onClick={() => action.onSubmit(addition.id, 'accept')}>{messages.consultationHistoryAccept}</Button>
          <Button size="sm" variant="outline" type="button" disabled={disabled || action.pending}
            onClick={() => action.onSubmit(addition.id, 'ignore')}>{messages.consultationHistoryIgnore}</Button>
        </> : applied ? <>
          {addition.reviewStatus === 'confirmed' ? null : <Button size="sm" type="button" disabled={disabled || action.pending || dirty}
            onClick={() => action.onSubmit(addition.id, 'confirm')}>{messages.consultationHistoryConfirm}</Button>}
          {undoPending ? null : <Button size="sm" variant="outline" type="button" disabled={disabled || action.pending || dirty}
            onClick={() => action.onSubmit(addition.id, 'undo')}>{messages.consultationHistoryUndo}</Button>}
        </> : null}
      </div>
    </li>
  }
  return <div className="flex min-w-0 flex-col gap-2" data-consultation-field-suggestions={field}>
{active.length === 0 ? null : <p role="status" data-consultation-unreviewed={active.length}>
  {messages.consultationHistoryUnreviewed} {active.length}
</p>}
{active.length === 0 ? null : <ul className="flex flex-col gap-3">{active.map(renderAddition)}</ul>}
{history.length === 0 ? null : <details>
  <summary className="cursor-pointer">{messages.consultationHistoryHistory} {history.length}</summary>
  <ul className="mt-2 flex flex-col gap-3">{history.map(renderAddition)}</ul>
</details>}
  </div>
}
