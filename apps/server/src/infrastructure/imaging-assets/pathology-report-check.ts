import { canonicalJsonHash } from '../../application/scenario-data/canonical-json.ts'
import {
  pathologyReviewItems,
  type PathologyCatalogAsset,
  type PathologyCatalogAssetEntry,
  type PathologyClinicalFields,
  type PathologyReportRevision,
} from './pathology-catalog.ts'

/** 自动一致性检查规则版本；规则变化时递增，复核记录保存当时使用的版本。 */
export const pathologyReportCheckVersion = 1

export type PathologyReportIssueCode =
  | 'CLINICAL_HER2_CONTRADICTORY'
  | 'CLINICAL_HER2_UNDETERMINED'
  | 'CLINICAL_HISTOLOGIC_TYPE_UNSUPPORTED'
  | 'CLINICAL_RECEPTOR_MISSING'
  | 'REPORT_GRADE_CLAIMED'
  | 'REPORT_GRADE_STATEMENT_MISSING'
  | 'REPORT_HISTOLOGIC_TYPE_MISMATCH'
  | 'REPORT_LYMPH_NODE_CLAIMED'
  | 'REPORT_NOTE_MISMATCH'
  | 'REPORT_RECEPTOR_MISMATCH'
  | 'REPORT_RECEPTOR_SOURCE_MISSING'
  | 'REPORT_UNSUPPORTED_DETAIL'

export interface PathologyReportIssue {
  code: PathologyReportIssueCode
  message: string
}

type ReceptorStatus = 'negative' | 'positive'

/** 首批支持的组织学类型：TCGA 原文 → 报告中使用的中文名称。 */
const histologicTypes: Record<string, string> = {
  'Infiltrating Ductal Carcinoma': '浸润性导管癌',
  'Infiltrating Lobular Carcinoma': '浸润性小叶癌',
}
/** 报告中可能出现的组织学类型名；只允许出现来源类型名称所包含的那一个。 */
const histologicTypeTerms = ['导管癌', '小叶癌', '黏液癌', '粘液癌', '髓样癌', '化生性癌', '小管癌', '筛状癌', '乳头状癌', '原位癌', '混合型癌', '混合性癌']
export const gradeStatement = '原始资料未提供组织学分级'
/** 去掉固定声明后，正文不得出现任何“级”字、分化程度或分级的组成部分（核分裂、核异型、多形性）。 */
const gradeTerms = /级|分化|G\s*[1-3]|Nottingham|Elston|SBR|核分裂|异型|多形/i
const receptorSourceStatements = ['原始病理资料', '本次会诊未提供免疫组化切片']
const noteStatements = ['原发灶', '淋巴结情况以原病例记录为准']
const lymphNodeClaim = /转移|阳性|阴性|累及|见癌|未见|N\s*[0-3]|枚|\d|\//
const unsupportedDetail = /\d+(?:\.\d+)?\s*(?:mm|cm|毫米|厘米)|p?T\s*[0-4]|分期|左|右|象限|乳头|乳晕|切缘|脉管|神经|坏死|钙化/
const receptorMention = /ER|PR|HER2|雌激素|孕激素|受体/

function normalizedStatus(value: string | undefined): ReceptorStatus | 'equivocal' | undefined {
  const lower = value?.toLowerCase()
  if (lower === 'positive') return 'positive'
  if (lower === 'negative') return 'negative'
  if (lower === 'equivocal') return 'equivocal'
  return undefined
}

/**
 * 由来源字段派生受体状态。ER、PR 取来源状态；HER2 以 IHC 3+ 或 FISH 阳性判为阳性，IHC 0/1+（或来源 IHC 判为阴性）
 * 或 IHC 2+ 且 FISH 阴性判为阴性。IHC 评分与 IHC 结论、IHC 与 FISH、派生结果与来源最终结论任一矛盾时不能发布。
 */
export function pathologyClinicalStatus(clinical: PathologyClinicalFields): {
  er?: ReceptorStatus
  her2?: ReceptorStatus
  histologicType?: string
  issues: PathologyReportIssue[]
  pr?: ReceptorStatus
} {
  const issues: PathologyReportIssue[] = []
  const result: ReturnType<typeof pathologyClinicalStatus> = { issues }
  const histologicType = histologicTypes[clinical.histologicType]
  if (histologicType === undefined) {
    issues.push({ code: 'CLINICAL_HISTOLOGIC_TYPE_UNSUPPORTED', message: `The histologic type ${clinical.histologicType} has no report wording` })
  } else {
    result.histologicType = histologicType
  }
  for (const [name, value] of [['er', clinical.estrogenReceptor], ['pr', clinical.progesteroneReceptor]] as const) {
    const status = normalizedStatus(value)
    if (status === 'positive' || status === 'negative') result[name] = status
    else issues.push({ code: 'CLINICAL_RECEPTOR_MISSING', message: `The source has no definite ${name.toUpperCase()} status` })
  }
  const { her2 } = clinical
  const scoreCategory = her2.ihcScore === undefined
    ? undefined
    : ({ '0': 'negative', '1+': 'negative', '2+': 'equivocal', '3+': 'positive' } as const)[her2.ihcScore]
  const ihcStatus = normalizedStatus(her2.ihcStatus)
  const fish = normalizedStatus(her2.fish)
  const contradictions: string[] = []
  if (her2.ihcScore !== undefined && scoreCategory === undefined) contradictions.push(`unknown IHC score ${her2.ihcScore}`)
  if (scoreCategory !== undefined && ihcStatus !== undefined && scoreCategory !== ihcStatus) contradictions.push('IHC score and IHC status disagree')
  const ihc = scoreCategory ?? ihcStatus
  if ((ihc === 'positive' && fish === 'negative') || (ihc === 'negative' && fish === 'positive')) contradictions.push('IHC and FISH disagree')
  const derived: ReceptorStatus | undefined = ihc === 'positive' || fish === 'positive'
    ? 'positive'
    : ihc === 'negative' || fish === 'negative' ? 'negative' : undefined
  const finalStatus = normalizedStatus(her2.finalStatus)
  if (finalStatus !== undefined && derived !== undefined && finalStatus !== derived) contradictions.push('the final status disagrees')
  if (contradictions.length > 0) {
    issues.push({ code: 'CLINICAL_HER2_CONTRADICTORY', message: `The source HER2 fields are contradictory: ${contradictions.join('; ')}` })
  } else if (derived === undefined) {
    issues.push({ code: 'CLINICAL_HER2_UNDETERMINED', message: 'The source HER2 fields do not determine a status' })
  } else {
    result.her2 = derived
  }
  return result
}

function sentences(text: string): string[] {
  return text.split(/[。；;\n]/).map(sentence => sentence.trim()).filter(sentence => sentence !== '')
}

/**
 * 对照来源临床字段检查一份报告修订：病理诊断写出来源组织学类型且不出现其他类型；不写分级并声明来源未提供分级；
 * 既有免疫组化逐项与派生受体状态一致并注明来源；不对淋巴结作出判断，不写来源字段无法支持的大小、分期、部位和形态细节。
 */
export function checkPathologyReport(
  asset: PathologyCatalogAssetEntry,
  report: PathologyReportRevision,
): { checkVersion: number; issues: PathologyReportIssue[] } {
  const status = pathologyClinicalStatus(asset.clinical)
  const issues = [...status.issues]
  const issue = (code: PathologyReportIssueCode, message: string) => issues.push({ code, message })
  const sections = {
    diagnosis: report.diagnosis,
    immunohistochemistry: report.immunohistochemistry,
    microscopy: report.microscopy,
    note: report.note,
  }
  const allText = Object.values(sections).join('\n')

  if (status.histologicType !== undefined && !report.diagnosis.includes(status.histologicType)) {
    issue('REPORT_HISTOLOGIC_TYPE_MISMATCH', `The diagnosis does not state ${status.histologicType}`)
  }
  for (const term of histologicTypeTerms) {
    if (allText.includes(term) && !(status.histologicType ?? '').includes(term)) {
      issue('REPORT_HISTOLOGIC_TYPE_MISMATCH', `The report names ${term}, which the source histologic type does not support`)
    }
  }

  if (!report.diagnosis.includes(gradeStatement)) {
    issue('REPORT_GRADE_STATEMENT_MISSING', `The diagnosis must state ${gradeStatement}`)
  }
  for (const [section, text] of Object.entries(sections)) {
    if (gradeTerms.test(text.replaceAll(gradeStatement, ''))) {
      issue('REPORT_GRADE_CLAIMED', `The ${section} section states a grade or grading component`)
    }
  }

  for (const [section, text] of Object.entries(sections)) {
    if (section !== 'immunohistochemistry' && receptorMention.test(text)) {
      issue('REPORT_RECEPTOR_MISMATCH', `The ${section} section mentions receptor results outside the immunohistochemistry section`)
    }
  }
  for (const [name, pattern] of [['er', /(?<!H)ER[^：:；;。]*[：:]\s*(阳性|阴性)/g], ['pr', /PR[^：:；;。]*[：:]\s*(阳性|阴性)/g], ['her2', /HER2[^：:；;。]*[：:]\s*(阳性|阴性)/g]] as const) {
    const stated = [...report.immunohistochemistry.matchAll(pattern)].map(match => match[1] === '阳性' ? 'positive' : 'negative')
    const expected = status[name]
    if (stated.length !== 1 || (expected !== undefined && stated[0] !== expected)) {
      issue('REPORT_RECEPTOR_MISMATCH', `The immunohistochemistry section must state ${name.toUpperCase()} once as ${expected ?? 'the source status'}`)
    }
  }
  const ihcScore = /IHC\s*([0-3]\+?)/g
  for (const match of report.immunohistochemistry.matchAll(ihcScore)) {
    if (match[1] !== asset.clinical.her2.ihcScore) issue('REPORT_RECEPTOR_MISMATCH', `The stated HER2 IHC score ${match[1]} differs from the source`)
  }
  for (const [method, value] of [['IHC', asset.clinical.her2.ihcStatus], ['FISH', asset.clinical.her2.fish]] as const) {
    for (const match of report.immunohistochemistry.matchAll(new RegExp(`${method}\\s*(阳性|阴性)`, 'g'))) {
      if ((match[1] === '阳性' ? 'positive' : 'negative') !== normalizedStatus(value)) {
        issue('REPORT_RECEPTOR_MISMATCH', `The stated HER2 ${method} result differs from the source`)
      }
    }
  }
  if (!receptorSourceStatements.every(statement => report.immunohistochemistry.includes(statement))) {
    issue('REPORT_RECEPTOR_SOURCE_MISSING', 'The immunohistochemistry section must attribute the results to the original pathology record')
  }

  for (const [section, text] of Object.entries(sections)) {
    for (const sentence of sentences(text)) {
      if (sentence.includes('淋巴结') && (section !== 'note' || lymphNodeClaim.test(sentence))) {
        issue('REPORT_LYMPH_NODE_CLAIMED', `The report makes a lymph node statement: ${sentence}`)
      }
    }
  }
  if (!noteStatements.every(statement => report.note.includes(statement))) {
    issue('REPORT_NOTE_MISMATCH', 'The note must state that the slide is primary tumour tissue and lymph nodes follow the source case')
  }

  for (const [section, text] of Object.entries(sections)) {
    if (section !== 'immunohistochemistry' && unsupportedDetail.test(text)) {
      issue('REPORT_UNSUPPORTED_DETAIL', `The ${section} section states a size, stage, location or morphology detail the source fields do not support`)
    }
  }
  return { checkVersion: pathologyReportCheckVersion, issues }
}

/**
 * 复核所签署的内容：素材身份与来源（受试者、切片、Study/Series/Instance UID 及其字节数与哈希、IDC 序列目录）、
 * 合集 DOI 与许可、临床字段及其来源条款、已安装层级与摄取参数、生成草稿所用 prompt 文件和报告修订本身；任何一项变化都使复核失效。
 */
export function pathologyReportContentSha256(asset: PathologyCatalogAsset, report: PathologyReportRevision): string {
  const { review: _review, ...content } = report
  return canonicalJsonHash({
    assetId: asset.assetId,
    clinical: asset.clinical,
    clinicalSource: asset.reviewScope.clinicalSource,
    collection: asset.reviewScope.collection,
    output: asset.output,
    promptSha256: asset.reviewScope.promptSha256[report.draft.promptVersion] ?? null,
    report: content,
    source: asset.source,
  })
}

export type PathologyPublicationBlockCode =
  | 'ASSET_UNRECORDED'
  | 'AUTOMATED_CHECK_FAILED'
  | 'REPORT_MISSING'
  | 'REVIEW_INCOMPLETE'
  | 'REVIEW_MISSING'
  | 'REVIEW_NOT_APPROVED'
  | 'REVIEW_STALE'

/**
 * 素材能否进入病例匹配：切片已登记，且至少一份报告修订通过自动检查（含来源字段一致性）并由维护者对当前内容签署复核。
 * 返回可发布的报告修订号，以及其余修订或整个素材被拦下的原因。
 */
export function pathologyAssetPublication(asset: PathologyCatalogAsset): {
  publishedRevisions: number[]
  reasons: Array<{ code: PathologyPublicationBlockCode; revision?: number }>
} {
  if (asset.output === undefined) return { publishedRevisions: [], reasons: [{ code: 'ASSET_UNRECORDED' }] }
  if (asset.reports === undefined || asset.reports.length === 0) {
    return { publishedRevisions: [], reasons: [{ code: 'REPORT_MISSING' }] }
  }
  const publishedRevisions: number[] = []
  const reasons: Array<{ code: PathologyPublicationBlockCode; revision: number }> = []
  for (const report of asset.reports) {
    const { review, revision } = report
    if (review === undefined) reasons.push({ code: 'REVIEW_MISSING', revision })
    else if (review.contentSha256 !== pathologyReportContentSha256(asset, report)) reasons.push({ code: 'REVIEW_STALE', revision })
    else if (review.conclusion !== 'approved') reasons.push({ code: 'REVIEW_NOT_APPROVED', revision })
    else if (!pathologyReviewItems.every(item => review.items.some(entry => entry.item === item && entry.conclusion === 'confirmed'))) {
      reasons.push({ code: 'REVIEW_INCOMPLETE', revision })
    } else if (checkPathologyReport(asset, report).issues.length > 0) reasons.push({ code: 'AUTOMATED_CHECK_FAILED', revision })
    else publishedRevisions.push(revision)
  }
  return { publishedRevisions, reasons }
}
