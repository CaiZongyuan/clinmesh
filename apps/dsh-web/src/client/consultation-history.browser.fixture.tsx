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
    sources: [],
    status: 'pending',
    failures: [{ sourceTurnId: 'synthetic-reply', code: 'AI_TIMEOUT', retrying: false }],
    additions: [{ id: 'synthetic-correction', field: 'historyOfPresentIllness',
    sourceTurnId: 'synthetic-reply', quote: '刚才说错了，头晕是六天。', relation: 'correction', targetAdditionId: 'synthetic-original',
    status: 'pending', reviewStatus: 'unreviewed', ownership: 'manual', currentText: '医生核对：头晕五天。', reviewable: true },
    { id: 'synthetic-applied', field: 'historyOfPresentIllness', sourceTurnId: 'synthetic-reply',
      quote: '刚才说错了，头晕是六天。', relation: 'correction', status: 'applied', reviewStatus: 'unreviewed',
      ownership: 'automatic', currentText: '患者自述：刚才说错了，头晕是六天。', reviewable: false },
    { id: 'synthetic-superseded', field: 'historyOfPresentIllness', sourceTurnId: 'synthetic-reply',
      quote: '刚才说错了，头晕是六天。', relation: 'correction', status: 'superseded', reviewStatus: 'undo-pending',
      ownership: 'automatic', currentText: '患者自述：刚才说错了，头晕是六天。', reviewable: false }] },
}
const host = document.createElement('div')
host.style.cssText = 'position:absolute;left:20px;top:20px;width:340px;height:calc(100vh - 40px);contain:strict;overflow:hidden'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('div')
root.className = 'clinmesh-web-root h-full'
root.dataset.clinmeshApp = ''
root.dataset.fontSize = 'default'
shadow.append(root)

function App(): React.JSX.Element {
  const [locale, setLocale] = React.useState<'zh-CN' | 'en-US'>('zh-CN')
  const [working, setWorking] = React.useState({ ...documentContent, historyOfPresentIllness: '医生尚未保存的编辑。' })
  const [savedDocument, setSavedDocument] = React.useState(documentContent)
  const [decisions, setDecisions] = React.useState<string[]>([])
  const [recording, setRecording] = React.useState(detail.consultationRecording!)
  const [consultation, setConsultation] = React.useState(detail.consultation!)
  const [controls, setControls] = React.useState<string[]>([])
  const [blocked, setBlocked] = React.useState(false)
  const [failReview, setFailReview] = React.useState(false)
  const [reviewError, setReviewError] = React.useState<{ additionId: string; error: Error }>()
  const [signedView, setSignedView] = React.useState(false)
  return <PortalContainerProvider container={root}>
    <div className="h-full overflow-y-auto">
    <button type="button" onClick={() => setLocale(current => current === 'zh-CN' ? 'en-US' : 'zh-CN')}>切换语言</button>
    <button type="button" onClick={() => setWorking(documentContent)}>模拟保存编辑</button>
    <button type="button" onClick={() => setRecording(current => ({ ...current, additions: [
      ...current.additions,
      { ...current.additions[0]!, id: 'synthetic-chief', field: 'chiefComplaint', relation: 'addition',
        targetAdditionId: undefined, currentText: '', summary: '自述头晕六天' },
      { ...current.additions[0]!, id: 'synthetic-prior', field: 'priorMedicalHistory', relation: 'addition',
        targetAdditionId: undefined, currentText: '', summary: '合成长病史建议。'.repeat(80) },
    ] }))}>模拟字段建议</button>
    <button type="button" onClick={() => setBlocked(true)}>模拟签署准备</button>
    <button type="button" onClick={() => setFailReview(true)}>模拟应用失败</button>
    <button type="button" onClick={() => setSignedView(true)}>模拟已签内容</button>
    <button type="button" onClick={() => {
      const fields = {
        chiefComplaint: '头晕六天。', historyOfPresentIllness: '头晕六天，休息后缓解。', priorMedicalHistory: '既往高血压。',
        physicalExamination: '右下腹压痛。', auxiliaryExamination: '血常规白细胞10.5×10⁹/L。',
        assessment: '医生评估：考虑腹部炎症，待进一步检查。', disposition: '医生安排：完善腹部超声。', followUp: '医生安排：明日复诊。',
      } satisfies ClinicalDocumentContent
      const messageText = Object.values(fields).join('\n')
      setWorking(fields)
      setSavedDocument(fields)
      setBlocked(false)
      setSignedView(false)
      setFailReview(false)
      setReviewError(undefined)
      setRecording(current => ({ ...current, status: 'updated', sources: [{
        id: 'synthetic-doctor-facts', kind: 'doctor', messageText, recordedAt: '2026-10-08T10:00:00+08:00',
        sessionId: 'synthetic-session', messageId: 'synthetic-message', rpcId: 'synthetic-rpc',
      }], additions: (['chiefComplaint', 'historyOfPresentIllness', 'priorMedicalHistory', 'physicalExamination',
        'auxiliaryExamination', 'assessment', 'disposition', 'followUp'] as const).map(field => ({
        ...current.additions[0]!, id: `synthetic-${field}`, field,
        sourceTurnId: 'synthetic-doctor-facts', quote: fields[field], summary: fields[field],
        relation: 'addition', targetAdditionId: undefined, status: 'applied', reviewStatus: 'unreviewed', ownership: 'automatic',
        currentText: fields[field], facts: [{ text: fields[field], sources: [{ sourceTurnId: 'synthetic-doctor-facts', quote: fields[field] }] }],
      })) }))
    }}>模拟医生全病历</button>
    <button type="button" onClick={() => setRecording(current => ({ ...current,
      sources: [...(current.sources ?? []), { id: 'synthetic-report', kind: 'report',
        messageText: '血常规白细胞10.5×10⁹/L。\n报告结论：白细胞升高。', recordedAt: '2026-10-08T10:05:00+08:00',
        reportReference: 'DiagnosticReport/synthetic-report/_history/2' }],
      additions: current.additions.map(addition => addition.field !== 'auxiliaryExamination' ? addition : {
        ...addition, sourceTurnId: 'synthetic-report',
        facts: [{ text: addition.summary!, sources: [{ sourceTurnId: 'synthetic-report', quote: addition.quote }] }],
      }),
    }))}>模拟授权报告来源</button>
    <button type="button" onClick={() => setRecording(current => ({ ...current,
      sources: [...(current.sources ?? []), { id: 'synthetic-patient-facts', kind: 'patient',
        messageText: '头晕六天，休息后缓解。', recordedAt: '2026-10-08T10:10:00+08:00' }],
      additions: current.additions.map(addition => addition.field !== 'historyOfPresentIllness' ? addition : {
        ...addition, facts: [{ text: addition.summary!, sources: [
          { sourceTurnId: addition.sourceTurnId, quote: addition.quote },
          { sourceTurnId: 'synthetic-patient-facts', quote: '头晕六天，休息后缓解。' },
        ] }],
      }),
    }))}>模拟混合来源</button>
    <button type="button" onClick={() => { setConsultation(current => ({ ...current, turns: [] }));
      setRecording(current => ({ ...current, sources: [] })) }}>模拟来源不可读取</button>
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
    <output aria-label="核对结果">{decisions.join(',')}</output>
    <button type="button" onClick={() => setRecording(current => ({ ...current, status: 'backfill', version: 0, remainingCount: 2 }))}>模拟历史病例</button>
    <button type="button" onClick={() => setRecording(current => ({ ...current, status: 'failed', failedCount: 1 }))}>模拟整理失败</button>
    <output aria-label="控制结果">{controls.join(',')}</output>
    {signedView ? <ClinicalDocumentContentView content={savedDocument} messages={getWorkspaceMessages(locale)}
      history={{ detail: { ...detail, consultation, consultationRecording: recording }, workingDocument: savedDocument,
        action: undefined, disabled: true, messages: getWorkspaceMessages(locale), locale }} /> : <ClinicalDocumentPage allowRevision={false} detail={{ ...detail, consultation, consultationRecording: {
      ...recording, ...(blocked ? { signingPreparation: { active: true, previewId: 'synthetic-preview', expiresAt: '2099-01-01T00:00:00Z' } } : {}),
    }, clinicalDocument: { ...detail.clinicalDocument!, draft: { ...savedDocument, version: 1, updatedAt: '2026-10-08T09:00:00+08:00' } } }} elementId="record" locale={locale}
      messages={getWorkspaceMessages(locale)} workingDocument={working} onDocumentChange={setWorking}
      actions={{
        prepareSign: { data: undefined, error: null, onReset: () => {}, onSubmit: () => {}, pending: false },
        revise: { error: null, onSubmit: () => {}, pending: false, success: false },
        sign: { error: null, onSubmit: () => {}, pending: false, success: false },
        reviewHistory: { error: reviewError?.error ?? null, additionId: reviewError?.additionId, pending: false, onSubmit: (id, decision) => {
          if (failReview) { setReviewError({ additionId: id, error: new Error('Synthetic failure') }); return }
          setDecisions(current => [...current, `${id}:${decision}`])
          if (decision === 'confirm' || decision === 'undo') setRecording(current => ({ ...current,
            additions: current.additions.map(addition => addition.id !== id ? addition : { ...addition,
              reviewStatus: 'confirmed', status: decision === 'undo' ? 'undone' : addition.status }) }))
        } },
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
