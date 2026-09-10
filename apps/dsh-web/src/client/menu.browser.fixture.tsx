import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Button } from '@clinmesh/ui/components/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@clinmesh/ui/components/dropdown-menu'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'

async function run() {
  const host = document.createElement('div')
  document.body.append(host)
  const shadow = host.attachShadow({ mode: 'open' })
  const container = document.createElement('div')
  container.style.cssText = 'padding: 80px;'
  shadow.append(container)
  let selected = false
  flushSync(() => createRoot(container).render(
    <PortalContainerProvider container={container}>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button />}>Account</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => { selected = true }}>Settings</DropdownMenuItem>
          <DropdownMenuItem>Help</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </PortalContainerProvider>,
  ))
  const trigger = shadow.querySelector('button')
  if (!trigger) throw new Error('Missing menu trigger')
  const settle = () => new Promise(resolve => setTimeout(resolve, 100))
  const cycles = []
  const closures = []
  for (let i = 0; i < 2; i++) {
    trigger.focus()
    trigger.click()
    await settle()
    const menu = shadow.querySelector('[role="menu"]')
    const anchor = trigger.getBoundingClientRect()
    const rect = menu?.getBoundingClientRect()
    const positioner = menu?.parentElement
    cycles.push({
      visible: !!positioner && getComputedStyle(positioner).opacity === '1',
      anchored: !!rect && rect.top >= anchor.bottom && rect.top - anchor.bottom < 16,
    })
    menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }))
    await settle()
    closures.push(trigger.getAttribute('aria-expanded') === 'false')
  }
  trigger.focus()
  trigger.click()
  await settle()
  const menu = shadow.querySelector('[role="menu"]')
  menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true }))
  await settle()
  const keyboardFocusedItem = shadow.activeElement?.getAttribute('role') === 'menuitem'
  const item = shadow.querySelector('[role="menuitem"]')
  if (item instanceof HTMLElement) item.click()
  await settle()
  document.title = btoa(JSON.stringify({ cycles, closures, keyboardFocusedItem, selected, closed: trigger.getAttribute('aria-expanded') === 'false' }))
}

void run().catch(error => { document.title = btoa(JSON.stringify({ error: String(error) })) })
