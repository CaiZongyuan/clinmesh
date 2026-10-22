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
import { subscribeHostTheme, type ClientSessionBindingPort, type ClientSessionInputPort, type ClientThemePort } from './host-ports.ts'
import { createWorkspaceNavigation, registerWorkspaceNavigation } from './workspace-navigation.tsx'
import type { WebSurfaceDisplay, WebSurfaceNavigation, WebRuntimeOptions } from '@clinmesh/web/runtime'
import { createDoctorInputBridge } from './doctor-task.ts'
import { createFontSizePreference, registerFontSizeSettings, type FontSizePreferenceStore } from './font-size-settings.tsx'
import { registerModelSettings } from './model-settings.tsx'
import type { FontSizePreference } from '../../../web/src/app/preferences.ts'

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
  surfaceDoctorInput,
}: ReactSurfaceProps & {
  surfaceNavigation: WebSurfaceNavigation
  surfaceDisplay: WebSurfaceDisplay
  surfaceColorScheme: 'dark' | 'light'
  surfaceLocale: 'zh-CN' | 'en-US'
  surfaceFontSize: FontSizePreference
  surfaceSessionId?: string
  surfaceDoctorInput: NonNullable<WebRuntimeOptions['surfaceDoctorInput']>
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
        surfaceDoctorInput,
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
  const sessionBinding = ctx.get('uiSession') as unknown as ClientSessionBindingPort
  const theme = ctx.get('theme') as unknown as ClientThemePort
  const locale = ctx.get('locale') as unknown as ClientLocalePort
  const subscribeLocale = (listener: () => void) => locale.subscribe(listener)
  const getLocale = () => normalizeHostLocale(locale.getLocale().active)
  const surfaces = ctx.get('reactSurfaces') as unknown as ReactSurfaceRegistry
  const sessions = ctx.get('sessions') as unknown as ClientSessionInputPort
  const surfaceDoctorInput: NonNullable<WebRuntimeOptions['surfaceDoctorInput']> = (accept, record, sourceFailed) => createDoctorInputBridge({
    current: sessionBinding.adapter.current, sessions,
  }, accept, record, sourceFailed)
  const subscribe = (listener: () => void): (() => void) => sessionBinding.adapter.current.subscribe(listener)
  const subscribeTheme = (listener: () => void): (() => void) => subscribeHostTheme(ctx, listener)
  const getSnapshot = (): string | undefined => sessionBinding.adapter.current.getSnapshot().key
  function SessionBoundClinMeshSurface(props: ReactSurfaceProps): React.JSX.Element {
    const surfaceSessionId = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    const surfaceLocale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
    const surfaceFontSize = useSyncExternalStore(fontSize.subscribe, fontSize.getSnapshot, fontSize.getSnapshot)
    const surfaceColorScheme = useSyncExternalStore(
      subscribeTheme,
      () => theme.getTheme().active.colorScheme,
      () => theme.getTheme().active.colorScheme,
    )
    // 退出全屏回到进入前的布局，不因全屏往返丢失非全屏形态。
    const lastWorkspaceLayout = useRef<ReactSurfaceProps['layout']>('workspace')
    if (props.layout !== 'full-frame') lastWorkspaceLayout.current = props.layout
    return (
      <ClinMeshSurface
        {...props}
        surfaceNavigation={navigation}
        surfaceDoctorInput={surfaceDoctorInput}
        surfaceDisplay={{
          fullscreen: props.layout === 'full-frame',
          // 全屏保留宿主会话文件等原生右栏内容。
          fullscreenKeepsDetails: true,
          // DSH 面队列统一收进贴内容区左缘的折叠卡片（2026-10-22 用户确认保留该形态）。
          queuePresentation: 'rail',
          toggle: () => surfaces.setLayout('clinmesh.his', props.layout === 'full-frame' ? lastWorkspaceLayout.current : 'full-frame'),
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
    // 会话列保持宿主右侧原生位置（2026-10-22 用户确认镜像左列形态回退）；
    // 短暂默认期写入的存量镜像偏好由 upgradeLegacyMirrorLayout 升级回本默认值。
    default: 'workspace',
    fallback: 'shrink',
    fullFrameKeepDetails: true,
    minSurfaceWidth: 360,
    persist: true,
    resizable: true,
    // workspace-mirror 必须留在 supported：注册表只恢复受支持的存量布局，
    // upgradeLegacyMirrorLayout 依赖快照读出它才能落盘覆盖为默认值。
    supported: ['workspace', 'workspace-mirror', 'full-frame'],
  },
  lifecycle: { mount: 'lazy', retention: 'keep-alive' },
  order: 10,
  styles: clinMeshStyles,
  title: 'ClinMesh',
  })
}

export const inject = ['reactSurfaces', 'uiSession', 'uiWorkspace', 'sessions', 'workspaces', 'layout', 'theme', 'slots', 'locale', 'remote', 'remote.settings', 'remote.session']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => registerProfileBrand(ctx), 'clinmesh-dsh-web: register Profile identity')
  const navigation = createWorkspaceNavigation()
  const fontSize = createFontSizePreference()
  ctx.effect(() => registerModelSettings(ctx), 'clinmesh-dsh-web: register model setting')
  ctx.effect(() => registerFontSizeSettings(ctx, fontSize), 'clinmesh-dsh-web: register font size setting')
  ctx.effect(() => registerWorkspaceNavigation(ctx, navigation), 'clinmesh-dsh-web: register hospital navigation')
  const definition = createDefinition(ctx, navigation, fontSize)
  const reactSurfaces = ctx.get('reactSurfaces') as unknown as ReactSurfaceRegistry
  ctx.effect(
    () => {
      const dispose = reactSurfaces.register(definition)
      // 注册时恢复的存量偏好可能仍指向已退役的镜像布局，会在持久化下一直覆盖默认值。
      upgradeLegacyMirrorLayout(reactSurfaces)
      return dispose
    },
    'clinmesh-dsh-web: register application Surface',
  )
}

/**
 * 会话列回到宿主右侧后，短暂镜像默认期写入的存量 workspace-mirror 偏好会被当作
 * 明确选择而一直覆盖默认。注册完成后把它视为未选择、升级回 workspace：setLayout
 * 即落盘，升级只发生一次，此后为 no-op；full-frame 等其他布局不受影响。
 */
export function upgradeLegacyMirrorLayout(registry: ReactSurfaceRegistry): void {
  const surface = registry
    .getSnapshot()
    .surfaces.find(({ definition }) => definition.id === 'clinmesh.his')
  if (surface?.layout === 'workspace-mirror') registry.setLayout('clinmesh.his', 'workspace')
}
