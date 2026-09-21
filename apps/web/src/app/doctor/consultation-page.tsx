import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Bubble, BubbleContent } from '@clinmesh/ui/components/bubble'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea } from '@clinmesh/ui/components/input-group'
import { Message, MessageContent, MessageFooter, MessageHeader } from '@clinmesh/ui/components/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@clinmesh/ui/components/message-scroller'
import { CircleAlertIcon, MessagesSquareIcon, RefreshCwIcon, SendIcon } from 'lucide-react'
import { useState } from 'react'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { formatClinicalTime } from './clinical-date-time.ts'

export interface ConsultationPageAction {
  error: Error | null
  onAsk: (message: string) => void
  onRetry: () => void
  onOpenReport?: () => void
  pendingMessage?: string
  pending: boolean
}

export function ConsultationPage({ action, consultation, locale, messages, patientName, readOnly }: {
  action: ConsultationPageAction
  consultation: NonNullable<DoctorCaseDetail['consultation']>
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  patientName: string
  readOnly: boolean
}): React.JSX.Element {
  const [message, setMessage] = useState('')
  const lastTextTurn = consultation.turns.findLast(turn => turn.kind === 'text')
  const unanswered = lastTextTurn?.speaker === 'doctor'
  const optimisticMessage = action.pending && action.pendingMessage !== undefined
    && !(unanswered && lastTextTurn.messageText === action.pendingMessage)
    ? action.pendingMessage : undefined
  return (
    <section aria-labelledby="consultation-record-heading" className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h3 className="text-sm font-semibold" id="consultation-record-heading">{messages.consultationRecord}</h3>
        <Badge variant="secondary">{consultation.turns.length}</Badge>
      </div>
      <MessageScrollerProvider autoScroll>
        <MessageScroller data-agent-consultation="" className="min-h-0 flex-1 rounded-md border">
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
                      <MessageHeader>{turn.speaker === 'doctor' ? messages.doctorQuestion : patientName}</MessageHeader>
                      <Bubble data-agent-consultation-message={turn.kind === 'text' ? turn.id : undefined} align={turn.speaker === 'doctor' ? 'end' : 'start'} variant={turn.speaker === 'doctor' ? 'outline' : 'muted'}>
                        <BubbleContent>
                          <p className="whitespace-pre-wrap">{turn.messageText}</p>
                          {turn.kind === 'report-card' ? (
                            <Button onClick={action.onOpenReport} size="sm" type="button" variant="outline">
                              {locale === 'zh-CN' ? '查看检验报告' : 'View laboratory report'}
                            </Button>
                          ) : null}
                        </BubbleContent>
                      </Bubble>
                      <MessageFooter>{formatClinicalTime(turn.recordedAt, locale)}</MessageFooter>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ))}
              {optimisticMessage === undefined ? null : (
                <MessageScrollerItem messageId="sending-doctor-message" scrollAnchor>
                  <Message align="end"><MessageContent>
                    <MessageHeader>{messages.doctorQuestion}</MessageHeader>
                    <Bubble data-agent-consultation-pending="" align="end" variant="outline"><BubbleContent>{optimisticMessage}</BubbleContent></Bubble>
                  </MessageContent></Message>
                </MessageScrollerItem>
              )}
              {action.pending ? (
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
          onSubmit={event => {
            event.preventDefault()
            if (message.trim() !== '' && !action.pending && !unanswered) {
              action.onAsk(message.trim())
              setMessage('')
            }
          }}
        >
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel className="sr-only" htmlFor="consultation-message">{messages.askPatient}</FieldLabel>
              <InputGroup aria-label={messages.askPatient}>
                <InputGroupTextarea
                  className="max-h-40 overflow-y-auto"
                  disabled={action.pending || unanswered}
                  id="consultation-message"
                  maxLength={2000}
                  onChange={event => setMessage(event.target.value)}
                  placeholder={messages.askPatient}
                  value={message}
                />
                <InputGroupAddon align="block-end">
                  {action.pending ? <InputGroupText>{messages.waitingForPatientAnswer}</InputGroupText> : null}
                  {unanswered && !action.pending ? (
                    <InputGroupButton className="ml-auto" onClick={action.onRetry} size="sm" type="button" variant="outline">
                      <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
                      {locale === 'zh-CN' ? '重试患者回答' : 'Retry patient reply'}
                    </InputGroupButton>
                  ) : (
                    <InputGroupButton
                      aria-label={action.pending ? messages.waitingForPatientAnswer : messages.askPatient}
                      className="ml-auto shrink-0 rounded-full"
                      disabled={action.pending || message.trim() === ''}
                      size="icon-sm"
                      title={action.pending ? messages.waitingForPatientAnswer : messages.askPatient}
                      type="submit"
                      variant="default"
                    >
                      {action.pending
                        ? <RefreshCwIcon aria-hidden="true" className="animate-spin" />
                        : <SendIcon aria-hidden="true" />}
                    </InputGroupButton>
                  )}
                </InputGroupAddon>
              </InputGroup>
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
