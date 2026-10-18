import { createHash } from 'node:crypto'
import type { GuidelineDocument } from '../../src/application/guideline-corpus.ts'

export const syntheticGuidelineParagraph = 'Synthetic diabetes guidance. Review current glucose and previous treatment in adults with established type 2 diabetes. An isolated symptom does not establish diabetes; confirm the diagnosis before treatment.'
export const syntheticGuidelineMarker = '合成新增糖尿病主题：医生已核实糖尿病病史，仍需核对本次血糖。'
export const syntheticGuidelineDocument: GuidelineDocument = {
  source: {
    id: 'synthetic-free-diabetes', title: '合成免费糖尿病指南', publisher: '合成指南发布机构',
    documentType: 'guideline', version: 'synthetic-1', url: 'https://www.who.int/synthetic-diabetes',
    downloadUrl: 'https://iris.who.int/synthetic-diabetes.txt', format: 'text',
    sha256: createHash('sha256').update(syntheticGuidelineParagraph).digest('hex'), scope: '仅供合成集成测试，非临床建议。',
    status: 'active', license: { id: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', usage: 'open' },
    topics: [{ terms: ['糖尿病', 'diabetes'], diagnosisQueries: ['糖尿病'] }],
  },
  passages: [{ locator: '合成第3节第1段', text: syntheticGuidelineParagraph }],
}
