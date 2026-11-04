import { expect, it } from 'vitest'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { inpatientInvestigationWaiting } from './inpatient-stage-activity.ts'

const request = { id: 'request-1', catalogItemId: 'laboratory-1', indicationCode: 'screening', serviceRequestId: 'service-1', serviceRequestVersion: '1', taskId: 'task-1', taskVersion: '1', version: 1 }
const acknowledged = { ...request, status: 'acknowledged', report: { diagnosticReportId: 'report-1', diagnosticReportVersion: '1', issuedAt: '2026-08-24T09:00:00+08:00', revisionNumber: 1, specimenId: 'specimen-1', status: 'final', conclusion: '合成检验结论', acknowledgement: { id: 'ack-1', acknowledgedAt: '2026-08-24T09:10:00+08:00', acknowledgedBy: 'doctor' }, results: [{ code: 'test', display: '合成定性结果', value: '阴性', interpretation: 'normal', observationId: 'observation-1', referenceRange: { text: '阴性' } }] } }
const data = (requests: unknown[]) => inpatientInvestigationsSchema.parse({ admissionId: 'admission-1', laboratoryRequests: requests, imagingRequests: [], sent: [] })

it('忽略已取消申请后，已阅报告与全部取消分别交接，不继续等待出报告', () => {
  expect(inpatientInvestigationWaiting(data([acknowledged, { ...request, id: 'cancelled-1', status: 'cancelled' }]), 'zh-CN')).toBe('报告已全部已阅')
  expect(inpatientInvestigationWaiting(data([{ ...request, status: 'cancelled' }]), 'zh-CN')).toContain('已全部取消')
  expect(inpatientInvestigationWaiting(data([{ ...request, status: 'accepted' }]), 'zh-CN')).toContain('未出报告')
  expect(inpatientInvestigationWaiting(data([{ ...request, status: 'issued' }]), 'zh-CN')).toContain('病区护士')
})

it('读取失败覆盖缓存中的已阅完成状态，未读到资料也不报空或完成', () => {
  const failed = inpatientInvestigationWaiting(data([acknowledged]), 'zh-CN', true)
  expect(failed).toContain('读取失败')
  expect(failed).not.toContain('全部已阅')
  expect(inpatientInvestigationWaiting(undefined, 'zh-CN')).toContain('正在读取')
})
