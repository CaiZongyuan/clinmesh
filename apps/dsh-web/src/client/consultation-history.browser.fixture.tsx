import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { ClinicalDocumentPage } from '../../../web/src/app/doctor/clinical-document-page.tsx'
import { getWorkspaceMessages } from '../../../web/src/app/workspace-i18n.ts'
import type { ClinicalDocumentContent, DoctorCaseDetail } from '@clinmesh/contracts/his'

const documentContent: ClinicalDocumentContent = {
  chiefComplaint: '', historyOfPresentIllness: '医生核对：头晕五天。', assessment: '',
  physicalExamination: '', disposition: '', followUp: '',
}
const detail: DoctorCaseDetail = {
  allergies: [], caseId: 'synthetic-case', encounter: { id: 'synthetic-encounter', status: 'in-progress', versionId: '1' },
  patient: { id: 'synthetic-patient', identifier: 'SYNTHETIC', name: '合成患者', gender: 'female', birthDate: '1990-01-01', synthetic: true, versionId: '1' },
  presentation: null, priorFacts: [], status: 'first-visit', taskId: 'synthetic-task', taskVersion: '1',
  clinicalDocument: { draft: { ...documentContent, version: 1, updatedAt: '2026-10-08T09:00:00+08:00' }, signed: [] },
  consultation: { version: 1, turns: [{ id: 'synthetic-reply', actorId: null, practitionerId: null, speaker: 'patient',
    source: 'patient-agent', kind: 'text', messageText: '刚才说错了，头晕是六天。', sequence: 1,
    recordedAt: '2026-10-08T09:00:00+08:00', personaRevision: 1, reportReference: null }] },
  consultationRecording: { hasSavedDraft: true, version: 1, paused: false, processedCount: 1, remainingCount: 0, failedCount: 0,
    status: 'pending',
    failures: [{ sourceTurnId: 'synthetic-reply', code: 'AI_TIMEOUT', retrying: false }],
    additions: [{ id: 'synthetic-correction', field: 'historyOfPresentIllness',
    sourceTurnId: 'synthetic-reply', quote: '刚才说错了，头晕是六天。', relation: 'correction', targetAdditionId: 'synthetic-original',
    status: 'pending', ownership: 'manual', currentText: '医生核对：头晕五天。', reviewable: true }] },
}
const host = document.createElement('div')
host.style.cssText = 'position:absolute;left:20px;top:20px;width:340px;height:820px;contain:strict;overflow:auto'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('div')
root.className = 'clinmesh-web-root'
shadow.append(root)

function App(): React.JSX.Element {
  const [working, setWorking] = React.useState({ ...documentContent, historyOfPresentIllness: '医生尚未保存的编辑。' })
  const [decisions, setDecisions] = React.useState<string[]>([])
  const [recording, setRecording] = React.useState(detail.consultationRecording!)
  const [controls, setControls] = React.useState<string[]>([])
  return <>
    <button type="button" onClick={() => setWorking(documentContent)}>模拟保存编辑</button>
    <output aria-label="核对结果">{decisions.join(',')}</output>
    <button type="button" onClick={() => setRecording(current => ({ ...current, status: 'backfill', version: 0, remainingCount: 2 }))}>模拟历史病例</button>
    <button type="button" onClick={() => setRecording(current => ({ ...current, status: 'failed', failedCount: 1 }))}>模拟整理失败</button>
    <output aria-label="控制结果">{controls.join(',')}</output>
    <ClinicalDocumentPage allowRevision={false} detail={{ ...detail, consultationRecording: recording }} elementId="record" locale="zh-CN"
      messages={getWorkspaceMessages('zh-CN')} workingDocument={working} onDocumentChange={setWorking}
      actions={{
        prepareSign: { data: undefined, error: null, onReset: () => {}, onSubmit: () => {}, pending: false },
        revise: { error: null, onSubmit: () => {}, pending: false, success: false },
        sign: { error: null, onSubmit: () => {}, pending: false, success: false },
        reviewHistory: { error: null, pending: false, onSubmit: (id, decision) => setDecisions(current => [...current, `${id}:${decision}`]) },
        controlRecording: { error: null, pending: false, onSubmit: action => {
          setControls(current => [...current, action])
          setRecording(current => ({ ...current, version: current.version + 1, paused: action === 'pause',
            status: action === 'pause' ? 'paused' : 'processing', failedCount: 0 }))
        } },
      }} />
  </>
}
createRoot(root).render(<App />)
