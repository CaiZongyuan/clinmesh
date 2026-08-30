import { createContext, useContext, type ReactNode, type RefObject } from 'react'

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
  apiBasePath?: string
  mode?: WebRuntimeMode
  onExit?: () => void
  surfaceActive?: boolean
  surfaceAgent?: WebSurfaceAgentController
  surfaceAgentStatus?: WebSurfaceAgentStatus
}

interface WebRuntimeValue {
  appearanceRoot: RefObject<HTMLElement | null>
  mode: WebRuntimeMode
  onExit?: () => void
  surfaceActive?: boolean
  surfaceAgent?: WebSurfaceAgentController
  surfaceAgentStatus?: WebSurfaceAgentStatus
}

const WebRuntimeContext = createContext<WebRuntimeValue | null>(null)

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
