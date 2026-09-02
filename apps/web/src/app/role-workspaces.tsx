import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlertIcon, DatabaseIcon, RefreshCwIcon, RotateCcwIcon } from 'lucide-react'
import { useMemo } from 'react'
import {
  getCurrentScenario,
  installScenario,
  newIdempotencyKey,
  resetScenario,
  sessionQueryKey,
} from './api-client.ts'
import type { WorkspaceSection } from './workspace-shell.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { RegistrarWorkspace } from './registrar-workspace.tsx'
import { TriageWorkspace } from './triage-workspace.tsx'
import { DoctorWorkspace } from './doctor-workspace.tsx'
import { BillingWorkspace } from './billing-workspace.tsx'
import { PharmacyWorkspace } from './pharmacy-workspace.tsx'
import { ScenarioDataWorkspace } from './scenario-data-workspace.tsx'
import { LaboratoryServiceWorkspace } from './laboratory-service-workspace.tsx'
import { agentViewRevision, useRegisterAgentPage } from './agent-page-context.tsx'
import { useAgentReview } from './agent-review.tsx'

interface RoleWorkspaceProps {
  activeSection: WorkspaceSection
  locale: WorkspaceLocale
  session: SessionContext
}

function scenarioQueryKey(session: SessionContext) {
  return ['scenario-current', session.actor.workspaceId, session.actor.epoch] as const
}

function AdminWorkspace({ locale, session }: Omit<RoleWorkspaceProps, 'activeSection'>): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const agentReview = useAgentReview()
  const queryClient = useQueryClient()
  const queryKey = scenarioQueryKey(session)
  const scenario = useQuery({
    queryFn: ({ signal }) => getCurrentScenario(signal),
    queryKey,
  })
  const mutation = useMutation({
    mutationFn: async (action: 'candidate' | 'density' | 'reset') => {
      if (action === 'reset') {
        if (scenario.data === undefined) throw new Error(messages.scenarioUnavailable)
        return resetScenario(scenario.data.scenarioRunId, newIdempotencyKey())
      }
      return installScenario(action, newIdempotencyKey())
    },
    onSuccess: async response => {
      queryClient.setQueryData(queryKey, response.data)
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey })
    },
  })

  const agentPage = useMemo(() => ({
    actions: {
      'scenario.status.read': {
        description: 'Read the current Scenario Run status without authoring truth.',
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: () => scenario.data ?? { status: 'loading' },
      },
      'scenario.install.propose': {
        description: 'Open human review for installing one built-in synthetic Scenario.',
        parameters: {
          type: 'object' as const,
          properties: { kind: { type: 'string', enum: ['candidate', 'density'] } },
          required: ['kind'],
          additionalProperties: false,
        },
        execute: (raw: unknown, signal: AbortSignal) => {
          const kind = scenarioKind(raw)
          return agentReview.request({
            confirmLabel: kind === 'candidate' ? messages.installCandidate : messages.installDensity,
            description: messages[`scenarioKind_${kind}`],
            onConfirm: () => mutation.mutateAsync(kind),
            signal,
            title: messages.scenarioActions,
          })
        },
      },
      'scenario.reset.propose': {
        description: 'Open human review for resetting the current synthetic Scenario Run.',
        enabled: scenario.data !== undefined,
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => agentReview.request({
          confirmLabel: messages.resetRun,
          description: scenario.data?.scenarioRunId ?? messages.scenarioUnavailable,
          onConfirm: () => mutation.mutateAsync('reset'),
          signal,
          title: messages.resetRun,
        }),
      },
    },
    claim: {
      version: 1 as const,
      viewId: 'overview' as const,
      viewRevision: agentViewRevision({
        scenarioRunId: scenario.data?.scenarioRunId,
        status: scenario.data?.status,
        virtualTime: scenario.data?.virtualTime,
      }),
      ...(scenario.data === undefined ? {} : {
        selection: {
          id: scenario.data.scenarioRunId,
          kind: 'scenario-run' as const,
          version: scenario.data.epoch,
        },
      }),
      ui: {
        status: scenario.isPending ? 'loading' as const
          : scenario.isError ? 'error' as const : 'ready' as const,
      },
    },
    label: 'ClinMesh · 仿真管理',
    readState: () => ({
      scenario: scenario.data === undefined ? null : {
        epoch: scenario.data.epoch,
        kind: scenario.data.kind,
        scenarioRunId: scenario.data.scenarioRunId,
        status: scenario.data.status,
        virtualTime: scenario.data.virtualTime,
      },
    }),
  }), [agentReview, messages, mutation.mutateAsync, scenario.data, scenario.isError, scenario.isPending])
  useRegisterAgentPage(agentPage)

  if (scenario.isPending) {
    return (
      <section aria-label={messages.loadingScenario} className="flex flex-col gap-3">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-36 w-full" />
      </section>
    )
  }

  if (scenario.isError) {
    return (
      <Alert variant="destructive">
        <CircleAlertIcon aria-hidden="true" />
        <AlertTitle>{getWorkspaceErrorTitle(scenario.error, messages, messages.scenarioUnavailable)}</AlertTitle>
        <AlertDescription>{getWorkspaceErrorMessage(scenario.error, messages)}</AlertDescription>
      </Alert>
    )
  }

  const state = scenario.data
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="scenario-heading" className="flex flex-col gap-4 border-b pb-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold" id="scenario-heading">{messages.scenarioRun}</h2>
          <Badge variant={state.status === 'active' ? 'default' : 'secondary'}>
            {messages[`scenarioStatus_${state.status}`]}
          </Badge>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{messages.scenarioDefinition}</dt>
            <dd className="font-medium">{messages[`scenarioKind_${state.kind}`]}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{messages.virtualTime}</dt>
            <dd className="font-medium">{new Intl.DateTimeFormat(locale, {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(state.virtualTime))}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="scenario-actions-heading" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold" id="scenario-actions-heading">{messages.scenarioActions}</h2>
        <div className="flex flex-wrap gap-2">
          <Button disabled={mutation.isPending} onClick={() => mutation.mutate('candidate')}>
            <RefreshCwIcon data-icon="inline-start" />
            {messages.installCandidate}
          </Button>
          <Button disabled={mutation.isPending} onClick={() => mutation.mutate('density')} variant="outline">
            <DatabaseIcon data-icon="inline-start" />
            {messages.installDensity}
          </Button>
          <Button disabled={mutation.isPending} onClick={() => mutation.mutate('reset')} variant="outline">
            <RotateCcwIcon data-icon="inline-start" />
            {messages.resetRun}
          </Button>
        </div>
        {mutation.isError ? (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>{getWorkspaceErrorTitle(mutation.error, messages, messages.operationFailed)}</AlertTitle>
            <AlertDescription>{getWorkspaceErrorMessage(mutation.error, messages)}</AlertDescription>
          </Alert>
        ) : null}
      </section>
      <LaboratoryServiceWorkspace locale={locale} session={session} />
    </div>
  )
}

function scenarioKind(value: unknown): 'candidate' | 'density' {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Scenario Agent input must be an object')
  }
  const kind = (value as Record<string, unknown>).kind
  if (kind !== 'candidate' && kind !== 'density') throw new TypeError('kind is invalid')
  return kind
}

export function RoleWorkspace({ activeSection, locale, session }: RoleWorkspaceProps): React.JSX.Element {
  if (session.actor.roleCode === 'administrator' && activeSection === 'scenarioData') {
    return <ScenarioDataWorkspace locale={locale} />
  }
  if (session.actor.roleCode === 'administrator' && activeSection === 'overview') {
    return <AdminWorkspace locale={locale} session={session} />
  }
  if (
    session.actor.roleCode === 'registrar'
    && activeSection === 'registration'
  ) {
    return <RegistrarWorkspace locale={locale} session={session} />
  }
  if (
    session.actor.roleCode === 'triage-nurse'
    && activeSection === 'triage'
  ) {
    return <TriageWorkspace locale={locale} session={session} />
  }
  if (
    session.actor.roleCode === 'outpatient-doctor'
    && activeSection === 'consultation'
  ) {
    return <DoctorWorkspace locale={locale} session={session} />
  }
  if (
    session.actor.roleCode === 'cashier'
    && activeSection === 'billing'
  ) {
    return <BillingWorkspace locale={locale} session={session} />
  }
  if (
    session.actor.roleCode === 'pharmacist'
    && activeSection === 'pharmacy'
  ) {
    return <PharmacyWorkspace locale={locale} session={session} />
  }
  return <div />
}
