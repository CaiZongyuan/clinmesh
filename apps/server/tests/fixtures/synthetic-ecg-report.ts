import { v7 as uuidv7 } from 'uuid'
import type { PciPaymentDrgFixture } from './pci-payment-drg.ts'

/** 向病例或住院写入一份已签发的合成 12 导联心电图报告（ST-T 三组导联）。 */
export function insertSyntheticEcgReport(
  fixture: PciPaymentDrgFixture,
  options: {
    anteriorText: string
    caseId: string
    conclusion: string
    encounterId: string
    epoch: string
    interpretation: 'abnormal' | 'normal'
    patientId: string
    workspaceId: string
  },
) {
  const scope = { workspaceId: options.workspaceId, epoch: options.epoch } as const
  const now = '2026-08-24T09:45:00+08:00'
  const report = fixture.runtime.fhir.create(scope, {
    resourceType: 'DiagnosticReport',
    id: uuidv7(),
    status: 'final',
    code: { text: '常规 12 导联心电图报告' },
    subject: { reference: `Patient/${options.patientId}` },
    encounter: { reference: `Encounter/${options.encounterId}` },
    issued: now,
    conclusion: options.conclusion,
  })
  const serviceRequest = fixture.runtime.fhir.create(scope, {
    resourceType: 'ServiceRequest',
    id: uuidv7(),
    status: 'completed',
    intent: 'order',
    code: { text: '常规 12 导联心电图' },
    subject: { reference: `Patient/${options.patientId}` },
    encounter: { reference: `Encounter/${options.encounterId}` },
  })
  const task = fixture.runtime.fhir.create(scope, {
    resourceType: 'Task',
    id: uuidv7(),
    status: 'completed',
    intent: 'order',
    for: { reference: `Patient/${options.patientId}` },
    focus: { reference: `ServiceRequest/${serviceRequest.id}` },
  })
  const requestId = uuidv7()
  fixture.runtime.database.driver.prepare(`
    INSERT INTO laboratory_request (
      workspace_id, epoch, request_id, case_id, request_kind, catalog_item_id,
      indication_code, service_snapshot_json, service_request_id, execution_task_id,
      diagnostic_report_id, status, version, authored_by, authored_at, reported_at
    ) VALUES (?, ?, ?, ?, 'examination', 'examination-ecg-12-lead', 'clinical-evaluation', '{}', ?, ?, ?, 'reported', 1, 'actor-test', ?, ?)
  `).run(options.workspaceId, options.epoch, requestId, options.caseId, serviceRequest.id, task.id, report.id, now, now)
  fixture.runtime.database.driver.prepare(`
    INSERT INTO examination_request_detail (workspace_id, epoch, request_id, exam_code, indication)
    VALUES (?, ?, ?, 'ecg-12-lead', '胸闷待查')
  `).run(options.workspaceId, options.epoch, requestId)
  fixture.runtime.database.driver.prepare(`
    INSERT INTO examination_report_content (
      workspace_id, epoch, diagnostic_report_id, request_id, case_id, content_json, issued_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(options.workspaceId, options.epoch, report.id, requestId, options.caseId, JSON.stringify({
    conclusion: options.conclusion,
    results: [
      { code: 'st-t-anterior', display: '前壁导联组 ST-T', value: options.anteriorText, referenceRange: { text: '未见明显异常' }, interpretation: options.interpretation },
      { code: 'st-t-inferior', display: '下壁导联组 ST-T', value: '未见明显异常', referenceRange: { text: '未见明显异常' }, interpretation: 'normal' },
      { code: 'st-t-lateral', display: '侧壁导联组 ST-T', value: '未见明显异常', referenceRange: { text: '未见明显异常' }, interpretation: 'normal' },
    ],
  }), now)
  return report.id
}
