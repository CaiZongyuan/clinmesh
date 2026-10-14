import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { ClinicalDocumentContentView, ClinicalDocumentPage } from '../../../web/src/app/doctor/clinical-document-page.tsx'
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
    source: 'patient-agent', kind: 'text', messageText: '刚才说错了，头晕是六天。\n' + '我站起来会更明显，休息后会缓解。\n'.repeat(45) + '最后补充：夜间也会头晕。', sequence: 1,
    recordedAt: '2026-10-08T09:00:00+08:00', personaRevision: 1, reportReference: null }] },
  consultationRecording: { hasSavedDraft: true, version: 1, paused: false, processedCount: 1, remainingCount: 0, failedCount: 0,
    status: 'updated',
    failures: [{ sourceTurnId: 'synthetic-reply', code: 'AI_TIMEOUT', retrying: false }],
    additions: [{ id: 'synthetic-correction', field: 'historyOfPresentIllness',
    sourceTurnId: 'synthetic-reply', quote: '刚才说错了，头晕是六天。', relation: 'correction', targetAdditionId: 'synthetic-original',
    status: 'applied', ownership: 'manual', currentText: '医生核对：头晕五天。' },
    { id: 'synthetic-applied', field: 'historyOfPresentIllness', sourceTurnId: 'synthetic-reply',
      quote: '刚才说错了，头晕是六天。', relation: 'correction', status: 'applied',
      ownership: 'automatic', currentText: '患者自述：刚才说错了，头晕是六天。' },
    { id: 'synthetic-superseded', field: 'historyOfPresentIllness', sourceTurnId: 'synthetic-reply',
      quote: '刚才说错了，头晕是六天。', relation: 'correction', status: 'superseded',
      ownership: 'automatic', currentText: '患者自述：刚才说错了，头晕是六天。' }] },
}
const host = document.createElement('div')
host.style.cssText = 'position:absolute;left:20px;top:20px;width:340px;height:calc(100vh - 40px);contain:strict;overflow:hidden'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('div')
root.className = 'clinmesh-web-root h-full'
root.dataset.clinmeshApp = 'web'
root.dataset.fontSize = 'standard'
shadow.append(root)

function App(): React.JSX.Element {
  const [locale, setLocale] = React.useState<'zh-CN' | 'en-US'>('zh-CN')
  const [working, setWorking] = React.useState(documentContent)
  const [recording, setRecording] = React.useState(detail.consultationRecording!)
  const [consultation, setConsultation] = React.useState(detail.consultation!)
  const [controls, setControls] = React.useState<string[]>([])
  const [blocked, setBlocked] = React.useState(false)
  const [signedView, setSignedView] = React.useState(false)
  return <PortalContainerProvider container={root}>
    <div className="h-full overflow-y-auto">
    <button type="button" onClick={() => setLocale(current => current === 'zh-CN' ? 'en-US' : 'zh-CN')}>切换语言</button>
    <button type="button" onClick={() => setWorking(documentContent)}>模拟保存编辑</button>
    <button type="button" onClick={() => { setWorking(current => ({ ...current, chiefComplaint: "自述头晕六天", priorMedicalHistory: "合成长病史记录。".repeat(80), familyHistory: "患者自述父亲患高血压。", allergyHistory: "患者自述青霉素用药后出现皮疹。" })); setRecording(current => ({ ...current, additions: [
      ...current.additions,
      { ...current.additions[0]!, id: 'synthetic-chief', field: 'chiefComplaint', relation: 'addition',
        targetAdditionId: undefined, currentText: '', summary: '自述头晕六天' },
      { ...current.additions[0]!, id: 'synthetic-prior', field: 'priorMedicalHistory', relation: 'addition',
        targetAdditionId: undefined, currentText: '', summary: '合成长病史记录。'.repeat(80) },
      { ...current.additions[0]!, id: 'synthetic-family', field: 'familyHistory', relation: 'addition',
        targetAdditionId: undefined, currentText: '', summary: '患者自述父亲患高血压。' },
      { ...current.additions[0]!, id: 'synthetic-family-second', field: 'familyHistory', relation: 'addition',
        targetAdditionId: undefined, currentText: '', summary: '患者自述母亲无糖尿病。' },
      { ...current.additions[0]!, id: 'synthetic-allergy', field: 'allergyHistory', relation: 'addition',
        targetAdditionId: undefined, currentText: '', summary: '患者自述青霉素用药后出现皮疹。' },
    ] })) }}>模拟自动记录</button>
    <button type="button" onClick={() => setBlocked(true)}>模拟签署准备</button>
    <button type="button" onClick={() => setSignedView(true)}>模拟已签内容</button>
    <button type="button" onClick={() => {
      setConsultation(current => ({ ...current, turns: [...current.turns,
        { ...current.turns[0]!, id: 'synthetic-question', speaker: 'doctor', messageText: '夜间是否头晕，有没有胸痛？', sequence: 2 },
        { ...current.turns[0]!, id: 'synthetic-second-reply', messageText: '晚上也会头晕，但是胸口不痛。', sequence: 3 },
      ] }))
      setRecording(current => ({ ...current, additions: current.additions.map(addition => addition.id !== 'synthetic-applied' ? addition : {
        ...addition, summary: '自述头晕六天；夜间亦会头晕，否认胸痛',
        facts: [{ text: '自述头晕六天', sources: [{ sourceTurnId: 'synthetic-reply', quote: '刚才说错了，头晕是六天。' }] },
          { text: '夜间亦会头晕，否认胸痛', sources: [{ sourceTurnId: 'synthetic-second-reply', quote: '晚上也会头晕，但是胸口不痛。' }] }],
      }) }))
    }}>模拟跨轮总结</button>
    <button type="button" onClick={() => {
      setConsultation(current => ({ ...current, turns: current.turns.map(turn => turn.id !== 'synthetic-reply' ? turn : {
        ...turn, messageText: '我之前没有发热。发热。',
      }) }))
      setRecording(current => ({ ...current, additions: current.additions.map(addition => addition.id !== 'synthetic-applied' ? addition : {
        ...addition, summary: '自述发热',
        facts: [{ text: '自述发热', sources: [{ sourceTurnId: 'synthetic-reply', quote: '发热。' }] }],
      }) }))
    }}>模拟重复引用</button>
    <button type="button" onClick={() => setRecording(current => ({ ...current, status: 'backfill', version: 0, remainingCount: 2 }))}>模拟历史病例</button>
    <button type="button" onClick={() => setRecording(current => ({ ...current, status: 'failed', failedCount: 1 }))}>模拟整理失败</button>
    <output aria-label="控制结果">{controls.join(',')}</output>
    {signedView ? <ClinicalDocumentContentView content={documentContent} messages={getWorkspaceMessages(locale)}
      history={{ detail: { ...detail, consultation, consultationRecording: recording }, messages: getWorkspaceMessages(locale), locale }} /> : <ClinicalDocumentPage allowRevision={false} detail={{ ...detail, consultation, consultationRecording: {
      ...recording, ...(blocked ? { signingPreparation: { active: true, previewId: 'synthetic-preview', expiresAt: '2099-01-01T00:00:00Z' } } : {}),
    } }} elementId="record" locale={locale}
      messages={getWorkspaceMessages(locale)} workingDocument={working} onDocumentChange={setWorking}
      actions={{
        prepareSign: { data: undefined, error: null, onReset: () => {}, onSubmit: () => {}, pending: false },
        revise: { error: null, onSubmit: () => {}, pending: false, success: false },
        sign: { error: null, onSubmit: () => {}, pending: false, success: false },
        controlRecording: { error: null, pending: false, onSubmit: action => {
          setControls(current => [...current, action])
          setRecording(current => ({ ...current, version: current.version + 1, paused: action === 'pause',
            status: action === 'pause' ? 'paused' : 'processing', failedCount: 0 }))
        } },
      }} />}
    </div>
  </PortalContainerProvider>
}
createRoot(root).render(<App />)
