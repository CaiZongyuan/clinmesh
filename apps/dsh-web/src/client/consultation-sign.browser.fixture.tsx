import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import type { ClinicalDocumentContent, DoctorCaseDetail } from '@clinmesh/contracts/his'
import { ClinicalDocumentPage, type ClinicalDocumentSignPreview } from '../../../web/src/app/doctor/clinical-document-page.tsx'
import { ConsultationSignReviewNotice } from '../../../web/src/app/doctor/consultation-sign-review.tsx'
import { AgentReviewProvider, useAgentReview } from '../../../web/src/app/agent-review.tsx'
import { getWorkspaceMessages } from '../../../web/src/app/workspace-i18n.ts'

const messages = getWorkspaceMessages('zh-CN')
const content: ClinicalDocumentContent = { chiefComplaint: '头晕一周。', historyOfPresentIllness: '医生核对病史。\n'.repeat(60),
  priorMedicalHistory: '既往高血压。', physicalExamination: '查体正常。', auxiliaryExamination: '暂无检查。',
  assessment: '进一步评估。', disposition: '门诊随访。', followUp: '加重及时就诊。' }
const review = { consultationVersion: 3, remainingCount: 2, failedCount: 1, paused: true, conflictCount: 1, unreviewedCount: 2 }
const detail: DoctorCaseDetail = {
  allergies: [], caseId: 'synthetic-sign-case', encounter: { id: 'synthetic-encounter', status: 'in-progress', versionId: '1' },
  patient: { id: 'synthetic-patient', identifier: 'SYNTHETIC', name: '合成患者', gender: 'female', birthDate: '1990-01-01', synthetic: true, versionId: '1' },
  presentation: null, priorFacts: [], status: 'first-visit', taskId: 'synthetic-task', taskVersion: '1',
  clinicalDocument: { draft: { ...content, version: 1, updatedAt: '2026-10-10T09:00:00+08:00' }, signed: [] },
  consultationRecording: { hasSavedDraft: true, version: 1, paused: true, processedCount: 1, remainingCount: 2, failedCount: 1,
    status: 'paused', failures: [], additions: [] },
}
const host = document.createElement('div')
host.style.cssText = 'position:absolute;left:20px;top:20px;width:340px;height:calc(100vh - 40px);contain:strict;overflow:hidden'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('div')
root.className = 'clinmesh-web-root h-full'
shadow.append(root)

function App(): React.JSX.Element {
  const [preview, setPreview] = React.useState<ClinicalDocumentSignPreview>()
  const [serial, setSerial] = React.useState(0)
  const [result, setResult] = React.useState('')
  const [failCancel, setFailCancel] = React.useState(false)
  const [cancelError, setCancelError] = React.useState<Error | null>(null)
  const [recovery, setRecovery] = React.useState(false)
  const agentReview = useAgentReview()
  const cancel = () => {
    if (failCancel) { setFailCancel(false); setCancelError(new Error('合成取消失败，请重试。')); return }
    setCancelError(null); setPreview(undefined); setRecovery(false); setResult('cancelled')
  }
  return <div className="h-full overflow-y-auto">
    <button onClick={() => setFailCancel(true)}>模拟取消失败</button>
    <button onClick={() => setRecovery(true)}>模拟重连恢复</button>
    <button onClick={() => {
      const task = agentReview.request({ signal: new AbortController().signal, title: messages.confirmClinicalRecordSign,
        description: messages.clinicalDocumentSignDescription, confirmLabel: messages.confirmClinicalRecordSign,
        content: <ConsultationSignReviewNotice review={review} messages={messages} />,
        confirmationLabel: messages.consultationSignReviewed, onConfirm: acknowledged => setResult(`agent:${acknowledged}`) })
      task.bindDecisionGate(async () => {})
      void task.decision.catch(() => undefined)
    }}>Agent 签署提案</button>
    <output aria-label="签署结果">{result}</output>
    <ClinicalDocumentPage allowRevision={false} detail={{ ...detail, consultationRecording: { ...detail.consultationRecording!,
      ...(recovery ? { signingPreparation: { previewId: 'recovered', expiresAt: '2026-10-10T09:00:00Z', active: false } } : {}) } }}
      elementId="signing-record" locale="zh-CN" messages={messages} workingDocument={content} onDocumentChange={() => {}}
      actions={{
        cancelSign: { error: cancelError, pending: false, onSubmit: cancel },
        prepareSign: { data: preview, error: null, pending: false, onReset: cancel, onSubmit: () => {
          setSerial(current => current + 1)
          setPreview({ previewId: `preview-${serial}`, commitToken: 'synthetic-commit-token', document: { content }, consultationReview: review })
        } },
        revise: { error: null, pending: false, success: false, onSubmit: () => {} },
        sign: { error: null, pending: false, success: false, onSubmit: value => { setResult(`signed:${value.consultationReviewed}`); setPreview(undefined) } },
      }} />
  </div>
}
createRoot(root).render(<PortalContainerProvider container={root}><AgentReviewProvider><App /></AgentReviewProvider></PortalContainerProvider>)
