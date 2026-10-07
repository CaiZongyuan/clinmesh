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
rootElement.lang = 'en-US'
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
let setDarkTheme: () => void
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
function Fixture(): React.JSX.Element {
  const [dark, setDark] = React.useState(false)
  setDarkTheme = () => setDark(true)
  return <WebRuntimeProvider value={{ mode: 'surface', surfaceColorScheme: dark ? 'dark' : 'light', appearanceRoot: { current: rootElement } }}>
    <PortalContainerProvider container={{ current: rootElement }}>
      <AgentActionFeedbackProvider><div data-clinmesh-workspace-panel="" style={{ width: 360, height: 640 }}>
        <AgentReviewProvider><Harness /></AgentReviewProvider>
      </div></AgentActionFeedbackProvider>
    </PortalContainerProvider>
  </WebRuntimeProvider>
}
flushSync(() => createRoot(rootElement).render(<Fixture />))

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
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const lightCanvas = rootElement.querySelector('canvas')
  flushSync(() => setDarkTheme())
  const darkThemeUpdated = lightCanvas === null || !lightCanvas.isConnected && rootElement.querySelector('canvas') !== null
  const panel = rootElement.querySelector<HTMLElement>('[data-clinmesh-workspace-panel]')!
  panel.style.width = '320px'
  panel.style.height = '500px'
  await wait(150)
  const canvas = rootElement.querySelector('canvas')
  const gl = canvas?.getContext('webgl2')
  let frames = 0
  if (gl) {
    const draw = gl.drawArrays.bind(gl)
    gl.drawArrays = (...args) => { frames += 1; draw(...args) }
  }
  await wait(250)
  const canvasRunning = reduced
    ? canvas === null && rootElement.querySelector('.clinmesh-agent-workspace-glow[data-static]') !== null
    : rootElement.querySelector('.clinmesh-agent-workspace-glow[data-fallback]') !== null ? canvas === null
    : canvas !== null && frames > 1
  const canvasResized = canvas === null || Math.abs(canvas.width / devicePixelRatio - 320) < 1
    && Math.abs(canvas.height / devicePixelRatio - 500) < 1
  const panelRect = rootElement.querySelector('[data-clinmesh-workspace-panel]')!.getBoundingClientRect()
  const ambientRect = rootElement.querySelector('.clinmesh-agent-workspace-glow')!.getBoundingClientRect()
  const ambientAligned = ['left', 'top', 'width', 'height'].every(key => Math.abs(
    panelRect[key as keyof DOMRect] as number - (ambientRect[key as keyof DOMRect] as number)) < 1)
  flushSync(() => feedback({ id: 'fill', operationId: 'registration.patient.draft.set', input: {}, phase: 'completed' }))
  const completedFrames = frames
  await wait(150)
  const canvasStopped = frames === completedFrames
  await wait(1200)
  const ambientHeld = rootElement.querySelector('.clinmesh-agent-workspace-glow[data-visible]') !== null
    && Number(getComputedStyle(rootElement.querySelector('.clinmesh-agent-workspace-glow')!).opacity) >= 0.99
  const retainedCanvas = reduced || canvas === null || canvas.isConnected
  panel.style.width = '360px'
  panel.style.height = '640px'
  const held = Number(getComputedStyle(rootElement.querySelector('.clinmesh-agent-target')!).opacity) >= 0.8
  const fadeDeadline = Date.now() + 3_000
  while (rootElement.querySelector('.clinmesh-agent-target') !== null && Date.now() < fadeDeadline) {
    await wait(50)
  }
  const faded = rootElement.querySelector('.clinmesh-agent-target') === null
  const disposeDeadline = Date.now() + 1500
  while (rootElement.querySelector('canvas') !== null && Date.now() < disposeDeadline) await wait(50)
  const canvasDisposed = rootElement.querySelector('canvas') === null
  // The actual fast-action pattern: React may never paint the executing phase.
  flushSync(() => {
    feedback({ id: 'fast', operationId: 'registration.patient.draft.set', input: {}, phase: 'executing' })
    feedback({ id: 'fast', operationId: 'registration.patient.draft.set', input: {}, phase: 'completed' })
  })
  const fastGlow = rootElement.querySelector<HTMLElement>('.clinmesh-agent-workspace-glow')!
  const fastCanvas = fastGlow.querySelector('canvas')
  const fastCompleted = fastGlow.hasAttribute('data-visible') && !fastGlow.hasAttribute('data-active')
    && rootElement.querySelector('[role="status"]')?.textContent?.includes('Draft updated') === true
  const fastCanvasSized = fastCanvas === null ? reduced || fastGlow.hasAttribute('data-fallback')
    : Math.abs(fastCanvas.width / devicePixelRatio - panel.getBoundingClientRect().width) < 1
      && Math.abs(fastCanvas.height / devicePixelRatio - panel.getBoundingClientRect().height) < 1
  panel.style.width = '300px'
  panel.style.height = '480px'
  await wait(200)
  const fastCanvasResized = fastCanvas === null || Math.abs(fastCanvas.width / devicePixelRatio - 300) < 1
    && Math.abs(fastCanvas.height / devicePixelRatio - 480) < 1
  const fastGl = fastCanvas?.getContext('webgl2')
  let fastDraws = 0
  if (fastGl) {
    const draw = fastGl.drawArrays.bind(fastGl)
    fastGl.drawArrays = (...args) => { fastDraws += 1; draw(...args) }
  }
  await wait(1000)
  const fastHeld = fastGlow.hasAttribute('data-visible') && Number(getComputedStyle(fastGlow).opacity) >= 0.99
  const fastStatic = fastDraws === 0
  const fastDeadline = Date.now() + 3000
  while (fastGlow.hasAttribute('data-visible') || fastCanvas?.isConnected || rootElement.querySelector('.clinmesh-agent-target') !== null) {
    if (Date.now() >= fastDeadline) throw new Error('Fast operation feedback did not finish fading')
    await wait(50)
  }
  let task: AgentReviewTask | undefined
  let finishCommand: () => void = () => undefined
  const command = new Promise<void>(resolve => { finishCommand = resolve })
  const proposal = { id: 'review', operationId: 'registration.patient.create.propose', input: {} }
  flushSync(() => feedback({ ...proposal, phase: 'executing' }))
  const staticPreparing = rootElement.querySelector('canvas, .clinmesh-agent-target, .clinmesh-agent-workspace-glow[data-visible]') === null
    && rootElement.querySelector('[role="status"]')?.textContent === '1 in progress'
  flushSync(() => {
    task = review.request({
      title: 'Review synthetic patient', description: 'Synthetic data only', confirmLabel: 'Approve',
      signal: new AbortController().signal, onConfirm: async () => {
        flushSync(() => feedback({ ...proposal, phase: 'submitting' }))
        await command
        committed = true
        return { created: true }
      },
    })
    feedback({ ...proposal, phase: 'awaiting-review' })
  })
  if (task === undefined) throw new Error('Review task missing')
  task.bindDecisionGate(async () => undefined)
  await wait(950)
  const dialog = rootElement.querySelector('[role="alertdialog"]')
  const waiting = dialog?.textContent?.includes('待人工确认') === true && !committed
  const noReviewMotion = () => rootElement.querySelector('canvas, .clinmesh-agent-target, .clinmesh-agent-workspace-glow[data-visible]') === null
  const staticWaiting = noReviewMotion()
  const approve = [...rootElement.querySelectorAll('button')].find(button => button.textContent === 'Approve')
  approve?.click()
  await wait(100)
  const staticSubmitting = noReviewMotion() && !committed
  finishCommand()
  const result = await task.decision
  flushSync(() => feedback({ ...proposal, phase: 'completed' }))
  await wait(50)
  const staticApproved = noReviewMotion()
  let rejectedTask: AgentReviewTask | undefined
  flushSync(() => {
    feedback({ ...proposal, id: 'reject', phase: 'awaiting-review' })
    rejectedTask = review.request({
      title: 'Reject synthetic patient', description: 'Synthetic data only', confirmLabel: 'Approve',
      signal: new AbortController().signal, onConfirm: () => { throw new Error('Rejected command must not run') },
    })
  })
  if (!rejectedTask) throw new Error('Rejected task missing')
  rejectedTask.bindDecisionGate(async () => undefined)
  await wait(100)
  const cancel = [...rootElement.querySelectorAll('button')].find(button => button.textContent === '取消')
  cancel?.click()
  const rejectedResult = await rejectedTask.decision
  flushSync(() => feedback({ ...proposal, id: 'reject', phase: 'rejected' }))
  const staticRejected = !rejectedResult.approved && noReviewMotion()
  flushSync(() => showConsultation())
  flushSync(() => feedback({ id: 'ask', operationId: 'outpatient.consultation.ask', input: { message: 'New synthetic question' }, phase: 'executing' }))
  flushSync(() => receiveReply())
  const isHighlighted = (selector: string) => {
    const target = rootElement.querySelector(selector)
    if (!target) return false
    const rect = target.getBoundingClientRect()
    const bounds = rootElement.getBoundingClientRect()
    const visibleRect = new DOMRect(rect.left, rect.top,
      Math.min(rect.right, bounds.right, window.innerWidth) - rect.left,
      Math.min(rect.bottom, bounds.bottom, window.innerHeight) - rect.top)
    return [...rootElement.querySelectorAll('.clinmesh-agent-target')].some(glow => {
      const glowRect = glow.getBoundingClientRect()
      return ['left', 'top', 'width', 'height'].every(key => Math.abs(
        (visibleRect[key as keyof DOMRect] as number) - (glowRect[key as keyof DOMRect] as number),
      ) < 1)
    })
  }
  // Message layout can change after its first frame; sample the aligned result.
  const alignmentDeadline = Date.now() + 3_000
  while (!isHighlighted('[data-slot="message-scroller"]') && Date.now() < alignmentDeadline) await wait(50)
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
  const scroller = document.createElement('div')
  scroller.style.cssText = 'position:absolute;left:20px;top:80px;width:240px;height:120px;overflow:auto'
  const section = document.createElement('section')
  section.dataset.agentSection = 'diagnosis'
  section.style.height = '600px'
  scroller.append(section)
  rootElement.append(scroller)
  flushSync(() => feedback({ id: 'section', operationId: 'outpatient.section.select', input: { section: 'diagnosis' }, phase: 'completed' }))
  const sectionRect = section.getBoundingClientRect()
  const scrollRect = scroller.getBoundingClientRect()
  const sectionInset = [...rootElement.querySelectorAll('.clinmesh-agent-target')].some(glow => {
    const rect = glow.getBoundingClientRect()
    return Math.abs(rect.left - sectionRect.left - 4) < 1
      && Math.abs(rect.right - sectionRect.right + 4) < 1
      && Math.abs(rect.top - scrollRect.top - 4) < 1
      && Math.abs(rect.bottom - scrollRect.bottom + 4) < 1
  })
  document.title = btoa(JSON.stringify({ focused, highlighted, aligned, runningAnimation, canvasRunning, darkThemeUpdated, canvasResized, ambientAligned, canvasStopped, canvasDisposed,
    held, ambientHeld, retainedCanvas, fastCompleted, fastCanvasSized, fastCanvasResized, fastHeld, fastStatic,
    faded, waiting, staticPreparing, staticWaiting, staticSubmitting, staticApproved, staticRejected, committed, approved: result.approved,
    consultationRegion, consultationFormExcluded, newDoctorBubble, newPatientBubble, oldMessageUnchanged, onlyChangedRecordField, completedRecordField, sectionInset }))
}
void run().catch(error => { document.title = btoa(JSON.stringify({ error: String(error) })) })
