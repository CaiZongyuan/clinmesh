import type { ComponentProps } from 'react'
import { SidebarProvider } from '@clinmesh/ui/components/sidebar'
import { useContainerCompact } from '@clinmesh/ui/hooks/use-container-compact'

export function ResponsiveSidebarProvider(props: ComponentProps<typeof SidebarProvider>) {
  return props.heightMode === 'container' ? (
    <ContainerSidebarProvider {...props} />
  ) : (
    <SidebarProvider {...props} />
  )
}

function ContainerSidebarProvider(props: ComponentProps<typeof SidebarProvider>) {
  const { ref, compact } = useContainerCompact(768)
  return (
    <div ref={ref} className="h-full min-h-0 w-full min-w-0">
      <SidebarProvider {...props} compact={compact} />
    </div>
  )
}
