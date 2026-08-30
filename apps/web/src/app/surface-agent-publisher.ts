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
  const [binding, setBinding] = useState<AgentPageContextBinding>()
  const activeBinding = binding !== undefined
    && runtime.surfaceActive !== false
    && binding.snapshot.actor.actorId === input.session.actor.actorId
    && binding.snapshot.actor.practitionerRoleId === input.session.actor.practitionerRoleId
    && binding.snapshot.claim.viewId === page.claim.viewId
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
    if (
      runtime.mode !== 'surface'
      || runtime.surfaceActive === false
      || runtime.surfaceAgent === undefined
    ) {
      setBinding(undefined)
      return
    }
    const controller = new AbortController()
    let renewalTimer: ReturnType<typeof setTimeout> | undefined

    const refresh = async (): Promise<void> => {
      if (controller.signal.aborted) return
      try {
        const value = await createAgentPageContext(page.claim)
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
  }, [page, runtime.mode, runtime.surfaceActive, runtime.surfaceAgent])

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

  const pageScopeKey = activeBinding?.snapshot.scopeKey
  useEffect(() => {
    if (pageScopeKey === undefined) return
    return () => agentReview.cancel('The ClinMesh Agent page scope changed')
  }, [agentReview, pageScopeKey])

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
      ),
      ...publishedPage.actions,
    }
    const tools = buildSurfaceAgentTools({
      actions,
      authorize: (request, signal) => authorizeAgentToolCall(request, signal),
      binding: publishedBinding,
      complete: (request, signal) => completeAgentToolCall(request, signal),
      definitions,
      issueProof: ({ scopeKey, signal, toolName }) => issueAgentExecutionProof({
        signal,
        scopeKey,
        toolName,
      }),
      onExecutionSettled,
      onExecutionStart,
      readState: publishedPage.readState,
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
      execute: () => ({ focused: currentView }),
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
