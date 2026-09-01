declare module 'dsh-react-surface/client' {
  interface ReactSurfaceAgentTool {
    name: string
    description: string
    parameters: Record<string, unknown>
    execute(input: unknown, signal: AbortSignal): string | Promise<string>
  }

  interface ReactSurfaceAgentController {
    register(registration: {
      scopeKey: string
      label: string
      tools: readonly ReactSurfaceAgentTool[]
    }): () => void
  }

  export interface ReactSurfaceProps {
    active: boolean
    agent: ReactSurfaceAgentController
    capabilities: {
      agent: {
        available: boolean
        reason?: string
        status: 'unavailable' | 'idle' | 'connecting' | 'active' | 'contended' | 'error'
      }
    }
    close(): void
    location: string
    navigate(location: string): void
  }

  export interface ReactSurfaceDefinition {
    id: string
    title: string
    component: import('react').ComponentType<ReactSurfaceProps>
    [key: string]: unknown
  }

  export function defineReactSurface(
    definition: ReactSurfaceDefinition,
  ): Readonly<ReactSurfaceDefinition>
}
