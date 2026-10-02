import { describe, expect, it } from 'vitest'
import { insertImagingReportSummary } from './imaging-report-summary.ts'

const report = {
  impression: '右肺上叶实性结节，大小约 31 mm。',
  issuedLabel: '2026年8月24日 09:05',
  revisionNumber: 2,
}

describe('insertImagingReportSummary', () => {
  it('appends a summary that names the report version without touching written text', () => {
    const result = insertImagingReportSummary('血常规未见明显异常。', '胸部 CT 平扫', report)
    expect(result).toEqual({
      status: 'inserted',
      text: '血常规未见明显异常。\n胸部 CT 平扫（放射报告第 2 版，签发于 2026年8月24日 09:05）：右肺上叶实性结节，大小约 31 mm。',
    })
  })

  it('names a pathology consultation report as such', () => {
    expect(insertImagingReportSummary('胸片未见异常。', '乳腺切片病理会诊', {
      impression: '乳腺浸润性导管癌。原始资料未提供组织学分级。',
      issuedLabel: '2026年8月24日 09:05',
      reportKind: '病理会诊报告',
      revisionNumber: 1,
    })).toEqual({
      status: 'inserted',
      text: '胸片未见异常。\n乳腺切片病理会诊（病理会诊报告第 1 版，签发于 2026年8月24日 09:05）：乳腺浸润性导管癌。原始资料未提供组织学分级。',
    })
  })

  it('replaces only the generated placeholder and an empty field', () => {
    for (const current of [undefined, '  ', '暂无辅助检查结果。']) {
      expect(insertImagingReportSummary(current, '胸部正位片', { ...report, revisionNumber: 1 })).toEqual({
        status: 'inserted',
        text: '胸部正位片（放射报告第 1 版，签发于 2026年8月24日 09:05）：右肺上叶实性结节，大小约 31 mm。',
      })
    }
  })

  it('reports a repeated insertion of the same report version and keeps the text', () => {
    const first = insertImagingReportSummary('已有内容。', '胸部 CT 平扫', report)
    expect(first.status).toBe('inserted')
    expect(insertImagingReportSummary(first.text, '胸部 CT 平扫', report)).toEqual({ status: 'duplicate', text: first.text })
    // 更正后的新版本是另一份摘要，不覆盖旧版摘要。
    const corrected = insertImagingReportSummary(first.text, '胸部 CT 平扫', { ...report, revisionNumber: 3 })
    expect(corrected.status).toBe('inserted')
    expect(corrected.text.startsWith(first.text)).toBe(true)
  })

  it('refuses an insertion that would exceed the field limit', () => {
    const current = '已'.repeat(3_990)
    expect(insertImagingReportSummary(current, '胸部 CT 平扫', report)).toEqual({ status: 'too-long', text: current })
  })
})
