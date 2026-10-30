import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { Button } from '@clinmesh/ui/components/button'
import { AgentReviewAnchor, AgentReviewOutlet, AgentReviewProvider, useAgentReview } from '../../../web/src/app/agent-review.tsx'
import { AgentDraftField, WorkspaceActionBar, WorkspaceCard, WorkspaceCardLayout, WorkspacePatientCard, WorkspaceQueueCard, WorkspaceTabs } from '../../../web/src/app/workspace-card-layout.tsx'
import { Input } from '@clinmesh/ui/components/input'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'

declare global { interface Window { workspaceCardMode?: boolean } }

const host = document.createElement('div')
host.style.cssText = 'width:944px;height:720px'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('main')
root.className = 'clinmesh-web-root'
root.dataset.clinmeshApp = 'web'
root.lang = 'en-US'
root.style.height = '100%'
shadow.append(root)

function Harness({ onResult }: { onResult(value: string): void }) {
  const review = useAgentReview()
  const signal = React.useRef(new AbortController())
  const [row, setRow] = React.useState(true)
  const [outlet, setOutlet] = React.useState(true)
  const prepare = (checked = false, anchored = false, denied = false) => {
    signal.current = new AbortController()
    const events: string[] = []
    const task = review.request({
      title: 'Prepare verification', description: 'Verify this synthetic order before submitting.',
      confirmLabel: 'Confirm verification', ...(checked ? { confirmationLabel: 'I checked the order' } : {}),
      ...(anchored ? { anchor: 'order-row' } : {}),
      signal: signal.current.signal, onConfirm: () => { events.push('command'); return 'saved' },
    })
    task.bindDecisionGate(async decision => {
      if (denied) throw new Error('The page context expired')
      events.push(decision)
    })
    void task.decision.then(value => onResult(`${value.approved ? 'approved' : 'rejected'}: ${events.join(',')}`),
      error => onResult(error instanceof Error ? error.message : 'failed'))
  }
  return <>
    <Button onClick={() => prepare()}>Prepare order</Button>
    <Button onClick={() => prepare(true)}>Prepare checked order</Button>
    <Button onClick={() => prepare(false, true)}>Prepare row order</Button>
    <Button onClick={() => prepare(false, false, true)}>Prepare expired order</Button>
    <Button onClick={() => {
      const replacement = review.request({ title: 'Replacement verification', description: 'Second request',
        confirmLabel: 'Replace order', signal: new AbortController().signal, onConfirm: () => onResult('Wrong command') })
      void replacement.decision.catch(error => onResult(error.message))
    }}>Prepare replacement</Button>
    <Button onClick={() => signal.current.abort()}>Abort request</Button>
    <Button onClick={() => setRow(false)}>Hide order row</Button>
    <Button onClick={() => setOutlet(false)}>Hide action bar</Button>
    {row ? <article aria-label="Synthetic order"><AgentReviewAnchor id="order-row">Synthetic order details</AgentReviewAnchor></article> : null}
    {outlet ? <AgentReviewOutlet /> : null}
  </>
}

function LayoutFixture() {
  const [section, setSection] = React.useState('clinical')
  const [assisted, setAssisted] = React.useState(false)
  const [value, setValue] = React.useState('')
  return <div style={{ height: '100%' }}>
    <WorkspaceCardLayout id="layout-contract" locale="en-US" flow={[{ value: 'triage', label: 'Triage', status: 'current' }]}
      queue={<section aria-label="Patient queue"><WorkspaceQueueCard title="Patients">Synthetic queue</WorkspaceQueueCard></section>}
      patient={<WorkspacePatientCard title="Patient summary">Synthetic patient</WorkspacePatientCard>}
      tabs={<WorkspaceTabs id="layout-sections" locale="en-US" value={section} onValueChange={setSection} items={[
        { value: 'admission', label: 'Admission details', group: 'Admission', status: 'completed', count: 0 },
        { value: 'clinical', label: 'Clinical orders', group: 'Inpatient', status: 'current', count: 3 },
        { value: 'investigations', label: 'Investigations and reports', group: 'Inpatient', count: 2 },
        { value: 'surgery', label: 'Surgery preparation', group: 'Inpatient', count: 1 },
        { value: 'discharge', label: 'Discharge notes', group: 'Discharge' },
        { value: 'records', label: 'Medical records', group: 'Records', more: true },
      ]} />}
      aside={<aside aria-label="Read-only results"><WorkspaceCard title="Results">Synthetic results</WorkspaceCard></aside>}
      action={<WorkspaceActionBar summary="1 synthetic order" reason="Ready to review" action={<Button>Review order</Button>} />}>
      <section aria-label="Current work" className="flex flex-col gap-3">
        <output aria-label="Active section">{section}</output>
        <Button onClick={() => root.querySelector<HTMLButtonElement>('#layout-sections-records')!.click()}>Open records section</Button>
        <Button onClick={() => { setValue('Prepared value'); setAssisted(true) }}>Fill with assistant</Button>
        <AgentDraftField locale="en-US" assisted={assisted} onUserEdit={() => setAssisted(false)}>
          <Field><FieldLabel htmlFor="synthetic-order-note">Order note</FieldLabel>
            <Input id="synthetic-order-note" value={value} onChange={event => setValue(event.currentTarget.value)} /></Field>
        </AgentDraftField>
      </section>
    </WorkspaceCardLayout>
  </div>
}

function Fixture() {
  const [result, setResult] = React.useState('No command submitted')
  const [mounted, setMounted] = React.useState(true)
  if (window.workspaceCardMode) return <LayoutFixture />
  return <PortalContainerProvider container={{ current: root }}>
    <Button onClick={() => setMounted(false)}>Unmount workspace</Button>
    {mounted ? <AgentReviewProvider locale="en-US"><Harness onResult={setResult} /></AgentReviewProvider> : null}
    <output aria-label="Review result">{result}</output>
  </PortalContainerProvider>
}

createRoot(root).render(<Fixture />)
