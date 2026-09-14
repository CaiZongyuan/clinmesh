import { useRef } from 'react'
import { WebRuntimeProvider, type WebRuntimeOptions } from '../../../web/src/app/web-runtime.tsx'
import { SurfaceDisplayButton } from '../../../web/src/app/surface-display-control.tsx'

export function WebApp({ runtime }: { runtime: WebRuntimeOptions }) {
  const appearanceRoot = useRef<HTMLDivElement>(null)
  return (
    <WebRuntimeProvider value={{ ...runtime, mode: 'surface', appearanceRoot }}>
      <main>
        <header>
          <SurfaceDisplayButton locale="zh-CN" />
        </header>
        <input aria-label="Clinical draft" defaultValue="unsaved draft" />
      </main>
    </WebRuntimeProvider>
  )
}
