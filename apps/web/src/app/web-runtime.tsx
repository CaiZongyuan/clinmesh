import { createContext, useContext, type ReactNode, type RefObject } from 'react'
import type { WebPreferences } from './preferences.ts'
import type { DoctorAgentChatInput, DoctorAgentTaskSubmission, DoctorRecordingSourceInput } from '@clinmesh/contracts/agent'

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
  surfaceDoctorInput?: (accept: (input: DoctorAgentChatInput, signal: AbortSignal) => Promise<DoctorAgentTaskSubmission>,
    record?: (input: DoctorRecordingSourceInput, signal: AbortSignal) => Promise<void>,
    sourceFailed?: (dshSessionId: string) => void) => (() => void)
  surfaceNavigation?: WebSurfaceNavigation
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
  surfaceDoctorInput?: WebRuntimeOptions['surfaceDoctorInput']
  surfaceNavigation?: WebSurfaceNavigation
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
  /** DSH Surface 下队列统一为贴内容区左缘的收起卡片（2026-10-22 用户确认保留）；缺省为队列列。 */
  queuePresentation?: 'column' | 'rail'
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
