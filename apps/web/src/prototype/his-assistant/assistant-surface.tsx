import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Avatar, AvatarFallback } from '@clinmesh/ui/components/avatar'
import { Badge } from '@clinmesh/ui/components/badge'
import { Bubble, BubbleContent } from '@clinmesh/ui/components/bubble'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from '@clinmesh/ui/components/input-group'
import { Marker, MarkerContent, MarkerIcon } from '@clinmesh/ui/components/marker'
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from '@clinmesh/ui/components/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@clinmesh/ui/components/message-scroller'
import { Separator } from '@clinmesh/ui/components/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import {
  BotIcon,
  CheckIcon,
  CircleDotIcon,
  FileClockIcon,
  FilePenLineIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
  RouteIcon,
  SendIcon,
  ShieldCheckIcon,
  StethoscopeIcon,
  TerminalSquareIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useId, useState } from 'react'

import {
  conflictLabel,
  pageLabel,
  type AssistantProposal,
  type ClinicalPage,
  type DshStep,
  type PatientCase,
  type TypedAction,
} from './model'

interface AssistantActions {
  onApplyProposal: () => void
  onNavigate: (page: ClinicalPage, prompt: string) => void
  onOpenReview: () => void
  onPrompt: (prompt: string) => void
  onResetPatient: () => void
  onSimulateRemoteUpdate: () => void
}

interface AssistantSurfaceProps extends AssistantActions {
  patient: PatientCase
  showHeader?: boolean
}

export function AssistantSurface({
  patient,
  showHeader = true,
  onApplyProposal,
  onNavigate,
  onOpenReview,
  onPrompt,
  onResetPatient,
  onSimulateRemoteUpdate,
}: AssistantSurfaceProps): React.JSX.Element {
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      {showHeader ? <AssistantHeader patient={patient} /> : null}
      <Tabs defaultValue="conversation" className="min-h-0 flex-1 gap-0">
        <div className="border-b px-3 py-2">
          <TabsList className="w-full" variant="line">
            <TabsTrigger value="conversation">对话与建议</TabsTrigger>
            <TabsTrigger value="runtime">Session / Step</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="conversation" className="min-h-0">
          <div className="flex size-full min-h-0 flex-col">
            <Conversation patient={patient} onApplyProposal={onApplyProposal} onOpenReview={onOpenReview} onPrompt={onPrompt} />
            <QuickActions patient={patient} onNavigate={onNavigate} onPrompt={onPrompt} />
            <Composer patient={patient} onPrompt={onPrompt} />
          </div>
        </TabsContent>
        <TabsContent value="runtime" className="min-h-0 overflow-y-auto">
          <RuntimeInspector
            patient={patient}
            onResetPatient={onResetPatient}
            onSimulateRemoteUpdate={onSimulateRemoteUpdate}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export function InlineAssistant({
  patient,
  onApplyProposal,
  onNavigate,
  onOpenReview,
  onPrompt,
  onResetPatient,
  onSimulateRemoteUpdate,
}: AssistantSurfaceProps): React.JSX.Element {
  const lastTurn = patient.turns.at(-1)

  return (
    <section aria-labelledby="inline-assistant-title" className="border-y bg-muted/20">
      <div className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center">
        <div className="flex min-w-0 items-center gap-3 lg:w-64 lg:shrink-0">
          <Avatar className="size-8"><AvatarFallback><BotIcon /></AvatarFallback></Avatar>
          <div className="min-w-0">
            <h2 id="inline-assistant-title" className="truncate text-sm font-semibold">DSH 上下文助手</h2>
            <p className="truncate text-xs text-muted-foreground">{pageLabel(patient.page)} · page v{patient.pageRevision} · draft r{patient.draftRevision}</p>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <Composer patient={patient} onPrompt={onPrompt} inline />
        </div>
        <QuickActions patient={patient} onNavigate={onNavigate} onPrompt={onPrompt} inline />
      </div>

      {lastTurn === undefined && patient.proposal === null ? null : (
        <div className="grid border-t lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 p-4">
            {lastTurn === undefined ? null : (
              <Message>
                <MessageAvatar><Avatar className="size-8"><AvatarFallback><BotIcon /></AvatarFallback></Avatar></MessageAvatar>
                <MessageContent>
                  <MessageHeader>临床助手 · {lastTurn.id}</MessageHeader>
                  <Bubble variant="muted"><BubbleContent>{lastTurn.response}</BubbleContent></Bubble>
                </MessageContent>
              </Message>
            )}
            {patient.proposal === null ? null : (
              <div className="mt-4">
                <ProposalCard
                  patient={patient}
                  proposal={patient.proposal}
                  onApply={onApplyProposal}
                  onOpenReview={onOpenReview}
                  onRegenerate={() => onPrompt(patient.proposal?.kind === 'revisit' ? '重新读取结果并生成诊断草稿' : '重新读取当前病历并生成检验草稿')}
                />
              </div>
            )}
          </div>
          <div className="border-t p-4 lg:border-t-0 lg:border-l">
            <CompactRuntime patient={patient} />
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={onSimulateRemoteUpdate} size="sm" variant="outline"><FileClockIcon data-icon="inline-start" />模拟他处修改</Button>
              <Button onClick={onResetPatient} size="sm" variant="ghost"><RefreshCwIcon data-icon="inline-start" />重置患者</Button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function AssistantHeader({ patient }: { patient: PatientCase }): React.JSX.Element {
  return (
    <header className="border-b px-4 py-3">
      <div className="flex items-center gap-3">
        <Avatar className="size-9"><AvatarFallback><BotIcon /></AvatarFallback></Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">临床助手</h2>
            <Badge variant="success">Session active</Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{patient.sessionId} · {patient.threadId}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge variant="outline">可读</Badge>
        <Badge variant="outline">可导航</Badge>
        <Badge variant="outline">可填草稿</Badge>
        <Badge variant="outline">可预览</Badge>
        <Badge variant="secondary"><LockKeyholeIcon />不可代签</Badge>
      </div>
    </header>
  )
}

function Conversation({
  patient,
  onApplyProposal,
  onOpenReview,
  onPrompt,
}: Pick<AssistantSurfaceProps, 'patient' | 'onApplyProposal' | 'onOpenReview' | 'onPrompt'>): React.JSX.Element {
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-5 p-4">
            <MessageScrollerItem messageId="session-binding">
              <Marker variant="separator">
                <MarkerIcon><ShieldCheckIcon /></MarkerIcon>
                <MarkerContent>{patient.contextBindingId} · {patient.name}</MarkerContent>
              </Marker>
            </MessageScrollerItem>

            {patient.turns.map((turn) => (
              <TurnMessages key={turn.id} patient={patient} turn={turn} />
            ))}

            {patient.proposal === null ? null : (
              <MessageScrollerItem messageId={patient.proposal.id}>
                <ProposalCard
                  patient={patient}
                  proposal={patient.proposal}
                  onApply={onApplyProposal}
                  onOpenReview={onOpenReview}
                  onRegenerate={() => onPrompt(patient.proposal?.kind === 'revisit' ? '重新读取结果并生成诊断草稿' : '重新读取当前病历并生成检验草稿')}
                />
              </MessageScrollerItem>
            )}

            {patient.turns.length === 0 ? (
              <MessageScrollerItem messageId="empty-turns">
                <Marker>
                  <MarkerIcon><CircleDotIcon /></MarkerIcon>
                  <MarkerContent>尚未创建 Turn</MarkerContent>
                </Marker>
              </MessageScrollerItem>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

function TurnMessages({ patient, turn }: { patient: PatientCase; turn: PatientCase['turns'][number] }): React.JSX.Element {
  return (
    <>
      <MessageScrollerItem messageId={`${turn.id}-user`} scrollAnchor>
        <Message align="end">
          <MessageAvatar><Avatar className="size-8"><AvatarFallback>周</AvatarFallback></Avatar></MessageAvatar>
          <MessageContent>
            <MessageHeader>周芮医生</MessageHeader>
            <Bubble align="end"><BubbleContent>{turn.prompt}</BubbleContent></Bubble>
            <MessageFooter>{turn.time}</MessageFooter>
          </MessageContent>
        </Message>
      </MessageScrollerItem>
      <MessageScrollerItem messageId={`${turn.id}-assistant`}>
        <Message>
          <MessageAvatar><Avatar className="size-8"><AvatarFallback><BotIcon /></AvatarFallback></Avatar></MessageAvatar>
          <MessageContent>
            <MessageHeader>临床助手 · {patient.sessionId}</MessageHeader>
            <Bubble variant="muted"><BubbleContent>{turn.response}</BubbleContent></Bubble>
            <MessageFooter>{turn.steps.length} Steps · {turn.time}</MessageFooter>
          </MessageContent>
        </Message>
      </MessageScrollerItem>
    </>
  )
}

function ProposalCard({
  patient,
  proposal,
  onApply,
  onOpenReview,
  onRegenerate,
}: {
  patient: PatientCase
  proposal: AssistantProposal
  onApply: () => void
  onOpenReview: () => void
  onRegenerate: () => void
}): React.JSX.Element {
  const status = {
    ready: { label: '待应用', variant: 'info' },
    applied: { label: '草稿已更新', variant: 'warning' },
    stale: { label: '上下文已过期', variant: 'destructive' },
    submitted: { label: '医生已提交', variant: 'success' },
  } as const
  const currentStatus = status[proposal.status]

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{proposal.title}</CardTitle>
        <CardDescription>{proposal.summary}</CardDescription>
        <CardAction><Badge variant={currentStatus.variant}>{currentStatus.label}</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="grid grid-cols-3 gap-2 rounded-md bg-muted/50 p-2 text-xs">
          <VersionValue label="Page" value={`v${proposal.expectedPageRevision}`} />
          <VersionValue label="Draft" value={`r${proposal.expectedDraftRevision}`} />
          <VersionValue label="Context" value={`c${proposal.expectedContextRevision}`} />
        </div>
        <ol className="flex flex-col gap-1.5">
          {proposal.actions.map((action) => <ActionRow key={action.id} action={action} />)}
        </ol>
        {patient.lastConflict === null ? null : (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>{conflictLabel(patient.lastConflict)}</AlertTitle>
            <AlertDescription>expected {patient.lastConflict.expected}，actual {patient.lastConflict.actual}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap justify-end gap-2">
        {proposal.status === 'ready' ? <Button onClick={onApply} size="sm"><FilePenLineIcon data-icon="inline-start" />应用到草稿</Button> : null}
        {proposal.status === 'applied' ? <Button onClick={onOpenReview} size="sm"><ShieldCheckIcon data-icon="inline-start" />打开人工预览</Button> : null}
        {proposal.status === 'stale' ? <Button onClick={onRegenerate} size="sm"><RefreshCwIcon data-icon="inline-start" />刷新并重新生成</Button> : null}
        {proposal.status === 'submitted' ? <span className="text-xs text-muted-foreground">HIS page v{patient.pageRevision}</span> : null}
      </CardFooter>
    </Card>
  )
}

function ActionRow({ action }: { action: TypedAction }): React.JSX.Element {
  const command = action.kind === 'proposeCommand' ? action.command : action.kind
  return (
    <li className="grid grid-cols-[2.25rem_minmax(0,1fr)] items-start gap-2 text-xs">
      <Badge variant={action.risk === 'R0' ? 'secondary' : 'outline'}>{action.risk}</Badge>
      <span className="min-w-0">
        <code className="block truncate text-muted-foreground">{command}</code>
        <span className="mt-0.5 block leading-5">{action.label}</span>
      </span>
    </li>
  )
}

function QuickActions({
  patient,
  inline = false,
  onNavigate,
  onPrompt,
}: Pick<AssistantSurfaceProps, 'patient' | 'onNavigate' | 'onPrompt'> & { inline?: boolean }): React.JSX.Element {
  return (
    <div className={inline ? 'flex shrink-0 flex-wrap gap-2' : 'flex flex-wrap gap-2 border-t px-3 py-2'}>
      <Button onClick={() => onPrompt('完善首诊病历并建议必要检查')} size="sm" variant="outline">
        <StethoscopeIcon data-icon="inline-start" />首诊建议
      </Button>
      <Button disabled={!patient.resultsReady} onClick={() => onPrompt('解释检验结果并生成诊断和处方草稿')} size="sm" variant="outline">
        <FilePenLineIcon data-icon="inline-start" />复诊建议
      </Button>
      <Button onClick={() => onNavigate('results', '打开当前患者的检验结果')} size="sm" variant="ghost">
        <RouteIcon data-icon="inline-start" />打开结果
      </Button>
    </div>
  )
}

function Composer({
  patient,
  inline = false,
  onPrompt,
}: Pick<AssistantSurfaceProps, 'patient' | 'onPrompt'> & { inline?: boolean }): React.JSX.Element {
  const inputId = useId()
  const [prompt, setPrompt] = useState('')

  const submit = () => {
    const value = prompt.trim()
    if (value.length === 0) return
    onPrompt(value)
    setPrompt('')
  }

  return (
    <form
      className={inline ? 'w-full' : 'border-t p-3'}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <Field>
        <FieldLabel className="sr-only" htmlFor={inputId}>给临床助手发送任务</FieldLabel>
        <InputGroup className={inline ? 'min-h-10' : 'min-h-20'}>
          <InputGroupTextarea
            aria-label="给临床助手发送任务"
            id={inputId}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder={`询问${patient.name}当前就诊…`}
            rows={inline ? 1 : 2}
            value={prompt}
          />
          <InputGroupAddon align="block-end">
            <InputGroupText>{patient.contextBindingId}</InputGroupText>
            <InputGroupButton aria-label="发送任务" className="ml-auto" disabled={prompt.trim().length === 0} size="icon-sm" title="发送任务" type="submit">
              <SendIcon />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </Field>
    </form>
  )
}

function RuntimeInspector({
  patient,
  onResetPatient,
  onSimulateRemoteUpdate,
}: Pick<AssistantSurfaceProps, 'patient' | 'onResetPatient' | 'onSimulateRemoteUpdate'>): React.JSX.Element {
  const lastTurn = patient.turns.at(-1)
  return (
    <div className="flex flex-col gap-5 p-4">
      <CompactRuntime patient={patient} />
      <Separator />
      <section>
        <h3 className="text-xs font-semibold">有效能力</h3>
        <dl className="mt-3 flex flex-col gap-2 text-xs">
          <CapabilityRow allowed label="读取当前 Encounter" />
          <CapabilityRow allowed label="执行 typed 页面动作" />
          <CapabilityRow allowed label="编辑未签署草稿" />
          <CapabilityRow allowed label="请求 Command preview" />
          <CapabilityRow label="签发医嘱或处方" />
          <CapabilityRow label="读取其他患者或 Hidden Fact" />
        </dl>
      </section>
      <Separator />
      <section>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold">当前 Turn 的 Steps</h3>
          <Badge variant="outline">{lastTurn?.id ?? '无 Turn'}</Badge>
        </div>
        <ol className="mt-3 flex flex-col gap-3">
          {lastTurn?.steps.map((step) => <StepRow key={step.id} step={step} />) ?? <li className="text-xs text-muted-foreground">等待医生发起任务</li>}
        </ol>
      </section>
      <Separator />
      <div className="flex flex-wrap gap-2">
        <Button onClick={onSimulateRemoteUpdate} size="sm" variant="outline"><FileClockIcon data-icon="inline-start" />模拟他处修改</Button>
        <Button onClick={onResetPatient} size="sm" variant="ghost"><RefreshCwIcon data-icon="inline-start" />重置患者</Button>
      </div>
    </div>
  )
}

function CompactRuntime({ patient }: { patient: PatientCase }): React.JSX.Element {
  const lastTurn = patient.turns.at(-1)
  const lastStep = lastTurn?.steps.at(-1)
  return (
    <section>
      <div className="flex items-center gap-2">
        <TerminalSquareIcon className="size-4 text-muted-foreground" />
        <h3 className="text-xs font-semibold">DSH Runtime</h3>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
        <RuntimeValue label="Thread" value={patient.threadId} />
        <RuntimeValue label="Session" value={patient.sessionId} />
        <RuntimeValue label="Turn" value={lastTurn?.id ?? '—'} />
        <RuntimeValue label="Step" value={lastStep?.id ?? '—'} />
        <RuntimeValue label="Page" value={`doctor.${patient.page}`} />
        <RuntimeValue label="Binding" value={patient.contextBindingId} />
      </dl>
    </section>
  )
}

function StepRow({ step }: { step: DshStep }): React.JSX.Element {
  const icon = step.status === 'completed' ? <CheckIcon /> : step.status === 'rejected' ? <TriangleAlertIcon /> : <CircleDotIcon />
  return (
    <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2 text-xs">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="min-w-0">
        <span className="flex items-center gap-2"><strong className="font-medium">{step.label}</strong><Badge variant={step.status === 'rejected' ? 'destructive' : step.status === 'waiting-human' ? 'warning' : 'secondary'}>{step.status}</Badge></span>
        <span className="mt-1 block leading-5 text-muted-foreground">{step.detail}</span>
        {step.command === null ? null : <code className="mt-1 block truncate rounded bg-muted px-2 py-1" title={step.command}>{step.command}</code>}
      </span>
    </li>
  )
}

function CapabilityRow({ allowed = false, label }: { allowed?: boolean; label: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt>{label}</dt>
      <dd><Badge variant={allowed ? 'success' : 'secondary'}>{allowed ? '允许' : '拒绝'}</Badge></dd>
    </div>
  )
}

function VersionValue({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div><span className="block text-muted-foreground">{label}</span><strong className="mt-0.5 block font-mono">{value}</strong></div>
}

function RuntimeValue({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="mt-0.5 truncate font-mono font-medium" title={value}>{value}</dd></div>
}
