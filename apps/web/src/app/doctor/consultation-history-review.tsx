import type { ClinicalDocumentContent, ConsultationHistoryDecision, DoctorCaseDetail } from '@clinmesh/contracts/his'
import { findCompleteStatementQuote } from '@clinmesh/core/document-text'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { Separator } from '@clinmesh/ui/components/separator'
import { useId } from 'react'
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
  field: NonNullable<DoctorCaseDetail['consultationRecording']>['additions'][number]['field']
  workingDocument: ClinicalDocumentContent
  action: ConsultationHistoryReviewAction | undefined
  disabled: boolean
  messages: ReturnType<typeof getWorkspaceMessages>
  locale: WorkspaceLocale
}): React.JSX.Element | null {
  const headingId = useId()
  const additions = detail.consultationRecording?.additions.filter(addition => addition.field === field) ?? []
  if (additions.length === 0) return null
  const turns = detail.consultation?.turns ?? []
  const turnsById = new Map(turns.map(turn => [turn.id, turn]))
  const active = additions.filter(addition => addition.status === 'pending'
    || (addition.status === 'applied' && addition.reviewStatus !== 'confirmed'))
  const history = additions.filter(addition => !active.includes(addition))
  const renderAddition = (addition: typeof additions[number], index: number) => {
    const applied = addition.status === 'applied'
    const pending = addition.status === 'pending'
    const undoPending = applied && addition.reviewStatus === 'undo-pending'
    const dirty = (workingDocument[addition.field] ?? '') !== (detail.clinicalDocument?.draft?.[addition.field] ?? '')
    const facts = addition.facts ?? []
    const summary = addition.summary || addition.quote
    const citations = facts.length === 0 ? [{ sourceTurnId: addition.sourceTurnId, quote: addition.quote }]
      : facts.flatMap(fact => fact.sources)
    const sources = [...new Set(citations.map(source => source.sourceTurnId))]
      .flatMap(id => { const turn = turnsById.get(id); return turn === undefined ? [] : [turn] })
      .sort((left, right) => left.sequence - right.sequence)
    const label = addition.status === 'undone' ? messages.consultationHistoryUndone
      : addition.status === 'ignored' ? messages.consultationHistoryIgnored
        : addition.status === 'superseded' ? messages.consultationHistorySuperseded
          : pending ? messages.consultationHistoryPending : undoPending ? messages.consultationRecordingReview
            : addition.reviewStatus === 'confirmed' ? messages.consultationHistoryApplied
              : addition.relation === 'correction' ? messages.consultationHistoryCorrected : messages.consultationRecordingAdded
    return <li className="flex min-w-0 flex-col gap-2" data-consultation-addition={addition.status}
      data-consultation-review={addition.reviewStatus} key={addition.id}>
      {index === 0 ? null : <Separator />}
      <div className="flex flex-wrap items-center gap-2"><Badge variant={pending || (applied && addition.reviewStatus === 'unreviewed') ? 'secondary' : 'outline'}>
        {label}
      </Badge>
        {!pending || (addition.relation !== 'correction' && addition.relation !== 'conflict') ? null
          : <Badge variant="outline">{addition.relation === 'correction' ? messages.consultationHistoryCorrection : messages.consultationHistoryConflict}</Badge>}
      </div>
      {pending && addition.currentText ? <>
        <p className="text-muted-foreground">{messages.consultationHistoryReplace}</p>
        <dl className="flex min-w-0 flex-col gap-2">
          <div><dt className="text-muted-foreground">{messages.consultationHistoryOriginal}</dt>
            <dd className="whitespace-pre-wrap break-words">{addition.currentText}</dd></div>
          <div><dt className="text-muted-foreground">{messages.consultationHistorySuggestion}</dt>
            <dd className="whitespace-pre-wrap break-words">{summary}</dd></div>
        </dl>
      </> : <p className="whitespace-pre-wrap break-words">{summary}</p>}
      {pending && addition.reviewable && !addition.currentText ? <p className="text-muted-foreground">{messages.consultationHistoryAppend}</p> : null}
      {pending && !addition.reviewable ? <Alert><AlertDescription>{messages.consultationHistoryNoTarget}</AlertDescription></Alert> : null}
      {undoPending ? <>
        <p>{messages.consultationHistoryUndoPending}</p>
        <p className="whitespace-pre-wrap break-words">{messages.consultationHistoryOriginal}：{addition.currentText}</p>
      </> : null}
      {(pending || applied) && dirty ? <Alert><AlertDescription>{messages.consultationHistorySaveFirst}</AlertDescription></Alert> : null}
      {action?.additionId !== addition.id || action.error === null ? null
        : <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(action.error, messages)}</AlertDescription></Alert>}
      <div className="flex flex-wrap gap-2">
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
        {sources.length === 0 ? null : <Dialog>
          <DialogTrigger render={<Button size="sm" variant="outline" type="button" />}>
            {messages.consultationHistoryViewSource}
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{messages.consultationHistorySource}</DialogTitle>
              <DialogDescription>{messages[addition.field]} · {messages.consultationHistoryPatientStatement}</DialogDescription>
            </DialogHeader>
            <div data-consultation-source-content className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3">
              <p className="whitespace-pre-wrap break-words">{messages.consultationHistorySummary}：{summary}</p>
              {facts.length === 0 ? null : <ul className="flex flex-col gap-2">
                {facts.map((fact, index) => <li key={index} className="whitespace-pre-wrap break-words">
                  {fact.text} · {messages.consultationHistoryCitation} {sources.filter(source => fact.sources.some(citation => citation.sourceTurnId === source.id))
                    .map(source => source.sequence).join(', ')}
                </li>)}
              </ul>}
              {sources.map(source => {
                const question = turns.findLast(turn => turn.sequence < source.sequence && turn.speaker === 'doctor' && turn.kind === 'text')
                return <section key={source.id} className="flex flex-col gap-2" data-consultation-source={source.id}>
                  <p>{messages.consultationHistoryTurn} {source.sequence} · {formatClinicalDateTime(source.recordedAt, locale)}</p>
                  {question === undefined ? null : <p className="whitespace-pre-wrap break-words">{messages.consultationHistoryQuestion}：{question.messageText}</p>}
                  <QuotedReply text={source.messageText} quotes={citations.filter(citation => citation.sourceTurnId === source.id).map(citation => citation.quote)} />
                </section>
              })}
            </div>
          </DialogContent>
        </Dialog>}
      </div>
    </li>
  }
  const renderList = (items: typeof additions) => <ul className="flex flex-col gap-3">{items.map(renderAddition)}</ul>
  return <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3 rounded-md border bg-muted/40 p-3"
    data-consultation-field-suggestions={field}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h5 className="text-sm font-semibold" id={headingId}>{messages.consultationHistorySuggestions}</h5>
      {active.length === 0 ? null : <Badge variant="secondary" role="status" data-consultation-unreviewed={active.length}>
        {messages.consultationHistoryPendingCount} {active.length}
      </Badge>}
    </div>
    {active.some(addition => addition.status === 'applied') ? <p>{messages.consultationHistoryUnreviewed}</p> : null}
    {active.length === 0 ? null : renderList(active)}
    {history.length === 0 ? null : <details>
      <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">{messages.consultationHistoryHistory} {history.length}</summary>
      <div className="mt-3">{renderList(history)}</div>
    </details>}
  </section>
}
