import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Bubble, BubbleContent } from '@clinmesh/ui/components/bubble'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea } from '@clinmesh/ui/components/input-group'
import { Message, MessageContent, MessageHeader } from '@clinmesh/ui/components/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@clinmesh/ui/components/message-scroller'
import { CircleAlertIcon, LoaderCircleIcon, MessagesSquareIcon, MicIcon, RefreshCwIcon, SendIcon, SquareIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { useOptionalWebRuntime, type WebSurfaceVoiceSnapshot } from '../web-runtime.tsx'
import { formatClinicalTime } from './clinical-date-time.ts'
import { ConsultationRecordingControls, type ConsultationRecordingAction } from './consultation-recording-controls.tsx'

const EMPTY_VOICE_SNAPSHOT: WebSurfaceVoiceSnapshot = {
  installed: false,
  ready: false,
  phase: 'idle',
  shortcutEnabled: false,
  shortcut: '',
}

const noopSubscribe = () => () => {}

function deepActiveElement(root: Document | ShadowRoot): Element | null {
  let current = root.activeElement
  while (current !== null && current.shadowRoot !== null && current.shadowRoot.activeElement !== null) {
    current = current.shadowRoot.activeElement
  }
  return current
}

function isTextareaVisible(textarea: HTMLTextAreaElement | null): boolean {
  if (textarea === null || !textarea.isConnected || textarea.disabled) return false
  if (textarea.closest('[hidden]') !== null) return false
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    const style = window.getComputedStyle(textarea)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

export interface ConsultationPageAction {
  error: Error | null
  onAsk: (message: string) => void
  onRetry: () => void
  onOpenReport?: (reference: string | null) => void
  pendingMessage?: string
  pending: boolean
}

export function ConsultationPage({ action, consultation, locale, messages, patientName, readOnly, recording, recordingAction, recordingReadOnly }: {
  action: ConsultationPageAction
  consultation: NonNullable<DoctorCaseDetail['consultation']>
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  patientName: string
  readOnly: boolean
  recording?: DoctorCaseDetail['consultationRecording']
  recordingAction?: ConsultationRecordingAction | undefined
  recordingReadOnly?: boolean
}): React.JSX.Element {
  const [message, setMessage] = useState('')
  const formRef = useRef<HTMLFormElement | null>(null)
  const messageDraftRef = useRef(message)
  const runtime = useOptionalWebRuntime()
  const voiceInput = runtime?.surfaceVoiceInput
  const voiceSnapshot = useSyncExternalStore(
    voiceInput === undefined ? noopSubscribe : voiceInput.subscribe,
    voiceInput === undefined ? () => EMPTY_VOICE_SNAPSHOT : voiceInput.getSnapshot,
    voiceInput === undefined ? () => EMPTY_VOICE_SNAPSHOT : voiceInput.getSnapshot,
  )
  const lastTextTurn = consultation.turns.findLast(turn => turn.kind === 'text')
  const unanswered = lastTextTurn?.speaker === 'doctor'
  const replyStatus = consultation.replyAttempt?.doctorTurnId === lastTextTurn?.id
    ? consultation.replyAttempt?.status : undefined
  const replyExecuting = unanswered && replyStatus === 'executing'
  const optimisticMessage = action.pending && action.pendingMessage !== undefined
    && !(unanswered && lastTextTurn.messageText === action.pendingMessage)
    ? action.pendingMessage : undefined

  const voiceDisabled = readOnly || action.pending || unanswered
  const voiceActive = voiceSnapshot.phase === 'starting' || voiceSnapshot.phase === 'recording'
  const voiceBusy = voiceSnapshot.phase === 'transcribing' || voiceSnapshot.phase === 'polishing'
  const voiceOwningRef = useRef(false)
  const surfaceActive = runtime?.surfaceActive !== false
  const rightPaneHidden = runtime?.surfaceDisplay?.fullscreen === true
    || runtime?.surfaceDisplay?.conversation?.collapsed === true

  const latestRef = useRef({
    surfaceActive,
    rightPaneHidden,
    voiceDisabled,
    voiceSnapshot,
    voiceInput,
  })
  useEffect(() => {
    messageDraftRef.current = message
    latestRef.current = {
      surfaceActive,
      rightPaneHidden,
      voiceDisabled,
      voiceSnapshot,
      voiceInput,
    }
  })

  const toggleVoice = () => {
    const latest = latestRef.current
    const controller = latest.voiceInput
    if (controller === undefined || latest.voiceDisabled) return
    const current = latest.voiceSnapshot
    if (current.phase === 'starting' || current.phase === 'recording') {
      controller.stop()
      return
    }
    if (current.phase === 'transcribing' || current.phase === 'polishing') return
    if (!current.ready) return
    voiceOwningRef.current = true
    controller.start({
      getDraft: () => messageDraftRef.current,
      setDraft: next => {
        const clamped = next.slice(0, 2000)
        messageDraftRef.current = clamped
        setMessage(clamped)
      },
    })
  }
  const toggleVoiceRef = useRef(toggleVoice)
  useEffect(() => {
    toggleVoiceRef.current = toggleVoice
  })

  useEffect(() => {
    if (voiceSnapshot.phase === 'idle' || voiceSnapshot.phase === 'error') {
      voiceOwningRef.current = false
    }
  }, [voiceSnapshot.phase])

  useEffect(() => {
    if (voiceInput === undefined) return
    if (surfaceActive) voiceInput.refresh()
  }, [voiceInput, surfaceActive])

  useEffect(() => {
    if (voiceInput === undefined) return
    return voiceInput.registerShortcutHandler({
      shouldHandle: () => {
        const latest = latestRef.current
        if (!latest.surfaceActive || latest.voiceDisabled) return false
        const textarea = formRef.current?.querySelector('textarea') ?? null
        if (!isTextareaVisible(textarea)) return false
        const active = typeof document === 'undefined' ? null : deepActiveElement(document)
        if (textarea !== null && active === textarea) return true
        return latest.rightPaneHidden
      },
      toggle: () => toggleVoiceRef.current(),
    })
  }, [voiceInput])

  useEffect(() => {
    if ((voiceDisabled || !surfaceActive) && voiceOwningRef.current) {
      voiceOwningRef.current = false
      latestRef.current.voiceInput?.cancel()
    }
  }, [voiceDisabled, surfaceActive])

  useEffect(() => () => {
    if (voiceOwningRef.current) {
      voiceOwningRef.current = false
      latestRef.current.voiceInput?.cancel()
    }
  }, [])

  const chinese = locale === 'zh-CN'
  const showVoiceControl = voiceInput !== undefined && voiceSnapshot.installed && !unanswered
  const voiceLabel = voiceActive
    ? (chinese ? '停止语音输入' : 'Stop voice input')
    : voiceSnapshot.phase === 'transcribing'
      ? (chinese ? '正在转写语音' : 'Transcribing voice')
      : voiceSnapshot.phase === 'polishing'
        ? (chinese ? '正在润色文本' : 'Polishing text')
        : voiceSnapshot.ready
          ? (chinese ? '语音输入' : 'Voice input')
          : (voiceSnapshot.unavailableReason ?? (chinese ? '语音输入暂不可用' : 'Voice input unavailable'))
  const voiceStatusText = voiceSnapshot.phase === 'starting'
    ? (chinese ? '正在启动麦克风…' : 'Starting microphone…')
    : voiceSnapshot.phase === 'recording'
      ? (chinese ? '正在录音…' : 'Recording…')
      : voiceSnapshot.phase === 'transcribing'
        ? (chinese ? '正在转写…' : 'Transcribing…')
        : voiceSnapshot.phase === 'polishing'
          ? (chinese ? '正在润色…' : 'Polishing…')
          : undefined

  return (
    <section aria-label={messages.consultationRecord} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      {recording === undefined || recordingReadOnly === true ? null : (
        <ConsultationRecordingControls recording={recording} action={recordingAction}
          disabled={readOnly || recording.signingPreparation?.active === true} messages={messages} />
      )}
      <MessageScrollerProvider autoScroll>
        <MessageScroller data-agent-consultation="" className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-4 p-3">
              {consultation.turns.length === 0 ? (
                <MessageScrollerItem messageId="empty-consultation-records">
                  <Empty className="min-h-52">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><MessagesSquareIcon aria-hidden="true" /></EmptyMedia>
                      <EmptyTitle>{messages.noConsultationHistory}</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                </MessageScrollerItem>
              ) : consultation.turns.map(turn => (
                <MessageScrollerItem key={turn.id} messageId={turn.id} scrollAnchor={turn.speaker === 'doctor'}>
                  <Message align={turn.speaker === 'doctor' ? 'end' : 'start'}>
                    <MessageContent>
                      <MessageHeader className="flex flex-wrap items-center gap-2">{turn.speaker === 'doctor' ? messages.doctorQuestion : patientName}<time className="text-xs font-normal text-muted-foreground">{formatClinicalTime(turn.recordedAt, locale)}</time></MessageHeader>
                      <Bubble data-agent-consultation-message={turn.kind === 'text' ? turn.id : undefined} align={turn.speaker === 'doctor' ? 'end' : 'start'} variant={turn.speaker === 'doctor' ? 'default' : 'muted'}>
                        <BubbleContent>
                          <p className="whitespace-pre-wrap">{turn.messageText}</p>
                          {turn.kind === 'report-card' ? (
                            <Button onClick={() => action.onOpenReport?.(turn.reportReference)} size="sm" type="button" variant="outline">
                              {locale === 'zh-CN' ? '查看报告' : 'View report'}
                            </Button>
                          ) : null}
                        </BubbleContent>
                      </Bubble>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ))}
              {optimisticMessage === undefined ? null : (
                <MessageScrollerItem messageId="sending-doctor-message" scrollAnchor>
                  <Message align="end"><MessageContent>
                    <MessageHeader>{messages.doctorQuestion}</MessageHeader>
                    <Bubble data-agent-consultation-pending="" align="end"><BubbleContent>{optimisticMessage}</BubbleContent></Bubble>
                  </MessageContent></Message>
                </MessageScrollerItem>
              )}
              {action.pending || replyExecuting ? (
                <MessageScrollerItem messageId="patient-typing">
                  <Message><MessageContent><Bubble data-agent-consultation-pending="" variant="muted"><BubbleContent>
                    <span role="status">{locale === 'zh-CN' ? '患者正在输入…' : 'The patient is typing…'}</span>
                  </BubbleContent></Bubble></MessageContent></Message>
                </MessageScrollerItem>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      {readOnly ? null : (
        <form
          className="shrink-0"
          onFocus={() => {
            if (voiceSnapshot.installed && !voiceSnapshot.ready && voiceSnapshot.phase === 'idle') {
              voiceInput?.refresh()
            }
          }}
          onPointerEnter={() => {
            if (voiceSnapshot.installed && !voiceSnapshot.ready && voiceSnapshot.phase === 'idle') {
              voiceInput?.refresh()
            }
          }}
          onSubmit={event => {
            event.preventDefault()
            if (message.trim() !== '' && !action.pending && !unanswered) {
              if (voiceOwningRef.current || voiceActive || voiceBusy) {
                voiceOwningRef.current = false
                voiceInput?.cancel()
              }
              action.onAsk(message.trim())
              messageDraftRef.current = ''
              setMessage('')
            }
          }}
          ref={formRef}
        >
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel className="sr-only" htmlFor="consultation-message">{messages.askPatient}</FieldLabel>
              <InputGroup aria-label={messages.askPatient} className="border-input bg-card dark:bg-card focus-within:ring-2 focus-within:ring-ring/30">
                <InputGroupTextarea
                  className="max-h-40 overflow-y-auto"
                  disabled={action.pending || unanswered}
                  id="consultation-message"
                  maxLength={2000}
                  onChange={event => {
                    if (voiceSnapshot.phase === 'error') voiceInput?.clearError()
                    messageDraftRef.current = event.target.value
                    setMessage(event.target.value)
                  }}
                  placeholder={messages.askPatient}
                  value={message}
                />
                <InputGroupAddon align="block-end">
                  {action.pending ? <InputGroupText>{messages.waitingForPatientAnswer}</InputGroupText> : null}
                  {!action.pending && showVoiceControl && voiceStatusText !== undefined ? (
                    <InputGroupText role="status" aria-live="polite">
                      {voiceStatusText}
                    </InputGroupText>
                  ) : null}
                  {!action.pending && showVoiceControl && (voiceActive || voiceBusy) ? (
                    <InputGroupButton
                      aria-label={chinese ? '取消语音输入' : 'Cancel voice input'}
                      onClick={() => {
                        voiceOwningRef.current = false
                        voiceInput?.cancel()
                      }}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      <XIcon aria-hidden="true" />
                      {chinese ? '取消' : 'Cancel'}
                    </InputGroupButton>
                  ) : null}
                  {unanswered && !action.pending ? (
                    <InputGroupButton className="ml-auto" disabled={replyStatus === 'blocked'} onClick={action.onRetry} size="sm" type="button" variant="outline">
                      <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
                      {replyStatus === 'blocked' ? (locale === 'zh-CN' ? '等待模型控制恢复' : 'Waiting for model controls') : replyExecuting
                        ? (locale === 'zh-CN' ? '等待当前回答' : 'Wait for current reply')
                        : (locale === 'zh-CN' ? '重试患者回答' : 'Retry patient reply')}
                    </InputGroupButton>
                  ) : (
                    <div className="ml-auto flex shrink-0 items-center gap-1.5">
                      {showVoiceControl ? (
                        <InputGroupButton
                          aria-label={voiceLabel}
                          aria-pressed={voiceActive}
                          className="shrink-0 transition-none"
                          data-voice-state={voiceSnapshot.phase}
                          disabled={voiceDisabled || voiceBusy || (!voiceActive && !voiceSnapshot.ready)}
                          onClick={toggleVoice}
                          size="icon-sm"
                          title={voiceLabel}
                          type="button"
                          variant={voiceActive ? 'destructive' : 'outline'}
                        >
                          {voiceBusy
                            ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
                            : voiceActive
                              ? <SquareIcon aria-hidden="true" />
                              : <MicIcon aria-hidden="true" />}
                        </InputGroupButton>
                      ) : null}
                      <InputGroupButton
                        aria-label={action.pending ? messages.waitingForPatientAnswer : messages.askPatient}
                        className="shrink-0 transition-none"
                        data-unavailable={action.pending || message.trim() === '' ? '' : undefined}
                        disabled={action.pending || message.trim() === ''}
                        size="sm"
                        title={action.pending ? messages.waitingForPatientAnswer : messages.askPatient}
                        type="submit"
                        variant="default"
                      >
                        {action.pending
                          ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
                          : <SendIcon aria-hidden="true" data-icon="inline-start" />}
                        {locale === 'zh-CN' ? '发送' : 'Send'}
                      </InputGroupButton>
                    </div>
                  )}
                </InputGroupAddon>
              </InputGroup>
              {showVoiceControl && voiceSnapshot.phase === 'error' && voiceSnapshot.error !== undefined ? (
                <p className="text-destructive text-xs" role="alert">
                  {voiceSnapshot.error}
                </p>
              ) : null}
              {unanswered && !action.pending ? (
                <p className="text-muted-foreground text-sm">
                  {replyStatus === 'blocked'
                    ? (locale === 'zh-CN' ? '医生问题已保存，模型控制恢复且本次回答期限仍有效时将自动接续。' : 'The doctor question is saved. The reply resumes if model controls recover before its deadline.') : replyExecuting
                    ? (locale === 'zh-CN' ? '患者回答仍在生成，等待将复用本次回答。' : 'The patient is still answering. Waiting reuses this reply.')
                    : replyStatus === 'failed'
                      ? (locale === 'zh-CN' ? '患者回答失败。重试将使用当前 ClinMesh 模型设置。' : 'The patient reply failed. Retry uses the current ClinMesh model settings.')
                      : (locale === 'zh-CN' ? '上次回答结果未知，未自动补答。明确重试将使用当前 ClinMesh 模型设置。' : 'The previous reply outcome is unknown. No reply was started automatically. An explicit retry uses the current ClinMesh model settings.')}
                </p>
              ) : null}
            </Field>
            {action.error === null ? null : (
              <Alert variant="destructive">
                <CircleAlertIcon aria-hidden="true" />
                <AlertTitle>{getWorkspaceErrorTitle(action.error, messages, messages.operationFailed)}</AlertTitle>
                <AlertDescription>{getWorkspaceErrorMessage(action.error, messages)}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
        </form>
      )}
    </section>
  )
}
