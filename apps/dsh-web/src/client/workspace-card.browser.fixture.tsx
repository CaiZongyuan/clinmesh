import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { Button } from '@clinmesh/ui/components/button'
import { AgentReviewAnchor, AgentReviewOutlet, AgentReviewProvider, useAgentReview } from '../../../web/src/app/agent-review.tsx'
import { AgentDraftField, WorkspaceActionBar, WorkspaceCard, WorkspaceCardLayout, WorkspaceHeaderPatient, WorkspacePatientCard, WorkspaceQueueCard, WorkspaceTabs } from '../../../web/src/app/workspace-card-layout.tsx'
import { WorkspaceShell } from '../../../web/src/app/workspace-shell.tsx'
import { WebRuntimeProvider } from '../../../web/src/app/web-runtime.tsx'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Input } from '@clinmesh/ui/components/input'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'

declare global { interface Window { workspaceCardMode?: 'review' | 'layout' | 'shell' | 'surface' } }

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
  const [gateLog, setGateLog] = React.useState('No decisions')
  const prepare = (checked = false, anchored = false, denied = false) => {
    signal.current = new AbortController()
    setGateLog('No decisions')
    const events: string[] = []
    const task = review.request({
      title: 'Prepare verification', description: 'Verify this synthetic order before submitting.',
      confirmLabel: 'Confirm verification', ...(checked ? { confirmationLabel: 'I checked the order' } : {}),
      ...(anchored ? { anchor: 'order-row' } : {}),
      signal: signal.current.signal, onConfirm: () => { events.push('command'); return 'saved' },
    })
    task.bindDecisionGate(async decision => {
      if (denied) throw new Error('The page context expired')
      setGateLog(decision)
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
    <output aria-label="Decision log">{gateLog}</output>
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
      queue={<section aria-label="Patient queue"><WorkspaceQueueCard title="Patients"><div data-workspace-queue-items="">
        <Button variant="outline">Queue patient one</Button><Button variant="outline">Queue patient two</Button>
      </div></WorkspaceQueueCard></section>}
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

function ShellFixture() {
  const [role, setRole] = React.useState('doctor-role')
  const [fullscreen, setFullscreen] = React.useState(false)
  const [conversation, setConversation] = React.useState(false)
  const availableRoles: SessionContext['availableRoles'] = [
    { id: 'doctor-role', code: 'outpatient-doctor', practitionerId: 'doctor', practitionerName: '门诊医生', organizationId: 'hospital', locationId: 'clinic' },
    { id: 'nurse-role', code: 'ward-nurse', practitionerId: 'nurse', practitionerName: '病区护士', organizationId: 'hospital', locationId: 'ward' },
    { id: 'admin-role', code: 'administrator', practitionerId: 'admin', practitionerName: '管理员', organizationId: 'hospital', locationId: 'office' },
  ]
  const session: SessionContext = {
    actor: { actorId: 'synthetic-actor', epoch: 'synthetic-epoch', locationId: 'clinic', organizationId: 'hospital',
      practitionerId: 'doctor', practitionerRoleId: role, roleCode: 'outpatient-doctor', scenarioRunId: 'synthetic-run', workspaceId: 'synthetic-workspace' },
    availableRoles, user: { id: 'synthetic-user', name: '合成用户', email: 'synthetic@example.test' },
  }
  return <WebRuntimeProvider value={{ mode: window.workspaceCardMode === 'surface' ? 'surface' : 'standalone', appearanceRoot: { current: root },
    surfaceAgentStatus: window.workspaceCardMode === 'surface' ? 'active' : 'unavailable',
    ...(window.workspaceCardMode === 'surface' ? { surfaceDisplay: { fullscreen, toggle: () => setFullscreen(!fullscreen),
      conversation: { collapsed: conversation, toggle: () => setConversation(!conversation) } } } : {}) }}>
    <AgentReviewProvider locale="en-US"><WorkspaceShell activeSection="consultation" locale="en-US" session={session} theme="light" onLocaleChange={() => {}}
      onRoleChange={setRole} onSignOut={() => {}} onThemeChange={() => {}} roleChangePending={false} signOutPending={false}>
      <WorkspaceHeaderPatient>Synthetic current patient</WorkspaceHeaderPatient>
      <p>Current synthetic clinical work</p><output aria-label="Chosen role">{role}</output>
      <output aria-label="Conversation collapsed">{String(conversation)}</output>
      <ShellReviewControl />
    </WorkspaceShell></AgentReviewProvider>
  </WebRuntimeProvider>
}

function ShellReviewControl() {
  const review = useAgentReview()
  const [result, setResult] = React.useState('No shell command')
  return <><Button onClick={() => {
    const task = review.request({ title: 'Review shell order', description: 'Synthetic shell action', confirmLabel: 'Confirm shell order',
      signal: new AbortController().signal, onConfirm: () => 'submitted' })
    task.bindDecisionGate(async () => {})
    void task.decision.then(value => setResult(value.approved ? 'Shell command submitted' : 'Shell command rejected'), error => setResult(error.message))
  }}>Prepare shell order</Button><output aria-label="Shell review result">{result}</output></>
}

const shellRoute = createRootRoute({ component: ShellFixture })
const shellRouter = createRouter({ routeTree: shellRoute, history: createMemoryHistory({ initialEntries: ['/'] }) })

function Fixture() {
  const [result, setResult] = React.useState('No command submitted')
  const [mounted, setMounted] = React.useState(true)
  if (window.workspaceCardMode === 'layout') return <LayoutFixture />
  if (window.workspaceCardMode === 'shell' || window.workspaceCardMode === 'surface') return <PortalContainerProvider container={{ current: root }}><RouterProvider router={shellRouter} /></PortalContainerProvider>
  return <PortalContainerProvider container={{ current: root }}>
    <Button onClick={() => setMounted(false)}>Unmount workspace</Button>
    {mounted ? <AgentReviewProvider locale="en-US"><Harness onResult={setResult} /></AgentReviewProvider> : null}
    <output aria-label="Review result">{result}</output>
  </PortalContainerProvider>
}

createRoot(root).render(<Fixture />)
