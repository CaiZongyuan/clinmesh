import { MonitorIcon } from 'lucide-react'
import { Button } from '@clinmesh/ui/components/button'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@clinmesh/ui/components/sidebar'
import { useWebRuntime } from './web-runtime.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

function displayLabel(fullscreen: boolean, locale: WorkspaceLocale): string {
  if (locale === 'en-US') return fullscreen ? 'Return to DSH split view' : 'Fullscreen ClinMesh'
  return fullscreen ? '返回 DSH 分屏' : '全屏 ClinMesh'
}

export function SurfaceDisplayMenu({ locale }: { locale: WorkspaceLocale }) {
  const { surfaceDisplay } = useWebRuntime()
  const { setOpenMobile } = useSidebar()
  if (!surfaceDisplay) return null
  const label = displayLabel(surfaceDisplay.fullscreen, locale)
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          aria-label={label}
          tooltip={label}
          onClick={() => {
            setOpenMobile(false)
            surfaceDisplay.toggle()
          }}
        >
          <MonitorIcon aria-hidden="true" />
          <span>{label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

export function SurfaceFullscreenExit({ locale }: { locale: WorkspaceLocale }) {
  const { surfaceDisplay } = useWebRuntime()
  if (!surfaceDisplay?.fullscreen) return null
  return (
    <Button variant="ghost" size="sm" type="button" onClick={surfaceDisplay.toggle}>
      {displayLabel(true, locale)}
    </Button>
  )
}
