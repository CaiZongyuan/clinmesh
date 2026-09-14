import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { CircleAlertIcon, RefreshCwIcon } from 'lucide-react'
import { Component, type ReactNode } from 'react'
import { readWebPreferences } from './preferences.ts'
import { SurfaceFullscreenExitAction } from './surface-display-control.tsx'
import type { WebSurfaceDisplay } from './web-runtime.tsx'
import { getWorkspaceMessages } from './workspace-i18n.ts'

interface RuntimeErrorBoundaryProps {
  children: ReactNode
  surfaceDisplay?: WebSurfaceDisplay | undefined
}

interface RuntimeErrorBoundaryState {
  failed: boolean
}

export class RuntimeErrorBoundary extends Component<
  RuntimeErrorBoundaryProps,
  RuntimeErrorBoundaryState
> {
  override state: RuntimeErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): RuntimeErrorBoundaryState {
    return { failed: true }
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const { locale } = readWebPreferences()
    const messages = getWorkspaceMessages(locale)
    return (
      <main className="flex min-h-[320px] items-center justify-center p-6">
        <Alert className="max-w-xl" role="alert" variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{messages.runtimeErrorTitle}</AlertTitle>
          <AlertDescription>{messages.runtimeErrorDescription}</AlertDescription>
          <SurfaceFullscreenExitAction locale={locale} surfaceDisplay={this.props.surfaceDisplay} />
          <Button className="mt-4" onClick={() => this.setState({ failed: false })} variant="outline">
            <RefreshCwIcon data-icon="inline-start" />
            {messages.retry}
          </Button>
        </Alert>
      </main>
    )
  }
}
