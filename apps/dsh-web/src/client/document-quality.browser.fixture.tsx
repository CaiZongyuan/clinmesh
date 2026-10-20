import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import type { ClinicalDocumentContent, DoctorCaseDetail } from '@clinmesh/contracts/his'
import { ClinicalDocumentPage, type ClinicalDocumentSignPreview } from '../../../web/src/app/doctor/clinical-document-page.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from '../../../web/src/app/workspace-i18n.ts'

const content: ClinicalDocumentContent = {
  chiefComplaint: '头晕。', historyOfPresentIllness: '头晕一周，站立时明显。', priorMedicalHistory: '既往高血压。',
  familyHistory: '父亲有高血压，患者自述。', allergyHistory: '药物过敏情况待核实。',
  physicalExamination: '今天上午体温36.5℃。', auxiliaryExamination: '暂无本次检查结果。',
  assessment: 'Agent新增：确诊合成疾病，尚无来源。', disposition: '进一步核实病史。', followUp: '加重时及时就诊。',
}
const detail: DoctorCaseDetail = {
  registrationNumber: null,
  allergies: [], caseId: 'quality-case', encounter: { id: 'quality-encounter', status: 'in-progress', versionId: '1' },
  patient: { id: 'quality-patient', identifier: 'SYNTHETIC', name: '合成患者', gender: 'female', birthDate: '1990-01-01', synthetic: true, versionId: '1' },
  presentation: null, priorFacts: [], status: 'first-visit', taskId: 'quality-task', taskVersion: '1',
  clinicalDocument: { draft: { ...content, version: 1, updatedAt: '2026-10-15T09:00:00+08:00' }, signed: [] },
}
const host = document.createElement('div')
host.id = 'document-quality-host'
host.style.cssText = 'position:absolute;left:20px;top:20px;width:340px;height:calc(100vh - 40px);contain:strict;overflow:hidden'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('div')
shadow.append(root)

function Fixture(): React.JSX.Element {
  const [locale, setLocale] = React.useState<WorkspaceLocale>('zh-CN')
  const [fontSize, setFontSize] = React.useState('standard')
  const [document, setDocument] = React.useState(content)
  const [preview, setPreview] = React.useState<ClinicalDocumentSignPreview>()
  const [result, setResult] = React.useState('')
  const [visible, setVisible] = React.useState(true)
  React.useEffect(() => {
    const appearance = (event: Event) => {
      const next = (event as CustomEvent<{ locale: WorkspaceLocale; fontSize: string }>).detail
      setLocale(next.locale); setFontSize(next.fontSize)
    }
    window.addEventListener('document-quality-appearance', appearance)
    return () => window.removeEventListener('document-quality-appearance', appearance)
  }, [])
  return <div className="clinmesh-web-root h-full overflow-y-auto" data-clinmesh-app="web" data-font-size={fontSize} data-theme="light" lang={locale}>
    <output aria-label="签署结果">{result}</output>
    <button onClick={() => setVisible(value => !value)} type="button">{visible ? '查看合成病例B' : '返回合成病例A'}</button>
    {!visible ? <p>合成病例B</p> : <ClinicalDocumentPage allowRevision={false} detail={detail} elementId="quality-record" locale={locale}
      messages={getWorkspaceMessages(locale)} workingDocument={document} onDocumentChange={setDocument}
      actions={{
        cancelSign: { error: null, pending: false, onSubmit: () => setPreview(undefined) },
        prepareSign: { data: preview, error: null, pending: false, onReset: () => setPreview(undefined),
          onSubmit: () => setPreview({ previewId: 'quality-preview', commitToken: 'synthetic-commit-token', document: { content: document } }) },
        revise: { error: null, pending: false, success: false, onSubmit: () => {} },
        sign: { error: null, pending: false, success: false, onSubmit: () => { setResult('signed'); setPreview(undefined) } },
      }} />}
  </div>
}
createRoot(root).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <PortalContainerProvider container={root}><Fixture /></PortalContainerProvider>
</QueryClientProvider>)
