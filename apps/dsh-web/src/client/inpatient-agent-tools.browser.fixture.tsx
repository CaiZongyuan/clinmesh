import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { Button } from '@clinmesh/ui/components/button'
import { AgentPageRegistryProvider, useAgentPageRegistration } from '../../../web/src/app/agent-page-context.tsx'
import { AgentReviewProvider, isAgentReviewTask } from '../../../web/src/app/agent-review.tsx'
import { InpatientWorkspace } from '../../../web/src/app/inpatient-workspace.tsx'
import { getSession } from '../../../web/src/app/api-client.ts'
import type { SessionContext } from '@clinmesh/contracts/his'

const host = document.createElement('div')
host.style.cssText = 'width:944px;height:720px'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const container = document.createElement('main')
container.className = 'clinmesh-web-root'
container.dataset.clinmeshApp = 'web'
container.style.height = '100%'
shadow.append(container)

function Controls() {
  const registration = useAgentPageRegistration()
  const controller = React.useRef(new AbortController())
  const [result, setResult] = React.useState('尚未准备')
  const prepare = async (operation: string, input: unknown = {}) => {
    const action = registration?.actions[operation]
    if (!action) { setResult('工具未发布'); return }
    try { await action.execute(input, controller.current.signal); setResult('准备完成') }
    catch (error) { setResult(error instanceof Error ? error.message : '准备失败') }
  }
  return <div className="flex flex-wrap gap-2">
    <Button onClick={async () => {
      controller.current = new AbortController()
      const action = registration?.actions['inpatient.order.verify.propose']
      if (!action) { setResult('工具未发布'); return }
      const task = await action.execute({ orderId: document.documentElement.dataset.orderId, expectedOrderVersion: 1 }, controller.current.signal)
      if (isAgentReviewTask(task)) {
        task.bindDecisionGate(async () => {})
        void task.decision.then(value => setResult(value.approved ? '人工已确认' : '人工未采用'), error => setResult(error.message))
      }
    }}>助手准备校对</Button>
    <Button onClick={() => controller.current.abort()}>中止助手</Button>
    <Button onClick={() => prepare('inpatient.payment.draft.set', { tenders: [{ method: 'cash', amountFen: 5000 }] })}>助手填写补交</Button>
    <Button onClick={() => prepare('inpatient.payment.preview')}>助手预览收款</Button>
    <Button onClick={() => prepare('inpatient.settlement.preview')}>助手预览结算</Button>
    <Button onClick={() => prepare('inpatient.stage.select', { stage: 'investigations' })}>助手切到检查检验</Button>
    <Button onClick={() => prepare('inpatient.report.acknowledge.propose', { requestId: 'synthetic-imaging-request', expectedRequestVersion: 3,
      serviceRequestVersion: '2', taskVersion: '3', diagnosticReportId: 'synthetic-imaging-report', diagnosticReportVersion: '1' })}>助手准备已阅</Button>
    <output aria-label="助手结果">{result}</output>
  </div>
}

void getSession().then((session: SessionContext) => createRoot(container).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <PortalContainerProvider container={container}><AgentReviewProvider><AgentPageRegistryProvider>
      <Controls /><div style={{ height: '640px', display: 'flex' }}><InpatientWorkspace session={session} locale="zh-CN" /></div>
    </AgentPageRegistryProvider></AgentReviewProvider></PortalContainerProvider>
  </QueryClientProvider>,
))
