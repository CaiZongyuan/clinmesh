import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { DoctorCaseLayout, DoctorWorkspaceLayout } from '../../../web/src/app/doctor/responsive-layout.tsx'
import { ConsultationPage } from '../../../web/src/app/doctor/consultation-page.tsx'
import { getWorkspaceMessages } from '../../../web/src/app/workspace-i18n.ts'
import { AgentActionFeedbackProvider, useAgentActionFeedback } from '../../../web/src/app/agent-action-feedback.tsx'
import { WebRuntimeProvider } from '../../../web/src/app/web-runtime.tsx'

const host = document.createElement('div')
host.style.cssText = 'position:absolute;left:20px;top:20px;contain:strict'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
const style = document.createElement('style')
style.textContent = document.querySelector('style')!.textContent
const root = document.createElement('div')
root.className = 'clinmesh-web-root h-full min-h-0 overflow-hidden'
shadow.append(style, root)
let feedback: ReturnType<typeof useAgentActionFeedback>
function App() {
  feedback = useAgentActionFeedback({ identity: 'test', view: 'consultation', selection: 'case', section: 'consultation' })
  return <div className="flex h-full min-h-0 flex-col">
    <div data-agent-feedback-status="" />
    <DoctorWorkspaceLayout selectedCaseId="case" queueLabel="Queue" detailLabel="Case" queue={() => <div>Queue</div>}>
      <DoctorCaseLayout fillHeight railPlacement="host" contextLabel="Context" rail={() => null}>
        <div className="flex min-h-0 flex-1 flex-col">
          <div style={{ height: 160, flexShrink: 0 }}>Synthetic patient banner and tabs</div>
          <div data-agent-section="consultation" className="flex min-h-0 flex-1 flex-col p-4">
            <ConsultationPage action={{ error: null, pending: false, onAsk: () => {}, onRetry: () => {} }}
              consultation={{ version: 1, turns: [] }} locale="en-US" messages={getWorkspaceMessages('en-US')}
              patientName="Synthetic patient" readOnly={false} />
          </div>
        </div>
      </DoctorCaseLayout>
    </DoctorWorkspaceLayout>
  </div>
}
flushSync(() => createRoot(root).render(<WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: root } }}>
  <AgentActionFeedbackProvider><App /></AgentActionFeedbackProvider>
</WebRuntimeProvider>))

async function run() {
  const steps = []
  for (const [width, height] of [[1000, 700], [600, 700], [360, 520]]) {
    host.style.width = `${width}px`
    host.style.height = `${height}px`
    await new Promise(resolve => setTimeout(resolve, 200))
    const textarea = root.querySelector('textarea')!
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, `Question at ${width}px`)
      textarea.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    })
    flushSync(() => feedback({ id: 'section', operationId: 'outpatient.section.select', input: { section: 'consultation' }, phase: 'completed' }))
    await new Promise(resolve => setTimeout(resolve, 150))
    const composer = root.querySelector('[data-slot="input-group"]')!
    const button = composer.querySelector('button')!
    const buttonRect = button.getBoundingClientRect()
    const composerRect = composer.getBoundingClientRect()
    const glow = root.querySelector('.clinmesh-agent-target')!.getBoundingClientRect()
    steps.push({
      width, height,
      composerVisible: composerRect.bottom <= host.getBoundingClientRect().bottom - 4,
      buttonInside: buttonRect.bottom < composerRect.bottom && buttonRect.right < composerRect.right,
      glowOutside: glow.bottom > buttonRect.bottom && glow.right > buttonRect.right,
      buttonHit: shadow.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2)?.closest('button') === button,
      historyHeight: root.querySelector('[data-agent-consultation]')!.getBoundingClientRect().height,
    })
  }
  document.title = btoa(JSON.stringify(steps))
}
void run().catch(error => { document.title = btoa(JSON.stringify({ error: String(error) })) })
