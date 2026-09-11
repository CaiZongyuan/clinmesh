import type { ReactNode } from 'react'
import { Button } from '@clinmesh/ui/components/button'

export function SurfaceFrame({
  children,
  fullscreen,
  onToggle,
}: {
  children: ReactNode
  fullscreen: boolean
  onToggle: () => void
}) {
  return (
    <div className="clinmesh-web-root flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
      <div
        className="flex shrink-0 justify-end border-b px-2 py-1"
        role="toolbar"
        aria-label="ClinMesh 显示模式"
      >
        <Button onClick={onToggle} size="sm" variant="ghost" type="button">
          {fullscreen ? '返回 DSH 分屏' : '全屏 ClinMesh'}
        </Button>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  )
}
