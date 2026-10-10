import { createContext, useContext, type ReactNode, type RefObject } from 'react'
import type { WebPreferences } from './preferences.ts'
import type { DoctorAgentChatInput, DoctorAgentTaskSubmission } from '@clinmesh/contracts/agent'

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
  surfaceDoctorInput?: (accept: (input: DoctorAgentChatInput, signal: AbortSignal) => Promise<DoctorAgentTaskSubmission>) => (() => void)
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
  surfaceDoctorInput?: (accept: (input: DoctorAgentChatInput, signal: AbortSignal) => Promise<DoctorAgentTaskSubmission>) => (() => void)
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
