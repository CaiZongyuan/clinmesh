import type { WorkspaceLocale } from './workspace-i18n.ts'

export function inpatientAdmissionConditionLabel(value: string | undefined, locale: WorkspaceLocale): string {
  const labels: Record<string, [string, string]> = { '1': ['有', 'Present'], '2': ['临床未确定', 'Clinically undetermined'], '3': ['情况不明', 'Unknown'], '4': ['无', 'Absent'] }
  return labels[value ?? '']?.[locale === 'zh-CN' ? 0 : 1] ?? (locale === 'zh-CN' ? '未记录' : 'Not recorded')
}

export function inpatientDepartureLabel(value: string | undefined, locale: WorkspaceLocale): string {
  const labels: Record<string, [string, string]> = { home: ['医嘱离院', 'Discharged home'], transfer: ['医嘱转院', 'Transferred'], 'against-advice': ['非医嘱离院', 'Against medical advice'], death: ['死亡', 'Death'], other: ['其他', 'Other'] }
  return labels[value ?? '']?.[locale === 'zh-CN' ? 0 : 1] ?? (locale === 'zh-CN' ? '未记录' : 'Not recorded')
}

export function inpatientChargeCategoryLabel(value: string, locale: WorkspaceLocale): string {
  const labels: Record<string, [string, string]> = { bed: ['床位费用', 'Bed charges'], medication: ['药品费用', 'Medication charges'], service: ['诊疗服务费用', 'Clinical service charges'], surgery: ['手术费用', 'Surgery charges'], material: ['耗材费用', 'Material charges'], laboratory: ['检验费用', 'Laboratory charges'], imaging: ['影像检查费用', 'Imaging charges'] }
  return labels[value]?.[locale === 'zh-CN' ? 0 : 1] ?? (locale === 'zh-CN' ? '未分类费用' : 'Unclassified charges')
}

/** 住院频次的中文名与给药时间；executions 按 QD 08:00、BID 08:00/20:00 生成。 */
export function inpatientFrequencyLabel(code: 'QD' | 'BID' | 'PRN', locale: WorkspaceLocale, withTime = true): string {
  const labels = { QD: ['每日一次', '08:00', 'Once daily'], BID: ['每日两次', '08:00、20:00', 'Twice daily'], PRN: ['按需', '', 'As needed'] } as const
  const [zh, time, en] = labels[code]
  const timeText = locale === 'zh-CN' ? time : time.replace('、', ', ')
  return `${locale === 'zh-CN' ? zh : en}${withTime && timeText ? ` · ${timeText}` : ''}`
}
