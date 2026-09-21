import type { AgentActionFeedback } from './surface-agent-tools.ts'

const targets: Record<string, { label: string; selectors: string[] }> = {
  'ui.navigate': { label: '切换工作区', selectors: ['[data-agent-page-title]'] },
  'ui.panel.focus': { label: '聚焦工作区', selectors: ['[data-agent-page-title]'] },
  'registration.patient.search': { label: '查找患者', selectors: ['#patient-query'] },
  'registration.synthetic-case.search': { label: '查找待诊病例', selectors: ['#registration-case-query'] },
  'registration.patient.draft.set': { label: '填写患者资料', selectors: ['#patient-name', '#patient-identifier', '#patient-birth-date', '#patient-gender'] },
  'registration.draft.set': { label: '填写挂号信息', selectors: ['#registration-department', '#registration-location', '#registration-visit-type'] },
  'triage.draft.set': { label: '填写分诊评估', selectors: ['#triage-chief-complaint', '#triage-temperature', '#triage-pulse', '#triage-respiration', '#triage-systolic', '#triage-diastolic', '#triage-oxygen', '#triage-acuity'] },
  'pharmacy.review.draft.set': { label: '填写处方审核意见', selectors: ['#prescription-review-note'] },
  'pharmacy.dispense.draft.set': { label: '填写调剂批次与数量', selectors: ['[id^="lot-"]', '[id^="dispense-quantity-"]'] },
  'outpatient.consultation.ask': { label: '问诊并等待患者回答', selectors: ['[data-agent-consultation-pending]'] },
  'outpatient.consultation.reply.retry': { label: '重试患者回答', selectors: ['[data-agent-consultation-pending]'] },
  'outpatient.first-visit.draft.set': { label: '保存初诊草稿', selectors: ['#first-visit-history', '#first-visit-assessment'] },
  'outpatient.diagnosis.draft.set': { label: '保存诊断草稿', selectors: ['[data-agent-catalog-trigger="diagnosis"]', '[data-agent-catalog="diagnosis"] [data-slot="dialog-title"]', '[data-agent-diagnosis-entry]'] },
  'outpatient.laboratory.draft.set': { label: '保存检验申请草稿', selectors: ['#laboratory-item', '#laboratory-indication'] },
  'outpatient.prescription.draft.set': { label: '保存处方草稿', selectors: ['#medication-conclusion-heading', '[data-agent-medication-name]', '[data-agent-catalog-trigger="medication"]', '[data-agent-catalog="medication"] [data-slot="dialog-title"]', '[data-agent-medication-package]', '[id^="prescription-dose-"]', '[id^="prescription-frequency-"]', '[id^="prescription-course-"]', '[id^="prescription-quantity-"]'] },
  'outpatient.revisit.draft.set': { label: '保存复诊草稿', selectors: ['input[id^="revisit-"]', 'textarea[id^="revisit-"]', 'button[id^="revisit-"]', '[id^="medication-"]', '[id^="dose-"]', '[id^="frequency-"]', '[id^="quantity-"]'] },
  'outpatient.record.draft.set': { label: '保存病历草稿', selectors: [] },
  'outpatient.preview.request': { label: '生成签署预览', selectors: ['#structured-clinical-document-heading'] },
  'billing.payment.preview': { label: '生成缴费预览', selectors: ['#payment-details-heading'] },
}

const proposalLabels: Record<string, string> = {
  'registration.patient.create.propose': '创建患者档案',
  'registration.outpatient.propose': '确认门诊挂号',
  'registration.synthetic-case.start.propose': '开始合成病例',
  'triage.record.propose': '提交分诊评估',
  'outpatient.visit.start.propose': '开始接诊',
  'outpatient.diagnosis.confirm.propose': '确认诊断',
  'outpatient.laboratory.issue.propose': '开立检验申请',
  'outpatient.laboratory.cancel.propose': '撤销检验申请',
  'outpatient.report.acknowledge.propose': '确认查看报告',
  'outpatient.report.correct.propose': '更正检验报告',
  'outpatient.prescription.issue.propose': '开立处方',
  'outpatient.prescription.withdraw.propose': '撤回处方',
  'outpatient.medication.none.propose': '确认无需用药',
  'outpatient.record.sign.propose': '签署临床文书',
  'outpatient.record.revise.propose': '更正临床文书',
  'outpatient.encounter.complete.propose': '完成就诊',
  'billing.payment.confirm.propose': '确认收费',
  'pharmacy.review.propose': '审核处方',
  'pharmacy.dispense.propose': '确认发药',
  'scenario.reset.propose': '重置仿真场景',
}

const englishLabels: Record<string, string> = {
  '切换工作区': 'Navigate workspace', '聚焦工作区': 'Focus workspace',
  '查找患者': 'Search patients', '查找待诊病例': 'Search waiting cases',
  '填写患者资料': 'Fill patient details', '填写挂号信息': 'Fill registration details',
  '填写分诊评估': 'Fill triage assessment', '填写处方审核意见': 'Fill prescription review',
  '填写调剂批次与数量': 'Fill dispensing lots and quantities', '问诊并等待患者回答': 'Ask the patient',
  '重试患者回答': 'Retry patient reply', '保存初诊草稿': 'Save first-visit draft',
  '保存诊断草稿': 'Save diagnosis draft', '保存检验申请草稿': 'Save laboratory draft',
  '保存处方草稿': 'Save prescription draft', '保存复诊草稿': 'Save revisit draft',
  '保存病历草稿': 'Save clinical document draft', '生成签署预览': 'Preview document signing',
  '生成缴费预览': 'Preview payment', '切换诊疗页面': 'Select clinical section',
  '选择业务记录': 'Select record', '更新当前工作区': 'Update workspace',
  '创建患者档案': 'Create patient', '确认门诊挂号': 'Register outpatient visit',
  '开始合成病例': 'Start synthetic case', '提交分诊评估': 'Submit triage assessment',
  '开始接诊': 'Start consultation', '确认诊断': 'Confirm diagnosis',
  '开立检验申请': 'Issue laboratory request', '撤销检验申请': 'Cancel laboratory request',
  '确认查看报告': 'Acknowledge report', '更正检验报告': 'Correct laboratory report',
  '开立处方': 'Issue prescription', '撤回处方': 'Withdraw prescription',
  '确认无需用药': 'Confirm no medication', '签署临床文书': 'Sign clinical document',
  '更正临床文书': 'Revise clinical document', '完成就诊': 'Complete encounter',
  '确认收费': 'Confirm payment', '审核处方': 'Review prescription',
  '确认发药': 'Dispense medication', '重置仿真场景': 'Reset scenario',
}

export function agentActionLabel(event: AgentActionFeedback, english: boolean): string {
  const label = agentActionTarget(event).label
  return english ? englishLabels[label] ?? label : label
}

export function changedClinicalRecordSelectors(input: unknown, selectionId: string, root: HTMLElement | null): string[] {
  if (root === null || selectionId === '' || typeof input !== 'object' || input === null) return []
  return Object.entries(input).flatMap(([field, value]) => {
    const selector = `#${CSS.escape(`clinical-record-${selectionId}-${field}`)}`
    const element = root.querySelector(selector)
    return typeof value === 'string'
      && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      && element.value !== value ? [selector] : []
  })
}

export function agentActionTarget(event: AgentActionFeedback): { label: string; selectors: string[] } {
  if (event.operationId === 'ui.navigate' && event.phase !== 'completed') return { label: '切换工作区', selectors: [] }
  if (event.operationId === 'outpatient.section.select') {
    const section = typeof event.input === 'object' && event.input !== null && 'section' in event.input ? event.input.section : undefined
    return { label: '切换诊疗页面', selectors: event.phase === 'completed' && typeof section === 'string'
      ? [`[data-agent-selection="${CSS.escape(section)}"]`] : [] }
  }
  if (event.operationId.endsWith('.propose')) {
    return { label: proposalLabels[event.operationId] ?? '更新当前工作区', selectors: [] }
  }
  if (event.operationId.endsWith('.select')) {
    const values = typeof event.input === 'object' && event.input !== null ? Object.values(event.input) : []
    return {
      label: '选择业务记录',
      selectors: values.filter((value): value is string => typeof value === 'string')
        .map(value => `[data-agent-selection="${CSS.escape(value)}"]`),
    }
  }
  return targets[event.operationId] ?? { label: '更新当前工作区', selectors: [] }
}
