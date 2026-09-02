import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
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
} from './api-client.ts'
import {
  createDefaultAgentPageRegistration,
  useAgentPageRegistration,
  type AgentPageRegistration,
} from './agent-page-context.tsx'
import { buildSurfaceAgentTools, type SurfaceAgentPageAction } from './surface-agent-tools.ts'
import { useWebRuntime } from './web-runtime.tsx'
import { useAgentReview } from './agent-review.tsx'

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
const SURFACE_RESULT_SETTLE_MS = 100

interface PublishedSurfaceContext {
  binding: AgentPageContextBinding
  page: AgentPageRegistration
}

export function useSurfaceAgentPublisher(input: {
  activeSection: AgentViewId
  navigate: NavigateFn
  session: SessionContext
}): void {
  const runtime = useWebRuntime()
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
  const [pageContextClientId] = useState(() => `clinmesh-surface-${crypto.randomUUID()}`)
  const pageContextRevision = useRef(0)
  const [binding, setBinding] = useState<AgentPageContextBinding>()
  const [surfaceLeaseGeneration, setSurfaceLeaseGeneration] = useState(0)
  const previousSurfaceAgentStatus = useRef(runtime.surfaceAgentStatus)
  const activeBinding = binding !== undefined
    && runtime.surfaceActive !== false
    && runtime.surfaceSessionId !== undefined
    && binding.snapshot.actor.actorId === input.session.actor.actorId
    && binding.snapshot.actor.practitionerRoleId === input.session.actor.practitionerRoleId
    && binding.snapshot.claim.viewId === page.claim.viewId
    && binding.snapshot.dshSessionId === runtime.surfaceSessionId
    && binding.snapshot.workspace.epoch === input.session.actor.epoch
    && binding.snapshot.workspace.id === input.session.actor.workspaceId
    ? binding
    : undefined
  const [published, setPublished] = useState<PublishedSurfaceContext>()
  const publishedRef = useRef<PublishedSurfaceContext | undefined>(undefined)
  const pendingPublication = useRef<PublishedSurfaceContext | undefined>(undefined)
  const executionCount = useRef(0)
  const settlementTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const publish = useCallback((value: PublishedSurfaceContext | undefined): void => {
    publishedRef.current = value
    setPublished(value)
  }, [])
  const onExecutionStart = useCallback((): void => {
    executionCount.current += 1
  }, [])
  const onExecutionSettled = useCallback((): void => {
    const timer = setTimeout(() => {
      settlementTimers.current.delete(timer)
      executionCount.current = Math.max(0, executionCount.current - 1)
      if (executionCount.current !== 0 || pendingPublication.current === undefined) return
      const next = pendingPublication.current
      pendingPublication.current = undefined
      publish(next)
    }, SURFACE_RESULT_SETTLE_MS)
    settlementTimers.current.add(timer)
  }, [publish])

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
    const next = activeBinding === undefined ? undefined : { binding: activeBinding, page }
    const scopeChanged = publishedRef.current?.binding.snapshot.scopeKey
      !== next?.binding.snapshot.scopeKey
    if (executionCount.current === 0 || scopeChanged) {
      pendingPublication.current = undefined
      publish(next)
      return
    }
    pendingPublication.current = next
  }, [activeBinding, page, publish])

  useEffect(() => () => {
    for (const timer of settlementTimers.current) clearTimeout(timer)
    settlementTimers.current.clear()
  }, [])

  useEffect(() => {
    if (published === undefined || runtime.surfaceAgent === undefined) return
    const { binding: publishedBinding, page: publishedPage } = published
    const definitions = agentToolsForContext(
      publishedBinding.snapshot.actor.roleCode,
      publishedBinding.snapshot.claim.viewId,
    )
    const actions = {
      ...commonActions(
        input.navigate,
        publishedBinding.snapshot.claim.viewId,
        publishedBinding.snapshot.actor.roleCode,
        () => runtime.appearanceRoot.current,
      ),
      ...publishedPage.actions,
    }
    const tools = buildSurfaceAgentTools({
      actions,
      authorize: (request, signal) => authorizeAgentToolCall(request, signal),
      binding: publishedBinding,
      complete: (request, signal) => completeAgentToolCall(request, signal),
      definitions,
      issueProof: ({ contextId, scopeKey, signal, toolName }) => issueAgentExecutionProof({
        contextId,
        signal,
        scopeKey,
        toolName,
      }),
      onExecutionSettled,
      onExecutionStart,
      readState: publishedPage.readState,
      review: (request, signal) => reviewAgentToolCall(request, signal),
      strictDefinitions: publishedPage === registeredPage,
    })
    return runtime.surfaceAgent.register({
      label: publishedPage.label,
      scopeKey: publishedBinding.snapshot.scopeKey,
      tools,
    })
  }, [input.navigate, onExecutionSettled, onExecutionStart, published, registeredPage, runtime.surfaceAgent])
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
