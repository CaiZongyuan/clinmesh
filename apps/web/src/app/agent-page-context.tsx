import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type {
  AgentPageContextClaim,
  AgentViewId,
} from '@clinmesh/contracts/agent'
import type { SurfaceAgentPageAction } from './surface-agent-tools.ts'

export interface AgentPageRegistration {
  actions: Readonly<Record<string, SurfaceAgentPageAction>>
  claim: AgentPageContextClaim
  /** Visible selection remains scoped while its server detail is loading; never used for authorization. */
  feedbackSelectionId?: string
  label: string
  readState(): unknown
}

interface AgentPageRegistryValue {
  registration: AgentPageRegistration | null
  setRegistration(value: AgentPageRegistration | null): void
  forms: Map<symbol, AgentFormSnapshot>
}

interface AgentFormSnapshot {
  viewId: AgentViewId
  selectionId: string
  name: string
  values: unknown
  readValues?(): unknown
}

/** Registers only structured values owned by the mounted, authorized business form. */
export function useRegisterAgentForm(form: AgentFormSnapshot): void {
  const registry = useContext(AgentPageRegistryContext)
  const [key] = useState(() => Symbol('agent-form'))
  useLayoutEffect(() => {
    registry?.forms.set(key, form)
  })
  useLayoutEffect(() => () => { registry?.forms.delete(key) }, [registry?.forms, key])
}

interface PublishedAgentPageRegistration {
  fingerprint: string
  registration: AgentPageRegistration
  source: { current: AgentPageRegistration }
}

const AgentPageRegistryContext = createContext<AgentPageRegistryValue | null>(null)

export function AgentPageRegistryProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const forms = useRef(new Map<symbol, AgentFormSnapshot>()).current
  const [published, setPublished] = useState<PublishedAgentPageRegistration | null>(null)
  const updateRegistration = useCallback((value: AgentPageRegistration | null) => {
    setPublished(current => {
      if (value === null) return null
      const fingerprint = registrationFingerprint(value)
      if (current?.fingerprint === fingerprint) {
        current.source.current = value
        return current
      }
      return publishRegistration(value, fingerprint)
    })
  }, [])
  const value = useMemo(() => ({
    registration: published?.registration ?? null,
    forms,
    setRegistration: updateRegistration,
  }), [forms, published, updateRegistration])
  return (
    <AgentPageRegistryContext.Provider value={value}>
      {children}
    </AgentPageRegistryContext.Provider>
  )
}

export function useAgentPageRegistration(): AgentPageRegistration | null {
  return useContext(AgentPageRegistryContext)?.registration ?? null
}

export function useRegisterAgentPage(registration: AgentPageRegistration): void {
  const registry = useContext(AgentPageRegistryContext)
  const setRegistration = registry?.setRegistration
  useEffect(() => {
    if (setRegistration === undefined || registry === null) return
    setRegistration({
      ...registration,
      readState: () => ({
        ...registration.readState() as Record<string, unknown>,
        forms: Object.fromEntries([...registry.forms.values()]
          .filter(form => form.viewId === registration.claim.viewId
            && form.selectionId === registration.claim.selection?.id)
          .map(form => [form.name, form.readValues?.() ?? form.values])),
      }),
    })
  }, [registration, setRegistration])
  useEffect(() => () => setRegistration?.(null), [setRegistration])
}

export function createDefaultAgentPageRegistration(input: {
  activeSection?: string
  label: string
  viewId: AgentViewId
  viewRevision: string
}): AgentPageRegistration {
  return {
    actions: {},
    claim: {
      version: 1,
      viewId: input.viewId,
      viewRevision: input.viewRevision,
      ...(input.activeSection === undefined ? {} : { activeSection: input.activeSection }),
      ui: { status: 'ready' },
    },
    label: input.label,
    readState: () => ({ activeSection: input.activeSection ?? input.viewId }),
  }
}

export function agentViewRevision(value: unknown): string {
  const text = JSON.stringify(value)
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `view-${(hash >>> 0).toString(16)}`
}

function publishRegistration(
  registration: AgentPageRegistration,
  fingerprint: string,
): PublishedAgentPageRegistration {
  const source = { current: registration }
  const actions = Object.fromEntries(Object.entries(registration.actions).map(([operationId, action]) => [
    operationId,
    {
      description: action.description,
      ...(action.enabled === undefined ? {} : { enabled: action.enabled }),
      parameters: action.parameters,
      execute(input: unknown, signal: AbortSignal) {
        const current = source.current.actions[operationId]
        if (current === undefined) throw new Error('ClinMesh page action is no longer available')
        return current.execute(input, signal)
      },
    } satisfies SurfaceAgentPageAction,
  ]))
  return {
    fingerprint,
    source,
    registration: {
      actions,
      claim: registration.claim,
      ...(registration.feedbackSelectionId === undefined ? {} : { feedbackSelectionId: registration.feedbackSelectionId }),
      label: registration.label,
      readState: () => source.current.readState(),
    },
  }
}

function registrationFingerprint(registration: AgentPageRegistration): string {
  return JSON.stringify({
    actions: Object.fromEntries(Object.entries(registration.actions).map(([operationId, action]) => [
      operationId,
      {
        description: action.description,
        enabled: action.enabled ?? true,
        parameters: action.parameters,
      },
    ])),
    claim: registration.claim,
    feedbackSelectionId: registration.feedbackSelectionId,
    label: registration.label,
    state: registration.readState(),
  })
}
