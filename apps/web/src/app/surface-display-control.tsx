import type { LucideIcon } from 'lucide-react'
import { PanelRightCloseIcon, PanelRightOpenIcon } from 'lucide-react'
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

export function SurfaceConversationButton({ locale }: { locale: WorkspaceLocale }) {
  const { surfaceDisplay } = useWebRuntime()
  return <SurfaceConversationAction locale={locale} surfaceDisplay={surfaceDisplay} />
}

function SurfaceConversationAction({ locale, surfaceDisplay }: {
  locale: WorkspaceLocale
  surfaceDisplay: WebSurfaceDisplay | undefined
}) {
  const conversation = surfaceDisplay?.conversation
  if (!conversation || surfaceDisplay.fullscreen) return null
  const label = locale === 'en-US'
    ? conversation.collapsed ? 'Expand conversation' : 'Collapse conversation'
    : conversation.collapsed ? '展开会话' : '收起会话'
  const Icon = conversation.collapsed ? PanelRightOpenIcon : PanelRightCloseIcon
  return (
    <Button aria-label={label} aria-expanded={!conversation.collapsed} title={label} variant="ghost" size="icon" onClick={conversation.toggle}>
      <Icon aria-hidden="true" />
    </Button>
  )
}

export function SurfaceDisplayFallback({ locale }: { locale: WorkspaceLocale }) {
  const { surfaceDisplay } = useWebRuntime()
  return <SurfaceDisplayFallbackAction locale={locale} surfaceDisplay={surfaceDisplay} />
}

export function SurfaceDisplayFallbackAction({ locale, surfaceDisplay }: {
  locale: WorkspaceLocale
  surfaceDisplay: WebSurfaceDisplay | undefined
}) {
  if (!surfaceDisplay?.fullscreen) return <SurfaceConversationAction locale={locale} surfaceDisplay={surfaceDisplay} />
  return (
    <Button variant="ghost" size="sm" type="button" onClick={surfaceDisplay.toggle}>
      {displayLabel(true, locale)}
    </Button>
  )
}
