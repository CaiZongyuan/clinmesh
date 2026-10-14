import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { findCompleteStatementQuote } from '@clinmesh/core/document-text'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { Separator } from '@clinmesh/ui/components/separator'
import { useId } from 'react'
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

export function ConsultationHistorySources({ detail, field, messages, locale }: {
  detail: DoctorCaseDetail
  field: NonNullable<DoctorCaseDetail['consultationRecording']>['additions'][number]['field']
  messages: ReturnType<typeof getWorkspaceMessages>
  locale: WorkspaceLocale
}): React.JSX.Element | null {
  const headingId = useId()
  const additions = detail.consultationRecording?.additions.filter(addition => addition.field === field) ?? []
  if (additions.length === 0) return null
  const turns = detail.consultation?.turns ?? []
  const turnsById = new Map(turns.map(turn => [turn.id, turn]))
  const renderAddition = (addition: typeof additions[number], index: number) => {
    const facts = addition.facts ?? []
    const summary = addition.summary || addition.quote
    const citations = facts.length === 0 ? [{ sourceTurnId: addition.sourceTurnId, quote: addition.quote }]
      : facts.flatMap(fact => fact.sources)
    const sources = [...new Set(citations.map(source => source.sourceTurnId))]
      .flatMap(id => { const turn = turnsById.get(id); return turn === undefined ? [] : [turn] })
      .sort((left, right) => left.sequence - right.sequence)
    const label = addition.status === 'superseded' ? messages.consultationHistorySuperseded
      : addition.status === 'undone' ? messages.consultationHistoryUndone
        : addition.status === 'ignored' ? messages.consultationHistoryIgnored : messages.consultationHistoryApplied
    return <li className="flex min-w-0 flex-col gap-2" data-consultation-addition={addition.status}
      key={addition.id}>
      {index === 0 ? null : <Separator />}
      <Badge variant="outline">{label}</Badge>
      <p className="whitespace-pre-wrap break-words">{summary}</p>
      <div className="flex flex-wrap gap-2">
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
  return <details className="min-w-0 text-sm" data-consultation-field-sources={field}>
    <summary id={headingId} className="cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">{messages.consultationHistorySources} {additions.length}</summary>
    <div className="mt-3">{renderList(additions)}</div>
  </details>
}
