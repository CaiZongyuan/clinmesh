import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Button } from '@clinmesh/ui/components/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuTrigger } from '@clinmesh/ui/components/dropdown-menu'
import { ChevronDownIcon, HistoryIcon, PauseIcon, PlayIcon, RotateCcwIcon } from 'lucide-react'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import type { getWorkspaceMessages } from '../workspace-i18n.ts'

export interface ConsultationRecordingAction {
  error: Error | null
  pending: boolean
  onSubmit: (action: 'activate' | 'pause' | 'resume' | 'backfill' | 'retry') => void
}

export function ConsultationRecordingControls({ recording, action, disabled, messages }: {
  recording: DoctorCaseDetail['consultationRecording']
  action: ConsultationRecordingAction | undefined
  disabled: boolean
  messages: ReturnType<typeof getWorkspaceMessages>
}): React.JSX.Element | null {
  if (recording === undefined || (recording.version === 0 && recording.status === 'idle' && action?.error != null)) {
    return action?.error == null ? null : <div className="flex min-w-0 flex-wrap items-center gap-2">
      <p role="alert">{getWorkspaceErrorMessage(action.error, messages)}</p>
      <Button size="sm" type="button" variant="outline" disabled={disabled || action.pending}
        onClick={() => action.onSubmit('activate')}>{messages.consultationRecordingRetry}</Button>
    </div>
  }
  const labels = {
    idle: messages.consultationRecordingReady, processing: messages.consultationRecordingProcessing,
    updated: messages.consultationRecordingUpdated,
    paused: messages.consultationRecordingPaused, backfill: messages.consultationRecordingBackfill,
    failed: messages.consultationRecordingIncomplete,
  }
  const intent = recording.status === 'backfill' ? 'backfill' : recording.paused ? 'resume' : 'pause'
  const compact = {
    idle: messages.consultationRecordingIdleShort, processing: messages.consultationRecordingProcessingShort,
    updated: messages.consultationRecordingUpdatedShort,
    paused: messages.consultationRecordingPausedShort, backfill: messages.consultationRecordingBackfillShort,
    failed: undefined,
  }
  const intentLabel = intent === 'backfill' ? messages.consultationRecordingStartBackfill
    : intent === 'resume' ? messages.consultationRecordingResume : messages.consultationRecordingPause
  return <div className="flex min-w-0 flex-wrap items-center gap-1" data-consultation-recording={recording.status}>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant="outline" type="button" aria-label={messages.consultationAutoRecord} />}>
        <span role="status">{messages.consultationAutoRecord}{compact[recording.status] === undefined ? '' : ` · ${compact[recording.status]}`}</span>
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 max-w-(--available-width)">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="whitespace-normal">{labels[recording.status]}</DropdownMenuLabel>
          <DropdownMenuLabel className="whitespace-normal">{messages.consultationRecordingProcessed} {recording.processedCount} · {messages.consultationRecordingRemaining} {recording.remainingCount}</DropdownMenuLabel>
          {!recording.failures.some(failure => failure.retrying) ? null : <DropdownMenuLabel className="whitespace-normal">
            {messages.consultationRecordingRetrying}
          </DropdownMenuLabel>}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    {recording.requiresContextBinding !== true ? null : <>
      <span role="status">{messages.consultationRecordingBindingRequired}</span>
      {action === undefined ? null : <Button size="sm" type="button" variant="outline"
        disabled={disabled || action.pending} onClick={() => action.onSubmit('activate')}>
        {messages.consultationRecordingBindContext}
      </Button>}
    </>}
    {action === undefined ? null : <>
      <Button size="icon-sm" variant="outline" type="button" aria-label={intentLabel} title={intentLabel}
        disabled={disabled || action.pending} onClick={() => action.onSubmit(intent)}>
        {intent === 'backfill' ? <HistoryIcon /> : intent === 'resume' ? <PlayIcon /> : <PauseIcon />}
      </Button>
      {recording.status !== 'failed' || recording.paused || recording.requiresContextBinding === true ? null : <Button size="icon-sm" variant="outline" type="button"
        aria-label={messages.consultationRecordingRetry} title={messages.consultationRecordingRetry}
        disabled={disabled || action.pending} onClick={() => action.onSubmit('retry')}><RotateCcwIcon /></Button>}
    </>}
    {action?.error == null ? null : <p role="alert">{getWorkspaceErrorMessage(action.error, messages)}</p>}
  </div>
}
