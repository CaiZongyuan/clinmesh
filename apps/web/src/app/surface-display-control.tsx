import type { LucideIcon } from 'lucide-react'
import { Button } from '@clinmesh/ui/components/button'
import { useWebRuntime, type WebSurfaceDisplay } from './web-runtime.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

function displayLabel(fullscreen: boolean, locale: WorkspaceLocale): string {
  if (locale === 'en-US') return fullscreen ? 'Return to DSH split view' : 'Fullscreen ClinMesh'
  return fullscreen ? '返回 DSH 分屏' : '全屏 ClinMesh'
}

export function SurfaceDisplayButton({ locale, icon: Icon }: { locale: WorkspaceLocale; icon: LucideIcon }) {
  const { surfaceDisplay } = useWebRuntime()
  if (!surfaceDisplay) return null
  const label = displayLabel(surfaceDisplay.fullscreen, locale)
  return (
    <Button aria-label={label} title={label} variant="ghost" size="icon" onClick={surfaceDisplay.toggle}>
      <Icon aria-hidden="true" />
    </Button>
  )
}

export function SurfaceFullscreenExit({ locale }: { locale: WorkspaceLocale }) {
  const { surfaceDisplay } = useWebRuntime()
  return <SurfaceFullscreenExitAction locale={locale} surfaceDisplay={surfaceDisplay} />
}

export function SurfaceFullscreenExitAction({ locale, surfaceDisplay }: {
  locale: WorkspaceLocale
  surfaceDisplay: WebSurfaceDisplay | undefined
}) {
  if (!surfaceDisplay?.fullscreen) return null
  return (
    <Button variant="ghost" size="sm" type="button" onClick={surfaceDisplay.toggle}>
      {displayLabel(true, locale)}
    </Button>
  )
}
