import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { AgentReviewProvider, isAgentReviewTask } from '../../../web/src/app/agent-review.tsx'
import { AgentPageRegistryProvider, useAgentPageRegistration } from '../../../web/src/app/agent-page-context.tsx'
import { RegistrarWorkspace } from '../../../web/src/app/registrar-workspace.tsx'
import { BillingWorkspace } from '../../../web/src/app/billing-workspace.tsx'
import { PharmacyWorkspace } from '../../../web/src/app/pharmacy-workspace.tsx'
import { WebRuntimeProvider } from '../../../web/src/app/web-runtime.tsx'
import { getSession } from '../../../web/src/app/api-client.ts'
import { AgentDraftProbe } from './agent-draft-probe.browser.fixture.tsx'

declare global { interface Window { nonDoctorInputs?: Record<string, unknown> } }

const host = document.createElement('div')
host.style.cssText = 'height:900px;width:944px'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('main')
root.className = 'clinmesh-web-root'
root.dataset.clinmeshApp = 'web'
root.lang = 'zh-CN'
root.style.cssText = 'display:flex;flex-direction:column;height:100%;min-width:0'
shadow.append(root)

function ActionProbe() {
  const registration = useAgentPageRegistration()
  const [delayed, setDelayed] = React.useState(false)
  const [waiting, setWaiting] = React.useState(false)
  const [decision, setDecision] = React.useState('尚未确认')
  const gate = React.useRef<(() => void) | null>(null)
  const operations = [
    ['registration.patient.create.propose', '助手准备建档'], ['registration.outpatient.propose', '助手准备挂号'],
    ['registration.synthetic-case.start.propose', '助手准备病例挂号'], ['billing.payment.confirm.propose', '助手准备收款'],
    ['pharmacy.review.propose', '助手准备处方审核'], ['pharmacy.dispense.propose', '助手准备发药'],
  ] as const
  return <div className="flex shrink-0 flex-wrap items-center gap-2 p-2">
    {operations.filter(([id]) => registration?.actions[id] !== undefined).map(([id, label]) => <button key={id}
      disabled={!registration || registration.actions[id]?.enabled === false} onClick={async () => {
        try {
          const task = await registration?.actions[id]?.execute({}, new AbortController().signal)
          if (!isAgentReviewTask(task)) throw new Error('没有可审阅的操作')
          task.bindDecisionGate(async () => {
            if (delayed) { setWaiting(true); await new Promise<void>(resolve => { gate.current = resolve }); setWaiting(false) }
          })
          void task.decision.then(result => setDecision(result.approved ? '已确认' : '未采用'), error => setDecision(error.message))
        } catch (error) { setDecision(error instanceof Error ? error.message : '操作失败') }
      }}>{label}</button>)}
    {Object.entries(window.nonDoctorInputs ?? {}).map(([operation, input]) => <AgentDraftProbe key={operation} operation={operation} input={input} label={`助手填写 ${operation}`} />)}
    <label><input type="checkbox" checked={delayed} onChange={event => setDelayed(event.currentTarget.checked)} />延迟批准</label>
    <button disabled={!waiting} onClick={() => { gate.current?.(); gate.current = null }}>放行确认</button>
    <output aria-label="批准状态">{waiting ? '等待批准闸门' : decision}</output>
  </div>
}

void getSession().then(session => {
  const workspace = session.actor.roleCode === 'registrar' ? <RegistrarWorkspace locale="zh-CN" session={session} />
    : session.actor.roleCode === 'cashier' ? <BillingWorkspace locale="zh-CN" session={session} /> : <PharmacyWorkspace locale="zh-CN" session={session} />
  createRoot(root).render(<WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: root } }}>
    <PortalContainerProvider container={{ current: root }}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AgentPageRegistryProvider><AgentReviewProvider locale="zh-CN"><ActionProbe />
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">{workspace}</div>
      </AgentReviewProvider></AgentPageRegistryProvider>
    </QueryClientProvider></PortalContainerProvider>
  </WebRuntimeProvider>)
})
