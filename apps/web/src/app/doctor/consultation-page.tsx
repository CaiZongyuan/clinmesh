import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Bubble, BubbleContent } from '@clinmesh/ui/components/bubble'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { FieldGroup, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Message, MessageContent, MessageFooter, MessageHeader } from '@clinmesh/ui/components/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@clinmesh/ui/components/message-scroller'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { CircleAlertIcon, MessagesSquareIcon, RefreshCwIcon, SendIcon } from 'lucide-react'
import { useState } from 'react'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { formatClinicalTime } from './clinical-date-time.ts'

export interface ConsultationPageAction {
  error: Error | null
  onAsk: (questionCode: string) => void
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
  const [questionCode, setQuestionCode] = useState('')
  return (
    <section aria-labelledby="consultation-record-heading" className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold" id="consultation-record-heading">{messages.consultationRecord}</h3>
        <Badge variant="secondary">{consultation.records.length}</Badge>
      </div>
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="h-[min(34rem,55vh)] min-h-72 rounded-md border">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-4 p-3">
              {consultation.records.length === 0 ? (
                <MessageScrollerItem messageId="empty-consultation-records">
                  <Empty className="min-h-52">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><MessagesSquareIcon aria-hidden="true" /></EmptyMedia>
                      <EmptyTitle>{messages.noConsultationHistory}</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                </MessageScrollerItem>
              ) : consultation.records.flatMap(record => [
                <MessageScrollerItem key={`${record.id}-question`} messageId={`${record.id}-question`} scrollAnchor>
                  <Message align="end">
                    <MessageContent>
                      <MessageHeader>{messages.doctorQuestion} · #{record.sequence}</MessageHeader>
                      <Bubble align="end" variant="outline"><BubbleContent>{record.question.text}</BubbleContent></Bubble>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>,
                <MessageScrollerItem key={`${record.id}-answer`} messageId={`${record.id}-answer`}>
                  <Message>
                    <MessageContent>
                      <MessageHeader>{patientName}</MessageHeader>
                      <Bubble variant="muted"><BubbleContent>{record.answer}</BubbleContent></Bubble>
                      <MessageFooter>{formatClinicalTime(record.recordedAt, locale)}</MessageFooter>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>,
              ])}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      {readOnly ? null : (
        <form
          onSubmit={event => {
            event.preventDefault()
            if (questionCode !== '') action.onAsk(questionCode)
          }}
        >
          <FieldGroup className="gap-3">
            <FieldSet>
              <FieldLegend variant="label">{messages.consultationQuestions}</FieldLegend>
              <ToggleGroup
                aria-label={messages.consultationQuestions}
                className="w-full"
                disabled={action.pending}
                onValueChange={value => setQuestionCode(value[0] ?? '')}
                orientation="vertical"
                value={questionCode === '' ? [] : [questionCode]}
                variant="outline"
              >
                {consultation.questions.map(question => (
                  <ToggleGroupItem
                    aria-label={question.text}
                    className="h-auto w-full justify-start whitespace-normal px-3 py-2 text-left"
                    key={question.code}
                    value={question.code}
                  >
                    {question.text}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FieldSet>
            <div className="flex justify-end">
              <Button disabled={action.pending || questionCode === ''} type="submit">
                {action.pending
                  ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
                  : <SendIcon aria-hidden="true" data-icon="inline-start" />}
                {action.pending ? messages.waitingForPatientAnswer : messages.askPatient}
              </Button>
            </div>
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
