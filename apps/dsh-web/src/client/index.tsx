import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { WebApp } from '@clinmesh/web/application'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createMemoryHistory } from '@tanstack/react-router'
import {
  defineReactSurface,
  type ReactSurfaceDefinition,
  type ReactSurfaceProps,
  type ReactSurfaceRegistry,
} from 'dsh-react-surface/client'
import { clinMeshStyles } from './styles.generated.ts'
import { registerProfileBrand } from './profile-brand.tsx'
import { normalizeHostLocale, type ClientLocalePort } from './host-locale.ts'
import { createWorkspaceNavigation, registerWorkspaceNavigation } from './workspace-navigation.tsx'
import type { WebSurfaceDisplay, WebSurfaceNavigation } from '@clinmesh/web/runtime'
import { createFontSizePreference, registerFontSizeSettings, type FontSizePreferenceStore } from './font-size-settings.tsx'
import type { FontSizePreference } from '../../../web/src/app/preferences.ts'

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
  surfaceLocale,
  surfaceFontSize,
  surfaceSessionId,
  surfaceDisplay,
  surfaceNavigation,
}: ReactSurfaceProps & {
  surfaceNavigation: WebSurfaceNavigation
  surfaceDisplay: WebSurfaceDisplay
  surfaceColorScheme: 'dark' | 'light'
  surfaceLocale: 'zh-CN' | 'en-US'
  surfaceFontSize: FontSizePreference
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
        surfaceLocale,
        surfaceFontSize,
        surfaceDisplay,
        surfaceNavigation,
        ...(surfaceSessionId === undefined ? {} : { surfaceSessionId }),
      }}
    />
  )
}

function normalizeLocation(location: string): string {
  return location === '' ? '/' : location
}

export function createDefinition(
  ctx: ClientContext,
  navigation = createWorkspaceNavigation(),
  fontSize: FontSizePreferenceStore = createFontSizePreference(),
): Readonly<ReactSurfaceDefinition> {
  const sessions = ctx.get('sessions') as unknown as ClientSessionsPort
  const theme = ctx.get('theme') as unknown as ClientThemePort
  const locale = ctx.get('locale') as unknown as ClientLocalePort
  const subscribeLocale = (listener: () => void) => locale.subscribe(listener)
  const getLocale = () => normalizeHostLocale(locale.getLocale().active)
  const surfaces = ctx.get('reactSurfaces') as unknown as ReactSurfaceRegistry
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
    const surfaceLocale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
    const surfaceFontSize = useSyncExternalStore(fontSize.subscribe, fontSize.getSnapshot, fontSize.getSnapshot)
    const surfaceColorScheme = useSyncExternalStore(
      subscribeTheme,
      () => theme.getTheme().active.colorScheme,
      () => theme.getTheme().active.colorScheme,
    )
    return (
      <ClinMeshSurface
        {...props}
        surfaceNavigation={navigation}
        surfaceDisplay={{
          fullscreen: props.layout === 'full-frame',
          toggle: () => surfaces.setLayout('clinmesh.his', props.layout === 'full-frame' ? 'workspace' : 'full-frame'),
          conversation: {
            collapsed: props.conversationCollapsed,
            toggle: () => surfaces.setConversationCollapsed('clinmesh.his', !props.conversationCollapsed),
          },
        }}
        surfaceColorScheme={surfaceColorScheme}
        surfaceLocale={surfaceLocale}
        surfaceFontSize={surfaceFontSize}
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
    fallback: 'shrink',
    minSurfaceWidth: 360,
    persist: true,
    resizable: true,
    supported: ['workspace', 'full-frame'],
  },
  lifecycle: { mount: 'lazy', retention: 'keep-alive' },
  order: 10,
  styles: clinMeshStyles,
  title: 'ClinMesh',
  })
}

export const inject = ['reactSurfaces', 'sessions', 'theme', 'slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => registerProfileBrand(ctx), 'clinmesh-dsh-web: register Profile identity')
  const navigation = createWorkspaceNavigation()
  const fontSize = createFontSizePreference()
  ctx.effect(() => registerFontSizeSettings(ctx, fontSize), 'clinmesh-dsh-web: register font size setting')
  ctx.effect(() => registerWorkspaceNavigation(ctx, navigation), 'clinmesh-dsh-web: register hospital navigation')
  const definition = createDefinition(ctx, navigation, fontSize)
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
