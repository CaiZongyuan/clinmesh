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
      <input aria-label="Draft" defaultValue="initial shell draft" />
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
            <div style={{ display: 'flex', flexDirection: 'column', height: 384, minHeight: 0 }}><DoctorWorkspaceLayout
              locale="en-US"
              selectedCaseId="case-1"
              queueLabel="Queue"
              detailLabel="Case"
              queue={() => <div data-queue>Queue</div>}
              suggestions={{ label: 'Context', node: <div data-context tabIndex={-1}>Synthetic read-only context</div> }}
            >
              <DoctorCaseLayout>
                <div data-record>
                  <input aria-label="Record" defaultValue="initial case draft" />
                </div>
              </DoctorCaseLayout>
            </DoctorWorkspaceLayout></div>
          </div>
        </ResponsiveSidebarProvider>
      </PortalContainerProvider>,
    ),
  )
  const draft = shadow.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!
  const record = shadow.querySelector<HTMLInputElement>('input[aria-label="Record"]')!
  draft.value = 'retained draft'
  record.value = 'retained case draft'
  record.focus()
  const steps = []
  for (const width of [1400, 640, 360, 1024]) {
    host.style.width = `${width}px`
    await settle()
    const workspace = shadow.querySelector<HTMLElement>('[data-workspace-id="outpatient-doctor"]')!
    const currentRecord = shadow.querySelector<HTMLInputElement>('input[aria-label="Record"]')!
    const queue = workspace.querySelector<HTMLElement>('.clinmesh-card-queue')!.getBoundingClientRect()
    const main = workspace.querySelector<HTMLElement>('.clinmesh-card-main')!.getBoundingClientRect()
    const aside = workspace.querySelector<HTMLElement>('.clinmesh-card-aside')!.getBoundingClientRect()
    const recordBounds = workspace.querySelector<HTMLElement>('[data-record]')!.getBoundingClientRect()
    const context = workspace.querySelector<HTMLElement>('[data-context]')!
    context.scrollIntoView({ block: 'nearest' })
    await settle()
    const contextBounds = context.getBoundingClientRect(), hostBounds = host.getBoundingClientRect()
    const contextReachable = contextBounds.width > 0 && contextBounds.top >= hostBounds.top && contextBounds.bottom <= hostBounds.bottom
    currentRecord.scrollIntoView({ block: 'nearest' })
    await settle()
    steps.push({
      width,
      surfaceWidth: root.getBoundingClientRect().width,
      workspaceWidth: workspace.getBoundingClientRect().width,
      compact: shadow.querySelector('output')?.getAttribute('data-compact') === 'true',
      draft: shadow.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!.value,
      recordDraft: currentRecord.value,
      recordFocused: shadow.activeElement === currentRecord,
      recordWidth: recordBounds.width,
      recordBounded: recordBounds.left >= main.left - 0.5 && recordBounds.right <= main.right + 0.5,
      queueAlongside: queue.right <= main.left + 0.5,
      queueAbove: queue.bottom <= main.top + 0.5,
      contextAlongside: main.right <= aside.left + 0.5,
      contextBelow: main.bottom <= aside.top + 0.5,
      contextReachable,
      queueSwitch: shadow.querySelector('button[aria-label="Hide queue"]') !== null,
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
  document.title = btoa(JSON.stringify({ phase: 'catalog-open' }))
  await new Promise<void>(resolve => window.addEventListener('responsive-catalog-dismissed', () => resolve(), { once: true }))
  const catalogClosed = shadow.querySelector('[role="dialog"]') === null
  host.style.width = '360px'
  await settle()
  document.title = btoa(JSON.stringify({ phase: 'navigation-ready' }))
  await new Promise<void>(resolve => window.addEventListener('responsive-navigation-opened', () => resolve(), { once: true }))
  await settle()
  document.title = btoa(
    JSON.stringify({
      phase: 'complete',
      steps,
      catalogWidth,
      catalogClosed,
      navigationVisible: Array.from(shadow.querySelectorAll('[role="dialog"]')).some(dialog => dialog.textContent?.includes('Cases')),
    }),
  )
}
void run().catch((error) => {
  document.title = btoa(JSON.stringify({ error: String(error) }))
})
