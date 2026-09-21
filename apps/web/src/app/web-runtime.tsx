import { createContext, useContext, type ReactNode, type RefObject } from 'react'
import type { DoctorCaseDetail, EncounterCompletionPreview } from '@clinmesh/contracts/his'
import type { WebPreferences } from './preferences.ts'
import type { DoctorCaseSection } from './doctor/case-context-rail.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

/** Local presentation and actions; the application retains session and route ownership. */
export interface WebSurfaceNavigationState {
  items: readonly { path: string; label: string }[]
  activePath: string
  locale: WebPreferences['locale']
  navigate(path: string): void
}

export interface WebSurfaceNavigation {
  register(state: WebSurfaceNavigationState): () => void
}

/** Read-only case-context snapshot consumed by the host rightbar panel; view data only, never queries. */
export interface WebSurfaceCaseContextState {
  caseId: string
  completion: EncounterCompletionPreview | undefined
  detail: DoctorCaseDetail
  locale: WorkspaceLocale
  section: DoctorCaseSection
  statusText: string
}

/** Host rightbar contract; the application keeps query and state ownership. */
export interface WebSurfaceCaseContext {
  register(state: WebSurfaceCaseContextState): () => void
  /** 宿主患者信息的真实可见状态；手动收起、关闭和切换标签均同步。 */
  visibility?: {
    getSnapshot(): boolean
    subscribe(listener: () => void): () => void
    toggle(): void
  }
  /**
   * 用户在 WebApp 内主动请求展示右栏患者上下文（如手动按钮）。宿主负责打开/聚焦
   * 标签页，幂等；右栏座位未挂载时由宿主自行延迟重试。缺省（宿主未实现）时
   * WebApp 不渲染对应入口。
   */
  requestOpen?(): void
}

export type WebRuntimeMode = 'standalone' | 'surface'
export type WebSurfaceAgentStatus = 'unavailable' | 'idle' | 'connecting' | 'active' | 'contended' | 'error'

export interface WebSurfaceAgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(input: unknown, signal: AbortSignal): string | Promise<string>
}

export interface WebSurfaceAgentController {
  register(registration: {
    scopeKey: string
    label: string
    tools: readonly WebSurfaceAgentTool[]
  }): () => void
}

export interface WebRuntimeOptions {
  surfaceNavigation?: WebSurfaceNavigation
  surfaceCaseContext?: WebSurfaceCaseContext
  surfaceDisplay?: WebSurfaceDisplay
  apiBasePath?: string
  mode?: WebRuntimeMode
  onExit?: () => void
  surfaceActive?: boolean
  surfaceAgent?: WebSurfaceAgentController
  surfaceAgentStatus?: WebSurfaceAgentStatus
  surfaceColorScheme?: 'dark' | 'light'
  surfaceLocale?: WebPreferences['locale']
  surfaceFontSize?: WebPreferences['fontSize']
  surfaceSessionId?: string
}

export interface WebRuntimeValue {
  surfaceNavigation?: WebSurfaceNavigation
  surfaceCaseContext?: WebSurfaceCaseContext
  surfaceDisplay?: WebSurfaceDisplay
  appearanceRoot: RefObject<HTMLElement | null>
  mode: WebRuntimeMode
  onExit?: () => void
  surfaceActive?: boolean
  surfaceAgent?: WebSurfaceAgentController
  surfaceAgentStatus?: WebSurfaceAgentStatus
  surfaceColorScheme?: 'dark' | 'light'
  surfaceSessionId?: string
}

const WebRuntimeContext = createContext<WebRuntimeValue | null>(null)

export interface WebSurfaceDisplay {
  conversation?: { collapsed: boolean; toggle(): void }
  fullscreen: boolean
  /** 宿主全屏(full-frame)保留右栏(details)时声明:右栏标签在全屏下仍可见可交互。 */
  fullscreenKeepsDetails?: boolean
  toggle(): void
}

export function WebRuntimeProvider({
  children,
  value,
}: {
  children: ReactNode
  value: WebRuntimeValue
}): React.JSX.Element {
  return <WebRuntimeContext.Provider value={value}>{children}</WebRuntimeContext.Provider>
}

export function useWebRuntime(): WebRuntimeValue {
  const value = useContext(WebRuntimeContext)
  if (value === null) throw new Error('useWebRuntime must be used inside WebRuntimeProvider')
  return value
}

/** Nullable variant for shared components that may render outside the provider (直接挂载的视图与测试). */
export function useOptionalWebRuntime(): WebRuntimeValue | null {
  return useContext(WebRuntimeContext)
}
