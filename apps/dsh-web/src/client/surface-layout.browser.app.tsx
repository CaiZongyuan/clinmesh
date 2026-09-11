import { useRef } from 'react'
import { SidebarProvider, SidebarFooter } from '@clinmesh/ui/components/sidebar'
import { WebRuntimeProvider, type WebRuntimeOptions } from '../../../web/src/app/web-runtime.tsx'
import { SurfaceDisplayMenu } from '../../../web/src/app/surface-display-control.tsx'

export function WebApp({ runtime }: { runtime: WebRuntimeOptions }) {
  const appearanceRoot = useRef<HTMLDivElement>(null)
  return (
    <WebRuntimeProvider value={{ ...runtime, mode: 'surface', appearanceRoot }}>
      <SidebarProvider>
        <SidebarFooter>
          <SurfaceDisplayMenu locale="zh-CN" />
        </SidebarFooter>
        <input aria-label="Clinical draft" defaultValue="unsaved draft" />
      </SidebarProvider>
    </WebRuntimeProvider>
  )
}
