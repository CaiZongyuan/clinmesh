import { examinationRequestSchema } from '@clinmesh/contracts/his'

export function examinationFixture(tte = false) {
  const id = tte ? 'tte' : 'ecg'
  return examinationRequestSchema.parse({
    id, indication: '合成心功能评估', previousReports: [], status: 'reported', version: 1,
    serviceRequestId: `service-${id}`, serviceRequestVersion: '1', taskId: `task-${id}`, taskVersion: '1',
    service: { id: `examination-${id}`, code: id.toUpperCase(), name: tte ? '经胸超声心动图' : '常规十二导联心电图',
      examCode: tte ? 'tte' : 'ecg-12-lead', modality: tte ? 'US' : 'ECG', department: '心功能室', bodySite: '心脏',
      method: '合成结构化功能检查', applicability: '成人心功能评估', reportSections: ['technique', 'findings', 'impression'], version: 1 },
    report: { diagnosticReportId: `report-${id}`, diagnosticReportVersion: '1', examinedAt: '2026-10-10T10:00:00+08:00',
      issuedAt: '2026-10-10T10:00:00+08:00', revisionNumber: 1, status: 'final', technique: '合成结构化功能检查',
      findings: '合成结构化指标', impression: tte ? '左室收缩功能正常' : '窦性心律', results: [{ code: tte ? 'lvef' : 'ventricular-rate',
        display: tte ? 'LVEF' : '心室率', value: tte ? 62 : 72, interpretation: 'normal', referenceRange: { text: tte ? '55–70%' : '60–100次/分' },
        unit: { code: tte ? '%' : '/min', display: tte ? '%' : '次/分', system: 'http://unitsofmeasure.org' } }] },
  })
}
