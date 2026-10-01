import { canonicalJsonHash } from '../../application/scenario-data/canonical-json.ts'
import {
  imagingReviewItems,
  type ImagingCatalogAsset,
  type ImagingReportRevision,
} from './imaging-catalog.ts'

/** 自动一致性检查规则版本；规则变化时递增，复核记录保存当时使用的版本。 */
export const imagingReportCheckVersion = 1

export type ImagingReportIssueCode =
  | 'ANNOTATION_INDETERMINATE'
  | 'ANNOTATION_MISSING'
  | 'REPORT_IMPRESSION_MISMATCH'
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
const positiveTerm = /结节|肿块|占位|实变|磨玻璃|空洞|积液|气胸|肿大|不张|致密影|斑片/
const negationTerm = /未见|未及|无/
const sizeMention = /(\d+(?:\.\d+)?)\s*(mm|cm|毫米|厘米)/g

function sentences(text: string): string[] {
  return text.split(/[。；;\n]/).map(sentence => sentence.trim()).filter(sentence => sentence !== '')
}

/** 句中出现阳性征象词，且其前没有否定词。 */
function statesPositiveFinding(sentence: string): boolean {
  const positive = positiveTerm.exec(sentence)
  if (positive === null) return false
  const negation = negationTerm.exec(sentence)
  return negation === null || negation.index > positive.index
}

function namesSide(sentence: string, side: Side): boolean {
  return sideTerms[side].test(sentence) && !sideTerms[side === 'left' ? 'right' : 'left'].test(sentence)
}

function sizesMm(text: string): number[] {
  return [...text.matchAll(sizeMention)].map(match => (
    Number(match[1]) * (match[2] === 'cm' || match[2] === '厘米' ? 10 : 1)
  ))
}

/**
 * 来源标注中应当写入报告的病灶。CT 取多数读片者标记的结节；胸片取全体读片者一致认为可见的结节。
 * 只有少数读片者标记、或胸片可见性存疑时，素材既不算阴性也没有可报告的依据。
 */
function reportableNodules(annotation: NonNullable<ImagingCatalogAsset['annotation']>): {
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
  asset: ImagingCatalogAsset,
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
  for (const lesion of report.lesions) {
    const described = findings.some(sentence => (
      namesSide(sentence, lesion.side)
      && statesPositiveFinding(sentence)
      && (lesion.imageNumber === undefined || imageMention(lesion.imageNumber).test(sentence))
      && (lesion.longAxisMm === undefined || sizesMm(sentence).includes(lesion.longAxisMm))
    ))
    if (!described) {
      issue('REPORT_TEXT_LESION_MISMATCH', `The findings text does not describe lesion ${lesion.noduleId} as declared`)
    }
    if (!impression.some(sentence => namesSide(sentence, lesion.side) && statesPositiveFinding(sentence))) {
      issue('REPORT_IMPRESSION_MISMATCH', `The impression does not name lesion ${lesion.noduleId}`)
    }
  }

  // 小于 3 mm 的结节没有测量值，正文只允许以“3 mm”作为上界提及。
  const allowedSizes = new Set(report.lesions.map(lesion => lesion.longAxisMm ?? 3))
  for (const size of sizesMm(`${report.findings}\n${report.impression}`)) {
    if (!allowedSizes.has(size)) {
      issue('REPORT_TEXT_SIZE_UNSUPPORTED', `The text states ${size} mm, which no reported lesion has`)
    }
  }

  // 每个未被否定的阳性征象句都必须能归到一个已声明的病灶：CT 所见按图像号，其余按侧别。
  const unsupported = [
    ...findings.filter(sentence => statesPositiveFinding(sentence) && !report.lesions.some(lesion => (
      lesion.imageNumber === undefined ? namesSide(sentence, lesion.side) : imageMention(lesion.imageNumber).test(sentence)
    ))),
    ...impression.filter(sentence => statesPositiveFinding(sentence)
      && !report.lesions.some(lesion => namesSide(sentence, lesion.side))),
  ]
  for (const sentence of unsupported) {
    issue(
      nodules.length === 0 ? 'REPORT_POSITIVE_FINDING_IN_NEGATIVE' : 'REPORT_TEXT_UNSUPPORTED_FINDING',
      `The source annotation does not support the statement: ${sentence}`,
    )
  }
  return result()
}

/** 复核所签署的内容：素材身份、已安装像素、来源标注和报告修订本身；任何一项变化都使复核失效。 */
export function imagingReportContentSha256(asset: ImagingCatalogAsset, report: ImagingReportRevision): string {
  const { review: _review, ...content } = report
  return canonicalJsonHash({
    annotation: asset.annotation,
    assetId: asset.assetId,
    examCode: asset.examCode,
    output: asset.output,
    report: content,
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
