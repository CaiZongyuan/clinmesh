import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Button } from '@clinmesh/ui/components/button'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import type { getWorkspaceMessages } from '../workspace-i18n.ts'

export interface ConsultationRecordingAction {
  error: Error | null
  pending: boolean
  onSubmit: (action: 'pause' | 'resume' | 'backfill' | 'retry') => void
}

export function ConsultationRecordingControls({ recording, action, disabled, messages }: {
  recording: NonNullable<DoctorCaseDetail['consultationRecording']>
  action: ConsultationRecordingAction | undefined
  disabled: boolean
  messages: ReturnType<typeof getWorkspaceMessages>
}): React.JSX.Element {
  const labels = {
    idle: messages.consultationRecordingReady, processing: messages.consultationRecordingProcessing,
    updated: messages.consultationRecordingUpdated, pending: messages.consultationRecordingPending,
    paused: messages.consultationRecordingPaused, backfill: messages.consultationRecordingBackfill,
    failed: messages.consultationRecordingFailed,
  }
  const intent = recording.status === 'backfill' ? 'backfill' : recording.paused ? 'resume' : 'pause'
  return <div className="flex flex-col gap-2">
    <p role="status">{labels[recording.status]}</p>
    <p>{messages.consultationRecordingProcessed} {recording.processedCount} · {messages.consultationRecordingRemaining} {recording.remainingCount}</p>
    {action === undefined ? null : <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" type="button" disabled={disabled || action.pending}
        onClick={() => action.onSubmit(intent)}>
        {intent === 'backfill' ? messages.consultationRecordingStartBackfill
          : intent === 'resume' ? messages.consultationRecordingResume : messages.consultationRecordingPause}
      </Button>
      {recording.status !== 'failed' ? null : <Button size="sm" type="button" disabled={disabled || action.pending}
        onClick={() => action.onSubmit('retry')}>{messages.consultationRecordingRetry}</Button>}
    </div>}
    {action?.error == null ? null : <p role="alert">{getWorkspaceErrorMessage(action.error, messages)}</p>}
  </div>
}
