import { MedicationCatalogDialog } from '../../../web/src/app/doctor/catalog-picker-dialogs.tsx'
import {
  DoctorWorkspaceLayout,
  DoctorCaseLayout,
} from '../../../web/src/app/doctor/responsive-layout.tsx'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Sidebar, SidebarInset, SidebarTrigger, useSidebar } from '@clinmesh/ui/components/sidebar'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { ResponsiveSidebarProvider } from '../../../web/src/app/responsive-sidebar.tsx'

function Content() {
  const sidebar = useSidebar()
  return (
    <SidebarInset>
      <SidebarTrigger aria-label="Navigation" />
      <input aria-label="Draft" defaultValue="retained draft" />
      <output data-compact={sidebar.isMobile} />
    </SidebarInset>
  )
}

const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setTimeout(resolve, 50)
      }),
    ),
  )

async function run() {
  const host = document.createElement('div')
  host.style.cssText = 'width:1400px;height:600px'
  document.body.append(host)
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = document.querySelector('style[data-fixture]')?.textContent ?? ''
  const root = document.createElement('div')
  root.className = 'clinmesh-web-root'
  root.style.cssText =
    'height:100%;container-type:inline-size;container-name:dsh-react-surface-content'
  shadow.append(style, root)
  flushSync(() =>
    createRoot(root).render(
      <PortalContainerProvider container={root}>
        <ResponsiveSidebarProvider heightMode="container">
          <Sidebar mobileTitle="Navigation">
            <a href="#case">Cases</a>
          </Sidebar>
          <div style={{ minWidth: 0, flex: 1 }}>
            <Content />
            <div data-catalog>
              <MedicationCatalogDialog
                excludedIds={new Set()}
                localCatalog={[]}
                locale="en-US"
                onSelect={() => {}}
                search={{
                  data: undefined,
                  error: null,
                  isError: false,
                  isFetching: false,
                  isPending: false,
                  onSearch: () => {},
                }}
              />
            </div>
            <DoctorWorkspaceLayout
              selectedCaseId="case-1"
              queueLabel="Queue"
              detailLabel="Case"
              queue={() => <div data-queue>Queue</div>}
            >
              <DoctorCaseLayout
                contextLabel="Context"
                rail={() => <aside data-context>Context</aside>}
              >
                <div data-record>
                  <input aria-label="Record" defaultValue="case draft" />
                </div>
              </DoctorCaseLayout>
            </DoctorWorkspaceLayout>
          </div>
        </ResponsiveSidebarProvider>
      </PortalContainerProvider>,
    ),
  )
  const steps = []
  for (const width of [1400, 640, 360, 1024]) {
    host.style.width = `${width}px`
    await settle()
    steps.push({
      width,
      compact: shadow.querySelector('output')?.getAttribute('data-compact') === 'true',
      draft: shadow.querySelector('input')?.value,
      recordWidth: shadow.querySelector('[data-record]')?.getBoundingClientRect().width ?? 0,
      queueSwitch: Array.from(shadow.querySelectorAll('button')).some(
        (button) => button.textContent === 'Queue',
      ),
      contextSwitch: Array.from(shadow.querySelectorAll('button')).some(
        (button) => button.textContent === 'Context',
      ),
    })
  }
  host.style.width = '1400px'
  await settle()
  shadow.querySelector<HTMLButtonElement>('[data-catalog] button')!.click()
  await settle()
  const catalog = shadow.querySelector('[role=dialog]')!
  const catalogWidth = catalog.getBoundingClientRect().width
  catalog.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }),
  )
  await new Promise((resolve) => setTimeout(resolve, 200))
  host.style.width = '360px'
  await settle()
  shadow.querySelector<HTMLButtonElement>('button[aria-label="Navigation"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 200))
  document.title = btoa(
    JSON.stringify({
      steps,
      catalogWidth,
      navigationVisible: shadow.querySelector('[role="dialog"]') !== null,
    }),
  )
}
void run().catch((error) => {
  document.title = btoa(JSON.stringify({ error: String(error) }))
})
