import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Progress } from '@clinmesh/ui/components/progress'
import { Separator } from '@clinmesh/ui/components/separator'
import { cn } from '@clinmesh/ui/lib/utils'
import { ArrowRightIcon, CircleCheckIcon, Clock3Icon, UserRoundIcon } from 'lucide-react'

import {
  actors,
  flowStages,
  nextAssignments,
  stepLabels,
  type Actor,
  type FlowStep,
  type PrototypeScreen,
  type ScenarioState,
} from './model'

const completedStageCount: Record<FlowStep, number> = {
  'waiting-registration': 0,
  registered: 1,
  triaged: 2,
  'lab-ordered': 3,
  'lab-paid': 4,
  'specimen-received': 4,
  'result-ready': 5,
  'medication-ordered': 6,
  'medication-paid': 7,
  dispensed: 8,
  finished: 9,
}

export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string
  title: string
  description: string
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <header className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="m-0 text-xs font-medium text-muted-foreground">{eyebrow}</p>
        <h1 className="mt-1 text-xl font-semibold sm:text-2xl">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {actions === undefined ? null : <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}

export function PatientBanner({ scenario }: { scenario: ScenarioState }): React.JSX.Element {
  return (
    <section aria-label="当前患者" className="grid grid-cols-2 gap-3 border-b bg-muted/30 px-4 py-3 lg:grid-cols-[1.3fr_repeat(4,minmax(7rem,auto))] lg:items-center">
      <div className="col-span-2 min-w-0 lg:col-span-1">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-base">林若溪</strong>
          <Badge variant="outline">合成患者</Badge>
          <Badge variant={scenario.step === 'finished' ? 'success' : 'info'}>{stepLabels[scenario.step]}</Badge>
          <Badge variant="outline">expected v{scenario.version}</Badge>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">SYN-P-1042 · 门诊号 MZ-SYN-20260821-0017</p>
      </div>
      <PatientFact label="性别 / 年龄" value="女 / 34 岁" />
      <PatientFact label="主诉" value="发热、咽痛 1 天" />
      <PatientFact label="体温" value={scenario.step === 'waiting-registration' ? '--' : '38.6 °C'} />
      <PatientFact label="过敏史" value="否认药物过敏" />
    </section>
  )
}

function PatientFact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <p className="m-0 text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm font-medium">{value}</p>
    </div>
  )
}

export function FlowRail({
  scenario,
  onNavigate,
}: {
  scenario: ScenarioState
  onNavigate: (screen: PrototypeScreen) => void
}): React.JSX.Element {
  const completed = completedStageCount[scenario.step]

  return (
    <section aria-label="门诊流程进度" className="border-b bg-card px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Clock3Icon className="size-3.5 text-muted-foreground" />
          门诊接力进度
        </div>
        <span className="text-xs text-muted-foreground">{completed} / {flowStages.length}</span>
      </div>
      <Progress aria-label="门诊流程完成度" value={(completed / flowStages.length) * 100} />
      <div className="mt-3 overflow-x-auto">
        <div className="grid min-w-[58rem] grid-cols-9">
          {flowStages.map((stage, index) => {
            const isComplete = index < completed
            const isCurrent = index === completed && completed < flowStages.length
            return (
              <button
                key={stage.id}
                className="group flex min-h-12 items-center gap-2 border-l px-2 text-left first:border-l-0 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onNavigate(stage.screen)}
                type="button"
              >
                <span
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full',
                    isComplete
                      ? 'bg-success text-success-foreground'
                      : isCurrent
                        ? 'bg-primary text-primary-foreground'
                        : 'border bg-background text-muted-foreground',
                  )}
                >
                  {isComplete ? <CircleCheckIcon className="size-3" /> : index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{stage.label}</span>
                  <span className="block truncate text-[0.6875rem] text-muted-foreground">{stage.owner}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}

export function NextHandoff({
  scenario,
  onHandoff,
}: {
  scenario: ScenarioState
  onHandoff: () => void
}): React.JSX.Element {
  const next = nextAssignments[scenario.step]
  const actor = actors.find((candidate) => candidate.id === next.actorId)

  return (
    <Alert>
      <UserRoundIcon />
      <AlertTitle>{scenario.step === 'finished' ? '门诊闭环已完成' : `下一棒：${actor?.role ?? '当前岗位'}`}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>{next.label}</span>
        <Button onClick={onHandoff} size="sm" variant="outline">
          {scenario.step === 'finished' ? '查看全院流程' : '切换操作者'}
          <ArrowRightIcon data-icon="inline-end" />
        </Button>
      </AlertDescription>
    </Alert>
  )
}

export function ScenarioStatePanel({
  scenario,
  actor,
}: {
  scenario: ScenarioState
  actor: Actor
}): React.JSX.Element {
  const recentEvents = scenario.events.slice(-3).toReversed()

  return (
    <section aria-labelledby="prototype-state-title" className="mt-6 border-y bg-muted/30 px-4 py-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1">
          <h2 id="prototype-state-title" className="text-sm font-semibold">当前场景状态</h2>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-4 xl:grid-cols-8">
            <StateValue label="Workspace" value="yujiang-general" />
            <StateValue label="Epoch" value={`E-${scenario.epoch.toString().padStart(3, '0')}`} />
            <StateValue label="Version" value={`v${scenario.version}`} />
            <StateValue label="Actor" value={`${actor.name} / ${actor.role}`} />
            <StateValue label="患者" value="SYN-P-1042" />
            <StateValue label="流程状态" value={scenario.step} />
            <StateValue label="数据集" value={scenario.dataset} />
            <StateValue label="LIS 模式" value={scenario.lisMode} />
          </dl>
          {scenario.lastConflict ? (
            <p className="mt-3 text-xs text-warning-foreground">
              上次提交冲突：expected v{scenario.lastConflict.expectedVersion}，实际 v{scenario.lastConflict.actualVersion}；已刷新最新状态。
            </p>
          ) : null}
        </div>
        <Separator className="xl:hidden" />
        <div className="w-full xl:w-[25rem]">
          <h3 className="text-xs font-medium text-muted-foreground">最近事件</h3>
          <ol className="mt-2 flex flex-col gap-1.5">
            {recentEvents.map((event) => (
              <li key={event.id} className="grid grid-cols-[2.75rem_1fr] gap-2 text-xs">
                <time className="font-mono text-muted-foreground">{event.time}</time>
                <span className="truncate"><strong className="font-medium">{event.actor}</strong> · {event.action}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}

function StateValue({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-mono font-medium" title={value}>{value}</dd>
    </div>
  )
}

export function statusVariant(status: 'done' | 'active' | 'waiting' | 'blocked'): 'success' | 'info' | 'secondary' | 'warning' {
  if (status === 'done') return 'success'
  if (status === 'active') return 'info'
  if (status === 'blocked') return 'warning'
  return 'secondary'
}
