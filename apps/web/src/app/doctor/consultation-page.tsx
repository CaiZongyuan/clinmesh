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
import { CircleAlertIcon, MessagesSquareIcon, RefreshCwIcon, SendIcon, SettingsIcon, SquareIcon, Volume2Icon } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { ApiClientError } from '../api-client.ts'
import { ConsultationVoiceBar } from '../voice/consultation-voice-bar.tsx'
import { useSpeechPlayback } from '../voice/use-speech-playback.ts'
import { useVoiceConfig } from '../voice/use-voice-config.ts'
import { useVoiceSettings } from '../voice/voice-settings-storage.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { formatClinicalTime } from './clinical-date-time.ts'

export interface ConsultationPageAction {
  error: Error | null
  onAsk: (message: string) => void
  onRetry: () => void
  onOpenReport?: (reference: string | null) => void
  pendingMessage?: string
  pending: boolean
}

export function ConsultationPage({
  action,
  caseId = 'consultation-case',
  consultation,
  locale,
  messages,
  patientBirthDate,
  patientGender,
  patientName,
  readOnly,
}: {
  action: ConsultationPageAction
  caseId?: string
  consultation: NonNullable<DoctorCaseDetail['consultation']>
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  patientBirthDate?: string | undefined
  patientGender?: string | undefined
  patientName: string
  readOnly: boolean
}): React.JSX.Element {
  const [message, setMessage] = useState('')
  const voiceSettings = useVoiceSettings()
  const { config: voiceConfig } = useVoiceConfig()
  const speech = useSpeechPlayback({
    ttsProvider: voiceConfig.ttsProvider,
    locale,
    resetKey: caseId,
  })

  const lastTextTurn = consultation.turns.findLast(turn => turn.kind === 'text')
  const unanswered = lastTextTurn?.speaker === 'doctor'
  const replyStatus = consultation.replyAttempt?.doctorTurnId === lastTextTurn?.id
    ? consultation.replyAttempt?.status : undefined
  const replyExecuting = unanswered && replyStatus === 'executing'
  const optimisticMessage = action.pending && action.pendingMessage !== undefined
    && !(unanswered && lastTextTurn.messageText === action.pendingMessage)
    ? action.pendingMessage : undefined

  // Track turns already present at mount so historical turns are never auto-played.
  const knownTurnIdsRef = useRef<Set<string> | null>(null)
  const knownCaseIdRef = useRef<string>(caseId)
  const speakRef = useRef(speech.speak)
  useEffect(() => { speakRef.current = speech.speak }, [speech.speak])

  useEffect(() => {
    if (knownCaseIdRef.current !== caseId || knownTurnIdsRef.current === null) {
      knownCaseIdRef.current = caseId
      knownTurnIdsRef.current = new Set(consultation.turns.map(turn => turn.id))
      return
    }
    const known = knownTurnIdsRef.current
    const newlyArrivedPatientTurns = consultation.turns.filter(
      turn => !known.has(turn.id) && turn.speaker === 'patient' && turn.kind === 'text',
    )
    for (const turn of consultation.turns) {
      known.add(turn.id)
    }
    const latestNew = newlyArrivedPatientTurns.at(-1)
    if (latestNew !== undefined && voiceSettings.autoSpeakPatient && !readOnly) {
      void speakRef.current(latestNew.id, latestNew.messageText, {
        patientGender,
        patientBirthDate,
      })
    }
  }, [caseId, consultation.turns, patientBirthDate, patientGender, readOnly, voiceSettings.autoSpeakPatient])

  const handleVoiceTranscript = (transcript: string) => {
    const cleaned = transcript.trim()
    if (cleaned.length === 0) return
    if (!action.pending && !unanswered) {
      action.onAsk(cleaned)
    } else {
      // Preserve spoken words in composer draft if a reply is currently in flight.
      setMessage(prev => (prev.trim().length > 0 ? `${prev.trim()} ${cleaned}` : cleaned))
    }
  }

  return (
    <section aria-label={messages.consultationRecord} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
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
              ) : consultation.turns.map((turn, index) => {
                const isThisTurnSpeaking = speech.speakingId === turn.id
                return (
                  <MessageScrollerItem key={turn.id} messageId={turn.id} scrollAnchor={turn.speaker === 'doctor'}>
                    <Message align={turn.speaker === 'doctor' ? 'end' : 'start'}>
                      <MessageContent>
                        <MessageHeader className="flex flex-wrap items-center gap-2">
                          <span>{turn.speaker === 'doctor' ? messages.doctorQuestion : patientName}</span>
                          <time className="text-xs font-normal text-muted-foreground">{formatClinicalTime(turn.recordedAt, locale)}</time>
                          {turn.speaker === 'patient' && turn.kind === 'text' ? (
                            <Button
                              aria-label={isThisTurnSpeaking
                                ? (locale === 'zh-CN' ? `停止朗读第 ${index + 1} 条患者回复` : `Stop reading patient reply #${index + 1}`)
                                : (locale === 'zh-CN' ? `朗读第 ${index + 1} 条患者回复` : `Read patient reply #${index + 1}`)}
                              className="h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                              data-testid={`patient-turn-speak-${turn.id}`}
                              onClick={() => {
                                void speech.toggleSpeak(turn.id, turn.messageText, {
                                  patientGender,
                                  patientBirthDate,
                                })
                              }}
                              size="xs"
                              type="button"
                              variant="ghost"
                            >
                              {isThisTurnSpeaking
                                ? <SquareIcon aria-hidden="true" className="size-3 fill-current" />
                                : <Volume2Icon aria-hidden="true" className="size-3.5" />}
                              <span>{isThisTurnSpeaking ? (locale === 'zh-CN' ? '停止' : 'Stop') : (locale === 'zh-CN' ? '朗读' : 'Speak')}</span>
                            </Button>
                          ) : null}
                        </MessageHeader>
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
                )
              })}
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
        <div className="flex shrink-0 flex-col gap-2">
          <ConsultationVoiceBar
            caseId={caseId}
            disabled={false}
            isSpeaking={speech.isSpeaking}
            locale={locale}
            onFinalTranscript={handleVoiceTranscript}
            onInterruptSpeech={speech.interrupt}
            onSpeechStart={speech.interrupt}
            speechError={speech.error}
            sttProvider={voiceConfig.sttProvider}
            ttsProvider={voiceConfig.ttsProvider}
          />
          <form
            className="shrink-0"
            onSubmit={event => {
              event.preventDefault()
              if (message.trim() !== '' && !action.pending && !unanswered) {
                speech.interrupt()
                action.onAsk(message.trim())
                setMessage('')
              }
            }}
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
                    onChange={event => setMessage(event.target.value)}
                    onKeyDown={event => {
                      // IME-safe Enter submission (guards WebKit keyCode 229).
                      if (event.key !== 'Enter' || event.shiftKey) return
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return
                      event.preventDefault()
                      if (message.trim() !== '' && !action.pending && !unanswered) {
                        speech.interrupt()
                        action.onAsk(message.trim())
                        setMessage('')
                      }
                    }}
                    placeholder={messages.askPatient}
                    value={message}
                  />
                  <InputGroupAddon align="block-end">
                    {action.pending ? <InputGroupText>{messages.waitingForPatientAnswer}</InputGroupText> : null}
                    {unanswered && !action.pending ? (
                      <InputGroupButton className="ml-auto" disabled={replyStatus === 'blocked'} onClick={action.onRetry} size="sm" type="button" variant="outline">
                        <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
                        {replyStatus === 'blocked' ? (locale === 'zh-CN' ? '等待模型控制恢复' : 'Waiting for model controls') : replyExecuting
                          ? (locale === 'zh-CN' ? '等待当前回答' : 'Wait for current reply')
                          : (locale === 'zh-CN' ? '重试患者回答' : 'Retry patient reply')}
                      </InputGroupButton>
                    ) : (
                      <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
                  <AlertDescription className="space-y-2">
                    <p>{getWorkspaceErrorMessage(action.error, messages)}</p>
                    {action.error instanceof ApiClientError && (
                      action.error.code === 'LLM_PROVIDER_UNCONFIGURED' || action.error.code === 'AI_AUTH_FAILED'
                    ) ? (
                      <Button render={<Link to="/settings/models" />} size="sm" variant="outline">
                        <SettingsIcon aria-hidden="true" data-icon="inline-start" />
                        {locale === 'zh-CN' ? '前往模型与服务商设置' : 'Open Models & Provider settings'}
                      </Button>
                    ) : null}
                  </AlertDescription>
                </Alert>
              )}
            </FieldGroup>
          </form>
        </div>
      )}
    </section>
  )
}
