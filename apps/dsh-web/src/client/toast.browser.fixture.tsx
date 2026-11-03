import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '@clinmesh/ui/components/button'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { Toaster, createToastManager } from '@clinmesh/ui/components/toast'

const host = document.createElement('div')
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const container = document.createElement('main')
container.className = 'clinmesh-web-root'
shadow.append(container)
const manager = createToastManager()

function Harness() {
  const [confirmed, setConfirmed] = React.useState(0)
  const [actions, setActions] = React.useState(0)
  const notify = (action: boolean) => manager.add({
    title: '本次操作已完成', description: '继续处理当前退款', timeout: 0,
    ...(action ? { actionProps: { children: '查看回执', onClick: () => setActions(value => value + 1) } } : {}),
  })
  return <PortalContainerProvider container={container}>
    <Toaster toastManager={manager}>
      <Button onClick={() => notify(false)}>显示完成通知</Button>
      <Button onClick={() => notify(true)}>显示可操作通知</Button>
      <Button onClick={() => manager.add({ title: '短完成通知', timeout: 1200 })}>显示短通知</Button>
      <Button onClick={() => manager.add({ title: '下一项任务就绪', timeout: 0 })}>显示另一条通知</Button>
      <output aria-label="确认次数">{confirmed}</output>
      <output aria-label="通知操作次数">{actions}</output>
      <Button style={{ position: 'fixed', right: 64, bottom: 16, width: 320, height: 80 }}
        onClick={() => setConfirmed(value => value + 1)}>确认本次收退</Button>
    </Toaster>
  </PortalContainerProvider>
}

createRoot(container).render(<Harness />)
