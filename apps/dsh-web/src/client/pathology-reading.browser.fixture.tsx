import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { pathologyReportSchema, pathologyRequestSchema } from '@clinmesh/contracts/his'
import { Button } from '@clinmesh/ui/components/button'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { PathologyReadingViewer } from '../../../web/src/app/doctor/pathology-reading-viewer.tsx'

const host = document.createElement('div')
host.id = 'pathology-reading-host'
host.style.cssText = 'width:100%;height:100dvh;container-type:inline-size;container-name:dsh-react-surface-content;contain:strict'
document.body.append(host)
const surface = new URLSearchParams(location.search).get('surface') === '1'
const tree = surface ? host.attachShadow({ mode: 'open' }) : host
if (surface) for (const style of document.querySelectorAll('style')) tree.append(style.cloneNode(true))
const root = document.createElement('main')
root.className = 'clinmesh-web-root'
root.dataset.clinmeshApp = 'web'
root.dataset.fontSize = 'large'
root.dataset.theme = 'light'
root.style.cssText = 'height:100%;min-width:0;overflow:auto;padding:12px'
tree.append(root)

function request(patient: string) {
  const procedure = { code: 'synthetic-thyroid-surgery', display: '合成既往甲状腺手术', sourceReference: `Procedure/${patient}`, performedAt: '2025-01-01', specimenType: 'prior-thyroid-surgical-specimen' }
  const report = pathologyReportSchema.parse({ diagnosticReportId: `report-${patient}`, diagnosticReportVersion: '1', revisionNumber: 1,
    diagnosis: '合成文字报告，仅验证接入外壳。', immunohistochemistry: '合成既有记录。', microscopy: '合成镜下所见。', note: '请核对当前患者与报告版本。',
    receivedAt: '2026-11-20T09:00:00+08:00', issuedAt: '2026-11-20T10:00:00+08:00', status: 'final', studyId: `study-${patient}`,
    specimen: { procedure, slideCount: 1, specimenId: `specimen-${patient}`, stain: 'HE' } })
  return pathologyRequestSchema.parse({ id: `request-${patient}`, version: 1, purpose: '合成会诊复核', previousReports: [], status: 'reported',
    serviceRequestId: `service-request-${patient}`, serviceRequestVersion: '1', taskId: `task-${patient}`, taskVersion: '1', sourceProcedure: procedure, report,
    service: { applicability: '合成工程验证', bodySite: '甲状腺', code: 'synthetic-thyroid', department: '合成病理科', examCode: 'thyroid-slide-consultation',
      id: 'service-thyroid', name: '合成甲状腺病理会诊', reportSections: ['specimen', 'microscopy', 'diagnosis', 'note'], specimenType: 'prior-thyroid-surgical-specimen', stain: 'HE', version: 1 } })
}

function Fixture() {
  const [patient, setPatient] = React.useState('甲'), [opened, setOpened] = React.useState(true), [ready, setReady] = React.useState(false)
  const current = React.useMemo(() => request(patient), [patient])
  return <PortalContainerProvider container={root}>
    <section aria-label="当前合成病理会诊" className="min-w-0 space-y-3">
      <h1 className="break-words text-lg font-semibold">合成患者{patient}：既往甲状腺手术标本病理会诊与正式报告逐项核对</h1>
      <p className="break-words text-sm">合成文字报告始终可以阅读；请核对当前患者、既往标本、已签发报告版本和实际切片显示情况后，再由医生明确确认报告已阅。</p>
      <label className="block text-sm">未提交病历<textarea aria-label="未提交病历" className="w-full border" /></label>
      <div className="flex flex-wrap gap-2"><Button onClick={() => { setPatient(value => value === '甲' ? '乙' : '甲'); setReady(false) }}>切换患者</Button>
        <Button onClick={() => { setOpened(value => !value); setReady(false) }}>{opened ? '关闭阅片窗口' : '重新打开阅片窗口'}</Button></div>
      <output aria-label="阅读资格">{ready ? '已实际显示当前切片' : '尚未显示当前切片'}</output>
      {opened && <PathologyReadingViewer request={current} report={current.report!} locale="zh-CN" onReady={setReady} />}
      <Button disabled={!ready}>确认当前报告已阅</Button>
    </section>
  </PortalContainerProvider>
}

createRoot(root).render(<Fixture />)
