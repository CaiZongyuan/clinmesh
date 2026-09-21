import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { AgentActionFeedbackProvider, useAgentActionFeedback } from '../../../web/src/app/agent-action-feedback.tsx'
import { AgentReviewProvider, useAgentReview, type AgentReviewTask } from '../../../web/src/app/agent-review.tsx'
import { WebRuntimeProvider } from '../../../web/src/app/web-runtime.tsx'
import { ConsultationPage } from '../../../web/src/app/doctor/consultation-page.tsx'
import { ClinicalDocumentPage } from '../../../web/src/app/doctor/clinical-document-page.tsx'
import { getWorkspaceMessages } from '../../../web/src/app/workspace-i18n.ts'
import type { ClinicalDocumentContent, DoctorCaseDetail } from '@clinmesh/contracts/his'
import '../../../web/src/app/agent-action-feedback.css'

const rootElement = document.createElement('main')
rootElement.style.cssText = 'width:360px;height:640px;position:relative'
const host = document.createElement('div')
host.style.cssText = 'contain:strict;position:absolute;left:140px;top:90px;width:400px;height:700px'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
shadow.append(rootElement)
let feedback: ReturnType<typeof useAgentActionFeedback>
let review: ReturnType<typeof useAgentReview>
let committed = false
let showConsultation: () => void
let receiveReply: () => void
let showClinicalRecord: () => void
let updateRecord: (document: ClinicalDocumentContent) => void
const initialRecord: ClinicalDocumentContent = {
  chiefComplaint: 'Initial complaint', historyOfPresentIllness: 'Initial history',
  priorMedicalHistory: 'No prior conditions', physicalExamination: 'Examination recorded',
  auxiliaryExamination: 'No results', assessment: 'Initial assessment',
  disposition: 'Outpatient follow-up', followUp: 'Return if symptoms persist',
}
const oldTurn: NonNullable<DoctorCaseDetail['consultation']>['turns'][number] = {
  actorId: null, practitionerId: null,
  id: 'old-patient', kind: 'text', messageText: 'Old synthetic reply', personaRevision: 1,
  recordedAt: '2026-09-20T09:00:00+08:00', reportReference: null, sequence: 1,
  source: 'persona-opening', speaker: 'patient',
}
function Harness(): React.JSX.Element {
  const [recordVisible, setRecordVisible] = React.useState(false)
  const [record, setRecord] = React.useState(initialRecord)
  showClinicalRecord = () => setRecordVisible(true)
  updateRecord = setRecord
  const [consultation, setConsultation] = React.useState<'hidden' | 'waiting' | 'answered'>('hidden')
  showConsultation = () => setConsultation('waiting')
  receiveReply = () => setConsultation('answered')
  feedback = useAgentActionFeedback(recordVisible
    ? { identity: 'session:doctor', view: 'consultation', selection: 'case-1', section: 'record' }
    : consultation === 'hidden'
    ? { identity: 'session:registrar', view: 'registration', selection: '', section: '' }
    : { identity: 'session:doctor', view: 'consultation', selection: 'case-1', section: 'consultation' })
  review = useAgentReview()
  if (recordVisible) return <><div data-agent-feedback-status="" /><ClinicalDocumentPage
    actions={{
      prepareSign: { data: undefined, error: null, onReset: () => {}, onSubmit: () => {}, pending: false },
      revise: { error: null, onSubmit: () => {}, pending: false, success: false },
      sign: { error: null, onSubmit: () => {}, pending: false, success: false },
    }} allowRevision={false} detail={{
      allergies: [], caseId: 'case-1', encounter: { id: 'encounter-1', status: 'in-progress', versionId: '1' },
      patient: { id: 'patient-1', identifier: 'SYNTHETIC-1', name: 'Synthetic patient', gender: 'female', birthDate: '1990-01-01', synthetic: true, versionId: '1' },
      presentation: null, priorFacts: [], status: 'first-visit', taskId: 'task-1', taskVersion: '1',
    }} elementId="record" locale="en-US" messages={getWorkspaceMessages('en-US')}
    onDocumentChange={setRecord} workingDocument={record} /></>
  return <><div data-agent-feedback-status="" />{consultation === 'hidden'
    ? <input id="patient-name" aria-label="Patient name" defaultValue="Synthetic patient" />
    : <ConsultationPage action={{ error: null, onAsk: () => {}, onRetry: () => {}, pending: false }}
      consultation={{ version: 4, turns: consultation === 'waiting' ? [oldTurn] : [
        oldTurn,
        { ...oldTurn, id: 'new-doctor', messageText: 'New synthetic question', sequence: 2, speaker: 'doctor', source: 'doctor-typed', personaRevision: null },
        { ...oldTurn, id: 'new-patient', messageText: 'New synthetic reply', sequence: 3, source: 'patient-agent' },
      ] }} locale="en-US" messages={getWorkspaceMessages('en-US')} patientName="Synthetic patient" readOnly />}</>
}
flushSync(() => createRoot(rootElement).render(
  <WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: rootElement } }}>
    <PortalContainerProvider container={{ current: rootElement }}>
      <AgentActionFeedbackProvider><AgentReviewProvider><Harness /></AgentReviewProvider></AgentActionFeedbackProvider>
    </PortalContainerProvider>
  </WebRuntimeProvider>,
))

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function run(): Promise<void> {
  await wait(50)
  const field = rootElement.querySelector<HTMLInputElement>('#patient-name')!
  field.focus()
  flushSync(() => feedback({ id: 'fill', operationId: 'registration.patient.draft.set', input: {}, phase: 'executing' }))
  const focused = shadow.activeElement === field
  const highlighted = rootElement.querySelectorAll('.clinmesh-agent-target').length > 0
  const targetRect = field.getBoundingClientRect()
  const glowRect = rootElement.querySelector('.clinmesh-agent-target')!.getBoundingClientRect()
  const aligned = ['left', 'top', 'width', 'height'].every(key => Math.abs(targetRect[key as keyof DOMRect] as number - (glowRect[key as keyof DOMRect] as number)) < 1)
  const runningAnimation = getComputedStyle(rootElement.querySelector('.clinmesh-agent-target')!).animationName
  flushSync(() => feedback({ id: 'fill', operationId: 'registration.patient.draft.set', input: {}, phase: 'completed' }))
  await wait(1200)
  const held = Number(getComputedStyle(rootElement.querySelector('.clinmesh-agent-target')!).opacity) >= 0.8
  await wait(1100)
  const faded = rootElement.querySelector('.clinmesh-agent-target') === null
  let task: AgentReviewTask | undefined
  flushSync(() => {
    task = review.request({
      title: 'Review synthetic patient', description: 'Synthetic data only', confirmLabel: 'Approve',
      signal: new AbortController().signal, onConfirm: () => { committed = true; return { created: true } },
    })
  })
  if (task === undefined) throw new Error('Review task missing')
  task.bindDecisionGate(async () => undefined)
  await wait(950)
  const dialog = rootElement.querySelector('[role="alertdialog"]')
  const waiting = dialog?.textContent?.includes('待人工确认') === true && !committed
  const staticWaiting = rootElement.querySelector('[data-agent-review] [data-phase="awaiting-review"]') !== null
  const approve = [...rootElement.querySelectorAll('button')].find(button => button.textContent === 'Approve')
  approve?.click()
  const result = await task.decision
  await wait(50)
  flushSync(() => showConsultation())
  flushSync(() => feedback({ id: 'ask', operationId: 'outpatient.consultation.ask', input: { message: 'New synthetic question' }, phase: 'executing' }))
  flushSync(() => receiveReply())
  await wait(150)
  const isHighlighted = (selector: string) => {
    const target = rootElement.querySelector(selector)
    if (!target) return false
    const rect = target.getBoundingClientRect()
    const visibleRect = new DOMRect(rect.left, rect.top,
      Math.min(rect.right, window.innerWidth) - rect.left,
      Math.min(rect.bottom, window.innerHeight) - rect.top)
    return [...rootElement.querySelectorAll('.clinmesh-agent-target')].some(glow => {
      const glowRect = glow.getBoundingClientRect()
      return ['left', 'top', 'width', 'height'].every(key => Math.abs(
        (visibleRect[key as keyof DOMRect] as number) - (glowRect[key as keyof DOMRect] as number),
      ) < 1)
    })
  }
  const consultationRegion = isHighlighted('[data-slot="message-scroller"]')
  const consultationFormExcluded = !isHighlighted('[aria-labelledby="consultation-record-heading"]')
  const newDoctorBubble = isHighlighted('[data-agent-consultation-message="new-doctor"]')
  const newPatientBubble = isHighlighted('[data-agent-consultation-message="new-patient"]')
  const oldMessageUnchanged = !isHighlighted('[data-agent-consultation-message="old-patient"]')
  flushSync(() => showClinicalRecord())
  const changedRecord = { ...initialRecord, chiefComplaint: 'Updated complaint' }
  flushSync(() => feedback({ id: 'record', operationId: 'outpatient.record.draft.set', input: changedRecord, phase: 'executing' }))
  const onlyChangedRecordField = isHighlighted('#clinical-record-case-1-chiefComplaint')
    && !isHighlighted('#clinical-record-case-1-historyOfPresentIllness')
    && rootElement.querySelectorAll('.clinmesh-agent-target').length === 1
  flushSync(() => updateRecord(changedRecord))
  flushSync(() => feedback({ id: 'record', operationId: 'outpatient.record.draft.set', input: changedRecord, phase: 'completed' }))
  const completedRecordField = isHighlighted('#clinical-record-case-1-chiefComplaint')
    && rootElement.querySelectorAll('.clinmesh-agent-target').length === 1
  document.title = btoa(JSON.stringify({ focused, highlighted, aligned, runningAnimation, held, faded, waiting, staticWaiting, committed, approved: result.approved,
    consultationRegion, consultationFormExcluded, newDoctorBubble, newPatientBubble, oldMessageUnchanged, onlyChangedRecordField, completedRecordField }))
}
void run().catch(error => { document.title = btoa(JSON.stringify({ error: String(error) })) })
