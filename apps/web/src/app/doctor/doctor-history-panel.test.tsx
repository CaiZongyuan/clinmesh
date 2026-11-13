// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { DoctorHistoryPanel } from './doctor-history-panel.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('lets the responsible doctor open a dated inpatient summary with diagnoses, procedures, medications and reports', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    calls.push(url.pathname)
    if (url.pathname.endsWith('/history/detail')) return Response.json({ source: 'local-completed', entryId: 'inpatient:admission',
      clinicalDate: '2026-08-24T10:00:00+08:00', title: '本院住院诊疗摘要', record: {
        kind: 'inpatient', admissionId: 'admission', admittedAt: '2026-08-20T10:00:00+08:00', dischargedAt: '2026-08-24T10:00:00+08:00',
        diagnoses: [{ code: 'I25.1', display: '冠状动脉粥样硬化性心脏病', role: 'primary' }],
        procedures: [{ code: '36.06', display: '冠状动脉支架置入术', performedAt: '2026-08-21T10:00:00+08:00', conclusion: '术后血流通畅' }],
        medications: [{ display: '阿司匹林', doseText: '100 mg', frequencyCode: 'QD', state: 'stopped' }],
        reports: [{ title: '超声心动图', conclusion: '左室收缩功能正常', findings: ['LVEF：60 %'] }],
      } })
    return Response.json({ source: 'local-completed', availability: 'available', coverage: 'current-patient-responsible-doctor',
      items: [{ source: 'local-completed', entryId: 'inpatient:admission', resourceType: 'InpatientEncounter', clinicalDate: '2026-08-24T10:00:00+08:00', title: '本院住院诊疗摘要' }], total: 1, page: 1, pageSize: 10 })
  }))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DoctorHistoryPanel caseId="follow-up" scope="synthetic-scope" locale="zh-CN" /></QueryClientProvider>)
  expect(calls).toEqual([])
  fireEvent.click(screen.getByText('本院既往诊疗（门诊与已出院住院）'))
  const history = await screen.findByRole('button', { name: /本院住院诊疗摘要/ })
  fireEvent.click(history)
  await screen.findByText(/冠状动脉粥样硬化性心脏病/)
  expect(screen.getByText(/冠状动脉支架置入术/)).toBeTruthy()
  expect(screen.getByText(/阿司匹林 · 100 mg · QD · 已停用/)).toBeTruthy()
  expect(screen.getByText('LVEF：60 %')).toBeTruthy()
  expect(screen.getByText('左室收缩功能正常')).toBeTruthy()
  await waitFor(() => expect(calls).toEqual(['/api/his/v1/doctor/cases/follow-up/history', '/api/his/v1/doctor/cases/follow-up/history/detail']))
})

it('keeps completed outpatient records readable alongside inpatient history', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/history/detail')) return Response.json({ source: 'local-completed', entryId: 'previous-outpatient', record: {
      caseId: 'previous-outpatient', completedAt: '2026-08-19T10:00:00+08:00',
      clinicalDocuments: [{ bundleId: 'bundle', compositionId: 'composition', compositionVersion: '1', documentId: 'document', provenanceId: 'provenance',
        revisionNumber: 1, signedAt: '2026-08-19T10:00:00+08:00', content: { assessment: '门诊血压控制平稳', plan: '继续监测血压，定期复诊' } }],
      diagnosis: { id: 'diagnosis', confirmedAt: '2026-08-19T10:00:00+08:00', provenanceId: 'diagnosis-provenance', entries: [{
        code: 'I10', conditionId: 'condition', conditionVersion: '1', display: '原发性高血压', role: 'primary', system: 'http://hl7.org/fhir/sid/icd-10',
      }] },
      encounter: { id: 'encounter', status: 'completed', versionId: '1' }, laboratoryRequests: [], timeline: [],
      patient: { id: 'patient', identifier: 'SYNTHETIC-001', name: '合成患者', synthetic: true, versionId: '1' },
    } })
    return Response.json({ source: 'local-completed', availability: 'available', coverage: 'current-patient-responsible-doctor',
      items: [{ source: 'local-completed', entryId: 'previous-outpatient', resourceType: 'Encounter', clinicalDate: '2026-08-19T10:00:00+08:00', title: '门诊完诊记录' }], total: 1, page: 1, pageSize: 10 })
  }))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DoctorHistoryPanel caseId="follow-up" scope="synthetic-scope" locale="zh-CN" /></QueryClientProvider>)
  fireEvent.click(screen.getByText('本院既往诊疗（门诊与已出院住院）'))
  fireEvent.click(await screen.findByRole('button', { name: /门诊完诊记录/ }))
  await screen.findByText('门诊血压控制平稳')
  expect(screen.getByText('继续监测血压，定期复诊')).toBeTruthy()
  expect(screen.getByText('原发性高血压（I10）')).toBeTruthy()
})
