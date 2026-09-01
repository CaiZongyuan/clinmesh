import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { WebApp } from '@clinmesh/web/application'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createMemoryHistory } from '@tanstack/react-router'
import {
  defineReactSurface,
  type ReactSurfaceDefinition,
  type ReactSurfaceProps,
} from 'dsh-react-surface/client'
import { clinMeshStyles } from './styles.generated.ts'

interface ClientSessionsPort {
  list: {
    getSnapshot(): { current: string | undefined }
    subscribe(listener: () => void): () => void
  }
}

interface ClientThemePort {
  getTheme(): { active: { colorScheme: 'dark' | 'light' } }
}

interface ClientThemeContext {
  on(event: 'theme/change', listener: () => void): () => void
}

function ClinMeshSurface({
  active,
  agent,
  capabilities,
  close,
  location,
  navigate,
  surfaceColorScheme,
  surfaceSessionId,
}: ReactSurfaceProps & {
  surfaceColorScheme: 'dark' | 'light'
  surfaceSessionId?: string
}): React.JSX.Element {
  const locationRef = useRef(location)
  const navigateRef = useRef(navigate)
  const closeRef = useRef(close)
  locationRef.current = location
  navigateRef.current = navigate
  closeRef.current = close

  const [history] = useState(() => createMemoryHistory({
    initialEntries: [normalizeLocation(location)],
  }))

  useEffect(() => history.subscribe(({ location: nextLocation }) => {
    if (nextLocation.href !== locationRef.current) {
      navigateRef.current(nextLocation.href)
    }
  }), [history])

  useEffect(() => {
    const nextLocation = normalizeLocation(location)
    if (history.location.href !== nextLocation) history.replace(nextLocation)
  }, [history, location])

  useEffect(() => () => history.destroy(), [history])

  return (
    <WebApp
      history={history}
      runtime={{
        apiBasePath: '/clinmesh-api',
        mode: 'surface',
        onExit: () => closeRef.current(),
        surfaceActive: active,
        surfaceAgent: agent,
        surfaceAgentStatus: capabilities.agent.status,
        surfaceColorScheme,
        ...(surfaceSessionId === undefined ? {} : { surfaceSessionId }),
      }}
    />
  )
}

function normalizeLocation(location: string): string {
  return location === '' ? '/' : location
}

export function createDefinition(ctx: ClientContext): Readonly<ReactSurfaceDefinition> {
  const sessions = ctx.get('sessions') as unknown as ClientSessionsPort
  const theme = ctx.get('theme') as unknown as ClientThemePort
  const subscribe = (listener: () => void): (() => void) => sessions.list.subscribe(listener)
  const subscribeTheme = (listener: () => void): (() => void) => (
    ctx as unknown as ClientThemeContext
  ).on('theme/change', listener)
  const getSnapshot = (): string | undefined => {
    const current = sessions.list.getSnapshot().current
    return current === undefined ? undefined : String(current)
  }
  function SessionBoundClinMeshSurface(props: ReactSurfaceProps): React.JSX.Element {
    const surfaceSessionId = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    const surfaceColorScheme = useSyncExternalStore(
      subscribeTheme,
      () => theme.getTheme().active.colorScheme,
      () => theme.getTheme().active.colorScheme,
    )
    return (
      <ClinMeshSurface
        {...props}
        surfaceColorScheme={surfaceColorScheme}
        {...(surfaceSessionId === undefined ? {} : { surfaceSessionId })}
      />
    )
  }
  return defineReactSurface({
  branding: {
    colorScheme: 'system',
    identity: { mark: 'CM', name: 'ClinMesh' },
    shell: 'preserve',
  },
  component: SessionBoundClinMeshSurface,
  description: '中国公立医院仿真 HIS 工作台',
  id: 'clinmesh.his',
  initialLocation: '/',
  layout: {
    default: 'workspace',
    fallback: 'full-frame',
    minSurfaceWidth: 1024,
    persist: true,
    resizable: true,
    supported: ['workspace', 'center', 'full-frame'],
  },
  lifecycle: { mount: 'lazy', retention: 'keep-alive' },
  order: 10,
  styles: clinMeshStyles,
  title: 'ClinMesh',
  })
}

export const inject = ['reactSurfaces', 'sessions', 'theme']

export function apply(ctx: ClientContext): void {
  const definition = createDefinition(ctx)
  const reactSurfaces = (ctx as ClientContext & {
    reactSurfaces: {
      register(value: typeof definition): () => void
    }
  }).reactSurfaces
  ctx.effect(
    () => reactSurfaces.register(definition),
    'clinmesh-dsh-web: register application Surface',
  )
}
