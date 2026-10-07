import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  agentPageBindingRevision,
  agentToolsForContext,
  agentViewsForRole,
  type AgentPageContextBinding,
  type AgentHumanRoleCode,
  type AgentViewId,
} from '@clinmesh/contracts/agent'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { NavigateFn } from '@tanstack/react-router'
import {
  authorizeAgentToolCall,
  completeAgentToolCall,
  createAgentPageContext,
  issueAgentExecutionProof,
  reviewAgentToolCall,
  settleAgentToolHandoff,
} from './api-client.ts'
import {
  createDefaultAgentPageRegistration,
  useAgentPageRegistration,
  type AgentPageRegistration,
} from './agent-page-context.tsx'
import { buildSurfaceAgentTools, type AgentActionFeedback, type SurfaceAgentPageAction } from './surface-agent-tools.ts'
import { useWebRuntime } from './web-runtime.tsx'
import { useAgentReview } from './agent-review.tsx'
import { useAgentActionFeedback } from './agent-action-feedback.tsx'

const viewPaths: Record<AgentViewId, string> = {
  billing: '/billing',
  consultation: '/consultation',
  overview: '/',
  pharmacy: '/pharmacy',
  registration: '/registration',
  scenarioData: '/scenario-data',
  settingsGeneral: '/settings',
  triage: '/triage',
  uiComponents: '/settings/developer/components',
}

const PAGE_CONTEXT_RENEWAL_LEAD_MS = 60_000
const PAGE_CONTEXT_RETRY_MS = 5_000
const HANDOFF_TIMEOUT_MS = 30_000

interface PublishedSurfaceContext {
  binding: AgentPageContextBinding
  onActionFeedback(event: AgentActionFeedback): void
  page: AgentPageRegistration
  strictDefinitions: boolean
}

interface PendingHandoff {
  controller: AbortController
  dispose(): void
  proof: string
}

export function useSurfaceAgentPublisher(input: {
  activeSection: AgentViewId
  navigate: NavigateFn
  session: SessionContext
}): void {
  const runtime = useWebRuntime()
  const appearanceRoot = useRef(runtime.appearanceRoot)
  appearanceRoot.current = runtime.appearanceRoot
  const agentReview = useAgentReview()
  const registeredPage = useAgentPageRegistration()
  const defaultPage = useMemo(() => createDefaultAgentPageRegistration({
    activeSection: input.activeSection,
    label: `ClinMesh · ${input.activeSection}`,
    viewId: input.activeSection,
    viewRevision: [
      input.session.actor.workspaceId,
      input.session.actor.epoch,
      input.session.actor.practitionerRoleId,
      input.activeSection,
    ].join(':'),
  }), [
    input.activeSection,
    input.session.actor.epoch,
    input.session.actor.practitionerRoleId,
    input.session.actor.workspaceId,
  ])
  const page = registeredPage?.claim.viewId === input.activeSection ? registeredPage : defaultPage
  const onActionFeedback = useAgentActionFeedback(runtime.mode !== 'surface' || runtime.surfaceActive === false
    || (runtime.surfaceAgentStatus !== undefined && runtime.surfaceAgentStatus !== 'active'
      && runtime.surfaceAgentStatus !== 'connecting')
    || runtime.surfaceSessionId === undefined ? undefined : {
      identity: [runtime.surfaceSessionId, input.session.actor.actorId, input.session.actor.workspaceId,
        input.session.actor.epoch, input.session.actor.practitionerRoleId].join(':'),
      view: page.claim.viewId,
      selection: page.feedbackSelectionId ?? page.claim.selection?.id ?? '',
      section: page.claim.activeSection ?? '',
    })
  const [pageContextClientId] = useState(() => `clinmesh-surface-${crypto.randomUUID()}`)
  const pageContextRevision = useRef(0)
  const [binding, setBinding] = useState<AgentPageContextBinding>()
  const [surfaceLeaseGeneration, setSurfaceLeaseGeneration] = useState(0)
  const previousSurfaceAgentStatus = useRef(runtime.surfaceAgentStatus)
  const identityBinding = binding !== undefined
    && runtime.surfaceActive !== false
    && runtime.surfaceSessionId !== undefined
    && binding.snapshot.actor.actorId === input.session.actor.actorId
    && binding.snapshot.actor.practitionerRoleId === input.session.actor.practitionerRoleId
    && binding.snapshot.actor.roleCode === input.session.actor.roleCode
    && binding.snapshot.dshSessionId === runtime.surfaceSessionId
    && binding.snapshot.workspace.epoch === input.session.actor.epoch
    && binding.snapshot.workspace.id === input.session.actor.workspaceId
    && binding.snapshot.workspace.scenarioRunId === input.session.actor.scenarioRunId
    ? binding
    : undefined
  const scopeBinding = identityBinding !== undefined
    && identityBinding.snapshot.claim.viewId === page.claim.viewId
    && identityBinding.snapshot.claim.activeSection === page.claim.activeSection
    && identityBinding.snapshot.claim.selection?.id === page.claim.selection?.id
    && identityBinding.snapshot.claim.selection?.kind === page.claim.selection?.kind
    && identityBinding.snapshot.claim.selection?.version === page.claim.selection?.version
    ? identityBinding : undefined
  const activeBinding = scopeBinding !== undefined
    && agentPageBindingRevision(scopeBinding.snapshot.claim) === agentPageBindingRevision(page.claim)
    ? scopeBinding : undefined
  const currentBinding = useRef(activeBinding)
  currentBinding.current = activeBinding
  const [published, setPublished] = useState<PublishedSurfaceContext>()
  const publishedRef = useRef<PublishedSurfaceContext | undefined>(undefined)
  const committedFrame = useRef<PublishedSurfaceContext | undefined>(undefined)
  const executionCount = useRef(0)
  const handoffs = useRef(new Set<PendingHandoff>())
  const handoffRunning = useRef(false)
  const disposed = useRef(false)
  const [settlementRevision, setSettlementRevision] = useState(0)
  const publish = useCallback((value: PublishedSurfaceContext | undefined): void => {
    const previous = publishedRef.current
    if (previous?.binding === value?.binding && previous?.page === value?.page
      && previous?.onActionFeedback === value?.onActionFeedback
      && previous?.strictDefinitions === value?.strictDefinitions) return
    publishedRef.current = value
    setPublished(value)
  }, [])
  const onExecutionStart = useCallback((): void => {
    executionCount.current += 1
  }, [])
  const onExecutionSettled = useCallback((proof: string | undefined, signal: AbortSignal): void => {
    if (disposed.current) return
    executionCount.current = Math.max(0, executionCount.current - 1)
    if (proof !== undefined && !signal.aborted) {
      const controller = new AbortController()
      const onAbort = () => controller.abort(signal.reason)
      const timer = setTimeout(() => controller.abort(new Error('ClinMesh Tool handoff timed out')), HANDOFF_TIMEOUT_MS)
      const handoff: PendingHandoff = { controller, proof, dispose: () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      } }
      signal.addEventListener('abort', onAbort, { once: true })
      controller.signal.addEventListener('abort', () => {
        handoff.dispose()
        handoffs.current.delete(handoff)
        if (!disposed.current) setSettlementRevision(value => value + 1)
      }, { once: true })
      handoffs.current.add(handoff)
    }
    setSettlementRevision(value => value + 1)
  }, [])

  useEffect(() => {
    const dshSessionId = runtime.surfaceSessionId
    if (
      runtime.mode !== 'surface'
      || runtime.surfaceActive === false
      || runtime.surfaceAgent === undefined
      || dshSessionId === undefined
    ) {
      setBinding(undefined)
      return
    }
    const controller = new AbortController()
    let renewalTimer: ReturnType<typeof setTimeout> | undefined

    const refresh = async (): Promise<void> => {
      if (controller.signal.aborted) return
      try {
        pageContextRevision.current += 1
        const value = await createAgentPageContext({
          claim: page.claim,
          client: { id: pageContextClientId, revision: pageContextRevision.current },
          dshSessionId,
        }, controller.signal)
        if (controller.signal.aborted) return
        setBinding(value)
        const renewalDelay = Math.max(
          1_000,
          Date.parse(value.snapshot.expiresAt) - Date.now() - PAGE_CONTEXT_RENEWAL_LEAD_MS,
        )
        renewalTimer = setTimeout(() => void refresh(), renewalDelay)
      } catch (error) {
        if (controller.signal.aborted) return
        console.warn('ClinMesh Agent Page Context failed', error)
        renewalTimer = setTimeout(() => void refresh(), PAGE_CONTEXT_RETRY_MS)
      }
    }

    void refresh()
    return () => {
      controller.abort()
      if (renewalTimer !== undefined) clearTimeout(renewalTimer)
    }
  }, [
    page,
    pageContextClientId,
    runtime.mode,
    runtime.surfaceActive,
    runtime.surfaceAgent,
    runtime.surfaceSessionId,
    surfaceLeaseGeneration,
  ])

  useEffect(() => {
    const previousStatus = previousSurfaceAgentStatus.current
    previousSurfaceAgentStatus.current = runtime.surfaceAgentStatus
    const leaseFailed = runtime.surfaceAgentStatus === 'contended'
      || runtime.surfaceAgentStatus === 'error'
      || runtime.surfaceAgentStatus === 'idle'
      || runtime.surfaceAgentStatus === 'unavailable'
    if (
      runtime.mode !== 'surface'
      || previousStatus !== 'active'
      || !leaseFailed
    ) return

    setBinding(undefined)
    setSurfaceLeaseGeneration(current => current + 1)
  }, [runtime.mode, runtime.surfaceAgentStatus])

  useEffect(() => {
    if (
      runtime.mode === 'surface'
      && (
        runtime.surfaceActive === false
        || (runtime.surfaceAgentStatus !== undefined && runtime.surfaceAgentStatus !== 'active')
      )
    ) {
      agentReview.cancel('The ClinMesh Surface Agent lease is no longer active')
    }
  }, [agentReview, runtime.mode, runtime.surfaceActive, runtime.surfaceAgentStatus])

  const reviewPageKey = [
    runtime.surfaceSessionId,
    page.claim.viewId,
    page.claim.viewRevision,
    page.claim.draft?.revision,
    page.claim.selection?.id,
    page.claim.selection?.version,
  ].join(':')
  useEffect(() => {
    return () => agentReview.cancel('The ClinMesh Agent page state changed')
  }, [agentReview, reviewPageKey])

  const reviewBindingId = activeBinding?.snapshot.id
  useEffect(() => {
    if (reviewBindingId === undefined) return
    return () => agentReview.cancel('The ClinMesh Agent Page Context changed')
  }, [agentReview, reviewBindingId])

  useEffect(() => {
    if (binding === undefined) return
    const expiresIn = Date.parse(binding.snapshot.expiresAt) - Date.now()
    const expire = (): void => {
      setBinding(current => current?.snapshot.id === binding.snapshot.id ? undefined : current)
    }
    if (expiresIn <= 0) {
      expire()
      return
    }
    const expirationTimer = setTimeout(expire, expiresIn)
    return () => clearTimeout(expirationTimer)
  }, [binding])

  useEffect(() => {
    disposed.current = false
    return () => {
      disposed.current = true
      currentBinding.current = undefined
      for (const handoff of handoffs.current) handoff.controller.abort()
      handoffs.current.clear()
    }
  }, [])

  const toolsForFrame = useCallback((frame: PublishedSurfaceContext) => {
    const { binding: publishedBinding, page: publishedPage } = frame
    const definitions = agentToolsForContext(
      publishedBinding.snapshot.actor.roleCode,
      publishedBinding.snapshot.claim.viewId,
      publishedBinding.snapshot.claim.activeSection,
    )
    const actions = {
      ...commonActions(
        input.navigate,
        publishedBinding.snapshot.claim.viewId,
        publishedBinding.snapshot.actor.roleCode,
        () => appearanceRoot.current.current,
      ),
      ...publishedPage.actions,
    }
    return buildSurfaceAgentTools({
      actions,
      authorize: (request, signal) => authorizeAgentToolCall(request, signal),
      binding: publishedBinding,
      complete: (request, signal) => completeAgentToolCall(request, signal),
      definitions,
      issueProof: ({ contextId, pageRevision, scopeKey, signal, toolName }) => issueAgentExecutionProof({
        contextId,
        pageRevision,
        signal,
        scopeKey,
        toolName,
      }),
      onExecutionSettled,
      onExecutionStart,
      onActionFeedback: frame.onActionFeedback,
      readState: publishedPage.readState,
      resolveBinding: () => currentBinding.current,
      review: (request, signal) => reviewAgentToolCall(request, signal),
      strictDefinitions: frame.strictDefinitions,
    })
  }, [input.navigate, onExecutionSettled, onExecutionStart])

  useEffect(() => {
    const next = activeBinding === undefined ? undefined : {
      binding: activeBinding, onActionFeedback, page, strictDefinitions: page === registeredPage,
    }
    committedFrame.current = next
    const previous = publishedRef.current?.binding.snapshot
    const identityChanged = identityBinding === undefined
      || previous?.dshSessionId !== identityBinding.snapshot.dshSessionId
      || previous?.actor.actorId !== identityBinding.snapshot.actor.actorId
      || previous?.actor.practitionerRoleId !== identityBinding.snapshot.actor.practitionerRoleId
      || previous?.actor.roleCode !== identityBinding.snapshot.actor.roleCode
      || previous?.workspace.id !== identityBinding.snapshot.workspace.id
      || previous?.workspace.epoch !== identityBinding.snapshot.workspace.epoch
      || previous?.workspace.scenarioRunId !== identityBinding.snapshot.workspace.scenarioRunId
    if (identityChanged) {
      for (const handoff of handoffs.current) handoff.controller.abort()
      publish(next)
      return
    }
    if (executionCount.current !== 0 || handoffRunning.current) return
    if (handoffs.current.size === 0) { publish(next); return }
    if (next === undefined || page.claim.ui.status === 'loading'
      || (page !== registeredPage && page !== publishedRef.current?.page
        && !['uiComponents', 'settingsGeneral'].includes(page.claim.viewId))) return

    const targetFor = (frame: PublishedSurfaceContext) => ({
      scopeKey: frame.binding.snapshot.scopeKey,
      pageRevision: agentPageBindingRevision(frame.binding.snapshot.claim),
      toolNames: toolsForFrame(frame).map(tool => tool.name).sort(),
    })
    const target = targetFor(next)
    const batch = [...handoffs.current]
    handoffRunning.current = true
    void Promise.all(batch.map(handoff => settleAgentToolHandoff({
      proof: handoff.proof, target, signal: handoff.controller.signal,
    }))).then(() => {
      const current = committedFrame.current
      if (current === undefined || JSON.stringify(targetFor(current)) !== JSON.stringify(target)) {
        throw new Error('ClinMesh page changed during Tool handoff')
      }
      if (disposed.current || batch.some(handoff => handoff.controller.signal.aborted)) return
      for (const handoff of batch) { handoff.dispose(); handoffs.current.delete(handoff) }
      if (executionCount.current === 0 && handoffs.current.size === 0) publish(current)
    }).catch(() => {
      for (const handoff of batch) handoff.controller.abort()
      // Business results have already returned; handoff failure never replays an action.
    }).finally(() => {
      handoffRunning.current = false
      if (!disposed.current) setSettlementRevision(value => value + 1)
    })
  }, [activeBinding, identityBinding, onActionFeedback, page, publish, registeredPage, settlementRevision, toolsForFrame])

  useEffect(() => {
    if (published === undefined || runtime.surfaceAgent === undefined) return
    return runtime.surfaceAgent.register({
      label: published.page.label,
      scopeKey: published.binding.snapshot.scopeKey,
      tools: toolsForFrame(published),
    })
  }, [published, runtime.surfaceAgent, toolsForFrame])
}

function commonActions(
  navigate: NavigateFn,
  currentView: AgentViewId,
  roleCode: AgentHumanRoleCode,
  applicationRoot: () => HTMLElement | null,
): Record<string, SurfaceAgentPageAction> {
  const destinations = agentViewsForRole(roleCode)
  return {
    'ui.navigate': {
      description: 'Navigate to one allowed ClinMesh workspace without changing patient scope.',
      execute: async raw => {
        const destination = readString(raw, 'destination') as AgentViewId
        if (!destinations.includes(destination)) {
          throw new TypeError('ClinMesh destination is not allowed for the active role')
        }
        const path = viewPaths[destination]
        if (path === undefined) throw new TypeError('Unknown ClinMesh destination')
        await navigate({ to: path })
        return { destination, path }
      },
      parameters: {
        type: 'object',
        properties: { destination: { type: 'string', enum: destinations } },
        required: ['destination'],
        additionalProperties: false,
      },
    },
    'ui.panel.focus': {
      description: 'Keep focus on the current ClinMesh workspace panel.',
      execute: () => {
        const panel = applicationRoot()?.querySelector<HTMLElement>(
          '[data-clinmesh-workspace-panel]',
        )
        if (panel === undefined || panel === null) {
          throw new Error('The current ClinMesh workspace panel is unavailable')
        }
        panel.focus()
        return { focused: currentView }
      },
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  }
}

function readString(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('ClinMesh action input must be an object')
  }
  const candidate = (value as Record<string, unknown>)[key]
  if (typeof candidate !== 'string') throw new TypeError(`${key} must be a string`)
  return candidate
}

export type { AgentPageRegistration }
