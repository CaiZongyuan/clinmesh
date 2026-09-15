import { createContext, useContext, type ReactNode, type RefObject } from 'react'
import type { WebPreferences } from './preferences.ts'

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
  surfaceNavigation?: WebSurfaceNavigation
  surfaceDisplay?: WebSurfaceDisplay
  apiBasePath?: string
  mode?: WebRuntimeMode
  onExit?: () => void
  surfaceActive?: boolean
  surfaceAgent?: WebSurfaceAgentController
  surfaceAgentStatus?: WebSurfaceAgentStatus
  surfaceColorScheme?: 'dark' | 'light'
  surfaceSessionId?: string
}

interface WebRuntimeValue {
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
  fullscreen: boolean
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
