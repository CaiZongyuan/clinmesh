/** 病历“辅助检查”字段的长度上限，与临床文书合同一致。 */
const auxiliaryExaminationMaxLength = 4_000
/** 尚无检验结果时工作病历的默认占位文字；它不是医生写下的内容，插入摘要时替换。 */
export const emptyAuxiliaryExamination = '暂无辅助检查结果。'

/**
 * 把一份放射报告的印象或病理会诊报告的病理诊断作为摘要追加到病历“辅助检查”文字末尾。摘要写明报告类别、
 * 版本与签发时间，可据此追溯到具体报告；同一版本已在文字中时不重复插入，已写内容原样保留。
 */
export function insertImagingReportSummary(
  current: string | undefined,
  serviceName: string,
  report: { impression: string; issuedLabel: string; reportKind?: '放射报告' | '病理会诊报告'; revisionNumber: number },
): { status: 'duplicate' | 'inserted' | 'too-long'; text: string } {
  const text = current ?? ''
  const marker = `${serviceName}（${report.reportKind ?? '放射报告'}第 ${report.revisionNumber} 版，签发于 ${report.issuedLabel}）`
  if (text.includes(marker)) return { status: 'duplicate', text }
  const written = text.trim() === '' || text.trim() === emptyAuxiliaryExamination ? '' : `${text.trimEnd()}\n`
  const next = `${written}${marker}：${report.impression}`
  return next.length > auxiliaryExaminationMaxLength ? { status: 'too-long', text } : { status: 'inserted', text: next }
}
