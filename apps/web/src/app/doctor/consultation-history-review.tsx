import type { ClinicalDocumentContent, ConsultationHistoryDecision, DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import type { getWorkspaceMessages, WorkspaceLocale } from '../workspace-i18n.ts'
import { formatClinicalDateTime } from './clinical-date-time.ts'

export interface ConsultationHistoryReviewAction {
  error: Error | null
  pending: boolean
  onSubmit: (additionId: string, decision: ConsultationHistoryDecision) => void
}

export function ConsultationHistoryReview({ detail, workingDocument, action, disabled, messages, locale }: {
  detail: DoctorCaseDetail
  workingDocument: ClinicalDocumentContent
  action: ConsultationHistoryReviewAction | undefined
  disabled: boolean
  messages: ReturnType<typeof getWorkspaceMessages>
  locale: WorkspaceLocale
}): React.JSX.Element | null {
  const additions = detail.consultationRecording?.additions ?? []
  if (additions.length === 0) return null
  const outstanding = additions.filter(addition => addition.status === 'pending'
    || (addition.status === 'applied' && addition.reviewStatus !== 'confirmed')).length
  return <div className="flex flex-col gap-2">
    {outstanding === 0 ? null : <p role="status" data-consultation-unreviewed={outstanding}>
      {messages.consultationHistoryUnreviewed} {outstanding}
    </p>}
    <ul className="flex flex-col gap-3">
      {additions.map(addition => {
        const applied = addition.status === 'applied'
        const pending = addition.status === 'pending'
        const undoPending = applied && addition.reviewStatus === 'undo-pending'
        const dirty = (workingDocument[addition.field] ?? '') !== (detail.clinicalDocument?.draft?.[addition.field] ?? '')
        const source = detail.consultation?.turns.find(turn => turn.id === addition.sourceTurnId)
        const label = addition.status === 'undone' ? messages.consultationHistoryUndone
          : addition.status === 'ignored' ? messages.consultationHistoryIgnored
            : addition.status === 'superseded' ? messages.consultationHistorySuperseded
              : pending || undoPending ? messages.consultationRecordingReview
                : addition.reviewStatus === 'confirmed' ? messages.consultationHistoryConfirmed
                  : addition.relation === 'correction' ? messages.consultationHistoryCorrected : messages.consultationRecordingAdded
        return <li className="flex min-w-0 flex-col gap-2" data-consultation-addition={addition.status}
          data-consultation-review={addition.reviewStatus} key={addition.id}>
          <p className="whitespace-pre-wrap break-words"><Badge variant={applied && addition.reviewStatus === 'unreviewed' ? 'secondary' : 'outline'}>
            {label}
          </Badge>{' '}{messages[addition.field]}：{addition.quote}</p>
          {pending ? <>
            <p className="whitespace-pre-wrap break-words">{messages.consultationHistoryOriginal}：{addition.currentText || (addition.reviewable ? messages.consultationHistoryDeleted : messages.consultationHistoryNoTarget)}</p>
            <p className="whitespace-pre-wrap break-words">{messages.consultationHistorySuggestion}：{addition.quote}</p>
            <p className="whitespace-pre-wrap break-words">{messages.consultationHistorySource}：{source?.messageText}</p>
          </> : null}
          {undoPending ? <>
            <p>{messages.consultationHistoryUndoPending}</p>
            <p className="whitespace-pre-wrap break-words">{messages.consultationHistoryOriginal}：{addition.currentText}</p>
          </> : null}
          {(pending || applied) && dirty ? <p>{messages.consultationHistorySaveFirst}</p> : null}
          <div className="flex flex-wrap gap-2">
            {source === undefined ? null : <Dialog>
              <DialogTrigger render={<Button size="sm" variant="outline" type="button" />}>
                {messages.consultationHistoryViewSource}
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{messages.consultationHistorySource}</DialogTitle>
                  <DialogDescription>{messages[addition.field]} · {formatClinicalDateTime(source.recordedAt, locale)}</DialogDescription>
                </DialogHeader>
                <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3">
                  <p className="whitespace-pre-wrap break-words">{messages.consultationHistorySuggestion}：{addition.quote}</p>
                  <blockquote className="whitespace-pre-wrap break-words">{source.messageText}</blockquote>
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
      })}
    </ul>
  </div>
}
