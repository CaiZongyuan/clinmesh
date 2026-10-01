import { canonicalJsonHash } from '../../application/scenario-data/canonical-json.ts'
import {
  imagingReviewItems,
  type ImagingCatalogAsset,
  type ImagingCatalogAssetEntry,
  type ImagingReportRevision,
} from './imaging-catalog.ts'

/** 自动一致性检查规则版本；规则变化时递增，复核记录保存当时使用的版本。 */
export const imagingReportCheckVersion = 2

export type ImagingReportIssueCode =
  | 'ANNOTATION_INDETERMINATE'
  | 'ANNOTATION_MISSING'
  | 'REPORT_COUNT_MISMATCH'
  | 'REPORT_IMPRESSION_MISMATCH'
  | 'REPORT_LESION_DUPLICATE'
  | 'REPORT_LESION_MISSING'
  | 'REPORT_LESION_UNSUPPORTED'
  | 'REPORT_LOCATION_MISMATCH'
  | 'REPORT_POSITIVE_FINDING_IN_NEGATIVE'
  | 'REPORT_SIDE_MISMATCH'
  | 'REPORT_SIZE_MISMATCH'
  | 'REPORT_TEXT_LESION_MISMATCH'
  | 'REPORT_TEXT_SIZE_UNSUPPORTED'
  | 'REPORT_TEXT_UNSUPPORTED_FINDING'

export interface ImagingReportIssue {
  code: ImagingReportIssueCode
  message: string
}

type Side = 'left' | 'right'

interface ReportableNodule {
  id: string
  imageNumber?: number
  longAxisMm?: number
  side: Side
}

const sizeToleranceMm = 1
const sideTerms: Record<Side, RegExp> = { left: /左肺|左侧/, right: /右肺|右侧/ }
const positiveTerm = new RegExp([
  '结节', '肿块', '团块', '肿物', '占位', '病灶', '实变', '磨玻璃', '空洞', '空腔', '钙化', '积液', '积气', '气胸',
  '肿大', '不张', '密度影', '致密影', '阴影', '斑片', '斑点', '条索', '索条', '网格', '蜂窝', '增厚', '浸润', '渗出',
  '纤维化', '肺大疱', '囊状', '支气管扩张', '转移',
].join('|'), 'g')
const negationTerm = /未见|未及|未发现|未显示|无|没有/g
/** 否定之后重新出现的肯定谓词结束否定范围，例如“未见结节而右肺见肿块”。 */
const affirmingPredicate = /见|示|呈/
const sizeMention = /(\d+(?:\.\d+)?)\s*(mm|cm|毫米|厘米)/g
const numerals: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const countMention = /(\d+|[一两二三四五六七八九十])\s*(?:枚|个|颗|处)|单发/
const multipleMention = /多发|多个|多枚|多处|多颗|数枚|数个|数处|若干|散在|弥漫/

function sentences(text: string): string[] {
  return text.split(/[。；;\n]/).map(sentence => sentence.trim()).filter(sentence => sentence !== '')
}

/** 分句后的小句；顿号分隔的并列项沿用前项的否定，见 `positiveClause`。 */
function clauses(sentence: string): string[] {
  return sentence.split(/[，,：:]/).map(clause => clause.trim()).filter(clause => clause !== '')
}

/** 小句中任一阳性征象词未被其前、同一小句内的否定词覆盖，即为阳性。 */
function positiveClause(clause: string): boolean {
  const negations = [...clause.matchAll(negationTerm)]
  return [...clause.matchAll(positiveTerm)].some((positive) => {
    const negation = negations.findLast(candidate => candidate.index + candidate[0].length <= positive.index)
    return negation === undefined
      || affirmingPredicate.test(clause.slice(negation.index + negation[0].length, positive.index))
  })
}

function statesPositiveFinding(sentence: string): boolean {
  return clauses(sentence).some(positiveClause)
}

function namesSide(text: string, side: Side): boolean {
  return sideTerms[side].test(text) && !sideTerms[side === 'left' ? 'right' : 'left'].test(text)
}

/** 统一换算为毫米并按 0.001 mm 取整，避免“1.1 cm”换算出浮点误差。 */
function sizesMm(text: string): number[] {
  return [...text.matchAll(sizeMention)].map(match => (
    Math.round(Number(match[1]) * (match[2] === 'cm' || match[2] === '厘米' ? 10 : 1) * 1000) / 1000
  ))
}

/** 小句声明的病灶数：明确数目、多发（至少两个），或未声明。 */
function statedCount(clause: string): { minimum: number; exact?: number } | undefined {
  if (multipleMention.test(clause)) return { minimum: 2 }
  const match = countMention.exec(clause)
  if (match === null) return undefined
  const count = match[1] === undefined ? 1 : numerals[match[1]] ?? Number(match[1])
  return { exact: count, minimum: count }
}

/**
 * 来源标注中应当写入报告的病灶。CT 取多数读片者标记的结节；胸片取全体读片者一致认为可见的结节。
 * 只有少数读片者标记、或胸片可见性存疑时，素材既不算阴性也没有可报告的依据。
 */
function reportableNodules(annotation: NonNullable<ImagingCatalogAssetEntry['annotation']>): {
  indeterminate: boolean
  nodules: ReportableNodule[]
} {
  if (annotation.kind === 'lidc-ct') {
    const nodules = annotation.nodules
      .filter(nodule => nodule.agreement * 2 > annotation.readerCount)
      .map(nodule => ({
        id: nodule.id,
        imageNumber: nodule.frameIndex + 1,
        ...(nodule.longAxisMm === undefined ? {} : { longAxisMm: nodule.longAxisMm }),
        side: nodule.side,
      }))
    return { indeterminate: annotation.nodules.length > 0 && nodules.length === 0, nodules }
  }
  return {
    indeterminate: annotation.nodules.some(nodule => nodule.visibility === 'indeterminate'),
    nodules: annotation.nodules
      .filter(nodule => nodule.visibility === 'visible')
      .map(nodule => ({ id: nodule.id, side: nodule.side })),
  }
}

/**
 * 对照来源标注检查一份报告修订：结构化病灶的数量、侧别、层面和大小必须与标注一致，
 * 正文必须逐一写出这些病灶，且不能出现标注无法支持的大小或阳性征象。
 */
export function checkImagingReport(
  asset: ImagingCatalogAssetEntry,
  report: ImagingReportRevision,
): { checkVersion: number; issues: ImagingReportIssue[] } {
  const issues: ImagingReportIssue[] = []
  const issue = (code: ImagingReportIssueCode, message: string) => issues.push({ code, message })
  const result = () => ({ checkVersion: imagingReportCheckVersion, issues })
  if (asset.annotation === undefined) {
    issue('ANNOTATION_MISSING', 'The asset has no source annotation to check the report against')
    return result()
  }
  const { indeterminate, nodules } = reportableNodules(asset.annotation)
  if (indeterminate) {
    issue('ANNOTATION_INDETERMINATE', 'The source readers disagree; the asset is neither negative nor reportable')
  }

  const noduleIds = report.lesions.map(lesion => lesion.noduleId)
  for (const noduleId of new Set(noduleIds.filter((noduleId, index) => noduleIds.indexOf(noduleId) !== index))) {
    issue('REPORT_LESION_DUPLICATE', `The lesion ${noduleId} is declared more than once`)
  }
  for (const nodule of nodules) {
    const lesion = report.lesions.find(candidate => candidate.noduleId === nodule.id)
    if (lesion === undefined) {
      issue('REPORT_LESION_MISSING', `The annotated nodule ${nodule.id} is not reported`)
      continue
    }
    if (lesion.side !== nodule.side) {
      issue('REPORT_SIDE_MISMATCH', `The lesion ${nodule.id} is annotated on the ${nodule.side} side`)
    }
    if (lesion.imageNumber !== nodule.imageNumber) {
      issue('REPORT_LOCATION_MISMATCH', `The lesion ${nodule.id} is annotated on image ${nodule.imageNumber ?? '<none>'}`)
    }
    if (
      (lesion.longAxisMm === undefined) !== (nodule.longAxisMm === undefined)
      || Math.abs((lesion.longAxisMm ?? 0) - (nodule.longAxisMm ?? 0)) > sizeToleranceMm
    ) {
      issue('REPORT_SIZE_MISMATCH', `The lesion ${nodule.id} has an annotated long axis of ${nodule.longAxisMm ?? '<none>'} mm`)
    }
  }
  for (const lesion of report.lesions) {
    if (!nodules.some(nodule => nodule.id === lesion.noduleId)) {
      issue('REPORT_LESION_UNSUPPORTED', `The reported lesion ${lesion.noduleId} is not supported by the source annotation`)
    }
  }

  const findings = sentences(report.findings)
  const impression = sentences(report.impression)
  const imageMention = (imageNumber: number) => new RegExp(`Im\\s*${imageNumber}(?!\\d)`)
  const sameSize = (left: number, right: number) => Math.abs(left - right) < 1e-6
  for (const lesion of report.lesions) {
    const described = findings.some(sentence => (
      namesSide(sentence, lesion.side)
      && statesPositiveFinding(sentence)
      && (lesion.imageNumber === undefined || imageMention(lesion.imageNumber).test(sentence))
      && (lesion.longAxisMm === undefined || sizesMm(sentence).some(size => sameSize(size, lesion.longAxisMm!)))
    ))
    if (!described) {
      issue('REPORT_TEXT_LESION_MISMATCH', `The findings text does not describe lesion ${lesion.noduleId} as declared`)
    }
    if (!impression.some(sentence => namesSide(sentence, lesion.side) && statesPositiveFinding(sentence))) {
      issue('REPORT_IMPRESSION_MISMATCH', `The impression does not name lesion ${lesion.noduleId}`)
    }
  }

  // 小于 3 mm 的结节没有测量值，正文只允许以“3 mm”作为上界提及。
  const allowedSizes = report.lesions.map(lesion => lesion.longAxisMm ?? 3)
  for (const size of sizesMm(`${report.findings}\n${report.impression}`)) {
    if (!allowedSizes.some(allowed => sameSize(allowed, size))) {
      issue('REPORT_TEXT_SIZE_UNSUPPORTED', `The text states ${size} mm, which no reported lesion has`)
    }
  }

  // 每个阳性小句都必须能归到一个已声明的病灶：小句不写对侧，且所在句子写出该病灶的图像号（CT 所见）或侧别。
  const opposite = (side: Side): Side => side === 'left' ? 'right' : 'left'
  const positiveStatements = (texts: string[], locate: (sentence: string, lesion: (typeof report.lesions)[number]) => boolean) => (
    texts.flatMap(sentence => clauses(sentence).filter(positiveClause).map(clause => ({
      clause,
      lesions: report.lesions.filter(lesion => !namesSide(clause, opposite(lesion.side)) && locate(sentence, lesion)),
      sentence,
    })))
  )
  const statements = [
    ...positiveStatements(findings, (sentence, lesion) => (
      lesion.imageNumber === undefined ? namesSide(sentence, lesion.side) : imageMention(lesion.imageNumber).test(sentence)
    )),
    ...positiveStatements(impression, (sentence, lesion) => namesSide(sentence, lesion.side)),
  ]
  for (const { clause, lesions, sentence } of statements) {
    if (lesions.length === 0) {
      issue(
        nodules.length === 0 ? 'REPORT_POSITIVE_FINDING_IN_NEGATIVE' : 'REPORT_TEXT_UNSUPPORTED_FINDING',
        `The source annotation does not support the statement: ${sentence}`,
      )
    }
    // 数量词按小句所写侧别的已声明病灶计数；未写侧别时按全部病灶计数。
    const count = statedCount(clause)
    const declared = report.lesions.filter(lesion => !namesSide(clause, opposite(lesion.side))).length
    if (count !== undefined && (declared < count.minimum || (count.exact !== undefined && count.exact > declared))) {
      issue('REPORT_COUNT_MISMATCH', `The statement "${clause}" disagrees with ${declared} declared lesion(s)`)
    }
  }
  return result()
}

/**
 * 复核所签署的内容：素材身份与来源（受试者、Study/Series/Instance UID 及其字节数与哈希）、合集 DOI 与许可、
 * 已安装像素、来源标注、生成草稿所用 prompt 文件、引用该素材的适配条目和报告修订本身；任何一项变化都使复核失效。
 */
export function imagingReportContentSha256(asset: ImagingCatalogAsset, report: ImagingReportRevision): string {
  const { review: _review, ...content } = report
  return canonicalJsonHash({
    annotation: asset.annotation,
    assetId: asset.assetId,
    collection: asset.reviewScope.collection,
    examCode: asset.examCode,
    matchingProfiles: asset.reviewScope.matchingProfiles,
    output: asset.output,
    promptSha256: asset.reviewScope.promptSha256[report.draft.promptVersion] ?? null,
    report: content,
    source: asset.source,
  })
}

export type ImagingPublicationBlockCode =
  | 'ASSET_UNRECORDED'
  | 'AUTOMATED_CHECK_FAILED'
  | 'REPORT_MISSING'
  | 'REVIEW_INCOMPLETE'
  | 'REVIEW_MISSING'
  | 'REVIEW_NOT_APPROVED'
  | 'REVIEW_STALE'

/**
 * 素材能否进入病例匹配：像素已登记，且至少一份报告修订通过自动检查并由维护者对当前内容签署复核。
 * 返回可发布的报告修订号，以及其余修订或整个素材被拦下的原因。
 */
export function imagingAssetPublication(asset: ImagingCatalogAsset): {
  publishedRevisions: number[]
  reasons: Array<{ code: ImagingPublicationBlockCode; revision?: number }>
} {
  if (asset.output === undefined) return { publishedRevisions: [], reasons: [{ code: 'ASSET_UNRECORDED' }] }
  if (asset.reports === undefined || asset.reports.length === 0) {
    return { publishedRevisions: [], reasons: [{ code: 'REPORT_MISSING' }] }
  }
  const requiredItems = imagingReviewItems.filter(item => item !== 'plain-scan' || asset.examCode === 'chest-ct-plain')
  const publishedRevisions: number[] = []
  const reasons: Array<{ code: ImagingPublicationBlockCode; revision: number }> = []
  for (const report of asset.reports) {
    const { review, revision } = report
    if (review === undefined) reasons.push({ code: 'REVIEW_MISSING', revision })
    else if (review.contentSha256 !== imagingReportContentSha256(asset, report)) reasons.push({ code: 'REVIEW_STALE', revision })
    else if (review.conclusion !== 'approved') reasons.push({ code: 'REVIEW_NOT_APPROVED', revision })
    else if (!requiredItems.every(item => review.items.some(entry => entry.item === item && entry.conclusion === 'confirmed'))) {
      reasons.push({ code: 'REVIEW_INCOMPLETE', revision })
    } else if (checkImagingReport(asset, report).issues.length > 0) reasons.push({ code: 'AUTOMATED_CHECK_FAILED', revision })
    else publishedRevisions.push(revision)
  }
  return { publishedRevisions, reasons }
}
